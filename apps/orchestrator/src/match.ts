import { randomUUID } from "node:crypto";
import type { DecisionReport, Fighter, FighterEvents, FighterOptions } from "@phack/agent";
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
  type ArenaEvent,
  type Kit,
  type MatchSettings,
  type MatchRecord,
  type MatchResult,
  type MatchState,
  type PromptsResponse,
  type Provider,
  type Side,
  type TranscriptEntry,
} from "@phack/protocol";
import { buildArena, clearPlacedBlocks, prepareFighter, runCountdown } from "./arena";
import { extractCustomKit } from "./customkit";
import { buildExplanationMessages, cleanExplanation, fallbackExplanation, shouldExplain } from "./explain";
import type { EventSink } from "./hub";
import type { RconLike } from "./rcon";
import { SIDE_LABEL, decideTimeoutResult, describeResult, otherSide, resultForDeath } from "./result";
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
  /** Transcripción de cada pelea (DATA_DIR/transcripts). append no espera ni lanza. */
  transcripts: { append(matchId: string, entry: TranscriptEntry): void };
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
      startRecorded: false,
      beforeStart: [],
      lastStatus: { red: null, blue: null },
      absorption: { red: 0, blue: 0 },
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
    this.record(ctx, { type: "phase", at: ctx.createdAt, phase: "preparing" });
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

      const llms: Record<Side, LlmClient> = { red: this.makeLlm(ctx, "red"), blue: this.makeLlm(ctx, "blue") };
      // Los kits personalizados se arman en paralelo (cada uno con el LLM de su lado).
      const [redKit, blueKit] = await Promise.all(SIDES.map((side) => this.resolveKit(ctx, side, llms[side])));
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
          llm: llms[side],
          mc: { host: env.MC_HOST, port: env.MC_PORT, version: env.MC_VERSION },
          tickMs: env.AGENT_TICK_MS,
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

      const now = Date.now();
      // Con el límite de tiempo apagado no hay hora de término.
      const seconds = this.durationSeconds();
      // La cuenta regresiva se borra en la misma actualización que cambia la fase.
      this.state.phase = "running";
      this.state.countdownEndsAt = null;
      this.state.startedAt = now;
      this.state.endsAt = seconds === null ? null : now + seconds * 1000;
      this.record(ctx, { type: "phase", at: now, phase: "running" });
      for (const side of SIDES) {
        // Recién curados y teletransportados: se parte con vida completa.
        this.state.agents[side].alive = true;
        this.state.agents[side].health = 20;
        this.state.agents[side].damageDealt = 0;
        ctx.absorption[side] = 0;
      }
      if (seconds !== null) {
        ctx.timer = setTimeout(() => {
          void this.onTimeout(ctx);
        }, seconds * 1000);
      } else if (env.MATCH_MAX_SECONDS > 0) {
        ctx.timer = setTimeout(() => {
          void this.onCeiling(ctx);
        }, env.MATCH_MAX_SECONDS * 1000);
      }
      for (const side of SIDES) ctx.fighters[side]?.start();
      this.deps.hub.flushState();
      this.log(ctx, "info", "¡Comienza la pelea!");
    } catch (err) {
      if (ctx.ended || err instanceof CancelledError) return;
      this.log(ctx, "error", `No se pudo completar la pelea: ${errorMessage(err)}`);
      await this.finish(ctx, { winner: null, reason: "error" });
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
        a.decisions += 1;
        ctx.thoughtPending[side] = true;
        this.emit(ctx, { type: "thought", at: Date.now(), side, text: truncate(text, 2000) });
        hub.markStateDirty();
        // Modo "leen la mente": el rival recibe este razonamiento en su próxima observación.
        if (this.state.settings.comms === "thoughts") ctx.fighters[otherSide(side)]?.hear("thought", text);
      },
      onMessage: (text) => {
        if (!live() || this.state.settings.comms !== "chat") return;
        // Solo el tope de largo, por si acaso: el agente ya lo entrega limpio y recortado
        // igual (por punto de código), así que un mensaje nunca se corta dos veces. Sin
        // filtros por contenido, por frecuencia ni por repetición.
        const message = cutCodePoints(text, MAX_AGENT_MESSAGE_LENGTH);
        this.emit(ctx, { type: "message", at: Date.now(), side, text: message });
        ctx.fighters[otherSide(side)]?.hear("message", message);
      },
      onAction: (tool, args, result) => {
        if (!live()) return;
        const a = agent();
        // Una acción sin pensamiento previo también es una decisión del LLM.
        if (ctx.thoughtPending[side]) ctx.thoughtPending[side] = false;
        else a.decisions += 1;
        a.lastAction = formatAction(tool, args, result);
        this.emit(ctx, { type: "action", at: Date.now(), side, tool, args, result: truncate(result, 1000) });
        hub.markStateDirty();
      },
      onDecision: (d) => {
        if (!live()) return;
        this.recordDecision(ctx, side, d);
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
        this.emit(ctx, { type: "damage", at: Date.now(), side, amount, health });
        hub.markStateDirty();
      },
      onDeath: () => {
        if (!fighting()) return;
        this.handleDeath(ctx, side);
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
    void this.finish(ctx, resultForDeath(side));
  }

  /** Lo que dura esta pelea, en segundos; null si se pelea sin límite de tiempo. */
  private durationSeconds(): number | null {
    return this.state.settings.timer ? this.deps.env.MATCH_DURATION_SECONDS : null;
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
    await this.finish(
      ctx,
      decideTimeoutResult({ ...red, absorption: ctx.absorption.red }, { ...blue, absorption: ctx.absorption.blue }),
    );
  }

  /** Único camino de salida de una pelea. Nunca lanza. */
  private async finish(ctx: MatchContext, result: MatchResult): Promise<void> {
    if (ctx.ended) return;
    ctx.ended = true;
    if (ctx.timer) clearTimeout(ctx.timer);
    ctx.timer = null;
    // Si falló antes de crear a los agentes, "start" va igual primero.
    this.recordStart(ctx);

    let record: MatchRecord | null = null;
    try {
      const endedAt = Date.now();
      const reachedRunning = this.state.startedAt !== null;
      const startedAt = this.state.startedAt ?? ctx.createdAt;
      this.state.phase = "finished";
      // Si la pelea se canceló o falló en plena cuenta regresiva, ya no hay nada que contar.
      this.state.countdownEndsAt = null;
      this.state.result = result;
      this.deps.hub.flushState();
      this.record(ctx, { type: "phase", at: endedAt, phase: "finished" });

      // Foto final ANTES de desconectar (al reaparecer el perdedor vuelve a 20 de vida).
      record = {
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
        // Los bloques que colocaron los peleadores se borran sin esperar: un RCON lento no
        // debe retrasar el cierre (y la próxima pelea igual reconstruye la arena).
        void clearPlacedBlocks(this.deps.rcon).catch((err: unknown) => {
          this.deps.log("warn", `No se pudieron borrar los bloques colocados en la arena: ${errorMessage(err)}`);
        });
      }
      this.log(ctx, result.reason === "error" ? "error" : "info", describeResult(result));
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
