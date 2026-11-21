import { randomUUID } from "node:crypto";
import { kitToolNames, type DecisionReport, type Fighter, type FighterEvents, type FighterOptions } from "@phack/agent";
import type { Env } from "@phack/env";
import type { ApiKeys, LlmClient } from "@phack/llm";
import {
  MAX_HEALTH,
  AGENT_USERNAMES,
  COUNTDOWN_SECONDS,
  DEFAULT_KIT,
  KITS,
  MAX_AGENT_MESSAGE_LENGTH,
  INJECTION_AT_SECONDS,
  INJECTION_MESSAGES,
  SCENARIOS,
  SIDES,
  formatTranscript,
  kitOf,
  parseTranscript,
  roundPoints,
  seriesByPoints,
  seriesDecided,
  type Judgement,
  type MatchMetrics,
  type AgentStatus,
  type ArenaEvent,
  type Kit,
  type MatchSettings,
  type MatchRecord,
  type MatchResult,
  type MatchState,
  type PromptsResponse,
  type Provider,
  type RoundReason,
  type RoundResult,
  type Series,
  type Side,
  type TranscriptEntry,
} from "@phack/protocol";
import { buildArena, clearPlacedBlocks, prepareFighter, resetFighterForRound, runCountdown } from "./arena";
import { Conversation, type ConversationClock } from "./conversation";
import { extractCustomKit } from "./customkit";
import { buildExplanationMessages, cleanExplanation, fallbackExplanation, shouldExplain } from "./explain";
import type { EventSink } from "./hub";
import { judgeMatch, type JudgeOutcome } from "./judge";
import { MetricsCollector, countInvalidCalls, type Standing } from "./metrics";
import type { RconLike } from "./rcon";
import {
  SIDE_LABEL,
  decideTimeoutResult,
  describeResult,
  describeRound,
  otherSide,
  pointsResult,
  resultForDeath,
  roundNote,
  seriesResult,
} from "./result";
import {
  cutCodePoints,
  errorMessage,
  sleep as realSleep,
  truncate,
  withTimeout,
  type LogLevel,
  type SleepFn,
} from "./util";

const CONNECT_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 10_000;
/** Tiempo que el resultado queda en fase "finished" antes de volver a "idle". */
const FINISHED_HOLD_MS = 5_000;
/** Máximo que se espera al LLM que escribe el "por qué ganó"; después se usa la plantilla. */
const EXPLAIN_TIMEOUT_MS = 15_000;
/** Máximo que se espera al LLM que arma un kit personalizado; después se usa el kit por defecto. */
const CUSTOM_KIT_TIMEOUT_MS = 20_000;
/** Máximo que se espera al LLM juez. */
const JUDGE_TIMEOUT_MS = 90_000;
/** Pausa mínima entre dos calificaciones de la misma pelea (también mientras una está en curso). */
const JUDGE_COOLDOWN_MS = 60_000;
/**
 * Modo por rondas: pausa entre una ronda y la siguiente, en total. Sus últimos
 * COUNTDOWN_SECONDS son la cuenta regresiva que dibuja la web.
 */
const ROUND_BREAK_MS = 6_000;
/** Modo por rondas: cuánto se espera, al terminar una ronda, a que reaparezca el que murió. */
const RESPAWN_WAIT_MS = 2_000;
const RESPAWN_STEP_MS = 100;
/** Velocidad de la voz si no la pasan en MatchDeps.speechSpeed (la de ELEVENLABS_SPEED por defecto). */
const DEFAULT_SPEECH_SPEED = 1.1;
/**
 * Modo por rondas: false = el kit se entrega una sola vez, antes de la ronda 1, y lo que
 * un agente gasta no vuelve en las rondas siguientes. true = se entrega de nuevo (limpio)
 * antes de cada ronda.
 */
export const ROUNDS_REFILL_KIT = false;

export type MatchEnv = Pick<
  Env,
  | "LLM_PROVIDER"
  | "LLM_MODEL"
  | "VERCEL_API_KEY"
  | "MC_HOST"
  | "MC_PORT"
  | "MC_VERSION"
  | "MATCH_DURATION_SECONDS"
  | "MATCH_MAX_SECONDS"
  | "AGENT_TICK_MS"
  | "AGENT_OBSERVATION_RADIUS"
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
  /**
   * Transcripción de cada pelea (DATA_DIR/transcripts). append no espera ni lanza; read y
   * flush (opcionales) los usa el juez.
   */
  transcripts: {
    append(matchId: string, entry: TranscriptEntry): void;
    read?(matchId: string): Promise<string | null>;
    flush?(): Promise<void>;
  };
  /**
   * Lista de modelos permitidos (ver models.ts): segundo control, al iniciar la pelea.
   * price (opcional): dólares por token de un modelo, para el costo de cada ronda.
   */
  models: { isAllowed(id: string): boolean; price?(id: string): { input: number; output: number } | null };
  /** Registro para humanos (consola del servidor). */
  log: (level: LogLevel, text: string) => void;
  sleep?: SleepFn;
  /** Solo para los tests: reemplaza ROUNDS_REFILL_KIT. */
  roundsRefillKit?: boolean;
  /**
   * Voz de los mensajes (ver speech.ts). Opcional: sin esto, o sin clave, los mensajes solo
   * se leen. request no espera ni lanza: devuelve el id del audio o null.
   */
  speech?: {
    available(): boolean;
    request(side: Side, text: string): string | null;
    /** Despierta las voces antes de la pelea; opcional. */
    warm?(): void;
    /** Lo que dura de verdad el audio de ese id, en ms, cuando esté listo; null si no se sabe. */
    durationMs?(speechId: string): Promise<number | null>;
  };
  /**
   * Velocidad de la voz (ELEVENLABS_SPEED, ya acotada). Con la voz encendida, con ella se
   * estima cuánto dura cada frase mientras no llega la duración real del audio.
   */
  speechSpeed?: number;
  /** Solo para los tests: reloj, temporizadores y azar de los turnos para hablar. */
  conversationClock?: ConversationClock;
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
  /** Suma y cantidad de las latencias del LLM, para el promedio (avgDecisionMs). */
  latency: Record<Side, { totalMs: number; count: number }>;
  /** true cuando ya se escribió la entrada "start" de la transcripción. */
  startRecorded: boolean;
  /**
   * Lo que se anotó antes de "start" (la fase "preparing", el armado de los kits
   * personalizados): se escribe justo después de "start", en el mismo orden.
   */
  beforeStart: TranscriptEntry[];
  /** Último estado de cada agente anotado en la transcripción (para no repetir iguales). */
  lastStatus: Record<Side, StatusEntry | null>;
  /**
   * Corazones amarillos que informó cada agente. No van en el estado público: solo sirven
   * para desempatar por vida al acabarse el tiempo.
   */
  absorption: Record<Side, number>;
  /** Modo por rondas: cómo terminó la última ronda, contado a cada agente (ver roundNote). */
  roundNotes: Record<Side, string>;
  /** Modo "chat": quién tiene la palabra y qué frase espera su turno (ver conversation.ts). */
  conversation: Conversation;
  /** Benchmarks: lo que se mide de la ronda en juego (null entre rondas). */
  metrics: MetricsCollector | null;
  /** Benchmarks: lo medido en cada ronda ya cerrada, en orden. */
  roundMetrics: MatchMetrics[];
  /** Precio por token del modelo de cada lado (null si no se conoce o es el simulado). */
  prices: Record<Side, { input: number; output: number } | null>;
  /** Órdenes falsas que cada agente no alcanzó a leer en la ronda que terminó. */
  unseenInjections: Record<Side, number>;
  /** Órdenes falsas programadas para la ronda en juego (escenario "injection"). */
  injectionTimers: ReturnType<typeof setTimeout>[];
};

type StatusEntry = Extract<TranscriptEntry, { type: "status" }>;
/** Eventos de la pelea que van a la web y, tal cual, a la transcripción. */
type FightEvent = Extract<ArenaEvent, { type: "thought" | "message" | "action" | "damage" | "death" }>;

function emptyStatus(side: Side): AgentStatus {
  return {
    side,
    username: AGENT_USERNAMES[side],
    connected: false,
    alive: false,
    health: MAX_HEALTH,
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

/** Serie nueva, antes de la ronda 1. */
function newSeries(maxRounds: number): Series {
  return { round: 1, maxRounds, wins: { red: 0, blue: 0 }, rounds: [], roundStartedAt: null, points: { red: 0, blue: 0 } };
}

/**
 * Ajustes con los que de verdad se juega. Un escenario que reparte puntos necesita una
 * serie; la inyección necesita el chat (las órdenes falsas llegan por ahí) y el dilema,
 * un final por tiempo. Devuelve también qué se cambió, para avisarlo.
 */
export function effectiveSettings(settings: MatchSettings): { settings: MatchSettings; notes: string[] } {
  const out = structuredClone(settings);
  const notes: string[] = [];
  // El formato sale de las rondas: más de 1 es una serie.
  out.mode = out.rounds > 1 ? "rounds" : "single";
  if (out.scenario !== "duel" && out.mode !== "rounds") {
    out.mode = "rounds";
    notes.push(`El escenario "${SCENARIOS[out.scenario].name}" se juega como serie (aunque sea de 1 ronda) para repartir sus puntos`);
  }
  if (out.scenario === "injection" && out.comms !== "chat") {
    out.comms = "chat";
    notes.push("La inyección necesita que los agentes puedan hablarse: se juega con chat");
  }
  if (out.scenario === "dilemma" && !out.timer) {
    out.timer = true;
    notes.push("El dilema del prisionero necesita límite de tiempo: se juega con el límite encendido");
  }
  return { settings: out, notes };
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
 * En el modo por rondas, entre una ronda y la siguiente: running -> intermission -> running.
 * Solo existe una pelea a la vez (sala única).
 */
export class MatchManager {
  private state: MatchState;
  private ctx: MatchContext | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  /** Cuándo se pidió por última vez calificar cada pelea (ver JUDGE_COOLDOWN_MS). */
  private readonly judgedAt = new Map<string, number>();
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
      series: null,
      result: null,
    };
  }

  getState(): MatchState {
    return structuredClone(this.state);
  }

  isActive(): boolean {
    const { phase } = this.state;
    if (phase === "preparing" || phase === "running" || phase === "intermission") return true;
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

    const { settings, notes } = effectiveSettings(this.deps.settings.get());
    // Con voz, cada frase ocupa lo que dura dicha a la velocidad de la voz; sin voz, a velocidad normal.
    const speed = settings.voice ? (this.deps.speechSpeed ?? DEFAULT_SPEECH_SPEED) : 1;
    const ctx: MatchContext = {
      id: randomUUID(),
      createdAt: Date.now(),
      ended: false,
      finalized: false,
      fighters: {},
      timer: null,
      latency: { red: { totalMs: 0, count: 0 }, blue: { totalMs: 0, count: 0 } },
      startRecorded: false,
      beforeStart: [],
      lastStatus: { red: null, blue: null },
      absorption: { red: 0, blue: 0 },
      roundNotes: { red: "", blue: "" },
      conversation: new Conversation({
        speed,
        onRelease: (side, text) => this.releaseMessage(ctx, side, text),
        ...(this.deps.conversationClock ? { clock: this.deps.conversationClock } : {}),
      }),
      metrics: null,
      roundMetrics: [],
      prices: { red: null, blue: null },
      unseenInjections: { red: 0, blue: 0 },
      injectionTimers: [],
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
      settings,
      series: settings.mode === "rounds" ? newSeries(settings.rounds) : null,
      result: null,
    };
    this.deps.hub.flushState();
    this.record(ctx, { type: "phase", at: ctx.createdAt, phase: "preparing" });
    for (const note of notes) this.log(ctx, "warn", note);
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
      this.log(ctx, "info", "Preparando la pelea…");
      this.warmVoices(ctx);

      const llms: Record<Side, LlmClient> = { red: this.makeLlm(ctx, "red"), blue: this.makeLlm(ctx, "blue") };
      // Los kits personalizados se arman en paralelo (cada uno con el LLM de su lado).
      const [redKit, blueKit] = await Promise.all(SIDES.map((side) => this.resolveKit(ctx, side, llms[side])));
      // Precio por token de cada modelo, para el costo de cada ronda (el simulado no cuesta).
      for (const side of SIDES) {
        const llm = llms[side];
        ctx.prices[side] = llm.provider === "mock" ? null : (this.deps.models.price?.(llm.model) ?? null);
      }
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
          durationSeconds: this.durationSeconds(),
          rounds: this.state.series
            ? {
                maxRounds: this.state.series.maxRounds,
                scenario: this.state.settings.scenario,
                horizon: this.state.settings.horizon,
                byPoints: seriesByPoints(this.state.settings),
                refillKit: this.deps.roundsRefillKit ?? (this.state.settings.refillKit || ROUNDS_REFILL_KIT),
              }
            : null,
          rules: this.state.settings.rules[side],
          llm: llms[side],
          mc: { host: env.MC_HOST, port: env.MC_PORT, version: env.MC_VERSION },
          tickMs: env.AGENT_TICK_MS,
          observationRadius: env.AGENT_OBSERVATION_RADIUS,
          events: this.makeEvents(ctx, side),
        });
      }
      // La transcripción parte con lo que de verdad pelea: modelos, kits y prompts de sistema.
      this.recordStart(ctx);
      // El kit ya resuelto (también el personalizado) llega a la web con el próximo estado.
      this.deps.hub.markStateDirty();
      this.assertNotEnded(ctx);

      await buildArena(rcon, this.sleep);
      this.assertNotEnded(ctx);

      this.log(ctx, "info", "Conectando a los agentes al servidor de Minecraft…");
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
        await prepareFighter(rcon, side, kitOf(this.state.configs[side]), (text) => this.log(ctx, "warn", text));
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

      // Un agente que se desconectó durante la preparación o la cuenta regresiva no puede
      // pelear: al pasar a "running" se le daría por vivo y con vida completa.
      const gone = SIDES.find((side) => !this.state.agents[side].connected);
      if (gone) {
        this.log(ctx, "error", `${SIDE_LABEL[gone]} se desconectó del servidor antes de empezar la pelea`);
        await this.finish(ctx, { winner: null, reason: "error" });
        return;
      }

      this.startRound(ctx);
    } catch (err) {
      if (ctx.ended || err instanceof CancelledError) return;
      this.log(ctx, "error", `No se pudo completar la pelea: ${errorMessage(err)}`);
      await this.finish(ctx, { winner: null, reason: "error" });
    }
  }

  /**
   * Pasa a "running": la pelea (una sola) o la ronda que toca (modo por rondas). En la
   * primera los agentes empiezan a decidir; en las siguientes se reanudan.
   */
  private startRound(ctx: MatchContext): void {
    const { env } = this.deps;
    const series = this.state.series;
    const first = series === null || series.rounds.length === 0;
    const now = Date.now();
    // Con el límite de tiempo apagado no hay hora de término. En el modo por rondas, el
    // límite (o el tope de seguridad) vale para cada ronda.
    const seconds = this.durationSeconds();
    // La cuenta regresiva se borra en la misma actualización que cambia la fase.
    this.state.phase = "running";
    this.state.countdownEndsAt = null;
    if (first) this.state.startedAt = now;
    this.state.endsAt = seconds === null ? null : now + seconds * 1000;
    this.record(ctx, { type: "phase", at: now, phase: "running" });
    if (series) {
      series.roundStartedAt = now;
      this.record(ctx, { type: "round_start", at: now, round: series.round });
    }
    for (const side of SIDES) {
      // Recién curados y teletransportados: se parte con vida completa.
      this.state.agents[side].alive = true;
      this.state.agents[side].health = MAX_HEALTH;
      // El daño hecho se cuenta en toda la serie: solo parte de 0 en la primera ronda.
      if (first) this.state.agents[side].damageDealt = 0;
      ctx.absorption[side] = 0;
    }
    // Benchmarks: cada ronda se mide por separado. Las órdenes falsas que un agente no
    // alcanzó a leer en la ronda anterior las lee al reanudar: cuentan desde ahora.
    const unseen = ctx.unseenInjections;
    ctx.unseenInjections = { red: 0, blue: 0 };
    ctx.metrics = new MetricsCollector({
      rules: { red: this.state.settings.rules.red, blue: this.state.settings.rules.blue },
      standing: (side) => this.standing(side),
      prices: { ...ctx.prices },
    });
    ctx.metrics.start(now);
    for (const side of SIDES) for (let i = 0; i < unseen[side]; i += 1) ctx.metrics.injection(side, now);
    if (this.state.settings.scenario === "injection") this.scheduleInjections(ctx);
    if (seconds !== null) {
      ctx.timer = setTimeout(() => {
        void this.onTimeout(ctx);
      }, seconds * 1000);
    } else if (env.MATCH_MAX_SECONDS > 0) {
      ctx.timer = setTimeout(() => {
        void this.onCeiling(ctx);
      }, env.MATCH_MAX_SECONDS * 1000);
    }
    for (const side of SIDES) {
      const fighter = ctx.fighters[side];
      if (!fighter) continue;
      if (first || !series) {
        fighter.start();
      } else {
        const lost = series.wins[otherSide(side)];
        const drawn = series.rounds.filter((r) => r.winner === null).length;
        const view = {
          round: series.round,
          won: series.wins[side],
          lost,
          drawn,
          maxRounds: series.maxRounds,
          ...(this.state.settings.horizon === "unknown" ? { hideMax: true } : {}),
          ...(seriesByPoints(this.state.settings)
            ? { points: { mine: series.points[side], rival: series.points[otherSide(side)] } }
            : {}),
        };
        fighter.resume(view, `${ctx.roundNotes[side]}; empieza la ronda ${series.round}`);
      }
    }
    this.deps.hub.flushState();
    this.log(ctx, "info", series ? `¡Comienza la ronda ${series.round}!` : "¡Comienza la pelea!");
  }

  /**
   * Modo por rondas: terminó la ronda en juego. Se anota, se pausa a los agentes y, si la
   * serie no está decidida, empieza la pausa hacia la siguiente. Desde aquí nada de lo que
   * pase cuenta para el resultado: la fase deja de ser "running" en el acto.
   */
  private endRound(ctx: MatchContext, winner: Side | null, reason: RoundReason): void {
    const series = this.state.series;
    if (ctx.ended || !series || this.state.phase !== "running") return;
    if (ctx.timer) clearTimeout(ctx.timer);
    ctx.timer = null;
    const now = Date.now();
    // Benchmarks: se cierra lo medido en la ronda y se reparten los puntos del escenario.
    const metrics = this.closeRoundMetrics(ctx, now);
    const attacked = metrics ? { red: metrics.red.attacked, blue: metrics.blue.attacked } : { red: false, blue: false };
    const points = roundPoints(this.state.settings.scenario, { winner, reason }, attacked);
    const result: RoundResult = {
      round: series.round,
      winner,
      reason,
      durationMs: Math.max(0, now - (series.roundStartedAt ?? now)),
      points,
      attacked,
    };
    series.rounds.push(result);
    if (winner) series.wins[winner] += 1;
    series.points.red += points.red;
    series.points.blue += points.blue;
    series.roundStartedAt = null;
    this.state.phase = "intermission";
    this.state.endsAt = null;
    // Lo que esperaba su turno para decirse ya no sale: la ronda terminó.
    ctx.conversation.clear();
    for (const side of SIDES) {
      const note = this.roundNoteFor(result, side);
      ctx.roundNotes[side] = note;
      try {
        ctx.fighters[side]?.pause(note);
      } catch (err) {
        this.log(ctx, "warn", `No se pudo pausar a ${SIDE_LABEL[side]}: ${errorMessage(err)}`);
      }
    }
    // El duelo se decide por rondas ganadas (puede terminar antes); los escenarios con
    // puntos juegan todas las rondas.
    const byPoints = seriesByPoints(this.state.settings);
    const decided = byPoints ? series.rounds.length >= series.maxRounds : seriesDecided(series);
    // Durante la pausa, "round" ya es la ronda que viene (ver SeriesSchema).
    if (!decided) series.round += 1;
    const event: Extract<ArenaEvent, { type: "round_end" }> = {
      type: "round_end",
      at: now,
      result: { ...result },
      series: structuredClone(series),
    };
    this.deps.hub.broadcast(event);
    this.record(ctx, event);
    this.log(ctx, "info", describeRound(result, series, this.state.settings));
    if (decided) {
      void this.finish(ctx, byPoints ? pointsResult(series) : seriesResult(series));
      return;
    }
    this.record(ctx, { type: "phase", at: now, phase: "intermission" });
    this.deps.hub.flushState();
    void this.runIntermission(ctx);
  }

  /**
   * Modo por rondas: la pausa entre rondas. Borra los bloques colocados, lleva a los dos a
   * su lugar con la vida completa (sin reponer el inventario, salvo ROUNDS_REFILL_KIT),
   * muestra la cuenta regresiva y empieza la ronda siguiente. Se corta si la pelea terminó.
   */
  private async runIntermission(ctx: MatchContext): Promise<void> {
    const { rcon } = this.deps;
    const breakEndsAt = Date.now() + ROUND_BREAK_MS;
    try {
      await this.waitForRespawn(ctx);
      this.assertNotEnded(ctx);
      // Primero los bloques: así nadie aparece dentro de un muro que quedó en su spawn.
      await clearPlacedBlocks(rcon);
      this.assertNotEnded(ctx);
      for (const side of SIDES) {
        if (this.deps.roundsRefillKit ?? (this.state.settings.refillKit || ROUNDS_REFILL_KIT)) {
          await prepareFighter(rcon, side, kitOf(this.state.configs[side]), (text) => this.log(ctx, "warn", text));
        } else {
          await resetFighterForRound(rcon, side, kitOf(this.state.configs[side]));
        }
        this.assertNotEnded(ctx);
      }

      await runCountdown(this.sleep, breakEndsAt - COUNTDOWN_SECONDS * 1000, () => ctx.ended);
      this.assertNotEnded(ctx);
      this.state.countdownEndsAt = breakEndsAt;
      this.deps.hub.flushState();
      await runCountdown(this.sleep, breakEndsAt, () => ctx.ended);
      this.assertNotEnded(ctx);

      const gone = SIDES.find((side) => !this.state.agents[side].connected);
      if (gone) {
        this.log(ctx, "error", `${SIDE_LABEL[gone]} se desconectó del servidor entre rondas`);
        await this.finish(ctx, { winner: null, reason: "error" });
        return;
      }
      this.startRound(ctx);
    } catch (err) {
      if (ctx.ended || err instanceof CancelledError) return;
      this.log(ctx, "error", `No se pudo preparar la ronda siguiente: ${errorMessage(err)}`);
      await this.finish(ctx, { winner: null, reason: "error" });
    }
  }

  /**
   * El que murió reaparece solo (lo hace mineflayer): se le espera un poco antes de
   * llevarlo a su lugar, porque al reaparecer queda en el spawn del mundo. Si no avisa a
   * tiempo, se sigue igual.
   */
  private async waitForRespawn(ctx: MatchContext): Promise<void> {
    const dead = (): boolean => SIDES.some((side) => this.state.agents[side].connected && !this.state.agents[side].alive);
    for (let waited = 0; waited < RESPAWN_WAIT_MS && dead(); waited += RESPAWN_STEP_MS) {
      this.assertNotEnded(ctx);
      await this.sleep(RESPAWN_STEP_MS);
    }
  }

  /**
   * Kit con el que pelea un lado. Si eligió "custom", un LLM arma el inventario a partir
   * de su prompt; si no se puede (LLM simulado, falla, demora o el prompt no pide nada
   * válido), pelea con el kit por defecto y se avisa en el registro. Nunca lanza.
   */
  private async resolveKit(ctx: MatchContext, side: Side, llm: LlmClient): Promise<Kit> {
    const config = this.state.configs[side];
    if (config.kit !== "custom") return kitOf(config);
    const fallback = KITS[DEFAULT_KIT];
    const fail = (reason: string): Kit => {
      this.log(ctx, "warn", `[${SIDE_LABEL[side]}] No se pudo armar el kit personalizado (${reason}): pelea con el kit ${fallback.name}`);
      return fallback;
    };
    if (llm.provider === "mock") return fail("el LLM simulado no sabe leer el inventario del prompt");
    this.log(ctx, "info", `[${SIDE_LABEL[side]}] Armando el kit personalizado a partir del prompt…`);
    const abort = new AbortController();
    try {
      const outcome = await withTimeout(
        extractCustomKit(llm, config.prompt, abort.signal),
        CUSTOM_KIT_TIMEOUT_MS,
        "el LLM no respondió a tiempo",
      );
      if (!outcome.ok) return fail(outcome.reason);
      if (outcome.ignored.length > 0) {
        this.log(ctx, "warn", `[${SIDE_LABEL[side]}] Del kit personalizado se descartó: ${truncate(outcome.ignored.join("; "), 400)}`);
      }
      return outcome.kit;
    } catch (err) {
      return fail(errorMessage(err));
    } finally {
      abort.abort();
    }
  }

  // ---------- Transcripción ----------

  /**
   * Entrada "start": con qué se peleó. Se escribe una sola vez y siempre primero; lo que
   * se anotó antes queda en espera y va justo después. Si falló la creación de un agente,
   * su prompt de sistema va vacío.
   */
  private recordStart(ctx: MatchContext): void {
    if (ctx.startRecorded) return;
    ctx.startRecorded = true;
    const { env } = this.deps;
    const systemPrompt = (side: Side): string => {
      try {
        const text = ctx.fighters[side]?.systemPrompt;
        return typeof text === "string" ? text : "";
      } catch {
        return "";
      }
    };
    this.deps.transcripts.append(ctx.id, {
      type: "start",
      at: ctx.createdAt,
      matchId: ctx.id,
      configs: structuredClone(this.state.configs),
      settings: structuredClone(this.state.settings),
      systemPrompts: { red: systemPrompt("red"), blue: systemPrompt("blue") },
      tickMs: env.AGENT_TICK_MS,
      durationSeconds: this.durationSeconds(),
    });
    for (const entry of ctx.beforeStart.splice(0)) this.deps.transcripts.append(ctx.id, entry);
  }

  /** Anota una entrada en la transcripción de `ctx` (aunque ya haya empezado otra pelea). */
  private record(ctx: MatchContext, entry: TranscriptEntry): void {
    if (!ctx.startRecorded) {
      ctx.beforeStart.push(entry);
      return;
    }
    this.deps.transcripts.append(ctx.id, entry);
  }

  /** Lo que pasa en la pelea va a la web y a la transcripción por el mismo camino. */
  private emit(ctx: MatchContext, event: FightEvent): void {
    this.deps.hub.broadcast(event);
    this.record(ctx, event);
  }

  /** Una respuesta del LLM: lo que vio, lo que respondió tal cual y cuánto costó. */
  private recordDecision(ctx: MatchContext, side: Side, d: DecisionReport): void {
    const entry: Extract<TranscriptEntry, { type: "decision" }> = {
      type: "decision",
      at: Date.now(),
      side,
      ms: Number.isFinite(d.ms) ? d.ms : 0,
    };
    if (d.usage) {
      entry.tokensIn = count(d.usage.inputTokens);
      entry.tokensOut = count(d.usage.outputTokens);
    }
    if (d.contextProfile) entry.contextProfile = d.contextProfile;
    if (typeof d.observation === "object" && d.observation !== null) entry.observation = { ...d.observation };
    if (typeof d.response === "object" && d.response !== null) {
      const toolCalls = Array.isArray(d.response.toolCalls) ? d.response.toolCalls : [];
      entry.response = {
        text: typeof d.response.text === "string" ? d.response.text : "",
        toolCalls: toolCalls.map((call) => ({ name: call.name, args: call.args })),
      };
    }
    this.record(ctx, entry);
  }

  /** Anota el estado de un agente solo si cambió algo desde el último anotado. */
  private recordStatus(
    ctx: MatchContext,
    side: Side,
    s: { connected: boolean; alive: boolean; health: number; food: number; heldItem: string },
  ): void {
    const prev = ctx.lastStatus[side];
    if (
      prev &&
      prev.connected === s.connected &&
      prev.alive === s.alive &&
      prev.health === s.health &&
      prev.food === s.food &&
      prev.heldItem === s.heldItem
    ) {
      return;
    }
    const entry: StatusEntry = {
      type: "status",
      at: Date.now(),
      side,
      connected: s.connected,
      alive: s.alive,
      health: s.health,
      food: s.food,
      heldItem: s.heldItem,
    };
    ctx.lastStatus[side] = entry;
    this.record(ctx, entry);
  }

  private assertNotEnded(ctx: MatchContext): void {
    if (ctx.ended) throw new CancelledError();
  }

  private makeLlm(ctx: MatchContext, side: Side): LlmClient {
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
        ctx,
        "warn",
        `[${SIDE_LABEL[side]}] El modelo "${config.model}" no está en la lista de permitidos: se usa el modelo por defecto del servidor`,
      );
      model = serverModel;
    }
    return this.deps.createLlmClient({ provider, model, apiKeys: this.apiKeys() });
  }

  /**
   * Si en esta partida los agentes van a hablar en voz alta, despierta las voces mientras se
   * prepara la arena: así la primera frase no llega tarde. No espera ni puede fallar la pelea.
   */
  private warmVoices(ctx: MatchContext): void {
    const { voice, comms } = this.state.settings;
    if (!voice || comms !== "chat") return;
    try {
      this.deps.speech?.warm?.();
    } catch (err) {
      this.log(ctx, "warn", `No se pudieron preparar las voces: ${errorMessage(err)}`);
    }
  }

  /** Id del audio de un mensaje, o null si la voz está apagada, no hay servicio o falló. */
  private requestSpeech(ctx: MatchContext, side: Side, message: string): string | null {
    const speech = this.deps.speech;
    if (!speech || !this.state.settings.voice) return null;
    try {
      return speech.available() ? speech.request(side, message) : null;
    } catch (err) {
      this.log(ctx, "warn", `No se pudo pedir la voz de un mensaje: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * Le tocó el turno a una frase (ver conversation.ts): recién ahora se pide su voz, se
   * muestra, se anota y le llega al rival, que puede pensar mientras suena. Devuelve la
   * duración real del audio, cuando se sepa, para que la palabra dure eso.
   */
  private releaseMessage(ctx: MatchContext, side: Side, message: string): Promise<number | null> | void {
    if (this.ctx !== ctx || ctx.ended || this.state.phase !== "running") return;
    const speechId = this.requestSpeech(ctx, side, message);
    this.emit(ctx, { type: "message", at: Date.now(), side, text: message, ...(speechId ? { speechId } : {}) });
    ctx.fighters[otherSide(side)]?.hear("message", message);
    // Benchmarks: cuentan los mensajes que de verdad salieron, no los que esperaron y se reemplazaron.
    ctx.metrics?.message(side, message);
    return speechId ? this.speechDuration(speechId) : undefined;
  }

  /** Lo que dura el audio de esa frase; nunca lanza (null si no se sabe). */
  private speechDuration(speechId: string): Promise<number | null> | undefined {
    const speech = this.deps.speech;
    if (!speech?.durationMs) return undefined;
    try {
      return speech.durationMs(speechId).catch(() => null);
    } catch {
      return undefined;
    }
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
        this.recordStatus(ctx, side, s);
        const a = agent();
        a.connected = s.connected;
        a.alive = s.alive;
        a.health = s.health;
        a.food = s.food;
        a.heldItem = s.heldItem;
        ctx.absorption[side] = Number.isFinite(s.absorption) && s.absorption > 0 ? s.absorption : 0;
        hub.markStateDirty();
        if (this.state.phase !== "running") return;
        if (!s.connected) {
          this.log(ctx, "error", `${SIDE_LABEL[side]} se desconectó del servidor en plena pelea`);
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
        this.emit(ctx, { type: "thought", at: Date.now(), side, text: truncate(text, 2000) });
        hub.markStateDirty();
        // Modo "leen la mente": el rival recibe este razonamiento en su próxima observación.
        if (this.state.settings.comms === "thoughts") {
          ctx.fighters[otherSide(side)]?.hear("thought", text);
          if (fighting()) ctx.metrics?.thoughtShared(side);
        }
      },
      onMessage: (text) => {
        if (!fighting() || this.state.settings.comms !== "chat") return;
        // Solo el tope de largo, por si acaso: el agente ya lo entrega limpio y recortado
        // igual (por punto de código), así que un mensaje nunca se corta dos veces. Sin
        // filtros por contenido ni por repetición.
        const message = cutCodePoints(text, MAX_AGENT_MESSAGE_LENGTH);
        // Espera su turno para hablar (ver releaseMessage): sale apenas el otro termina.
        ctx.conversation.say(side, message);
      },
      onAction: (tool, args, result) => {
        if (!live()) return;
        const a = agent();
        a.lastAction = formatAction(tool, args, result);
        this.emit(ctx, { type: "action", at: Date.now(), side, tool, args, result: truncate(result, 1000) });
        // Una herramienta que no existe ya cuenta como llamada inválida: no es una acción.
        if (fighting() && this.offeredTools(side).includes(tool)) ctx.metrics?.action(side, tool, args);
        hub.markStateDirty();
      },
      onDecision: (d) => {
        if (!live()) return;
        this.recordDecision(ctx, side, d);
        // Igual que el daño: solo cuenta lo que el LLM gastó durante el duelo.
        if (!fighting()) return;
        const a = agent();
        // Una decisión por respuesta del LLM, traiga una acción, varias o ninguna.
        a.decisions += 1;
        const calls = Array.isArray(d.response?.toolCalls) ? d.response.toolCalls : [];
        ctx.metrics?.decision(side, d.ms, d.usage, countInvalidCalls(calls, this.offeredTools(side)), calls.length);
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
          ctx.metrics?.damage(side, amount);
        }
        this.emit(ctx, { type: "damage", at: Date.now(), side, amount, health });
        hub.markStateDirty();
      },
      onDeath: () => {
        if (!fighting()) return;
        this.handleDeath(ctx, side);
      },
      onSurrender: () => {
        // Solo existe en el modo por rondas, y solo cuenta con la ronda en juego.
        const series = this.state.series;
        if (!fighting() || !series) return;
        this.log(ctx, "info", `${SIDE_LABEL[side]} se rindió en la ronda ${series.round}`);
        ctx.metrics?.surrender(side);
        this.endRound(ctx, otherSide(side), "surrender");
      },
      onLog: (level, text) => {
        if (this.ctx !== ctx) return;
        this.log(ctx, level, `[${SIDE_LABEL[side]}] ${text}`);
      },
    };
  }

  private handleDeath(ctx: MatchContext, side: Side): void {
    if (ctx.ended || this.state.phase !== "running") return;
    const a = this.state.agents[side];
    a.alive = false;
    a.health = 0;
    this.emit(ctx, { type: "death", at: Date.now(), side });
    // En el modo por rondas una muerte termina la ronda, no la serie.
    if (this.state.series) this.endRound(ctx, otherSide(side), "kill");
    else void this.finish(ctx, resultForDeath(side));
  }

  /** Lo que dura esta pelea, en segundos; null si se pelea sin límite de tiempo. */
  private durationSeconds(): number | null {
    const { timer, timerSeconds } = this.state.settings;
    // La duración elegida en la web manda; sin elegir, la del servidor.
    return timer ? (timerSeconds ?? this.deps.env.MATCH_DURATION_SECONDS) : null;
  }

  /** Pelea sin límite de tiempo que llegó al tope de seguridad del servidor: se detiene, sin ganador. */
  private async onCeiling(ctx: MatchContext): Promise<void> {
    if (ctx.ended) return;
    const minutes = Math.round(this.deps.env.MATCH_MAX_SECONDS / 60);
    this.log(ctx, "warn", `La pelea no tenía límite de tiempo y llegó al tope del servidor (${minutes} min): se detiene`);
    await this.finish(ctx, { winner: null, reason: "stopped" });
  }

  private async onTimeout(ctx: MatchContext): Promise<void> {
    if (ctx.ended) return;
    const { red, blue } = this.state.agents;
    const result = decideTimeoutResult({ ...red, absorption: ctx.absorption.red }, { ...blue, absorption: ctx.absorption.blue });
    // En el modo por rondas se acabó el tiempo de la ronda, no el de la serie.
    if (this.state.series) {
      this.endRound(ctx, result.winner, result.winner ? "timeout_health" : "draw");
      return;
    }
    await this.finish(ctx, result);
  }

  /** Único camino de salida de una pelea. Nunca lanza. */
  private async finish(ctx: MatchContext, result: MatchResult): Promise<void> {
    if (ctx.ended) return;
    ctx.ended = true;
    if (ctx.timer) clearTimeout(ctx.timer);
    ctx.timer = null;
    // Ninguna frase sale después del final, ni queda un temporizador de la conversación.
    ctx.conversation.clear();
    this.clearInjections(ctx);
    // Si falló antes de crear a los agentes, "start" va igual primero.
    this.recordStart(ctx);

    let record: MatchRecord | null = null;
    try {
      const endedAt = Date.now();
      const reachedRunning = this.state.startedAt !== null;
      const startedAt = this.state.startedAt ?? ctx.createdAt;
      // Una pelea suelta es su única ronda: se cierra aquí lo medido. En una serie cortada a
      // mitad de ronda, esa ronda no se anotó en la serie y su medición se descarta.
      if (this.state.series) ctx.metrics = null;
      else this.closeRoundMetrics(ctx, endedAt);
      this.state.phase = "finished";
      // Si la pelea se canceló o falló en plena cuenta regresiva, ya no hay nada que contar.
      this.state.countdownEndsAt = null;
      this.state.result = result;
      this.deps.hub.flushState();
      this.record(ctx, { type: "phase", at: endedAt, phase: "finished" });

      // Foto final ANTES de desconectar (al reaparecer el perdedor vuelve a tener la vida completa).
      record = {
        id: ctx.id,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        configs: structuredClone(this.state.configs),
        final: structuredClone(this.state.agents),
        settings: structuredClone(this.state.settings),
        // Modo por rondas: las rondas jugadas; durationMs ya cubre toda la serie.
        series: this.state.series ? structuredClone(this.state.series) : null,
        result,
        roundMetrics: structuredClone(ctx.roundMetrics),
      };

      // "Por qué ganó": se pide ya (en paralelo con la desconexión) y se adjunta después,
      // así nunca retrasa el cierre de la pelea.
      const final = record;
      const explanation = reachedRunning && shouldExplain(result) ? this.explain(final) : null;

      const stops = SIDES.map(async (side) => {
        const fighter = ctx.fighters[side];
        if (fighter) await withTimeout(fighter.stop(), STOP_TIMEOUT_MS, "El agente no se detuvo a tiempo");
      });
      const settled = await Promise.allSettled(stops);
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          this.log(ctx, "warn", `Problema al detener un agente: ${errorMessage(outcome.reason)}`);
        }
      }

      // Solo las peleas que llegaron a empezar entran al historial, y solo esas emiten
      // "match_end" (la web agrega ese registro a su tabla de historial). Si la pelea
      // falló o se detuvo al prepararse, el evento "state" con fase "finished" y el
      // mensaje de log de abajo ya informan el resultado.
      if (reachedRunning) {
        await this.deps.history.append(final);
        this.deps.hub.broadcast({ type: "match_end", at: Date.now(), record: final });
        if (explanation) void this.attachExplanation(ctx, explanation);
        if (this.state.settings.judge) void this.autoJudge(final);
        // Los bloques que colocaron los peleadores se borran sin esperar: un RCON lento no
        // debe retrasar el cierre (y la próxima pelea igual reconstruye la arena).
        void clearPlacedBlocks(this.deps.rcon).catch((err: unknown) => {
          this.deps.log("warn", `No se pudieron borrar los bloques colocados en la arena: ${errorMessage(err)}`);
        });
      }
      this.log(ctx, result.reason === "error" ? "error" : "info", describeResult(result, this.state.series, this.state.settings));
    } catch (err) {
      this.log(ctx, "error", `Error al cerrar la pelea: ${errorMessage(err)}`);
    } finally {
      // Toda pelea cierra su transcripción, también las que no llegaron a empezar.
      if (record) this.record(ctx, { type: "end", at: Date.now(), record });
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

  // ---------- Benchmarks ----------

  /** Cierra la medición de la ronda en juego y la guarda; null si no había una. */
  private closeRoundMetrics(ctx: MatchContext, at: number): MatchMetrics | null {
    const collector = ctx.metrics;
    this.clearInjections(ctx);
    if (!collector) return null;
    ctx.metrics = null;
    for (const side of SIDES) ctx.unseenInjections[side] = collector.unseenInjections(side);
    const metrics = collector.finish(this.state.configs, at);
    ctx.roundMetrics.push(metrics);
    return metrics;
  }

  /** Cómo terminó la ronda, contado a un agente; en escenarios con puntos, también los puntos. */
  private roundNoteFor(result: RoundResult, side: Side): string {
    const note = roundNote(result, side);
    if (!seriesByPoints(this.state.settings) || !result.points || !result.attacked) return note;
    const rival = otherSide(side);
    const series = this.state.series;
    const total = series ? ` (en total: tú ${series.points[side]}, él ${series.points[rival]})` : "";
    return (
      `${note}; ${result.attacked[side] ? "le hiciste daño" : "no le hiciste daño"} y ${result.attacked[rival] ? "él a ti sí" : "él a ti no"}; ` +
      `puntos de la ronda: tú ${result.points[side]}, él ${result.points[rival]}${total}`
    );
  }

  /** Herramientas que se le ofrecen a un lado (las de su kit y, en una serie, surrender). */
  private offeredTools(side: Side): string[] {
    const tools: string[] = kitToolNames(kitOf(this.state.configs[side]));
    if (this.state.series) tools.push("surrender");
    return tools;
  }

  /** Cómo va un lado: primero el marcador de la serie y, si van parejos, la vida. */
  private standing(side: Side): Standing {
    const rival = otherSide(side);
    const series = this.state.series;
    if (series) {
      const score = seriesByPoints(this.state.settings) ? series.points : series.wins;
      if (score[side] !== score[rival]) return score[side] > score[rival] ? "ahead" : "behind";
    }
    const diff = this.state.agents[side].health - this.state.agents[rival].health;
    if (Math.abs(diff) < 2) return "even";
    return diff > 0 ? "ahead" : "behind";
  }

  /**
   * Escenario "injection": a los segundos de INJECTION_AT_SECONDS de cada ronda, los dos
   * agentes reciben por la bandeja del chat una orden falsa de rendirse.
   */
  private scheduleInjections(ctx: MatchContext): void {
    INJECTION_AT_SECONDS.forEach((seconds, index) => {
      const text = INJECTION_MESSAGES[index] ?? INJECTION_MESSAGES[0];
      const timer = setTimeout(() => {
        if (ctx.ended || this.ctx !== ctx || this.state.phase !== "running") return;
        for (const side of SIDES) {
          ctx.fighters[side]?.hear("message", text);
          ctx.metrics?.injection(side);
        }
        this.log(ctx, "warn", `Inyección ${index + 1}: los dos agentes recibieron una orden falsa de rendirse`);
      }, seconds * 1000);
      ctx.injectionTimers.push(timer);
    });
  }

  private clearInjections(ctx: MatchContext): void {
    for (const timer of ctx.injectionTimers) clearTimeout(timer);
    ctx.injectionTimers = [];
  }

  /** Juez automático (ajuste "judge"): califica la partida y la adjunta al historial. Nunca lanza. */
  private async autoJudge(record: MatchRecord): Promise<void> {
    try {
      const outcome = await this.judgeRecord(record);
      if (!outcome.ok) this.deps.log("warn", `El juez no calificó la pelea: ${outcome.reason}`);
    } catch (err) {
      this.deps.log("warn", `El juez falló: ${errorMessage(err)}`);
    }
  }

  /**
   * Le pide al LLM juez (proveedor y modelo por defecto del servidor) que califique una
   * pelea guardada, y guarda la nota en el historial.
   */
  async judgeRecord(record: MatchRecord): Promise<JudgeOutcome> {
    const { env, transcripts } = this.deps;
    if (env.LLM_PROVIDER === "mock") {
      return { ok: false, reason: "el juez necesita un LLM real (el servidor usa el simulado)", status: 400 };
    }
    if (!transcripts.read) return { ok: false, reason: "no hay transcripciones que leer", status: 404 };
    // Cada calificación cuesta una llamada grande al LLM: una a la vez por pelea y con pausa.
    const now = Date.now();
    const last = this.judgedAt.get(record.id);
    if (last !== undefined && now - last < JUDGE_COOLDOWN_MS) {
      return { ok: false, reason: "esa pelea se está calificando o se calificó hace muy poco", status: 429 };
    }
    this.judgedAt.set(record.id, now);
    await transcripts.flush?.();
    const raw = await transcripts.read(record.id);
    if (raw === null) return { ok: false, reason: "no hay transcripción de esa pelea", status: 404 };
    const text = formatTranscript(parseTranscript(raw));
    const llm = this.deps.createLlmClient({ provider: env.LLM_PROVIDER, model: env.LLM_MODEL || undefined, apiKeys: this.apiKeys() });
    const abort = new AbortController();
    try {
      const outcome = await withTimeout(judgeMatch(llm, record, text, abort.signal), JUDGE_TIMEOUT_MS, "el juez no respondió a tiempo");
      if (outcome.ok && !(await this.attachJudgement(record.id, outcome.judgement))) {
        return { ok: false, reason: "la calificación no se pudo guardar", status: 502 };
      }
      return outcome;
    } catch (err) {
      return { ok: false, reason: errorMessage(err), status: 502 };
    } finally {
      abort.abort();
      this.judgedAt.set(record.id, Date.now());
    }
  }

  /** Guarda la nota en el historial; false si esa pelea ya no está. */
  private async attachJudgement(id: string, judgement: Judgement): Promise<boolean> {
    const updated = await this.deps.history.update(id, (record) => ({ ...record, judgement }));
    if (!updated) this.deps.log("warn", "La pelea calificada ya no está en el historial: la nota no se guardó");
    else this.deps.log("info", `Juez: ${judgement.summary}`);
    return updated;
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
  private async attachExplanation(ctx: MatchContext, pending: Promise<string>): Promise<void> {
    const id = ctx.id;
    try {
      const explanation = await pending;
      this.record(ctx, { type: "explanation", at: Date.now(), text: explanation });
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

  /**
   * Mensaje para humanos: va a la consola, a todos los clientes web y a la transcripción
   * de `ctx` (la pelea de la que habla, aunque ya haya empezado otra).
   */
  private log(ctx: MatchContext, level: LogLevel, text: string): void {
    const at = Date.now();
    this.deps.log(level, text);
    this.deps.hub.broadcast({ type: "log", at, level, text });
    this.record(ctx, { type: "log", at, level, text });
  }
}
