import { randomUUID } from "node:crypto";
import type { Fighter, FighterEvents, FighterOptions } from "@phack/agent";
import type { Env } from "@phack/env";
import type { ApiKeys, LlmClient } from "@phack/llm";
import {
  AGENT_USERNAMES,
  SIDES,
  type AgentStatus,
  type MatchRecord,
  type MatchResult,
  type MatchState,
  type PromptsResponse,
  type Provider,
  type Side,
} from "@phack/protocol";
import { announce, buildArena, prepareFighter, runCountdown } from "./arena";
import type { EventSink } from "./hub";
import type { RconLike } from "./rcon";
import { SIDE_LABEL, decideTimeoutResult, describeResult, otherSide, resultForDeath } from "./result";
import { errorMessage, sleep as realSleep, truncate, withTimeout, type LogLevel, type SleepFn } from "./util";

const CONNECT_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 10_000;
/** Tiempo que el resultado queda en fase "finished" antes de volver a "idle". */
const FINISHED_HOLD_MS = 5_000;

export type MatchEnv = Pick<
  Env,
  | "LLM_PROVIDER"
  | "LLM_MODEL"
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "OPENROUTER_API_KEY"
  | "AI_GATEWAY_API_KEY"
  | "MC_HOST"
  | "MC_PORT"
  | "MC_VERSION"
  | "MATCH_DURATION_SECONDS"
  | "AGENT_TICK_MS"
>;

export type MatchDeps = {
  env: MatchEnv;
  rcon: RconLike;
  hub: EventSink;
  prompts: { get(): PromptsResponse };
  history: { append(record: MatchRecord): Promise<void> };
  createFighter: (opts: FighterOptions) => Fighter;
  createLlmClient: (opts: { provider: Provider; model?: string; apiKeys: ApiKeys }) => LlmClient;
  /** Registro para humanos (consola del servidor). */
  log: (level: LogLevel, text: string) => void;
  sleep?: SleepFn;
};

/** Se lanza al intentar iniciar una pelea cuando ya hay una en curso (HTTP 409). */
export class MatchActiveError extends Error {
  constructor() {
    super("Ya hay una pelea en curso");
    this.name = "MatchActiveError";
  }
}

/** Marca interna: la pelea se terminó (stop/error) mientras se preparaba. */
class CancelledError extends Error {}

type MatchContext = {
  id: string;
  createdAt: number;
  /** true desde que se decidió el final: a partir de ahí se ignoran los eventos de los agentes. */
  ended: boolean;
  /** true cuando terminó toda la limpieza y se puede iniciar otra pelea. */
  finalized: boolean;
  fighters: Partial<Record<Side, Fighter>>;
  timer: ReturnType<typeof setTimeout> | null;
  /** Para contar una decisión por respuesta del LLM (pensamiento + sus acciones). */
  thoughtPending: Record<Side, boolean>;
};

function emptyStatus(side: Side): AgentStatus {
  return {
    side,
    username: AGENT_USERNAMES[side],
    connected: false,
    alive: false,
    health: 20,
    food: 20,
    damageDealt: 0,
    decisions: 0,
    lastThought: "",
    lastAction: "",
  };
}

function formatAction(tool: string, args: Record<string, unknown>, result: string): string {
  let argsText = "";
  try {
    argsText = Object.keys(args).length > 0 ? JSON.stringify(args) : "";
  } catch {
    argsText = "";
  }
  return truncate(`${tool}(${argsText}) → ${result}`, 300);
}

/**
 * Máquina de estados de la pelea: idle -> preparing -> running -> finished -> idle.
 * Solo existe una pelea a la vez (sala única).
 */
export class MatchManager {
  private state: MatchState;
  private ctx: MatchContext | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private readonly sleep: SleepFn;

  constructor(private readonly deps: MatchDeps) {
    this.sleep = deps.sleep ?? realSleep;
    this.state = {
      id: "",
      phase: "idle",
      startedAt: null,
      endsAt: null,
      agents: { red: emptyStatus("red"), blue: emptyStatus("blue") },
      configs: deps.prompts.get(),
      result: null,
    };
  }

  getState(): MatchState {
    return structuredClone(this.state);
  }

  isActive(): boolean {
    if (this.state.phase === "preparing" || this.state.phase === "running") return true;
    // "finished" pero todavía desconectando agentes / guardando el resultado.
    return this.ctx !== null && !this.ctx.finalized;
  }

  /** Inicia una pelea con los prompts pendientes. Devuelve el estado en fase "preparing". */
  start(): MatchState {
    if (this.shuttingDown || this.isActive()) throw new MatchActiveError();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const ctx: MatchContext = {
      id: randomUUID(),
      createdAt: Date.now(),
      ended: false,
      finalized: false,
      fighters: {},
      timer: null,
      thoughtPending: { red: false, blue: false },
    };
    this.ctx = ctx;
    this.state = {
      id: ctx.id,
      phase: "preparing",
      startedAt: null,
      endsAt: null,
      agents: { red: emptyStatus("red"), blue: emptyStatus("blue") },
      // Los prompts quedan congelados: editar la web ya no afecta esta pelea.
      configs: this.deps.prompts.get(),
      result: null,
    };
    this.deps.hub.flushState();
    void this.run(ctx);
    return this.getState();
  }

  /** Detiene la pelea en curso (si la hay). Idempotente. */
  async stop(): Promise<MatchState> {
    const ctx = this.ctx;
    if (ctx && !ctx.ended) {
      await this.finish(ctx, { winner: null, reason: "stopped" });
    }
    return this.getState();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.stop();
  }

  // ---------- Flujo de la pelea ----------

  private async run(ctx: MatchContext): Promise<void> {
    const { rcon, env } = this.deps;
    try {
      this.log("info", "Preparando la pelea…");

      const llms: Record<Side, LlmClient> = { red: this.makeLlm("red"), blue: this.makeLlm("blue") };
      for (const side of SIDES) {
        // Se anota el proveedor y modelo que de verdad se usan (resueltos los valores por
        // defecto): es lo que muestran la web y el historial.
        this.state.configs[side] = {
          ...this.state.configs[side],
          provider: llms[side].provider,
          model: llms[side].model,
        };
        ctx.fighters[side] = this.deps.createFighter({
          side,
          username: AGENT_USERNAMES[side],
          opponentUsername: AGENT_USERNAMES[otherSide(side)],
          prompt: this.state.configs[side].prompt,
          llm: llms[side],
          mc: { host: env.MC_HOST, port: env.MC_PORT, version: env.MC_VERSION },
          tickMs: env.AGENT_TICK_MS,
          events: this.makeEvents(ctx, side),
        });
      }
      this.assertNotEnded(ctx);

      await buildArena(rcon, this.sleep);
      this.assertNotEnded(ctx);

      this.log("info", "Conectando a los agentes al servidor de Minecraft…");
      const connects = SIDES.map((side) => {
        const fighter = ctx.fighters[side];
        return fighter ? fighter.connect() : Promise.reject(new Error("Agente no creado"));
      });
      await withTimeout(
        Promise.all(connects),
        CONNECT_TIMEOUT_MS,
        "Los agentes no lograron conectarse a Minecraft a tiempo",
      );
      this.assertNotEnded(ctx);

      // Pequeña pausa para que el servidor termine de registrar a los jugadores.
      await this.sleep(500);
      this.assertNotEnded(ctx);

      for (const side of SIDES) {
        await prepareFighter(rcon, side);
        this.assertNotEnded(ctx);
      }

      // La cuenta regresiva además cubre la invulnerabilidad inicial al entrar al mundo.
      await runCountdown(rcon, this.sleep, () => ctx.ended);
      this.assertNotEnded(ctx);

      const now = Date.now();
      const durationMs = env.MATCH_DURATION_SECONDS * 1000;
      this.state.phase = "running";
      this.state.startedAt = now;
      this.state.endsAt = now + durationMs;
      for (const side of SIDES) {
        // Recién curados y teletransportados: se parte con vida completa.
        this.state.agents[side].alive = true;
        this.state.agents[side].health = 20;
        this.state.agents[side].damageDealt = 0;
      }
      ctx.timer = setTimeout(() => {
        void this.onTimeout(ctx);
      }, durationMs);
      for (const side of SIDES) ctx.fighters[side]?.start();
      this.deps.hub.flushState();
      this.log("info", "¡Comienza la pelea!");
    } catch (err) {
      if (ctx.ended || err instanceof CancelledError) return;
      this.log("error", `No se pudo completar la pelea: ${errorMessage(err)}`);
      await this.finish(ctx, { winner: null, reason: "error" });
    }
  }

  private assertNotEnded(ctx: MatchContext): void {
    if (ctx.ended) throw new CancelledError();
  }

  private makeLlm(side: Side): LlmClient {
    const { env } = this.deps;
    const config = this.state.configs[side];
    const provider: Provider = config.provider ?? env.LLM_PROVIDER;
    // LLM_MODEL solo aplica si el lado usa el mismo proveedor que el entorno.
    const model = config.model || (provider === env.LLM_PROVIDER ? env.LLM_MODEL : "") || undefined;
    const apiKeys: ApiKeys = {
      openai: env.OPENAI_API_KEY || undefined,
      anthropic: env.ANTHROPIC_API_KEY || undefined,
      openrouter: env.OPENROUTER_API_KEY || undefined,
      gateway: env.AI_GATEWAY_API_KEY || undefined,
    };
    return this.deps.createLlmClient({ provider, model, apiKeys });
  }

  private makeEvents(ctx: MatchContext, side: Side): FighterEvents {
    const { hub } = this.deps;
    /** Los eventos solo cuentan mientras esta pelea siga viva. */
    const live = (): boolean => this.ctx === ctx && !ctx.ended;
    /**
     * Daño y muerte solo cuentan con la pelea en marcha. Durante la preparación un bot
     * puede entrar muerto (quedó así guardado de la pelea anterior) o recibir daño al
     * ser teletransportado: eso no es parte del duelo.
     */
    const fighting = (): boolean => live() && this.state.phase === "running";
    const agent = (): AgentStatus => this.state.agents[side];

    return {
      onStatus: (s) => {
        if (!live()) return;
        const a = agent();
        a.connected = s.connected;
        a.alive = s.alive;
        a.health = s.health;
        a.food = s.food;
        hub.markStateDirty();
        if (this.state.phase !== "running") return;
        if (!s.connected) {
          this.log("error", `${SIDE_LABEL[side]} se desconectó del servidor en plena pelea`);
          void this.finish(ctx, { winner: null, reason: "error" });
        } else if (!s.alive && s.health <= 0) {
          // Respaldo por si el agente no alcanza a emitir onDeath.
          this.handleDeath(ctx, side);
        }
      },
      onThought: (text) => {
        if (!live()) return;
        const a = agent();
        a.lastThought = truncate(text, 500);
        a.decisions += 1;
        ctx.thoughtPending[side] = true;
        hub.broadcast({ type: "thought", at: Date.now(), side, text: truncate(text, 2000) });
        hub.markStateDirty();
      },
      onAction: (tool, args, result) => {
        if (!live()) return;
        const a = agent();
        // Una acción sin pensamiento previo también es una decisión del LLM.
        if (ctx.thoughtPending[side]) ctx.thoughtPending[side] = false;
        else a.decisions += 1;
        a.lastAction = formatAction(tool, args, result);
        hub.broadcast({ type: "action", at: Date.now(), side, tool, args, result: truncate(result, 1000) });
        hub.markStateDirty();
      },
      onDamageTaken: (amount, health) => {
        if (!fighting()) return;
        agent().health = health;
        const rival = this.state.agents[otherSide(side)];
        rival.damageDealt = Math.round((rival.damageDealt + Math.max(0, amount)) * 100) / 100;
        hub.broadcast({ type: "damage", at: Date.now(), side, amount, health });
        hub.markStateDirty();
      },
      onDeath: () => {
        if (!fighting()) return;
        this.handleDeath(ctx, side);
      },
      onLog: (level, text) => {
        if (this.ctx !== ctx) return;
        this.log(level, `[${SIDE_LABEL[side]}] ${text}`);
      },
    };
  }

  private handleDeath(ctx: MatchContext, side: Side): void {
    if (ctx.ended || this.state.phase !== "running") return;
    const a = this.state.agents[side];
    a.alive = false;
    a.health = 0;
    this.deps.hub.broadcast({ type: "death", at: Date.now(), side });
    void this.finish(ctx, resultForDeath(side));
  }

  private async onTimeout(ctx: MatchContext): Promise<void> {
    if (ctx.ended) return;
    const { red, blue } = this.state.agents;
    await this.finish(ctx, decideTimeoutResult(red, blue));
  }

  /** Único camino de salida de una pelea. Nunca lanza. */
  private async finish(ctx: MatchContext, result: MatchResult): Promise<void> {
    if (ctx.ended) return;
    ctx.ended = true;
    if (ctx.timer) clearTimeout(ctx.timer);
    ctx.timer = null;

    try {
      const endedAt = Date.now();
      const reachedRunning = this.state.startedAt !== null;
      const startedAt = this.state.startedAt ?? ctx.createdAt;
      this.state.phase = "finished";
      this.state.result = result;
      this.deps.hub.flushState();

      // Foto final ANTES de desconectar (al reaparecer el perdedor vuelve a 20 de vida).
      const record: MatchRecord = {
        id: ctx.id,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        configs: structuredClone(this.state.configs),
        final: structuredClone(this.state.agents),
        result,
      };

      const stops = SIDES.map(async (side) => {
        const fighter = ctx.fighters[side];
        if (fighter) await withTimeout(fighter.stop(), STOP_TIMEOUT_MS, "El agente no se detuvo a tiempo");
      });
      const settled = await Promise.allSettled(stops);
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          this.log("warn", `Problema al detener un agente: ${errorMessage(outcome.reason)}`);
        }
      }

      // Solo las peleas que llegaron a empezar entran al historial, y solo esas emiten
      // "match_end" (la web agrega ese registro a su tabla de historial). Si la pelea
      // falló o se detuvo al prepararse, el evento "state" con fase "finished" y el
      // mensaje de log de abajo ya informan el resultado.
      if (reachedRunning) {
        await this.deps.history.append(record);
        this.deps.hub.broadcast({ type: "match_end", at: Date.now(), record });
      }
      this.log(result.reason === "error" ? "error" : "info", describeResult(result));

      // El cartel en el juego no debe retrasar el cierre si RCON está caído.
      const color = result.winner === "red" ? "red" : result.winner === "blue" ? "blue" : "yellow";
      const title = result.winner
        ? `Gana ${SIDE_LABEL[result.winner]}`
        : result.reason === "draw"
          ? "Empate"
          : "Pelea terminada";
      announce(this.deps.rcon, title, color).catch(() => {});
    } catch (err) {
      this.log("error", `Error al cerrar la pelea: ${errorMessage(err)}`);
    } finally {
      ctx.finalized = true;
      if (!this.shuttingDown) {
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (this.ctx === ctx && this.state.phase === "finished") {
            this.state.phase = "idle";
            this.deps.hub.flushState();
          }
        }, FINISHED_HOLD_MS);
      }
    }
  }

  /** Mensaje para humanos: va a la consola y a todos los clientes web. */
  private log(level: LogLevel, text: string): void {
    this.deps.log(level, text);
    this.deps.hub.broadcast({ type: "log", at: Date.now(), level, text });
  }
}
