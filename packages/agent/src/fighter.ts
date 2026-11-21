import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { ARENA } from "@phack/protocol";
import type { ChatMessage, LlmResponse, TokenUsage, ToolDef } from "@phack/llm";
import { computeAim, estimateVelocity, PEARL_LAUNCH_HEIGHT, pearlPitch, type VelocitySample } from "./aim";
import { clampToArena, distance3, retreatTarget, round1, wallCells, type Vec3Like } from "./geometry";
import { buildTurnMessages, MAX_HISTORY_MESSAGES, trimHistory } from "./history";
import {
  ALWAYS_EDIBLE,
  attackCooldownMs,
  FOOD_NAMES,
  isArrow,
  isAxe,
  isBow,
  isBuildBlock,
  isPearl,
  isSword,
} from "./items";
import { buildObservation, type Observation } from "./observation";
import { buildSystemPrompt } from "./prompt";
import {
  BUILD_COOLDOWN_MS,
  isToolName,
  kitToolDefs,
  kitToolNames,
  parseToolArgs,
  PEARL_COOLDOWN_MS,
  PEARL_MIN_HEALTH,
  type ParsedToolArgs,
  type PearlTarget,
  type ToolName,
} from "./tools";
import type { DecisionReport, Fighter, FighterOptions } from "./types";

// mineflayer y mineflayer-pathfinder son CommonJS puro. Se cargan con createRequire
// (en vez de import ESM) para no depender de la detección de exports con nombre de
// Node; los tipos salen de sus .d.ts mediante `typeof import(...)`.
const requireCjs = createRequire(import.meta.url);
const mineflayer = requireCjs("mineflayer") as typeof import("mineflayer");
const { pathfinder, Movements, goals } = requireCjs("mineflayer-pathfinder") as typeof import("mineflayer-pathfinder");

type Entity = NonNullable<Bot["players"][string]["entity"]>;
type Vec3 = Entity["position"];

type Mode = ToolName;
type GoalKind = "none" | "follow" | "point" | "center";
type HeldState = "held" | "pending" | "missing";

const CONNECT_TIMEOUT_MS = 30_000;
/** Máximo de razonamientos o mensajes del rival que se juntan entre dos decisiones. */
const INBOX_MAX = 4;
/** Largo máximo de cada uno al pasarlo a la observación. */
const INBOX_TEXT_MAX = 300;
const LLM_TIMEOUT_MS = 20_000;
const BODY_TICK_MS = 100;
const MELEE_REACH = 3.2;
const FOLLOW_RANGE = 2;
const BOW_CHARGE_MS = 1100;
const BOW_PAUSE_MS = 250;
const EAT_MS = 1800;
const RETREAT_REPLAN_MS = 400;
const EYE_HEIGHT = 1.62;

/** Altura de los pies de un luchador parado en el piso de la arena. */
const FLOOR_Y = ARENA.center.y + 1;
/** Radio dentro del que caen las perlas: deja margen con el muro de la arena. */
const SAFE_RADIUS = ARENA.radius - 1.5;
/** Plazo para que un ítem de un solo uso (perla, bloques) llegue a la mano. */
const EQUIP_TIMEOUT_MS = 1000;

/**
 * El servidor lanza la perla hacia donde miraba el bot en el ÚLTIMO paquete de mirada que
 * recibió, y ese paquete sale recién en el siguiente tick de física (50 ms). Por eso se
 * espera este tiempo entre apuntar y lanzar.
 */
const PEARL_AIM_DELAY_MS = 150;
/** Una perla vuela menos de 1 segundo; pasado este plazo se da por perdida. */
const PEARL_FLIGHT_TIMEOUT_MS = 1500;
/** Con el rival más cerca que esto la perla no sirve: se llega antes caminando. */
const PEARL_MIN_DISTANCE = 4;
/** Sobre esta altura respecto del piso no se lanza: la perla podría pasar el muro. */
const PEARL_MAX_HEIGHT = 1.5;
/** Cuánto se adelanta el movimiento del rival al apuntar la perla (segundos). */
const PEARL_LEAD_S = 0.35;
/** Tope de la velocidad del rival que se usa para adelantar la perla (bloques/s). */
const PEARL_MAX_LEAD_SPEED = 8;
/** Cuántos bloques se intenta alejar del rival con una perla de escape. */
const PEARL_AWAY_STEP = 12;
/** Tras aterrizar, la primera baja de vida dentro de este plazo es el golpe de la caída. */
const SELF_DAMAGE_WINDOW_MS = 600;

/** Tiempo máximo colocando bloques de un muro. */
const BUILD_TIMEOUT_MS = 2500;
/** Espera máxima por cada bloque (mineflayer espera hasta 5 s si el servidor no responde). */
const BUILD_PLACE_TIMEOUT_MS = 700;
/** Con el centro de una celda a menos de esto de un luchador (en X y en Z), el bloque no cabe. */
const BUILD_CLEARANCE = 0.8;

const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Segundos que faltan para `readyAt`, con un decimal y nunca 0 (para los textos de recarga). */
function secondsLeft(readyAt: number, now: number): number {
  return Math.max(0.1, round1((readyAt - now) / 1000));
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Nombre del ítem en la mano principal ("" si está vacía o el bot aún no tiene inventario). */
function heldItemName(bot: Bot | null): string {
  const name = bot?.heldItem?.name;
  return typeof name === "string" ? name : "";
}

/** El cliente LLM puede ser cualquiera: solo se reenvía un consumo con números válidos. */
function validUsage(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const { inputTokens, outputTokens } = usage as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  return ok(inputTokens) && ok(outputTokens) ? { inputTokens, outputTokens } : undefined;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(errorText(err));
}

/**
 * Vida del rival. Mineflayer no siempre la expone para otros jugadores: se prueba
 * `entity.health` y, si no, el metadato 9 (vida de LivingEntity en 1.20.x).
 */
function readEntityHealth(entity: Entity): number | null {
  const direct = (entity as unknown as { health?: unknown }).health;
  if (typeof direct === "number" && Number.isFinite(direct)) return round1(direct);
  const metadata = (entity as unknown as { metadata?: unknown }).metadata;
  if (Array.isArray(metadata)) {
    const value: unknown = metadata[9];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1024) return round1(value);
  }
  return null;
}

class MineflayerFighter implements Fighter {
  private bot: Bot | null = null;
  private readonly systemPrompt: string;
  /** Herramientas del kit: lo único que se le ofrece al LLM y lo único que se ejecuta. */
  private readonly toolNames: ToolName[];
  private readonly toolDefs: ToolDef[];

  // Ciclo de vida
  private stopped = false;
  private started = false;
  private spawnedOnce = false;
  private connected = false;
  private ended = false;
  private alive = false;
  private lastHealth = 20;
  /** Último ítem en la mano que se informó en onStatus (para no repetir estados iguales). */
  private lastHeldItem = "";
  private connectPromise: Promise<void> | null = null;
  private settleConnect: ((err?: Error) => void) | null = null;
  private stopPromise: Promise<void> | null = null;

  // Bucle de decisiones
  private history: ChatMessage[] = [];
  private llmAbort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private wakeSleep: (() => void) | null = null;
  private startedAt = Date.now();
  /** Lo que llegó del rival y todavía no vio el LLM (se vacía al armar la observación). */
  private rivalThoughts: string[] = [];
  private rivalMessages: string[] = [];

  // Cuerpo (máquina de estados que corre cada BODY_TICK_MS)
  private bodyTimer: ReturnType<typeof setInterval> | null = null;
  private mode: Mode = "wait";
  private modeUntil: number | null = null;
  private lastResult = "todavía no has hecho nada";
  private goalKind: GoalKind = "none";
  private followTarget: Entity | null = null;
  private lastAttackAt = 0;
  private hits = 0;
  private shots = 0;
  private using = false;
  private useStartedAt = 0;
  private nextShotAt = 0;
  private equipBusy = false;
  private lastRetreatPlanAt = 0;
  private opponentSample: VelocitySample | null = null;
  private opponentVelocity: Vec3Like = { x: 0, y: 0, z: 0 };
  /** Nombre del ítem en la mano la última vez que cambió (para reiniciar la recarga del arma). */
  private weaponInHand = "";
  /** Aviso que antecede al resultado de "attack" (cómo se llegó a atacar); se borra al cambiar de acción. */
  private attackNote = "";
  /** Momento en que partió la acción de un solo uso en curso (perla o muro). */
  private oneShotStartedAt = 0;

  // Perla de ender: equipar -> apuntar -> esperar la mirada -> lanzar -> esperar el aterrizaje.
  private pearlTarget: PearlTarget = "rival";
  /** 0 = todavía no se apunta. */
  private pearlAimedAt = 0;
  /** 0 = todavía no se lanza. */
  private pearlThrownAt = 0;
  /** Momento del último aterrizaje de una perla propia. */
  private pearlLandedAt = 0;
  /** Hasta cuándo un teletransporte forzado se atribuye a una perla propia en vuelo. */
  private pearlFlightUntil = 0;
  private pearlReadyAt = 0;
  /** Hasta cuándo una baja de vida se atribuye a la caída de la perla y no al rival. */
  private selfDamageUntil = 0;

  // Muro: la colocación corre en una cadena asíncrona aparte del tick del cuerpo.
  private buildBusy = false;
  /** Sube cada vez que se sale de un modo; una cadena de otra generación se detiene sola. */
  private buildGeneration = 0;
  private buildReadyAt = 0;

  constructor(private readonly opts: FighterOptions) {
    const kit = opts.kit;
    this.toolNames = kitToolNames(kit);
    this.toolDefs = kitToolDefs(kit, opts.comms);
    this.systemPrompt = buildSystemPrompt({
      side: opts.side,
      username: opts.username,
      opponentUsername: opts.opponentUsername,
      kit,
      strategy: opts.prompt,
      tickMs: opts.tickMs,
      durationSeconds: opts.durationSeconds,
      comms: opts.comms,
    });
  }

  hear(kind: "thought" | "message", text: string): void {
    if (this.stopped) return;
    // Cada modo solo deja pasar lo suyo (el orquestador ya filtra; esto es la segunda llave).
    if (kind === "thought" && this.opts.comms !== "thoughts") return;
    if (kind === "message" && this.opts.comms !== "chat") return;
    const clean = text.trim().replace(/\s+/g, " ").slice(0, INBOX_TEXT_MAX);
    if (clean.length === 0) return;
    const box = kind === "thought" ? this.rivalThoughts : this.rivalMessages;
    box.push(clean);
    // Si el agente se demora en decidir, se queda con lo más nuevo.
    if (box.length > INBOX_MAX) box.splice(0, box.length - INBOX_MAX);
  }

  // ------------------------------------------------------------------
  // API pública
  // ------------------------------------------------------------------

  connect(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error(`El luchador ${this.opts.username} ya fue detenido`));
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settle(new Error(`Tiempo de espera agotado al conectar ${this.opts.username} al servidor de Minecraft`));
      }, CONNECT_TIMEOUT_MS);
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.settleConnect = null;
        if (err) {
          this.quitQuietly();
          reject(err);
        } else {
          resolve();
        }
      };
      this.settleConnect = settle;

      try {
        const bot = mineflayer.createBot({
          host: this.opts.mc.host,
          port: this.opts.mc.port,
          username: this.opts.username,
          version: this.opts.mc.version,
          auth: "offline",
          hideErrors: true,
        });
        this.bot = bot;
        bot.loadPlugin(pathfinder);
        this.attachListeners(bot);
      } catch (err) {
        settle(toError(err));
      }
    });
    return this.connectPromise;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.startedAt = Date.now();
    this.bodyTimer = setInterval(() => {
      try {
        this.bodyTick();
      } catch (err) {
        this.log("warn", `Error en el cuerpo del agente: ${errorText(err)}`);
      }
    }, BODY_TICK_MS);
    this.loopPromise = this.runLoop().catch((err) => {
      this.log("error", `El bucle de decisiones terminó con error: ${errorText(err)}`);
    });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.doStop().catch(() => undefined);
    return this.stopPromise;
  }

  // ------------------------------------------------------------------
  // Ciclo de vida
  // ------------------------------------------------------------------

  private async doStop(): Promise<void> {
    try {
      this.llmAbort?.abort();
    } catch {
      // nada
    }
    if (this.wakeSleep) this.wakeSleep();
    if (this.bodyTimer) {
      clearInterval(this.bodyTimer);
      this.bodyTimer = null;
    }

    const bot = this.bot;
    if (bot) {
      try {
        this.leaveMode(bot);
      } catch {
        // nada
      }
      if (!this.ended && !this.alive && this.spawnedOnce) {
        // Murió recién: stop() suele llamarse DENTRO del evento "death" de mineflayer,
        // antes de que este envíe el paquete de reaparición. Si se desconecta ahora, el
        // servidor guarda al jugador muerto y la próxima pelea parte con una muerte falsa.
        // Esta pausa deja que mineflayer reaparezca solo (opción respawn, activa por defecto).
        await new Promise<void>((resolve) => setTimeout(resolve, 400));
      }
      if (!this.ended) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          bot.once("end", () => {
            clearTimeout(timer);
            resolve();
          });
          try {
            bot.quit("fin de la pelea");
          } catch {
            clearTimeout(timer);
            resolve();
          }
        });
      }
    }

    if (this.settleConnect) this.settleConnect(new Error(`El luchador ${this.opts.username} fue detenido`));

    if (this.loopPromise) {
      // No esperar para siempre si el cliente LLM ignora la señal de aborto.
      await Promise.race([this.loopPromise, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
    }
  }

  private quitQuietly(): void {
    const bot = this.bot;
    if (!bot || this.ended) return;
    try {
      bot.quit("desconexión");
    } catch {
      // nada
    }
  }

  private attachListeners(bot: Bot): void {
    // Importante: siempre debe existir un listener de "error" o Node bota el proceso.
    bot.on("error", (err) => {
      if (!this.stopped) this.log("error", `Error de conexión de ${this.opts.username}: ${errorText(err)}`);
      if (this.settleConnect) this.settleConnect(toError(err));
    });

    bot.on("kicked", (reason) => {
      if (!this.stopped) this.log("error", `${this.opts.username} fue expulsado del servidor: ${errorText(reason)}`);
    });

    bot.on("end", (reason) => {
      this.ended = true;
      this.connected = false;
      this.alive = false;
      this.using = false;
      this.goalKind = "none";
      this.followTarget = null;
      if (this.settleConnect) {
        this.settleConnect(new Error(`Conexión cerrada antes de entrar al mundo (${errorText(reason)})`));
      }
      if (!this.stopped) {
        this.log("warn", `${this.opts.username} se desconectó (${errorText(reason)})`);
        this.emitStatus();
      }
    });

    bot.on("spawn", () => {
      this.guard("spawn", () => {
        this.connected = true;
        this.alive = true;
        if (typeof bot.health === "number" && Number.isFinite(bot.health)) this.lastHealth = bot.health;
        if (!this.spawnedOnce) {
          this.spawnedOnce = true;
          this.setupMovements(bot);
          this.log("info", `${this.opts.username} entró al mundo`);
        } else {
          this.resetBody("reapareciste después de morir");
        }
        this.emitStatus();
        if (this.settleConnect) this.settleConnect();
      });
    });

    bot.on("health", () => {
      this.guard("health", () => {
        const health = bot.health;
        if (typeof health !== "number" || !Number.isFinite(health)) return;
        if (this.alive && health < this.lastHealth && !this.stopped) {
          const amount = round1(this.lastHealth - health);
          const rounded = round1(health);
          // La caída de la perla propia es una sola baja de vida, justo después de
          // aterrizar: la ventana se consume con ella para no quitarle golpes al rival.
          const bySelf = Date.now() < this.selfDamageUntil;
          this.selfDamageUntil = 0;
          this.safe(() => this.opts.events.onDamageTaken(amount, rounded, bySelf));
        }
        this.lastHealth = health;
        this.emitStatus();
      });
    });

    // Equipar espada/arco, empezar a comer o gastar la última comida cambian la mano.
    // mineflayer emite este evento con cada actualización del slot (también si solo cambia
    // la cantidad), así que se informa solo cuando cambia el NOMBRE del ítem. Antes del
    // "spawn" no se informa: el inventario llega antes y el estado diría "desconectado".
    bot.on("heldItemChanged", () => {
      this.guard("heldItemChanged", () => {
        const name = heldItemName(bot);
        if (name !== this.weaponInHand) {
          // El servidor reinicia la fuerza del golpe al cambiar de ítem: si se pega de
          // inmediato el golpe sale débil, así que la recarga parte de nuevo.
          this.weaponInHand = name;
          this.lastAttackAt = Date.now();
        }
        if (this.connected && name !== this.lastHeldItem) this.emitStatus();
      });
    });

    // El servidor movió al bot a la fuerza. Si hay una perla propia en vuelo, es su
    // aterrizaje. El listener es global (no del modo "pearl") porque el teletransporte
    // ocurre igual aunque el LLM ya haya elegido otra acción.
    bot.on("forcedMove", () => {
      this.guard("forcedMove", () => {
        const now = Date.now();
        if (now >= this.pearlFlightUntil) return;
        this.pearlFlightUntil = 0;
        this.pearlLandedAt = now;
        this.selfDamageUntil = now + SELF_DAMAGE_WINDOW_MS;
        // La ruta del pathfinder y la velocidad estimada del rival quedaron viejas.
        this.goalKind = "none";
        this.followTarget = null;
        this.opponentSample = null;
        this.opponentVelocity = { x: 0, y: 0, z: 0 };
        bot.pathfinder.setGoal(null);
      });
    });

    bot.on("death", () => {
      this.guard("death", () => {
        this.alive = false;
        this.using = false;
        this.resetBody("moriste");
        if (!this.stopped) this.safe(() => this.opts.events.onDeath());
        this.emitStatus();
      });
    });
  }

  private setupMovements(bot: Bot): void {
    try {
      const movements = new Movements(bot);
      movements.canDig = false;
      movements.allow1by1towers = false;
      movements.allowParkour = false;
      // Sin andamios: por defecto el pathfinder pone tierra o piedra para abrirse camino, y
      // los bloques del kit son solo para la herramienta "build".
      movements.scafoldingBlocks = [];
      bot.pathfinder.setMovements(movements);
    } catch (err) {
      this.log("warn", `No se pudo configurar el pathfinder: ${errorText(err)}`);
    }
  }

  // ------------------------------------------------------------------
  // Utilidades de eventos
  // ------------------------------------------------------------------

  /** Llama a un callback del consumidor sin dejar que una excepción suya nos bote. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // Los errores del consumidor no son problema del agente.
    }
  }

  private guard(where: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log("warn", `Error manejando el evento "${where}": ${errorText(err)}`);
    }
  }

  private log(level: "info" | "warn" | "error", text: string): void {
    if (this.stopped) return;
    this.safe(() => this.opts.events.onLog(level, text));
  }

  private emitStatus(): void {
    if (this.stopped) return;
    const bot = this.bot;
    const health = bot && typeof bot.health === "number" && Number.isFinite(bot.health) ? bot.health : 0;
    const food = bot && typeof bot.food === "number" && Number.isFinite(bot.food) ? bot.food : 0;
    const heldItem = heldItemName(bot);
    this.lastHeldItem = heldItem;
    const status = {
      connected: this.connected,
      alive: this.alive,
      health: this.alive ? round1(health) : 0,
      food: round1(food),
      heldItem,
    };
    this.safe(() => this.opts.events.onStatus(status));
  }

  // ------------------------------------------------------------------
  // Bucle de decisiones (nunca hay dos llamadas al LLM a la vez: es secuencial)
  // ------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const tickStart = Date.now();
      try {
        await this.decide();
      } catch (err) {
        this.log("error", `Error en la decisión: ${errorText(err)}`);
      }
      if (this.stopped) break;
      const remaining = Math.max(50, this.opts.tickMs - (Date.now() - tickStart));
      await this.sleep(remaining);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.wakeSleep === done) this.wakeSleep = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeSleep = done;
    });
  }

  private async decide(): Promise<void> {
    const bot = this.bot;
    if (!bot || !this.connected || !this.alive) return;

    const observation = this.observe(bot);
    const observationJson = JSON.stringify(observation);
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...this.history,
      { role: "user", content: observationJson },
    ];

    const abort = new AbortController();
    this.llmAbort = abort;
    const timeout = setTimeout(() => abort.abort(), LLM_TIMEOUT_MS);
    const llmStartedAt = Date.now();
    let response: LlmResponse;
    try {
      response = await this.opts.llm.complete({ messages, tools: this.toolDefs, signal: abort.signal });
    } catch (err) {
      if (!this.stopped) this.log("warn", `Falló la llamada al LLM (se mantiene la acción actual): ${errorText(err)}`);
      return;
    } finally {
      clearTimeout(timeout);
      if (this.llmAbort === abort) this.llmAbort = null;
    }
    if (this.stopped) return;

    // Latencia y tokens de la llamada: se informan antes de actuar, una vez por respuesta.
    const report: DecisionReport = { ms: Date.now() - llmStartedAt };
    const usage = validUsage(response.usage);
    if (usage) report.usage = usage;
    this.safe(() => this.opts.events.onDecision(report));

    const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    const text = typeof response.text === "string" ? response.text : "";
    const normalized: LlmResponse = { text, toolCalls };
    const first = toolCalls[0];

    let firstResult = "";
    if (first) {
      const args: Record<string, unknown> =
        first.args && typeof first.args === "object" ? first.args : {};
      const parsed = parseToolArgs(args);
      const thought = parsed.reason ?? text.trim();
      if (thought.length > 0) this.safe(() => this.opts.events.onThought(thought));
      const said = this.opts.comms === "chat" ? parsed.say : null;
      if (said) this.safe(() => this.opts.events.onMessage(said));

      try {
        firstResult = this.executeTool(first.name, parsed);
      } catch (err) {
        firstResult = `error al ejecutar la acción: ${errorText(err)}`;
        this.log("warn", `Error ejecutando "${first.name}": ${errorText(err)}`);
      }
      const result = firstResult;
      this.safe(() => this.opts.events.onAction(first.name, args, result));
    } else {
      if (text.trim().length > 0) this.safe(() => this.opts.events.onThought(text.trim()));
      this.log("warn", "El LLM respondió sin elegir una herramienta; se mantiene la acción actual");
    }

    const turn = buildTurnMessages(observationJson, normalized, (index) =>
      index === 0 ? firstResult : "ignorada: solo se ejecuta una acción por turno",
    );
    this.history = trimHistory([...this.history, ...turn], MAX_HISTORY_MESSAGES);
  }

  private observe(bot: Bot): Observation {
    const opponent = this.opponent(bot);
    const held = bot.heldItem;
    return buildObservation({
      now: Date.now(),
      startedAt: this.startedAt,
      self: {
        position: bot.entity.position,
        health: typeof bot.health === "number" && Number.isFinite(bot.health) ? bot.health : 0,
        food: typeof bot.food === "number" && Number.isFinite(bot.food) ? bot.food : 0,
        heldItem: held ? held.name : null,
        inventory: bot.inventory.items().map((item) => ({ name: item.name, count: item.count })),
      },
      opponent: opponent ? { position: opponent.position, health: readEntityHealth(opponent) } : null,
      arena: { center: ARENA.center, radius: ARENA.radius },
      currentAction: this.mode,
      lastActionResult: this.lastResult,
      pearlReadyAt: this.pearlReadyAt,
      buildReadyAt: this.buildReadyAt,
      rivalThoughts: this.rivalThoughts.splice(0),
      rivalMessages: this.rivalMessages.splice(0),
    });
  }

  // ------------------------------------------------------------------
  // Ejecución de herramientas: solo cambian el modo del cuerpo
  // ------------------------------------------------------------------

  private executeTool(name: string, args: ParsedToolArgs): string {
    const bot = this.bot;
    if (!bot || !this.connected) return "no estás conectado al servidor";
    if (!this.alive) return "estás muerto";
    const available = this.toolNames.join(", ");
    if (!isToolName(name)) return `herramienta desconocida "${name}"; usa: ${available}`;
    // El LLM solo recibe las herramientas de su kit, pero puede inventar una de otro.
    if (!this.toolNames.includes(name)) return `tu kit no tiene esa herramienta; usa: ${available}`;

    const now = Date.now();
    if (name === this.mode) {
      // Repetir la herramienta continúa la acción en curso (no reinicia cargas ni comidas).
      if (name === "attack") this.modeUntil = args.seconds !== null ? now + args.seconds * 1000 : null;
      const text = `continúas con "${name}": ${this.lastResult}`;
      // El aviso de cómo empezó el ataque ya llegó al LLM en este texto: no se repite.
      this.attackNote = "";
      return text;
    }

    const opponent = this.opponent(bot);
    const items = bot.inventory.items();
    const has = (match: (itemName: string) => boolean): boolean => items.some((item) => match(item.name));

    let result = "";
    switch (name) {
      case "approach":
        result = opponent
          ? `avanzando hacia el rival (distancia ${round1(distance3(bot.entity.position, opponent.position))})`
          : "rival no visible; avanzando al centro de la arena";
        break;
      case "attack":
        result = has(isSword)
          ? "atacando cuerpo a cuerpo con la espada"
          : has(isAxe)
            ? "atacando cuerpo a cuerpo con el hacha"
            : "atacando cuerpo a cuerpo sin arma";
        break;
      case "retreat":
        result = opponent ? "alejándote del rival" : "rival no visible; te quedas donde estás";
        break;
      case "shoot":
        if (!has(isBow)) return this.enterWait(bot, "no puedes disparar: no tienes arco");
        if (!has(isArrow)) return this.enterWait(bot, "no puedes disparar: no te quedan flechas");
        result = opponent ? "cargando el arco" : "rival no visible; esperando para apuntar";
        break;
      case "eat": {
        const food = items.find((item) => this.isFood(bot, item.name));
        if (!food) return this.enterWait(bot, "no puedes comer: no tienes comida");
        if (bot.food >= 20 && !items.some((item) => ALWAYS_EDIBLE.has(item.name))) {
          return this.enterWait(bot, "no puedes comer: no tienes hambre (comida 20/20)");
        }
        result = "empezando a comer";
        break;
      }
      case "pearl": {
        // Si la perla no se puede usar, no se gasta nada y la acción en curso sigue.
        const refusal = this.pearlRefusal(bot, opponent, args.target, now);
        if (refusal) return `${refusal}; sigues con "${this.mode}"`;
        result =
          args.target === "away" ? "preparando la perla para alejarte del rival" : "preparando la perla para caer junto al rival";
        break;
      }
      case "build": {
        const refusal = this.buildRefusal(bot, opponent, now);
        if (refusal) return `${refusal}; sigues con "${this.mode}"`;
        result = "preparando los bloques para el muro";
        break;
      }
      case "wait":
        result = "esperando quieto";
        break;
    }

    this.leaveMode(bot);
    this.mode = name;
    this.modeUntil = name === "attack" && args.seconds !== null ? now + args.seconds * 1000 : null;
    this.hits = 0;
    this.shots = 0;
    this.nextShotAt = 0;
    this.lastRetreatPlanAt = 0;
    this.oneShotStartedAt = now;
    this.pearlTarget = args.target;
    this.pearlAimedAt = 0;
    this.pearlThrownAt = 0;
    this.lastResult = result;
    return result;
  }

  /** Por qué no se puede lanzar la perla ahora, o null si se puede. */
  private pearlRefusal(bot: Bot, opponent: Entity | null, target: PearlTarget, now: number): string | null {
    if (this.countItems(bot, isPearl) === 0) return "no puedes usar la perla: no te quedan perlas";
    if (now < this.pearlReadyAt) return `la perla está en recarga: faltan ${secondsLeft(this.pearlReadyAt, now)} s`;
    if (bot.health <= PEARL_MIN_HEALTH) return "no puedes usar la perla: te queda muy poca vida (caer quita ~2.5)";
    if (bot.entity.position.y - FLOOR_Y > PEARL_MAX_HEIGHT) return "no puedes usar la perla desde altura";
    if (target === "rival") {
      if (!opponent) return "no ves al rival: no hay hacia dónde lanzar la perla";
      const dist = round1(distance3(bot.entity.position, opponent.position));
      if (dist < PEARL_MIN_DISTANCE) return `el rival ya está a ${dist} bloques: usa attack`;
    }
    return null;
  }

  /** Por qué no se puede construir ahora, o null si se puede. */
  private buildRefusal(bot: Bot, opponent: Entity | null, now: number): string | null {
    if (this.countItems(bot, isBuildBlock) === 0) return "no te quedan bloques";
    if (now < this.buildReadyAt) return `todavía no puedes construir: faltan ${secondsLeft(this.buildReadyAt, now)} s`;
    if (!opponent) return "no ves al rival: no hay dónde poner el muro";
    return null;
  }

  private enterWait(bot: Bot, result: string): string {
    this.leaveMode(bot);
    this.mode = "wait";
    this.modeUntil = null;
    this.lastResult = result;
    return result;
  }

  /** Limpia lo que el modo actual dejó a medias (uso de ítem, ruta del pathfinder, muro a medio poner). */
  private leaveMode(bot: Bot): void {
    if (this.using) {
      this.using = false;
      try {
        bot.deactivateItem();
      } catch {
        // nada
      }
    }
    this.buildGeneration++;
    this.attackNote = "";
    this.clearGoal(bot);
  }

  /** Vuelve a "wait" sin tocar al bot (para muerte / reaparición). */
  private resetBody(result: string): void {
    this.mode = "wait";
    this.modeUntil = null;
    this.using = false;
    this.buildGeneration++;
    this.attackNote = "";
    // Un teletransporte después de morir es la reaparición, no una perla.
    this.pearlFlightUntil = 0;
    this.selfDamageUntil = 0;
    this.lastResult = result;
    const bot = this.bot;
    if (bot && !this.ended) {
      try {
        this.clearGoal(bot);
      } catch {
        this.goalKind = "none";
        this.followTarget = null;
      }
    }
  }

  // ------------------------------------------------------------------
  // Cuerpo: se ejecuta cada BODY_TICK_MS, independiente del LLM
  // ------------------------------------------------------------------

  private bodyTick(): void {
    const bot = this.bot;
    if (!bot || this.stopped || !this.connected || !this.alive || !bot.entity) return;

    const now = Date.now();
    const opponent = this.opponent(bot);
    this.trackOpponent(opponent, now);

    if (this.modeUntil !== null && now >= this.modeUntil) {
      this.enterWait(bot, `terminó el tiempo de "${this.mode}" (${this.lastResult})`);
    }

    switch (this.mode) {
      case "approach":
        this.tickApproach(bot, opponent);
        break;
      case "attack":
        this.tickAttack(bot, opponent, now);
        break;
      case "retreat":
        this.tickRetreat(bot, opponent, now);
        break;
      case "shoot":
        this.tickShoot(bot, opponent, now);
        break;
      case "eat":
        this.tickEat(bot, now);
        break;
      case "pearl":
        this.tickPearl(bot, opponent, now);
        break;
      case "build":
        this.tickBuild(bot, opponent, now);
        break;
      case "wait":
        this.clearGoal(bot);
        if (opponent) this.look(bot, opponent.position.offset(0, EYE_HEIGHT, 0));
        break;
    }
  }

  private tickApproach(bot: Bot, opponent: Entity | null): void {
    if (!opponent) {
      this.goToCenter(bot);
      this.lastResult = "rival no visible; avanzando al centro de la arena";
      return;
    }
    this.follow(bot, opponent);
    const dist = round1(distance3(bot.entity.position, opponent.position));
    this.lastResult = dist <= FOLLOW_RANGE + 0.5 ? `estás junto al rival (distancia ${dist})` : `avanzando hacia el rival (distancia ${dist})`;
  }

  private tickAttack(bot: Bot, opponent: Entity | null, now: number): void {
    if (!opponent) {
      this.goToCenter(bot);
      this.lastResult = "rival no visible; lo buscas en el centro de la arena";
      return;
    }
    // Preferir espada; si no hay, hacha; si no, a puño limpio.
    const items = bot.inventory.items();
    if (items.some((item) => isSword(item.name))) this.ensureHeld(bot, isSword);
    else if (items.some((item) => isAxe(item.name))) this.ensureHeld(bot, isAxe);

    this.follow(bot, opponent);
    const dist = distance3(bot.entity.position, opponent.position);
    if (dist <= MELEE_REACH) {
      this.look(bot, opponent.position.offset(0, EYE_HEIGHT, 0));
      // La recarga depende del arma que está en la mano (un hacha es más lenta que una espada).
      if (now - this.lastAttackAt >= attackCooldownMs(heldItemName(bot))) {
        this.lastAttackAt = now;
        bot.attack(opponent);
        this.hits++;
      }
    }
    const progress =
      this.hits > 0
        ? `atacando: ${this.hits} golpes lanzados (distancia ${round1(dist)})`
        : `persiguiendo al rival para golpear (distancia ${round1(dist)})`;
    this.lastResult = this.attackNote + progress;
  }

  private tickRetreat(bot: Bot, opponent: Entity | null, now: number): void {
    if (!opponent) {
      this.clearGoal(bot);
      this.lastResult = "rival no visible; te quedas donde estás";
      return;
    }
    if (now - this.lastRetreatPlanAt < RETREAT_REPLAN_MS) return;
    this.lastRetreatPlanAt = now;
    const self = bot.entity.position;
    const target = retreatTarget({ self, opponent: opponent.position, center: ARENA.center, radius: ARENA.radius });
    bot.pathfinder.setGoal(new goals.GoalNear(target.x, Math.floor(self.y), target.z, 1));
    this.goalKind = "point";
    this.followTarget = null;
    this.lastResult = `alejándote del rival (distancia ${round1(distance3(self, opponent.position))})`;
  }

  private tickShoot(bot: Bot, opponent: Entity | null, now: number): void {
    const items = bot.inventory.items();
    if (!items.some((item) => isArrow(item.name))) {
      this.enterWait(bot, `te quedaste sin flechas (disparaste ${this.shots})`);
      return;
    }
    const held = this.ensureHeld(bot, isBow);
    if (held === "missing") {
      this.enterWait(bot, "no puedes disparar: no tienes arco");
      return;
    }
    if (held === "pending") return;

    this.clearGoal(bot);
    if (!opponent) {
      this.lastResult = "rival no visible; esperando para apuntar";
      return;
    }

    const self = bot.entity.position;
    const aim = computeAim({
      from: { x: self.x, y: self.y + EYE_HEIGHT, z: self.z },
      target: { x: opponent.position.x, y: opponent.position.y + 0.9, z: opponent.position.z },
      targetVelocity: this.opponentVelocity,
    });
    this.look(
      bot,
      opponent.position.offset(aim.x - opponent.position.x, aim.y - opponent.position.y, aim.z - opponent.position.z),
    );

    if (!this.using) {
      if (now >= this.nextShotAt) {
        bot.activateItem();
        this.using = true;
        this.useStartedAt = now;
      }
      return;
    }
    if (now - this.useStartedAt >= BOW_CHARGE_MS) {
      bot.deactivateItem();
      this.using = false;
      this.shots++;
      this.nextShotAt = now + BOW_PAUSE_MS;
      this.lastResult = `flechas disparadas: ${this.shots} (distancia ${round1(distance3(self, opponent.position))})`;
    }
  }

  private tickEat(bot: Bot, now: number): void {
    if (this.using) {
      if (now - this.useStartedAt >= EAT_MS) {
        this.using = false;
        try {
          bot.deactivateItem();
        } catch {
          // nada
        }
        this.enterWait(bot, `terminaste de comer (comida ${round1(bot.food)}/20, vida ${round1(bot.health)}/20)`);
      }
      return;
    }
    // Con la barra de hambre llena el servidor solo deja comer ciertas comidas (manzana dorada).
    const full = bot.food >= 20;
    const held = this.ensureHeld(bot, (name) => (full ? ALWAYS_EDIBLE.has(name) : this.isFood(bot, name)));
    if (held === "missing") {
      this.enterWait(bot, "no puedes comer: no tienes comida");
      return;
    }
    if (held === "pending") return;
    this.clearGoal(bot);
    bot.activateItem();
    this.using = true;
    this.useStartedAt = now;
    this.lastResult = "comiendo (tarda unos 2 segundos)";
  }

  /**
   * Perla de ender, de un solo uso: equipar, apuntar, esperar a que la mirada llegue al
   * servidor, lanzar y esperar el aterrizaje (que avisa el listener de "forcedMove").
   * Si otra herramienta la interrumpe antes de lanzar, no se gasta nada.
   */
  private tickPearl(bot: Bot, opponent: Entity | null, now: number): void {
    if (this.pearlThrownAt > 0) {
      if (this.pearlLandedAt >= this.pearlThrownAt) this.finishPearl(bot, opponent);
      else if (now - this.pearlThrownAt >= PEARL_FLIGHT_TIMEOUT_MS) {
        this.enterWait(bot, "lanzaste la perla pero no te teletransportaste");
      }
      return;
    }

    const held = this.ensureHeld(bot, isPearl);
    if (held === "missing") {
      this.enterWait(bot, "no puedes usar la perla: no te quedan perlas");
      return;
    }
    // Quieto y sin ruta: el pathfinder gira la cabeza mientras camina y arruinaría la puntería.
    this.clearGoal(bot);
    if (held === "pending") {
      if (now - this.oneShotStartedAt >= EQUIP_TIMEOUT_MS) this.enterWait(bot, "no pudiste equipar la perla");
      return;
    }

    if (this.pearlAimedAt === 0) {
      const landing = this.pearlLanding(bot, opponent);
      if (!landing) {
        this.enterWait(bot, "no ves al rival: no lanzaste la perla");
        return;
      }
      const self = bot.entity.position;
      const dx = landing.x - self.x;
      const dz = landing.z - self.z;
      const pitch = pearlPitch(Math.hypot(dx, dz), self.y + PEARL_LAUNCH_HEIGHT - FLOOR_Y);
      bot.look(Math.atan2(-dx, -dz), pitch, true).catch(() => undefined);
      this.pearlAimedAt = now;
      this.lastResult = "apuntando la perla";
      return;
    }
    if (now - this.pearlAimedAt < PEARL_AIM_DELAY_MS) return;

    // No se marca `using`: la perla sale al instante y no hay nada que soltar después.
    bot.activateItem();
    this.pearlThrownAt = now;
    this.pearlReadyAt = now + PEARL_COOLDOWN_MS;
    this.pearlFlightUntil = now + 2 * PEARL_FLIGHT_TIMEOUT_MS;
    this.lastResult = "perla lanzada; esperando a que caiga";
  }

  /** Punto del piso donde debe caer la perla, siempre dentro de la arena. null = rival no visible. */
  private pearlLanding(bot: Bot, opponent: Entity | null): Vec3Like | null {
    const self = bot.entity.position;
    let point: Vec3Like;
    if (this.pearlTarget === "rival") {
      if (!opponent) return null;
      // Se adelanta un poco el movimiento del rival: la perla tarda en llegar.
      const speed = Math.hypot(this.opponentVelocity.x, this.opponentVelocity.z);
      const scale = speed > PEARL_MAX_LEAD_SPEED ? PEARL_MAX_LEAD_SPEED / speed : 1;
      point = {
        x: opponent.position.x + this.opponentVelocity.x * scale * PEARL_LEAD_S,
        y: FLOOR_Y,
        z: opponent.position.z + this.opponentVelocity.z * scale * PEARL_LEAD_S,
      };
    } else if (opponent) {
      point = retreatTarget({
        self,
        opponent: opponent.position,
        center: ARENA.center,
        radius: ARENA.radius,
        step: PEARL_AWAY_STEP,
      });
    } else {
      // Sin rival a la vista: al otro lado de la arena, pasando por el centro.
      point = { x: 2 * ARENA.center.x - self.x, y: FLOOR_Y, z: 2 * ARENA.center.z - self.z };
    }
    return clampToArena(point, ARENA.center, SAFE_RADIUS);
  }

  private finishPearl(bot: Bot, opponent: Entity | null): void {
    const where = opponent ? `distancia ${round1(distance3(bot.entity.position, opponent.position))}` : "no ves al rival";
    if (this.pearlTarget === "away") {
      const left = this.countItems(bot, isPearl);
      this.enterWait(bot, `te teletransportaste lejos del rival (${where}); te quedan ${left} perlas`);
      return;
    }
    // Cayó junto al rival: pasa directo a atacar, sin esperar la próxima decisión.
    this.mode = "attack";
    this.modeUntil = null;
    this.hits = 0;
    this.attackNote = `te teletransportaste junto al rival (${where}); `;
    this.lastResult = `${this.attackNote}atacando`;
  }

  /**
   * Muro, de un solo uso: equipa los bloques, se queda quieto y lanza la cadena que los
   * coloca. La cadena es asíncrona (cada bloque espera la respuesta del servidor), así
   * que corre aparte y este tick solo la prepara.
   */
  private tickBuild(bot: Bot, opponent: Entity | null, now: number): void {
    if (this.buildBusy) return;
    const held = this.ensureHeld(bot, isBuildBlock);
    if (held === "missing") {
      this.enterWait(bot, "no te quedan bloques");
      return;
    }
    this.clearGoal(bot);
    bot.clearControlStates();
    if (held === "pending") {
      if (now - this.oneShotStartedAt >= EQUIP_TIMEOUT_MS) this.enterWait(bot, "no pudiste equipar los bloques");
      return;
    }
    if (!opponent) {
      this.enterWait(bot, "no ves al rival: no hay dónde poner el muro");
      return;
    }

    const generation = ++this.buildGeneration;
    const before = this.countItems(bot, isBuildBlock);
    this.buildBusy = true;
    this.buildReadyAt = now + BUILD_COOLDOWN_MS;
    this.lastResult = "colocando los bloques del muro";
    this.placeWall(bot, wallCells(bot.entity.position, opponent.position), generation, now + BUILD_TIMEOUT_MS)
      .then((confirmed) => {
        // Si otra acción (o la muerte) cortó la construcción, no hay nada que informar.
        if (generation !== this.buildGeneration) return;
        const left = this.countItems(bot, isBuildBlock);
        // Un bloque puede quedar puesto aunque su confirmación llegue tarde: manda el inventario.
        const placed = Math.max(confirmed, before - left);
        this.enterWait(
          bot,
          placed > 0
            ? `muro de ${placed} bloques entre tú y el rival; te quedan ${left} bloques`
            : "no pudiste colocar ningún bloque (no hay espacio o el rival está encima)",
        );
      })
      .catch((err: unknown) => {
        this.log("warn", `Error al construir el muro: ${errorText(err)}`);
        if (generation === this.buildGeneration) this.enterWait(bot, "no pudiste terminar el muro");
      })
      .finally(() => {
        this.buildBusy = false;
      });
  }

  /** Coloca las celdas en orden y devuelve cuántas confirmó el servidor. */
  private async placeWall(bot: Bot, cells: Vec3Like[], generation: number, deadline: number): Promise<number> {
    const up = this.vec(bot, 0, 1, 0);
    let confirmed = 0;
    for (const cell of cells) {
      if (!this.buildActive(generation) || Date.now() >= deadline) break;
      const held = bot.heldItem;
      if (!held || !isBuildBlock(held.name)) break;

      const position = this.vec(bot, cell.x, cell.y, cell.z);
      const current = bot.blockAt(position);
      if (!current || !AIR_BLOCKS.has(current.name)) continue;
      if (this.cellOccupied(bot, cell)) continue;
      // El bloque se apoya en el de abajo: el piso para la fila baja, el muro para la alta.
      const below = bot.blockAt(position.offset(0, -1, 0));
      if (!below || below.boundingBox !== "block") continue;

      try {
        // Mirada forzada: placeBlock gira la cabeza de a poco si no está ya apuntando.
        await bot.lookAt(below.position.offset(0.5, 1, 0.5), true);
      } catch {
        continue;
      }
      if (!this.buildActive(generation)) break;
      // Un rechazo del servidor (celda ocupada) no corta el muro: se sigue con la siguiente.
      const placing = bot.placeBlock(below, up).then(
        () => true,
        () => false,
      );
      if (await Promise.race([placing, delay(BUILD_PLACE_TIMEOUT_MS).then(() => false)])) confirmed++;
    }
    return confirmed;
  }

  private buildActive(generation: number): boolean {
    return generation === this.buildGeneration && this.alive && !this.stopped && !this.ended;
  }

  /** Un bloque no se puede poner donde hay un luchador parado (ni el rival ni uno mismo). */
  private cellOccupied(bot: Bot, cell: Vec3Like): boolean {
    const near = (position: Vec3Like): boolean =>
      Math.abs(cell.x + 0.5 - position.x) < BUILD_CLEARANCE && Math.abs(cell.z + 0.5 - position.z) < BUILD_CLEARANCE;
    const opponent = this.opponent(bot);
    return near(bot.entity.position) || (opponent !== null && near(opponent.position));
  }

  // ------------------------------------------------------------------
  // Ayudas del cuerpo
  // ------------------------------------------------------------------

  private opponent(bot: Bot): Entity | null {
    const player = bot.players[this.opts.opponentUsername];
    const entity = player ? player.entity : null;
    return entity ?? null;
  }

  private trackOpponent(opponent: Entity | null, now: number): void {
    if (!opponent) {
      this.opponentSample = null;
      this.opponentVelocity = { x: 0, y: 0, z: 0 };
      return;
    }
    const sample: VelocitySample = { x: opponent.position.x, y: opponent.position.y, z: opponent.position.z, at: now };
    this.opponentVelocity = estimateVelocity(this.opponentSample, sample, this.opponentVelocity);
    this.opponentSample = sample;
  }

  private isFood(bot: Bot, name: string): boolean {
    const foods = (bot.registry as unknown as { foodsByName?: Record<string, unknown> }).foodsByName;
    if (foods && Object.prototype.hasOwnProperty.call(foods, name)) return true;
    return FOOD_NAMES.has(name);
  }

  /** Cuántas unidades hay en el inventario de los ítems que calzan con `match`. */
  private countItems(bot: Bot, match: (name: string) => boolean): number {
    let total = 0;
    for (const item of bot.inventory.items()) {
      if (match(item.name)) total += item.count;
    }
    return total;
  }

  /** Un Vec3 nuevo. "vec3" no es dependencia directa del paquete, así que se clona uno del bot. */
  private vec(bot: Bot, x: number, y: number, z: number): Vec3 {
    const point = bot.entity.position.clone();
    point.x = x;
    point.y = y;
    point.z = z;
    return point;
  }

  /** Asegura (de forma asíncrona, sin bloquear el tick) que el ítem buscado esté en la mano. */
  private ensureHeld(bot: Bot, match: (name: string) => boolean): HeldState {
    const held = bot.heldItem;
    if (held && match(held.name)) return "held";
    const item = bot.inventory.items().find((candidate) => match(candidate.name));
    if (!item) return "missing";
    if (!this.equipBusy) {
      this.equipBusy = true;
      bot
        .equip(item, "hand")
        .catch((err: unknown) => {
          this.log("warn", `No se pudo equipar ${item.name}: ${errorText(err)}`);
        })
        .finally(() => {
          this.equipBusy = false;
        });
    }
    return "pending";
  }

  private look(bot: Bot, point: Vec3): void {
    bot.lookAt(point, true).catch(() => undefined);
  }

  private follow(bot: Bot, entity: Entity): void {
    if (this.goalKind === "follow" && this.followTarget === entity) return;
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, FOLLOW_RANGE), true);
    this.goalKind = "follow";
    this.followTarget = entity;
  }

  private goToCenter(bot: Bot): void {
    if (this.goalKind === "center") return;
    bot.pathfinder.setGoal(new goals.GoalNear(ARENA.center.x, ARENA.center.y + 1, ARENA.center.z, 2));
    this.goalKind = "center";
    this.followTarget = null;
  }

  private clearGoal(bot: Bot): void {
    if (this.goalKind === "none") return;
    this.goalKind = "none";
    this.followTarget = null;
    bot.pathfinder.setGoal(null);
  }
}

export function createFighter(opts: FighterOptions): Fighter {
  return new MineflayerFighter(opts);
}
