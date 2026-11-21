import { randomUUID } from "node:crypto";
import type { Fighter, FighterEvents, FighterOptions, LlmErrorReport } from "@phack/agent";
import type { Env } from "@phack/env";
import type { ApiKeys, GatewayRouting, LlmClient } from "@phack/llm";
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
import { buildArena, prepareFighter, runCountdown } from "./arena";
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

export type MatchEnv = Pick<
  Env,
  | "LLM_PROVIDER"
  | "LLM_MODEL"
  | "VERCEL_API_KEY"
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
  history: {
    append(record: MatchRecord): Promise<void>;
    /** Corrige una pelea ya guardada; false si ya no está. */
    update(id: string, change: (record: MatchRecord) => MatchRecord): Promise<boolean>;
  };
  createFighter: (opts: FighterOptions) => Fighter;
  createLlmClient: (opts: {
    provider: Provider;
    model?: string;
    apiKeys: ApiKeys;
    gatewayRouting?: GatewayRouting;
  }) => LlmClient;
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

// ---------- Pelea única con configuración explícita (torneo) ----------

/** Configuración explícita de un lado para `runOnce` (no usa los prompts de la web). */
export type RunOnceSide = {
  provider: Provider;
  model: string;
  prompt: string;
  /** Enrutamiento de Vercel AI Gateway (p. ej. fijar "baseten"). */
  gatewayRouting?: GatewayRouting;
};

export type RunOnceOptions = {
  configs: Record<Side, RunOnceSide>;
  durationSeconds: number;
  /** Pedir el "por qué ganó" al LLM del servidor. Por defecto false. */
  explain?: boolean;
  /** Abortar = detener la pelea (resultado "stopped"). */
  signal?: AbortSignal;
};

export type LatencySummary = { count: number; mean: number; p50: number; p95: number };

/** Lo que el LLM de un lado hizo durante el duelo (solo cuenta la fase "running"). */
export type SideOutcome = {
  provider: Provider;
  model: string;
  /** Respuestas del LLM (una por llamada exitosa). */
  decisions: number;
  /** Decisiones sin acción válida (sin tool, tool desconocida o argumentos inválidos). */
  invalidActions: number;
  tokensIn: number;
  tokensOut: number;
  /** Suma del costo informado por el proveedor (USD). */
  costUsd: number;
  /** Cuántas respuestas traían costo informado (0 = hay que estimar por tokens). */
  costReportedCalls: number;
  /** Latencia estado -> acción válida de cada decisión válida, en orden (ms). */
  decisionLatenciesMs: number[];
  latencyMs: LatencySummary;
  llmErrors: number;
  retryableLlmErrors: number;
  /** Racha máxima de errores reintentables seguidos (una respuesta exitosa la corta). */
  maxRetryableStreak: number;
  lastLlmError: string | null;
};

export type MatchOutcome = {
  id: string;
  /** true si la pelea llegó a la fase "running" (solo entonces hay record). */
  reachedRunning: boolean;
  record: MatchRecord | null;
  result: MatchResult;
  /** Motivo del fallo si la pelea terminó en "error" (preparación, desconexión) o se detuvo. */
  error: string | null;
  /** Algún bot se desconectó en plena pelea. */
  disconnected: boolean;
  startedAt: number | null;
  endedAt: number;
  sides: Record<Side, SideOutcome>;
};

/** Resumen de latencias: media y percentiles por rango más cercano. Vacío = todo 0. */
export function latencySummary(values: readonly number[]): LatencySummary {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { count: 0, mean: 0, p50: 0, p95: 0 };
  const rank = (p: number): number => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))] ?? 0;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n;
  return { count: n, mean: Math.round(mean), p50: rank(0.5), p95: rank(0.95) };
}

type SideStatsAcc = Omit<SideOutcome, "provider" | "model" | "latencyMs"> & { streak: number };

function emptyStatsAcc(): SideStatsAcc {
  return {
    decisions: 0,
    invalidActions: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    costReportedCalls: 0,
    decisionLatenciesMs: [],
    llmErrors: 0,
    retryableLlmErrors: 0,
    maxRetryableStreak: 0,
    lastLlmError: null,
    streak: 0,
  };
}

/** Hub que no envía nada: para correr peleas sin web (torneo por CLI). */
export const NOOP_HUB: EventSink = { broadcast: () => {}, markStateDirty: () => {}, flushState: () => {} };

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
  durationMs: number;
  explain: boolean;
  routing: Partial<Record<Side, GatewayRouting>>;
  stats: Record<Side, SideStatsAcc>;
  /** Motivo del fallo (para MatchOutcome). */
  error: string | null;
  disconnected: boolean;
  record: MatchRecord | null;
  /** Configuración resuelta (proveedor y modelo reales) y resultado, para MatchOutcome. */
  configs: PromptsResponse;
  result: MatchResult | null;
  /** Se resuelve al terminar toda la limpieza (finalized). */
  done: Promise<void>;
  resolveDone: () => void;
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
    // Los prompts quedan congelados: editar la web ya no afecta esta pelea.
    this.begin(this.deps.prompts.get(), {
      durationMs: this.deps.env.MATCH_DURATION_SECONDS * 1000,
      explain: true,
      routing: {},
    });
    return this.getState();
  }

  /**
   * Corre UNA pelea con configuración explícita y espera a que termine (incluida la
   * limpieza). No usa los prompts de la web. Rechaza con MatchActiveError si ya hay otra.
   * Nunca rechaza por fallos de la pelea: esos quedan en `result`/`error` del resultado.
   */
  async runOnce(opts: RunOnceOptions): Promise<MatchOutcome> {
    if (opts.signal?.aborted) throw new Error("Pelea cancelada antes de empezar");
    const configs: PromptsResponse = {
      red: { side: "red", prompt: opts.configs.red.prompt, provider: opts.configs.red.provider, model: opts.configs.red.model },
      blue: { side: "blue", prompt: opts.configs.blue.prompt, provider: opts.configs.blue.provider, model: opts.configs.blue.model },
    };
    const routing: Partial<Record<Side, GatewayRouting>> = {};
    for (const side of SIDES) {
      const r = opts.configs[side].gatewayRouting;
      if (r) routing[side] = r;
    }
    const ctx = this.begin(configs, {
      durationMs: Math.max(1, opts.durationSeconds) * 1000,
      explain: opts.explain ?? false,
      routing,
    });
    const onAbort = (): void => {
      if (!ctx.ended) ctx.error = ctx.error ?? "pelea detenida por quien la pidió";
      void this.finish(ctx, { winner: null, reason: "stopped" });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await ctx.done;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
    return this.outcome(ctx);
  }

  private begin(
    configs: PromptsResponse,
    opts: { durationMs: number; explain: boolean; routing: Partial<Record<Side, GatewayRouting>> },
  ): MatchContext {
    if (this.shuttingDown || this.isActive()) throw new MatchActiveError();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const ctx: MatchContext = {
      id: randomUUID(),
      createdAt: Date.now(),
      ended: false,
      finalized: false,
      fighters: {},
      timer: null,
      thoughtPending: { red: false, blue: false },
      latency: { red: { totalMs: 0, count: 0 }, blue: { totalMs: 0, count: 0 } },
      durationMs: opts.durationMs,
      explain: opts.explain,
      routing: opts.routing,
      stats: { red: emptyStatsAcc(), blue: emptyStatsAcc() },
      error: null,
      disconnected: false,
      record: null,
      configs: structuredClone(configs),
      result: null,
      done,
      resolveDone,
    };
    this.ctx = ctx;
    this.state = {
      id: ctx.id,
      phase: "preparing",
      startedAt: null,
      endsAt: null,
      agents: { red: emptyStatus("red"), blue: emptyStatus("blue") },
      configs,
      result: null,
    };
    this.deps.hub.flushState();
    void this.run(ctx);
    return ctx;
  }

  private outcome(ctx: MatchContext): MatchOutcome {
    const side = (s: Side): SideOutcome => {
      const { streak: _streak, ...acc } = ctx.stats[s];
      const config = ctx.configs[s];
      return {
        provider: config.provider ?? this.deps.env.LLM_PROVIDER,
        model: config.model ?? "",
        ...acc,
        decisionLatenciesMs: [...acc.decisionLatenciesMs],
        latencyMs: latencySummary(acc.decisionLatenciesMs),
      };
    };
    const record = ctx.record ? structuredClone(ctx.record) : null;
    const reachedRunning = record !== null;
    return {
      id: ctx.id,
      reachedRunning,
      record,
      result: ctx.result ?? { winner: null, reason: "error" },
      error: ctx.error,
      disconnected: ctx.disconnected,
      startedAt: record?.startedAt ?? null,
      endedAt: record?.endedAt ?? Date.now(),
      sides: { red: side("red"), blue: side("blue") },
    };
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

      const llms: Record<Side, LlmClient> = { red: this.makeLlm(ctx, "red"), blue: this.makeLlm(ctx, "blue") };
      for (const side of SIDES) {
        // Se anota el proveedor y modelo que de verdad se usan (resueltos los valores por
        // defecto): es lo que muestran la web y el historial.
        this.state.configs[side] = {
          ...this.state.configs[side],
          provider: llms[side].provider,
          model: llms[side].model,
        };
        ctx.configs[side] = { ...this.state.configs[side] };
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

      // La pausa cubre la invulnerabilidad inicial al entrar al mundo. Dentro del juego no
      // se muestra nada: la cuenta regresiva y los avisos son cosa del sitio web.
      await runCountdown(this.sleep, () => ctx.ended);
      this.assertNotEnded(ctx);

      const now = Date.now();
      const durationMs = ctx.durationMs;
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
      ctx.error = errorMessage(err);
      await this.finish(ctx, { winner: null, reason: "error" });
    }
  }

  private assertNotEnded(ctx: MatchContext): void {
    if (ctx.ended) throw new CancelledError();
  }

  private makeLlm(ctx: MatchContext, side: Side): LlmClient {
    const { env } = this.deps;
    const config = this.state.configs[side];
    const provider: Provider = config.provider ?? env.LLM_PROVIDER;
    // LLM_MODEL solo aplica si el lado usa el mismo proveedor que el entorno.
    const model = config.model || (provider === env.LLM_PROVIDER ? env.LLM_MODEL : "") || undefined;
    const gatewayRouting = ctx.routing[side];
    return this.deps.createLlmClient({
      provider,
      model,
      apiKeys: this.apiKeys(),
      ...(gatewayRouting ? { gatewayRouting } : {}),
    });
  }

  private apiKeys(): ApiKeys {
    const { env } = this.deps;
    return {
      vercel: env.VERCEL_API_KEY || undefined,
      openai: env.OPENAI_API_KEY || undefined,
      anthropic: env.ANTHROPIC_API_KEY || undefined,
      openrouter: env.OPENROUTER_API_KEY || undefined,
      gateway: env.AI_GATEWAY_API_KEY || undefined,
    };
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
          ctx.disconnected = true;
          ctx.error = ctx.error ?? `${SIDE_LABEL[side]} se desconectó del servidor en plena pelea`;
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
        const st = ctx.stats[side];
        st.decisions += 1;
        st.streak = 0;
        if (d.usage) {
          st.tokensIn += count(d.usage.inputTokens);
          st.tokensOut += count(d.usage.outputTokens);
        }
        if (typeof d.costUsd === "number" && Number.isFinite(d.costUsd) && d.costUsd >= 0) {
          st.costUsd += d.costUsd;
          st.costReportedCalls += 1;
        }
        if (d.invalid === true) st.invalidActions += 1;
        else if (typeof d.decisionMs === "number" && Number.isFinite(d.decisionMs) && d.decisionMs >= 0) {
          st.decisionLatenciesMs.push(Math.round(d.decisionMs));
        }
        hub.markStateDirty();
      },
      onLlmError: (e: LlmErrorReport) => {
        if (!fighting()) return;
        const st = ctx.stats[side];
        st.llmErrors += 1;
        st.lastLlmError = truncate(e.message, 300);
        if (e.retryable) {
          st.retryableLlmErrors += 1;
          st.streak += 1;
          st.maxRetryableStreak = Math.max(st.maxRetryableStreak, st.streak);
        } else {
          st.streak = 0;
        }
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
      ctx.result = result;
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

      // "Por qué ganó": se pide ya (en paralelo con la desconexión) y se adjunta después,
      // así nunca retrasa el cierre de la pelea.
      const explanation = ctx.explain && reachedRunning && shouldExplain(result) ? this.explain(record) : null;
      if (reachedRunning) ctx.record = record;

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
      }
      this.log(result.reason === "error" ? "error" : "info", describeResult(result));
    } catch (err) {
      this.log("error", `Error al cerrar la pelea: ${errorMessage(err)}`);
    } finally {
      ctx.finalized = true;
      ctx.resolveDone();
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
