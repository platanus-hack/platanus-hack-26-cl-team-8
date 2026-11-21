import { randomUUID } from "node:crypto";
import type { Fighter, FighterEvents, FighterOptions } from "@phack/agent";
import type { Env } from "@phack/env";
import type { ApiKeys, LlmClient } from "@phack/llm";
import {
  AGENT_USERNAMES,
  COUNTDOWN_SECONDS,
  DEFAULT_KIT,
  KITS,
  MAX_AGENT_MESSAGE_LENGTH,
  SIDES,
  kitOf,
  type AgentStatus,
  type Kit,
  type MatchSettings,
  type MatchRecord,
  type MatchResult,
  type MatchState,
  type PromptsResponse,
  type Provider,
  type Side,
} from "@phack/protocol";
import { buildArena, clearPlacedBlocks, prepareFighter, runCountdown } from "./arena";
import { extractCustomKit } from "./customkit";
import { buildExplanationMessages, cleanExplanation, fallbackExplanation, shouldExplain } from "./explain";
import type { EventSink } from "./hub";
import type { RconLike } from "./rcon";
import { SIDE_LABEL, decideTimeoutResult, describeResult, otherSide, resultForDeath } from "./result";
import { errorMessage, sleep as realSleep, truncate, withTimeout, type LogLevel, type SleepFn } from "./util";

const CONNECT_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 10_000;
/** Tiempo que el resultado queda en fase "finished" antes de volver a "idle". */
const FINISHED_HOLD_MS = 5_000;
/** Máximo que se espera al LLM que escribe el "por qué ganó"; después se usa la plantilla. */
const EXPLAIN_TIMEOUT_MS = 15_000;
/** Máximo que se espera al LLM que arma un kit personalizado; después se usa el kit por defecto. */
const CUSTOM_KIT_TIMEOUT_MS = 20_000;

export type MatchEnv = Pick<
  Env,
  | "LLM_PROVIDER"
  | "LLM_MODEL"
  | "VERCEL_API_KEY"
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
  /** Ajustes pendientes de la próxima pelea (modo de comunicación). */
  settings: { get(): MatchSettings };
  history: {
    append(record: MatchRecord): Promise<void>;
    /** Corrige una pelea ya guardada; false si ya no está. */
    update(id: string, change: (record: MatchRecord) => MatchRecord): Promise<boolean>;
  };
  createFighter: (opts: FighterOptions) => Fighter;
  createLlmClient: (opts: { provider: Provider; model?: string; apiKeys: ApiKeys }) => LlmClient;
  /** Lista de modelos permitidos (ver models.ts): segundo control, al iniciar la pelea. */
  models: { isAllowed(id: string): boolean };
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
  /** Suma y cantidad de las latencias del LLM, para el promedio (avgDecisionMs). */
  latency: Record<Side, { totalMs: number; count: number }>;
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
    heldItem: "",
    tokensIn: 0,
    tokensOut: 0,
    avgDecisionMs: 0,
  };
}

/** Un contador que llega de afuera: entero >= 0 o 0 si es basura. */
function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
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
      countdownEndsAt: null,
      agents: { red: emptyStatus("red"), blue: emptyStatus("blue") },
      configs: deps.prompts.get(),
      settings: deps.settings.get(),
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
      latency: { red: { totalMs: 0, count: 0 }, blue: { totalMs: 0, count: 0 } },
    };
    this.ctx = ctx;
    this.state = {
      id: ctx.id,
      phase: "preparing",
      startedAt: null,
      endsAt: null,
      countdownEndsAt: null,
      agents: { red: emptyStatus("red"), blue: emptyStatus("blue") },
      // Los prompts quedan congelados: editar la web ya no afecta esta pelea.
      configs: this.deps.prompts.get(),
      settings: this.deps.settings.get(),
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
      // Los kits personalizados se arman en paralelo (cada uno con el LLM de su lado).
      const [redKit, blueKit] = await Promise.all(SIDES.map((side) => this.resolveKit(side, llms[side])));
      this.assertNotEnded(ctx);
      const kits: Record<Side, Kit> = { red: redKit as Kit, blue: blueKit as Kit };
      for (const side of SIDES) {
        // Se anota el proveedor, el modelo y el kit que de verdad se usan (resueltos los
        // valores por defecto): es lo que muestran la web y el historial.
        const kit = kits[side];
        const config = { ...this.state.configs[side], provider: llms[side].provider, model: llms[side].model, kit: kit.id };
        if (kit.id === "custom") config.customKit = kit;
        else delete config.customKit;
        this.state.configs[side] = config;
        ctx.fighters[side] = this.deps.createFighter({
          side,
          username: AGENT_USERNAMES[side],
          opponentUsername: AGENT_USERNAMES[otherSide(side)],
          prompt: config.prompt,
          kit,
          comms: this.state.settings.comms,
          durationSeconds: env.MATCH_DURATION_SECONDS,
          llm: llms[side],
          mc: { host: env.MC_HOST, port: env.MC_PORT, version: env.MC_VERSION },
          tickMs: env.AGENT_TICK_MS,
          events: this.makeEvents(ctx, side),
        });
      }
      // El kit ya resuelto (también el personalizado) llega a la web con el próximo estado.
      this.deps.hub.markStateDirty();
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
        await prepareFighter(rcon, side, kitOf(this.state.configs[side]), (text) => this.log("warn", text));
        this.assertNotEnded(ctx);
      }

      // Cuenta regresiva: los dos peleadores ya están listos. Dentro del juego no se muestra
      // nada; el sitio web la dibuja a partir de countdownEndsAt, así que el estado se envía
      // ya, sin esperar el throttle. La pausa cubre además la invulnerabilidad inicial al
      // entrar al mundo.
      const countdownEndsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
      this.state.countdownEndsAt = countdownEndsAt;
      this.deps.hub.flushState();
      await runCountdown(this.sleep, countdownEndsAt, () => ctx.ended);
      this.assertNotEnded(ctx);

      const now = Date.now();
      const durationMs = env.MATCH_DURATION_SECONDS * 1000;
      // La cuenta regresiva se borra en la misma actualización que cambia la fase.
      this.state.phase = "running";
      this.state.countdownEndsAt = null;
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

  /**
   * Kit con el que pelea un lado. Si eligió "custom", un LLM arma el inventario a partir
   * de su prompt; si no se puede (LLM simulado, falla, demora o el prompt no pide nada
   * válido), pelea con el kit por defecto y se avisa en el registro. Nunca lanza.
   */
  private async resolveKit(side: Side, llm: LlmClient): Promise<Kit> {
    const config = this.state.configs[side];
    if (config.kit !== "custom") return kitOf(config);
    const fallback = KITS[DEFAULT_KIT];
    const fail = (reason: string): Kit => {
      this.log("warn", `[${SIDE_LABEL[side]}] No se pudo armar el kit personalizado (${reason}): pelea con el kit ${fallback.name}`);
      return fallback;
    };
    if (llm.provider === "mock") return fail("el LLM simulado no sabe leer el inventario del prompt");
    this.log("info", `[${SIDE_LABEL[side]}] Armando el kit personalizado a partir del prompt…`);
    const abort = new AbortController();
    try {
      const outcome = await withTimeout(
        extractCustomKit(llm, config.prompt, abort.signal),
        CUSTOM_KIT_TIMEOUT_MS,
        "el LLM no respondió a tiempo",
      );
      if (!outcome.ok) return fail(outcome.reason);
      if (outcome.ignored.length > 0) {
        this.log("warn", `[${SIDE_LABEL[side]}] Del kit personalizado se descartó: ${truncate(outcome.ignored.join("; "), 400)}`);
      }
      return outcome.kit;
    } catch (err) {
      return fail(errorMessage(err));
    } finally {
      abort.abort();
    }
  }

  private assertNotEnded(ctx: MatchContext): void {
    if (ctx.ended) throw new CancelledError();
  }

  private makeLlm(side: Side): LlmClient {
    const { env, models } = this.deps;
    const config = this.state.configs[side];
    const provider: Provider = config.provider ?? env.LLM_PROVIDER;
    // LLM_MODEL solo aplica si el lado usa el mismo proveedor que el entorno.
    const serverModel = (provider === env.LLM_PROVIDER ? env.LLM_MODEL : "") || undefined;
    // El simulado no tiene modelos que elegir: un modelo guardado sería solo una etiqueta falsa.
    let model = provider === "mock" ? serverModel : config.model || serverModel;
    // Segundo control de la lista de permitidos (el primero está al guardar el prompt): cubre
    // prompts guardados antes de que existiera y modelos que salieron de la lista después.
    if (provider !== "mock" && config.model && !models.isAllowed(config.model)) {
      this.log(
        "warn",
        `[${SIDE_LABEL[side]}] El modelo "${config.model}" no está en la lista de permitidos: se usa el modelo por defecto del servidor`,
      );
      model = serverModel;
    }
    return this.deps.createLlmClient({ provider, model, apiKeys: this.apiKeys() });
  }

  private apiKeys(): ApiKeys {
    return { vercel: this.deps.env.VERCEL_API_KEY || undefined };
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
        a.heldItem = s.heldItem;
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
        // Modo "leen la mente": el rival recibe este razonamiento en su próxima observación.
        if (this.state.settings.comms === "thoughts") ctx.fighters[otherSide(side)]?.hear("thought", text);
      },
      onMessage: (text) => {
        if (!live() || this.state.settings.comms !== "chat") return;
        const message = truncate(text, MAX_AGENT_MESSAGE_LENGTH);
        hub.broadcast({ type: "message", at: Date.now(), side, text: message });
        ctx.fighters[otherSide(side)]?.hear("message", message);
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
      onDecision: (d) => {
        // Igual que el daño: solo cuenta lo que el LLM gastó durante el duelo.
        if (!fighting()) return;
        const a = agent();
        if (d.usage) {
          a.tokensIn += count(d.usage.inputTokens);
          a.tokensOut += count(d.usage.outputTokens);
        }
        if (Number.isFinite(d.ms) && d.ms >= 0) {
          const latency = ctx.latency[side];
          latency.totalMs += d.ms;
          latency.count += 1;
          a.avgDecisionMs = Math.round(latency.totalMs / latency.count);
        }
        hub.markStateDirty();
      },
      onDamageTaken: (amount, health, bySelf) => {
        if (!fighting()) return;
        agent().health = health;
        // El daño que un peleador se hace solo (al caer con su perla de ender) no es mérito del rival.
        if (!bySelf) {
          const rival = this.state.agents[otherSide(side)];
          rival.damageDealt = Math.round((rival.damageDealt + Math.max(0, amount)) * 100) / 100;
        }
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
      // Si la pelea se canceló o falló en plena cuenta regresiva, ya no hay nada que contar.
      this.state.countdownEndsAt = null;
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
        settings: structuredClone(this.state.settings),
        result,
      };

      // "Por qué ganó": se pide ya (en paralelo con la desconexión) y se adjunta después,
      // así nunca retrasa el cierre de la pelea.
      const explanation = reachedRunning && shouldExplain(result) ? this.explain(record) : null;

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
        if (explanation) void this.attachExplanation(record.id, explanation);
        // Los bloques que colocaron los peleadores se borran sin esperar: un RCON lento no
        // debe retrasar el cierre (y la próxima pelea igual reconstruye la arena).
        void clearPlacedBlocks(this.deps.rcon).catch((err: unknown) => {
          this.deps.log("warn", `No se pudieron borrar los bloques colocados en la arena: ${errorMessage(err)}`);
        });
      }
      this.log(result.reason === "error" ? "error" : "info", describeResult(result));
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

  /**
   * Escribe la frase del "por qué ganó" con el proveedor y modelo por defecto del servidor
   * (LLM_PROVIDER / LLM_MODEL). Nunca lanza: con "mock", o si el LLM falla, se demora o
   * responde vacío, usa la plantilla armada con las estadísticas.
   */
  private async explain(record: MatchRecord): Promise<string> {
    const { env } = this.deps;
    if (env.LLM_PROVIDER === "mock") return fallbackExplanation(record);
    const abort = new AbortController();
    try {
      const llm = this.deps.createLlmClient({
        provider: env.LLM_PROVIDER,
        model: env.LLM_MODEL || undefined,
        apiKeys: this.apiKeys(),
      });
      const response = await withTimeout(
        llm.complete({ messages: buildExplanationMessages(record), tools: [], signal: abort.signal }),
        EXPLAIN_TIMEOUT_MS,
        "el LLM no respondió a tiempo",
      );
      const text = cleanExplanation(typeof response.text === "string" ? response.text : "");
      if (text !== "") return text;
      this.deps.log("warn", "El LLM respondió vacío al explicar el resultado; se usa la plantilla");
    } catch (err) {
      this.deps.log("warn", `No se pudo explicar el resultado con el LLM (se usa la plantilla): ${errorMessage(err)}`);
    } finally {
      // Si se agotó el tiempo, corta la solicitud que sigue en vuelo.
      abort.abort();
    }
    return fallbackExplanation(record);
  }

  /** Adjunta la explicación al resultado en vivo (si sigue siendo esa pelea) y al historial. */
  private async attachExplanation(id: string, pending: Promise<string>): Promise<void> {
    try {
      const explanation = await pending;
      // Si ya empezó otra pelea, el estado en vivo es de esa: solo se corrige el historial.
      if (this.state.id === id && this.state.result) {
        this.state.result = { ...this.state.result, explanation };
        this.deps.hub.flushState();
      }
      await this.deps.history.update(id, (record) => ({ ...record, result: { ...record.result, explanation } }));
      this.deps.log("info", `Por qué terminó así: ${explanation}`);
    } catch (err) {
      this.deps.log("warn", `No se pudo guardar la explicación del resultado: ${errorMessage(err)}`);
    }
  }

  /** Mensaje para humanos: va a la consola y a todos los clientes web. */
  private log(level: LogLevel, text: string): void {
    this.deps.log(level, text);
    this.deps.hub.broadcast({ type: "log", at: Date.now(), level, text });
  }
}
