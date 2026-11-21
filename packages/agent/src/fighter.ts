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
  bestDigTool,
  FOOD_NAMES,
  isArrow,
  isAxe,
  isBow,
  isBreakable,
  isBuildBlock,
  isLavaBucket,
  isPearl,
  isShield,
  isSword,
  isWaterBucket,
} from "./items";
import { buildObservation, type Observation } from "./observation";
import { buildSystemPrompt } from "./prompt";
import {
  BOX_BLOCKS,
  BUILD_COOLDOWN_MS,
  BUILD_MIN_DISTANCE,
  DIG_MAX_BLOCKS,
  DIG_MAX_SECONDS,
  eatRefusal,
  isToolName,
  kitToolDefs,
  kitToolNames,
  LAVA_MAX_DISTANCE,
  LAVA_MIN_DISTANCE,
  parseToolArgs,
  PEARL_COOLDOWN_MS,
  PEARL_MIN_HEALTH,
  refusalText,
  shootRefusal,
  TOWER_HEIGHT,
  WATER_BETWEEN_MIN_DISTANCE,
  type BuildShape,
  type DigTarget,
  type ParsedToolArgs,
  type PearlTarget,
  type ToolName,
  type WaterPlace,
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
type Block = NonNullable<ReturnType<Bot["blockAt"]>>;

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
 * recibió, y ese paquete sale recién en el siguiente tick de física. Por eso se lanza solo
 * después de ver pasar un tick; si en este plazo no pasa ninguno (física detenida), se desiste.
 */
const PEARL_AIM_TIMEOUT_MS = 1000;
/** Una perla vuela menos de 1 segundo; pasado este plazo se da por perdida. */
const PEARL_FLIGHT_TIMEOUT_MS = 1500;
/** Un teletransporte forzado solo puede ser el aterrizaje de una perla lanzada hace menos que esto. */
const PEARL_LANDING_WINDOW_MS = 2000;
/**
 * ... y solo si movió al bot más que esto (bloques). El servidor también corrige la
 * posición por otros motivos (el `tp` de la preparación, un tirón por lag) sin moverlo tanto.
 */
const PEARL_MIN_JUMP = 2;
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
/** Margen para decir que los pies están a la altura del piso de la arena. */
const FLOOR_TOLERANCE = 0.1;
/**
 * Un salto o un empujón no levantan los pies más que esto sobre el piso. Más arriba (o
 * parado a otra altura) el luchador está encima de un bloque, y desde ahí no se construye.
 */
const BUILD_MAX_AIRBORNE = 1.3;

const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);
/**
 * Altura máxima de los pies sobre el piso: la tapa invisible está un bloque sobre los muros
 * y el jugador mide 1.8, así que más arriba no cabe.
 */
const MAX_FEET_HEIGHT = ARENA.wallHeight - 2;
/** Cuánto se espera a que el salto suba lo suficiente, o a volver a pisar, al levantar una torre. */
const TOWER_STEP_TIMEOUT_MS = 900;
/** Alcance para vaciar un cubo (el servidor no deja más de ~5 bloques desde los ojos). */
const POUR_REACH = 4.6;
/** Cuánto se espera a que el servidor vacíe el cubo antes de dar el intento por fallido. */
const POUR_CONFIRM_MS = 400;
/** Distancia (bloques) hacia el rival en que cae el agua "between". */
const WATER_BETWEEN_STEP = 2;
/** Alcance para romper bloques (desde los ojos hasta el centro del bloque). */
const DIG_REACH = 4.5;
/** Plazo total de una llamada a dig. */
const DIG_TIMEOUT_MS = 12_000;
/** Cuánto se espera a quedar al centro del bloque antes de encerrarse. */
const CENTER_TIMEOUT_MS = 700;
/** Paso con que se recorre la recta hacia el rival buscando bloques en medio. */
const LINE_STEP = 0.25;
/** Las cuatro direcciones horizontales. */
const SIDES_XZ: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Slot de la mano secundaria en la ventana de inventario del jugador. */
const OFFHAND_SLOT = 45;

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Espera a que `done()` sea verdad (revisando cada 50 ms) o a que pase `timeoutMs`. */
async function waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return true;
    await delay(50);
  }
  return done();
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

/**
 * Corazones amarillos (absorción) de un jugador: el metadato 15 de Player en 1.20.x. No
 * van incluidos en `bot.health`. 0 si no se conocen.
 */
function readAbsorption(entity: Entity): number {
  const metadata = (entity as unknown as { metadata?: unknown }).metadata;
  if (!Array.isArray(metadata)) return 0;
  const value: unknown = metadata[15];
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1024 ? value : 0;
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
  /**
   * Aviso que antecede al resultado de la acción a la que se pasó solo al caer de una perla
   * ("attack" o "eat"): cuenta cómo se llegó ahí. Se borra al cambiar de acción.
   */
  private pearlNote = "";
  /** Momento en que partió la acción de un solo uso en curso (perla o muro). */
  private oneShotStartedAt = 0;
  /** Ticks de física de mineflayer vistos hasta ahora (cada uno envía posición y mirada al servidor). */
  private physicsTicks = 0;
  /** Posición propia en el último tick de física: con ella se mide cuánto movió un teletransporte. */
  private tickPosition: Vec3Like | null = null;

  // Perla de ender: equipar -> apuntar -> esperar un tick de física -> lanzar -> esperar el aterrizaje.
  private pearlTarget: PearlTarget = "rival";
  /** 0 = todavía no se apunta. */
  private pearlAimedAt = 0;
  /** Valor de `physicsTicks` cuando se apuntó. */
  private pearlAimTick = 0;
  /** 0 = todavía no se lanza. */
  private pearlThrownAt = 0;
  /** Momento del último aterrizaje de una perla propia. */
  private pearlLandedAt = 0;
  /** Hasta cuándo un teletransporte forzado se atribuye a una perla propia en vuelo (0 = no hay). */
  private pearlFlightUntil = 0;
  private pearlReadyAt = 0;
  /** Hasta cuándo una baja de vida se atribuye a la caída de la perla y no al rival. */
  private selfDamageUntil = 0;

  // Muro: la colocación corre en una cadena asíncrona aparte del tick del cuerpo.
  private buildBusy = false;
  /** Sube cada vez que se sale de un modo; una cadena de otra generación se detiene sola. */
  private buildGeneration = 0;
  /** Número de la última cadena lanzada: solo ella suelta `buildBusy` al terminar. */
  private buildChain = 0;
  private buildReadyAt = 0;
  /** Qué levanta "build" en curso. */
  private buildShape: BuildShape = "wall";
  /** Qué rompe el "dig" en curso. */
  private digTarget: DigTarget = "between";
  /** true mientras bot.dig está rompiendo un bloque (leaveMode lo corta). */
  private digging = false;
  /** Dónde va el agua del "water" en curso. */
  private waterPlace: WaterPlace = "between";

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

    // Cada tick de física mineflayer envía al servidor la posición y la mirada. El contador
    // le dice a la perla que su mirada ya salió, y la posición guardada permite medir después
    // cuánto movió al bot un teletransporte. Sin `guard`: corre 20 veces por segundo y no
    // hace nada que pueda fallar.
    bot.on("physicsTick", () => {
      this.physicsTicks++;
      const position = bot.entity?.position;
      if (position) this.tickPosition = { x: position.x, y: position.y, z: position.z };
    });

    // El servidor movió al bot a la fuerza. El listener es global (no del modo "pearl")
    // porque el teletransporte ocurre igual aunque el LLM ya haya elegido otra acción, y
    // porque no todo movimiento forzado es una perla: también lo son el `tp` de la
    // preparación, la reaparición y las correcciones del servidor por lag.
    bot.on("forcedMove", () => {
      this.guard("forcedMove", () => {
        const now = Date.now();
        const position = bot.entity.position;
        const moved = this.tickPosition ? distance3(this.tickPosition, position) : 0;
        this.tickPosition = { x: position.x, y: position.y, z: position.z };
        // Siempre: la ruta del pathfinder se calculó desde otro lugar. El modo en curso
        // vuelve a pedir la suya en su próximo tick.
        this.clearGoal(bot);

        // Solo es el aterrizaje de una perla propia si se lanzó hace poco y el salto fue grande.
        const pearlInFlight = this.pearlFlightUntil > 0 && now < this.pearlFlightUntil;
        if (!pearlInFlight || moved <= PEARL_MIN_JUMP) return;
        this.pearlFlightUntil = 0;
        this.pearlLandedAt = now;
        this.selfDamageUntil = now + SELF_DAMAGE_WINDOW_MS;
      });
    });

    // mineflayer guarda los atributos de una entidad bajo `prop.key`, pero hasta 1.20.4 ese
    // campo del paquete se llama `name` (recién es `key` desde 1.20.5): quedan todos bajo
    // "undefined" y la física nunca ve el modificador de velocidad, así que Velocidad I no
    // movería más rápido al bot. Aquí se guardan los atributos propios con su nombre real.
    bot._client.on("entity_update_attributes", (packet: unknown) => {
      this.guard("entity_update_attributes", () => this.storeOwnAttributes(bot, packet));
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

  /**
   * Guarda en la entidad propia los atributos de un paquete `entity_update_attributes`,
   * con la misma forma que usa mineflayer ({ value, modifiers }) pero bajo su nombre real
   * ("minecraft:generic.movement_speed"), que es donde los busca la física.
   */
  private storeOwnAttributes(bot: Bot, packet: unknown): void {
    const own = bot.entity as unknown as { id?: unknown; attributes?: Record<string, unknown> } | undefined;
    if (!own || typeof packet !== "object" || packet === null) return;
    const { entityId, properties } = packet as { entityId?: unknown; properties?: unknown };
    if (entityId !== own.id || !Array.isArray(properties)) return;
    const attributes = own.attributes ?? {};
    own.attributes = attributes;
    for (const property of properties as unknown[]) {
      if (typeof property !== "object" || property === null) continue;
      const { key, name, value, modifiers } = property as Record<string, unknown>;
      const id = typeof key === "string" ? key : name;
      if (typeof id !== "string" || typeof value !== "number") continue;
      attributes[id] = { value, modifiers: Array.isArray(modifiers) ? modifiers : [] };
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
        inventory: this.inventoryWithOffhand(bot),
        absorption: readAbsorption(bot.entity),
      },
      opponent: opponent ? { position: opponent.position, health: readEntityHealth(opponent) } : null,
      arena: { center: ARENA.center, radius: ARENA.radius },
      currentAction: this.mode,
      lastActionResult: this.lastResult,
      pearlReadyAt: this.pearlReadyAt,
      buildReadyAt: this.buildReadyAt,
      terrain: this.terrain(bot, opponent),
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
      // El aviso de cómo se llegó a esta acción ya fue al LLM en este texto: no se repite.
      this.pearlNote = "";
      return text;
    }

    const opponent = this.opponent(bot);
    const items = bot.inventory.items();
    const itemNames = items.map((item) => item.name);
    const has = (match: (itemName: string) => boolean): boolean => itemNames.some(match);

    // Una herramienta que no se puede usar ahora no gasta nada ni cambia de acción: el
    // cuerpo sigue con lo que hacía (quedarse quieto en "wait" sería regalarle golpes al rival).
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
      case "shoot": {
        const refusal = shootRefusal(itemNames);
        if (refusal) return refusalText(refusal, this.mode);
        result = opponent ? "cargando el arco" : "rival no visible; esperando para apuntar";
        break;
      }
      case "eat": {
        const refusal = eatRefusal(itemNames, bot.food, (itemName) => this.isFood(bot, itemName));
        if (refusal) return refusalText(refusal, this.mode);
        result = "empezando a comer";
        break;
      }
      case "pearl": {
        const refusal = this.pearlRefusal(bot, opponent, args.target, now);
        if (refusal) return refusalText(refusal, this.mode);
        result =
          args.target === "away" ? "preparando la perla para alejarte del rival" : "preparando la perla para caer junto al rival";
        break;
      }
      case "build": {
        const refusal =
          args.shape === "tower"
            ? this.towerRefusal(bot, now)
            : args.shape === "box"
              ? this.boxRefusal(bot, now)
              : this.buildRefusal(bot, opponent, now);
        if (refusal) return refusalText(refusal, this.mode);
        result =
          args.shape === "tower"
            ? "preparando los bloques para la torre"
            : args.shape === "box"
              ? "preparando los bloques para encerrarte"
              : "preparando los bloques para el muro";
        break;
      }
      case "dig": {
        const targets = this.digCandidates(bot, opponent, args.digTarget);
        if (typeof targets === "string") return refusalText(targets, this.mode);
        result = `rompiendo ${targets[0]?.name.replaceAll("_", " ") ?? "bloques"}`;
        break;
      }
      case "shield": {
        if (!this.hasShield(bot)) return refusalText("no tienes escudo", this.mode);
        result = opponent ? "levantando el escudo hacia el rival" : "levantando el escudo (rival no visible)";
        break;
      }
      case "water": {
        const refusal = this.waterRefusal(bot, opponent, args.where);
        if (refusal) return refusalText(refusal, this.mode);
        result = args.where === "feet" ? "preparando el agua bajo tus pies" : "preparando el agua entre tú y el rival";
        break;
      }
      case "lava": {
        const refusal = this.lavaRefusal(bot, opponent);
        if (refusal) return refusalText(refusal, this.mode);
        result = "preparando la lava a los pies del rival";
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
    this.buildShape = args.shape;
    this.waterPlace = args.where;
    this.digTarget = args.digTarget;
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
    // El muro va 3 bloques por delante: con el rival más cerca quedaría encima de las
    // celdas o del lado propio, y los bloques se gastarían sin cubrir nada.
    const dist = round1(distance3(bot.entity.position, opponent.position));
    if (dist < BUILD_MIN_DISTANCE) {
      return `el rival está a ${dist} bloques: muy cerca para levantar un muro (mínimo ${BUILD_MIN_DISTANCE})`;
    }
    // Encima de un bloque (un muro anterior) no hay piso delante donde apoyar el muro. En
    // el aire por un salto o un empujón sí se acepta: tickBuild espera a que caiga.
    const height = bot.entity.position.y - FLOOR_Y;
    if (!this.onArenaFloor(bot) && (bot.entity.onGround || height > BUILD_MAX_AIRBORNE)) {
      return "no puedes construir desde arriba de un bloque: baja al piso de la arena";
    }
    return null;
  }

  /** Por qué no se puede levantar una torre ahora, o null si se puede. */
  private towerRefusal(bot: Bot, now: number): string | null {
    const blocks = this.countItems(bot, isBuildBlock);
    if (blocks === 0) return "no te quedan bloques";
    if (now < this.buildReadyAt) return `todavía no puedes construir: faltan ${secondsLeft(this.buildReadyAt, now)} s`;
    if (!bot.entity.onGround) return "no puedes levantar una torre en el aire: espera a pisar";
    if (bot.entity.position.y - FLOOR_Y + 1 > MAX_FEET_HEIGHT) return "ya estás tan alto como deja el techo de la arena";
    return null;
  }

  /** Por qué no se puede vaciar el agua ahí, o null si se puede. */
  private waterRefusal(bot: Bot, opponent: Entity | null, where: WaterPlace): string | null {
    if (this.countItems(bot, isWaterBucket) === 0) return "no te quedan cubos de agua";
    if (where === "feet") return null;
    if (!opponent) return "no ves al rival: no hay hacia dónde vaciar el agua";
    const dist = round1(distance3(bot.entity.position, opponent.position));
    if (dist < WATER_BETWEEN_MIN_DISTANCE) {
      return `el rival está a ${dist} bloques: muy cerca para poner agua entre los dos (usa where "feet" o aléjate)`;
    }
    return null;
  }

  /** Por qué no se puede vaciar la lava ahora, o null si se puede. */
  private lavaRefusal(bot: Bot, opponent: Entity | null): string | null {
    if (this.countItems(bot, isLavaBucket) === 0) return "no te quedan cubos de lava";
    if (!opponent) return "no ves al rival: no hay dónde vaciar la lava";
    const dist = round1(distance3(bot.entity.position, opponent.position));
    if (dist < LAVA_MIN_DISTANCE) return `el rival está a ${dist} bloques: tan cerca te quemarías tú también`;
    if (dist > LAVA_MAX_DISTANCE) return `el rival está a ${dist} bloques: fuera de tu alcance (máximo ${LAVA_MAX_DISTANCE})`;
    return null;
  }

  /** Por qué no se puede encerrar ahora, o null si se puede. */
  private boxRefusal(bot: Bot, now: number): string | null {
    if (this.countItems(bot, isBuildBlock) === 0) return "no te quedan bloques";
    if (now < this.buildReadyAt) return `todavía no puedes construir: faltan ${secondsLeft(this.buildReadyAt, now)} s`;
    if (!bot.entity.onGround) return "no puedes encerrarte en el aire: espera a pisar";
    // El techo va 2 bloques sobre los pies y la tapa de la arena no deja poner nada más arriba.
    if (bot.entity.position.y - FLOOR_Y + 2 > MAX_FEET_HEIGHT + 1) return "estás muy alto: el techo de la caja no cabe bajo el de la arena";
    return null;
  }

  /**
   * Bloques que rompería "dig" (el primero es el siguiente), o por qué no hay ninguno.
   * "between": los que cortan la recta hasta el rival, a la altura de los pies o de la
   * cabeza. "nearest": el más cercano. Siempre dentro del alcance y nunca de la arena.
   */
  private digCandidates(bot: Bot, opponent: Entity | null, target: DigTarget): Block[] | string {
    const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0);
    const reachable = (block: Block): boolean => distance3(eye, block.position.offset(0.5, 0.5, 0.5)) <= DIG_REACH;
    if (target === "nearest") {
      const near = this.breakableAround(bot, Math.ceil(DIG_REACH)).filter(reachable);
      if (near.length === 0) return "no hay ningún bloque colocado a tu alcance (el piso y los muros de la arena no se rompen)";
      return near;
    }
    if (!opponent) return "no ves al rival: no hay hacia dónde abrirte paso";
    const between = this.blocksBetween(bot, opponent);
    if (between.length === 0) return "no hay bloques entre tú y el rival";
    const inReach = between.filter(reachable);
    if (inReach.length === 0) {
      const first = between[0];
      const dist = first ? round1(distance3(eye, first.position.offset(0.5, 0.5, 0.5))) : 0;
      return `el bloque más cercano entre tú y el rival está a ${dist} bloques: acércate primero`;
    }
    return inReach;
  }

  /** Bloques rompibles en la recta de uno al rival (pies y cabeza), del más cercano al más lejano. */
  private blocksBetween(bot: Bot, opponent: Entity): Block[] {
    const from = bot.entity.position;
    const to = opponent.position;
    const length = distance3(from, to);
    const seen = new Set<string>();
    const found: { block: Block; at: number }[] = [];
    for (let t = 0; t <= length; t += LINE_STEP) {
      const k = length === 0 ? 0 : t / length;
      for (const lift of [0.5, 1.5]) {
        const x = Math.floor(from.x + (to.x - from.x) * k);
        const y = Math.floor(from.y + (to.y - from.y) * k + lift);
        const z = Math.floor(from.z + (to.z - from.z) * k);
        const key = `${x},${y},${z}`;
        if (seen.has(key) || y < FLOOR_Y) continue;
        seen.add(key);
        const block = bot.blockAt(this.vec(bot, x, y, z));
        if (block && isBreakable(block.name)) found.push({ block, at: t });
      }
    }
    return found.sort((a, b) => a.at - b.at).map((entry) => entry.block);
  }

  /** Bloques rompibles en un cubo de `radius` alrededor, del más cercano al más lejano. */
  private breakableAround(bot: Bot, radius: number): Block[] {
    const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0);
    const base = bot.entity.position;
    const found: { block: Block; dist: number }[] = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -1; dy <= radius; dy += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          const y = Math.floor(base.y) + dy;
          if (y < FLOOR_Y) continue;
          const block = bot.blockAt(this.vec(bot, Math.floor(base.x) + dx, y, Math.floor(base.z) + dz));
          if (!block || !isBreakable(block.name)) continue;
          found.push({ block, dist: distance3(eye, block.position.offset(0.5, 0.5, 0.5)) });
        }
      }
    }
    return found.sort((a, b) => a.dist - b.dist).map((entry) => entry.block);
  }

  /** Lo que la observación cuenta del terreno: altura, bloques hasta el rival y si está encerrado. */
  private terrain(bot: Bot, opponent: Entity | null): { height: number; blocksBetween: number; enclosed: boolean } {
    const position = bot.entity.position;
    const feet = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
    const enclosed = SIDES_XZ.every(([dx, dz]) => {
      const block = bot.blockAt(this.vec(bot, feet.x + dx, feet.y, feet.z + dz));
      return block !== null && block.boundingBox === "block";
    });
    return {
      height: position.y - FLOOR_Y,
      blocksBetween: opponent ? this.blocksBetween(bot, opponent).length : 0,
      enclosed,
    };
  }

  /** Inventario para la observación: items() no trae la mano secundaria, donde va el escudo. */
  private inventoryWithOffhand(bot: Bot): { name: string; count: number }[] {
    const items = bot.inventory.items().map((item) => ({ name: item.name, count: item.count }));
    const offhand = bot.inventory.slots[OFFHAND_SLOT];
    if (offhand) items.push({ name: offhand.name, count: offhand.count });
    return items;
  }

  /** ¿Tiene un escudo, en la mano secundaria o en el inventario? */
  private hasShield(bot: Bot): boolean {
    if (bot.inventory.slots[OFFHAND_SLOT]?.name === "shield") return true;
    return bot.inventory.items().some((item) => isShield(item.name));
  }

  /** ¿Está parado sobre el piso de la arena (no en el aire ni encima de un bloque)? */
  private onArenaFloor(bot: Bot): boolean {
    return bot.entity.onGround && Math.abs(bot.entity.position.y - FLOOR_Y) <= FLOOR_TOLERANCE;
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
    if (this.digging) {
      this.digging = false;
      try {
        bot.stopDigging();
      } catch {
        // nada
      }
    }
    this.buildGeneration++;
    this.pearlNote = "";
    this.clearGoal(bot);
  }

  /** Vuelve a "wait" sin tocar al bot (para muerte / reaparición). */
  private resetBody(result: string): void {
    this.mode = "wait";
    this.modeUntil = null;
    this.using = false;
    // La cadena del muro se corta sola al cambiar la generación; la marca se suelta ya,
    // para que "build" no quede bloqueada si esa cadena nunca llega a terminar.
    this.buildGeneration++;
    this.buildBusy = false;
    this.pearlNote = "";
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
        if (this.buildShape === "tower") this.tickTower(bot, now);
        else if (this.buildShape === "box") this.tickBox(bot, now);
        else this.tickBuild(bot, opponent, now);
        break;
      case "dig":
        this.tickDig(bot, now);
        break;
      case "shield":
        this.tickShield(bot, opponent);
        break;
      case "water":
      case "lava":
        this.tickPour(bot, opponent, this.mode, now);
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
    this.lastResult = this.pearlNote + progress;
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
    this.lastResult = `${this.pearlNote}comiendo (tarda unos 2 segundos)`;
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
      const yaw = Math.atan2(-dx, -dz);
      // Dos llamadas: look() no hace nada (ni fija la "última mirada enviada") cuando la
      // mirada pedida coincide con la actual, y podría quedar enviada una mirada vieja del
      // pathfinder. Mirar primero apenas al lado obliga a que la segunda la fije.
      bot.look(yaw + 0.01, pitch, true).catch(() => undefined);
      bot.look(yaw, pitch, true).catch(() => undefined);
      this.pearlAimedAt = now;
      this.pearlAimTick = this.physicsTicks;
      this.lastResult = "apuntando la perla";
      return;
    }
    // La mirada viaja al servidor con el siguiente tick de física: hasta ver pasar uno no
    // se lanza, o la perla saldría hacia donde el bot miraba antes.
    if (this.physicsTicks === this.pearlAimTick) {
      if (now - this.pearlAimedAt >= PEARL_AIM_TIMEOUT_MS) this.enterWait(bot, "no pudiste lanzar la perla");
      return;
    }

    // No se marca `using`: la perla sale al instante y no hay nada que soltar después.
    bot.activateItem();
    this.pearlThrownAt = now;
    this.pearlReadyAt = now + PEARL_COOLDOWN_MS;
    this.pearlFlightUntil = now + PEARL_LANDING_WINDOW_MS;
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

  /**
   * La perla ya cayó. Corre en el tick siguiente al teletransporte, así que la distancia
   * que informa es la medida DESPUÉS de aterrizar (la perla suele caer algo corta).
   */
  private finishPearl(bot: Bot, opponent: Entity | null): void {
    const where = opponent ? `distancia ${round1(distance3(bot.entity.position, opponent.position))}` : "no ves al rival";
    if (this.pearlTarget === "away") {
      const landed = `te teletransportaste lejos del rival (${where}); te quedan ${this.countItems(bot, isPearl)} perlas`;
      // El rival vuelve a estar encima en 2 o 3 segundos y la próxima decisión tarda: si
      // hay hambre y comida, se empieza a comer ya, sin esperarla.
      const canEat =
        this.toolNames.includes("eat") &&
        bot.food < 20 &&
        bot.inventory.items().some((item) => this.isFood(bot, item.name));
      if (!canEat) {
        this.enterWait(bot, landed);
        return;
      }
      this.mode = "eat";
      this.modeUntil = null;
      this.pearlNote = `${landed}; `;
      this.lastResult = `${this.pearlNote}empezando a comer`;
      return;
    }
    // Cayó junto al rival: pasa directo a atacar, sin esperar la próxima decisión.
    this.mode = "attack";
    this.modeUntil = null;
    this.hits = 0;
    this.pearlNote = `te teletransportaste junto al rival (${where}); `;
    this.lastResult = `${this.pearlNote}atacando`;
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
    const timedOut = now - this.oneShotStartedAt >= EQUIP_TIMEOUT_MS;
    if (held === "pending") {
      if (timedOut) this.enterWait(bot, "no pudiste equipar los bloques");
      return;
    }
    if (!opponent) {
      this.enterWait(bot, "no ves al rival: no hay dónde poner el muro");
      return;
    }
    // El muro se apoya en el piso que hay delante de los pies: en el aire (un salto, un
    // empujón) las celdas saldrían un bloque más arriba, sin nada debajo. Se espera a caer.
    if (!this.onArenaFloor(bot)) {
      if (timedOut) this.enterWait(bot, "no pudiste construir: no estás parado en el piso de la arena");
      return;
    }

    const generation = ++this.buildGeneration;
    const chain = ++this.buildChain;
    this.buildBusy = true;
    this.buildReadyAt = now + BUILD_COOLDOWN_MS;
    this.lastResult = "colocando los bloques del muro";
    this.placeWall(bot, wallCells(bot.entity.position, opponent.position), generation, now + BUILD_TIMEOUT_MS)
      .then((tried) => {
        // Si otra acción (o la muerte) cortó la construcción, no hay nada que informar.
        if (!this.buildActive(generation)) return;
        // Se cuenta mirando el mundo y no las respuestas de placeBlock: un bloque puede
        // quedar puesto aunque su confirmación haya llegado después del plazo de espera.
        const placed = tried.filter((cell) => isBuildBlock(bot.blockAt(cell)?.name ?? "")).length;
        const left = this.countItems(bot, isBuildBlock);
        this.enterWait(
          bot,
          placed > 0
            ? `muro de ${placed} bloques entre tú y el rival; te quedan ${left} bloques`
            : "no pudiste colocar ningún bloque (no hay espacio o el rival está encima)",
        );
      })
      .catch((err: unknown) => {
        this.log("warn", `Error al construir el muro: ${errorText(err)}`);
        if (this.buildActive(generation)) this.enterWait(bot, "no pudiste terminar el muro");
      })
      .finally(() => {
        // Pase lo que pase la marca se suelta, o "build" quedaría muerta el resto de la
        // pelea. Solo la suelta la última cadena lanzada: una vieja que termina tarde
        // (resetBody ya la dio por cortada) no debe liberar a la que corre ahora.
        if (chain === this.buildChain) this.buildBusy = false;
      });
  }

  /**
   * Torre, de un solo uso: salta y pone un bloque bajo los pies, TOWER_HEIGHT veces (o
   * menos si el techo no deja). Corre en la misma cadena asíncrona que el muro.
   */
  private tickTower(bot: Bot, now: number): void {
    if (this.buildBusy) return;
    const held = this.ensureHeld(bot, isBuildBlock);
    if (held === "missing") {
      this.enterWait(bot, "no te quedan bloques");
      return;
    }
    this.clearGoal(bot);
    bot.clearControlStates();
    const timedOut = now - this.oneShotStartedAt >= EQUIP_TIMEOUT_MS;
    if (held === "pending" || !bot.entity.onGround) {
      if (timedOut) this.enterWait(bot, held === "pending" ? "no pudiste equipar los bloques" : "no pudiste construir: no estás pisando nada");
      return;
    }

    const height = Math.round(bot.entity.position.y - FLOOR_Y);
    const steps = Math.min(TOWER_HEIGHT, MAX_FEET_HEIGHT - height);
    const generation = ++this.buildGeneration;
    const chain = ++this.buildChain;
    this.buildBusy = true;
    this.buildReadyAt = now + BUILD_COOLDOWN_MS;
    this.lastResult = "subiendo la torre";
    this.raiseTower(bot, steps, generation)
      .then((placed) => {
        if (!this.buildActive(generation)) return;
        const up = round1(bot.entity.position.y - FLOOR_Y);
        const left = this.countItems(bot, isBuildBlock);
        this.enterWait(
          bot,
          placed > 0
            ? `torre de ${placed} bloques: estás a ${up} bloques del piso; te quedan ${left} bloques`
            : "no pudiste subir: no se colocó ningún bloque",
        );
      })
      .catch((err: unknown) => {
        this.log("warn", `Error al levantar la torre: ${errorText(err)}`);
        if (this.buildActive(generation)) this.enterWait(bot, "no pudiste terminar la torre");
      })
      .finally(() => {
        bot.setControlState("jump", false);
        if (chain === this.buildChain) this.buildBusy = false;
      });
  }

  /** Salta y pone un bloque bajo los pies `steps` veces; devuelve cuántos quedaron puestos. */
  private async raiseTower(bot: Bot, steps: number, generation: number): Promise<number> {
    const up = this.vec(bot, 0, 1, 0);
    let placed = 0;
    for (let i = 0; i < steps; i += 1) {
      if (!this.buildActive(generation)) break;
      const held = bot.heldItem;
      if (!held || !isBuildBlock(held.name)) break;
      const feet = bot.entity.position;
      const support = bot.blockAt(this.vec(bot, Math.floor(feet.x), Math.floor(feet.y) - 1, Math.floor(feet.z)));
      if (!support || support.boundingBox !== "block") break;
      try {
        await bot.lookAt(support.position.offset(0.5, 1, 0.5), true);
      } catch {
        break;
      }
      const startY = bot.entity.position.y;
      bot.setControlState("jump", true);
      const rose = await waitUntil(() => bot.entity.position.y >= startY + 1.05, TOWER_STEP_TIMEOUT_MS);
      bot.setControlState("jump", false);
      if (!rose || !this.buildActive(generation)) break;
      const placing = bot.placeBlock(support, up).catch(() => undefined);
      await Promise.race([placing, delay(BUILD_PLACE_TIMEOUT_MS)]);
      await waitUntil(() => bot.entity.onGround, TOWER_STEP_TIMEOUT_MS);
      // Si el bloque no quedó, el salto vuelve a caer a la misma altura.
      if (bot.entity.position.y < startY + 0.9) break;
      placed += 1;
    }
    return placed;
  }

  /**
   * Escudo: en la mano secundaria (si está en el inventario, se pasa ahí), levantado y
   * mirando al rival hasta la próxima decisión. leaveMode lo baja.
   */
  private tickShield(bot: Bot, opponent: Entity | null): void {
    this.clearGoal(bot);
    bot.clearControlStates();
    if (opponent) this.look(bot, opponent.position.offset(0, EYE_HEIGHT, 0));
    if (bot.inventory.slots[OFFHAND_SLOT]?.name !== "shield") {
      const shield = bot.inventory.items().find((item) => isShield(item.name));
      if (!shield) {
        this.enterWait(bot, "no tienes escudo");
        return;
      }
      if (!this.equipBusy) {
        this.equipBusy = true;
        bot
          .equip(shield, "off-hand")
          .catch((err: unknown) => this.log("warn", `No se pudo pasar el escudo a la mano secundaria: ${errorText(err)}`))
          .finally(() => {
            this.equipBusy = false;
          });
      }
      return;
    }
    if (!this.using) {
      bot.activateItem(true);
      this.using = true;
      this.useStartedAt = Date.now();
    }
    this.lastResult = opponent ? "escudo levantado hacia el rival" : "escudo levantado (rival no visible)";
  }

  /**
   * Cubo de agua o de lava, de un solo uso: equipar, mirar el bloque donde va el líquido
   * y usar el cubo. El servidor pone el líquido donde apunta la mirada.
   */
  private tickPour(bot: Bot, opponent: Entity | null, kind: "water" | "lava", now: number): void {
    if (this.buildBusy) return;
    const match = kind === "water" ? isWaterBucket : isLavaBucket;
    const name = kind === "water" ? "agua" : "lava";
    const held = this.ensureHeld(bot, match);
    if (held === "missing") {
      this.enterWait(bot, `no te quedan cubos de ${name}`);
      return;
    }
    this.clearGoal(bot);
    bot.clearControlStates();
    if (held === "pending") {
      if (now - this.oneShotStartedAt >= EQUIP_TIMEOUT_MS) this.enterWait(bot, `no pudiste sacar el cubo de ${name}`);
      return;
    }
    const target = this.pourTarget(bot, opponent, kind);
    if (typeof target === "string") {
      this.enterWait(bot, target);
      return;
    }

    const generation = ++this.buildGeneration;
    const chain = ++this.buildChain;
    this.buildBusy = true;
    this.lastResult = `vaciando el cubo de ${name}`;
    this.pour(bot, target, match, generation)
      .then((done) => {
        if (!this.buildActive(generation)) return;
        if (!done) {
          this.enterWait(bot, `no se pudo vaciar el cubo de ${name} (no había un bloque al alcance donde apuntar)`);
          return;
        }
        const left = this.countItems(bot, match);
        const rest = left > 0 ? ` Te quedan ${left} cubos de ${name}.` : ` No te quedan cubos de ${name}.`;
        if (kind === "lava") {
          const dist = opponent ? round1(distance3(bot.entity.position, opponent.position)) : null;
          this.enterWait(
            bot,
            `vaciaste la lava a los pies del rival${dist !== null ? ` (a ${dist} bloques)` : ""}; se extiende unos 3 bloques: no te acerques.${rest}`,
          );
        } else {
          this.enterWait(
            bot,
            this.waterPlace === "feet"
              ? `vaciaste el agua bajo tus pies: no recibes daño de caída y no te quemas mientras estés en ella.${rest}`
              : `vaciaste el agua entre tú y el rival: corre por el piso y lo empuja.${rest}`,
          );
        }
      })
      .catch((err: unknown) => {
        this.log("warn", `Error al vaciar el cubo de ${name}: ${errorText(err)}`);
        if (this.buildActive(generation)) this.enterWait(bot, `no pudiste vaciar el cubo de ${name}`);
      })
      .finally(() => {
        if (chain === this.buildChain) this.buildBusy = false;
      });
  }

  /**
   * Punto (cara de arriba de un bloque sólido) donde apuntar el cubo, o el motivo por el
   * que no hay dónde. Agua "feet": el primer bloque bajo los pies (también cayendo). Agua
   * "between": el piso a WATER_BETWEEN_STEP bloques hacia el rival. Lava: lo que pisa el rival.
   */
  private pourTarget(bot: Bot, opponent: Entity | null, kind: "water" | "lava"): Vec3 | string {
    const self = bot.entity.position;
    let column: Vec3Like;
    let fromY: number;
    if (kind === "water" && this.waterPlace === "feet") {
      column = self;
      fromY = Math.floor(self.y) - 1;
    } else {
      if (!opponent) return "no ves al rival: no hay hacia dónde vaciar el cubo";
      if (kind === "lava") {
        column = opponent.position;
        fromY = Math.floor(opponent.position.y) - 1;
      } else {
        const dx = opponent.position.x - self.x;
        const dz = opponent.position.z - self.z;
        const len = Math.hypot(dx, dz) || 1;
        column = { x: self.x + (dx / len) * WATER_BETWEEN_STEP, y: self.y, z: self.z + (dz / len) * WATER_BETWEEN_STEP };
        fromY = FLOOR_Y - 1;
      }
    }
    // Primer bloque sólido de la columna hacia abajo (nunca bajo el piso de la arena).
    for (let y = fromY; y >= FLOOR_Y - 1; y -= 1) {
      const block = bot.blockAt(this.vec(bot, Math.floor(column.x), y, Math.floor(column.z)));
      if (!block || block.boundingBox !== "block") continue;
      const above = bot.blockAt(block.position.offset(0, 1, 0));
      if (above && !AIR_BLOCKS.has(above.name) && above.name !== "water" && above.name !== "lava") {
        return "no hay espacio libre donde vaciar el cubo (hay un bloque encima)";
      }
      const point = block.position.offset(0.5, 1, 0.5);
      const eye = self.offset(0, EYE_HEIGHT, 0);
      if (distance3(eye, point) > POUR_REACH) return "ese lugar queda fuera de tu alcance para vaciar el cubo";
      return point;
    }
    return "no hay piso donde vaciar el cubo";
  }

  /** Mira el punto y usa el cubo; true si el servidor lo vació (el cubo quedó vacío en la mano). */
  private async pour(bot: Bot, point: Vec3, match: (name: string) => boolean, generation: number): Promise<boolean> {
    const before = this.countItems(bot, match);
    await bot.lookAt(point, true);
    if (!this.buildActive(generation)) return false;
    bot.activateItem();
    return waitUntil(() => this.countItems(bot, match) < before, POUR_CONFIRM_MS);
  }

  /**
   * Intenta colocar las celdas en orden y devuelve las que estaban libres y se intentaron.
   * No dice cuáles quedaron puestas: eso se lee después en el mundo.
   */
  private async placeWall(bot: Bot, cells: Vec3Like[], generation: number, deadline: number): Promise<Vec3[]> {
    const up = this.vec(bot, 0, 1, 0);
    const tried: Vec3[] = [];
    for (const cell of cells) {
      if (!this.buildActive(generation) || Date.now() >= deadline) break;
      const held = bot.heldItem;
      if (!held || !isBuildBlock(held.name)) break;

      const position = this.vec(bot, cell.x, cell.y, cell.z);
      const current = bot.blockAt(position);
      if (!current || !AIR_BLOCKS.has(current.name)) continue;
      if (this.cellOccupied(bot, cell)) continue;
      // El bloque se apoya en el de abajo (el piso para la fila baja, el muro para la alta)
      // o, si abajo no hay nada (el techo de la caja), en uno de al lado.
      const support = this.supportFor(bot, position, up);
      if (!support) continue;

      try {
        // Mirada forzada: placeBlock gira la cabeza de a poco si no está ya apuntando.
        await bot.lookAt(support.aim, true);
      } catch {
        continue;
      }
      if (!this.buildActive(generation)) break;
      tried.push(position);
      // Un rechazo del servidor (celda ocupada) no corta el muro: se sigue con la siguiente.
      // Tampoco se espera más que el plazo: mineflayer aguarda hasta 5 s por la respuesta.
      const placing = bot.placeBlock(support.block, support.face).catch(() => undefined);
      await Promise.race([placing, delay(BUILD_PLACE_TIMEOUT_MS)]);
    }
    return tried;
  }

  /**
   * Bloque sólido en el que apoyar uno nuevo en `cell`, la cara que toca y el punto al que
   * mirar: primero el de abajo; si no hay, uno de los cuatro de al lado.
   */
  private supportFor(bot: Bot, cell: Vec3, up: Vec3): { block: Block; face: Vec3; aim: Vec3 } | null {
    const below = bot.blockAt(cell.offset(0, -1, 0));
    if (below && below.boundingBox === "block") return { block: below, face: up, aim: below.position.offset(0.5, 1, 0.5) };
    for (const [dx, dz] of SIDES_XZ) {
      const side = bot.blockAt(cell.offset(dx, 0, dz));
      if (!side || side.boundingBox !== "block") continue;
      // La cara del vecino que mira hacia la celda.
      const face = this.vec(bot, -dx, 0, -dz);
      return { block: side, face, aim: side.position.offset(0.5 - dx * 0.5, 0.5, 0.5 - dz * 0.5) };
    }
    return null;
  }

  /**
   * Caja, de un solo uso: queda al centro de su bloque y se rodea de bloques (4 lados de
   * 2 de alto), con un apoyo arriba y el techo. Misma cadena asíncrona que el muro.
   */
  private tickBox(bot: Bot, now: number): void {
    if (this.buildBusy) return;
    const held = this.ensureHeld(bot, isBuildBlock);
    if (held === "missing") {
      this.enterWait(bot, "no te quedan bloques");
      return;
    }
    this.clearGoal(bot);
    bot.clearControlStates();
    if (held === "pending" || !bot.entity.onGround) {
      if (now - this.oneShotStartedAt >= EQUIP_TIMEOUT_MS) {
        this.enterWait(bot, held === "pending" ? "no pudiste equipar los bloques" : "no pudiste encerrarte: no estás pisando nada");
      }
      return;
    }

    const generation = ++this.buildGeneration;
    const chain = ++this.buildChain;
    this.buildBusy = true;
    this.buildReadyAt = now + BUILD_COOLDOWN_MS;
    this.lastResult = "encerrándote con bloques";
    (async () => {
      await this.centerOnBlock(bot, generation);
      const p = bot.entity.position;
      const fx = Math.floor(p.x);
      const fy = Math.floor(p.y);
      const fz = Math.floor(p.z);
      const cells: Vec3Like[] = [];
      for (const lift of [0, 1]) for (const [dx, dz] of SIDES_XZ) cells.push({ x: fx + dx, y: fy + lift, z: fz + dz });
      // El techo no tiene nada abajo (es la cabeza): se apoya en un bloque puesto encima del lado +x.
      cells.push({ x: fx + 1, y: fy + 2, z: fz }, { x: fx, y: fy + 2, z: fz });
      return this.placeWall(bot, cells.slice(0, BOX_BLOCKS), generation, Date.now() + BUILD_TIMEOUT_MS * 2);
    })()
      .then((tried) => {
        if (!this.buildActive(generation)) return;
        const placed = tried.filter((cell) => isBuildBlock(bot.blockAt(cell)?.name ?? "")).length;
        const left = this.countItems(bot, isBuildBlock);
        const closed = this.terrain(bot, null).enclosed;
        const roof = bot.blockAt(bot.entity.position.offset(0, 2, 0));
        const covered = roof !== null && roof.boundingBox === "block";
        this.enterWait(
          bot,
          placed === 0
            ? "no pudiste colocar ningún bloque alrededor"
            : `${closed && covered ? "quedaste encerrado" : closed ? "quedaste rodeado de bloques, pero sin techo" : "quedó algún hueco en la caja"} (${placed} bloques); te quedan ${left} bloques`,
        );
      })
      .catch((err: unknown) => {
        this.log("warn", `Error al encerrarse: ${errorText(err)}`);
        if (this.buildActive(generation)) this.enterWait(bot, "no pudiste terminar de encerrarte");
      })
      .finally(() => {
        bot.clearControlStates();
        if (chain === this.buildChain) this.buildBusy = false;
      });
  }

  /** Camina lo justo para quedar al centro del bloque que pisa (así los bloques de al lado no lo tocan). */
  private async centerOnBlock(bot: Bot, generation: number): Promise<void> {
    const p = bot.entity.position;
    const target = this.vec(bot, Math.floor(p.x) + 0.5, p.y + EYE_HEIGHT, Math.floor(p.z) + 0.5);
    const off = (): number => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
    if (off() < 0.2) return;
    try {
      await bot.lookAt(target, true);
    } catch {
      return;
    }
    if (!this.buildActive(generation)) return;
    bot.setControlState("forward", true);
    await waitUntil(() => off() < 0.2 || !this.buildActive(generation), CENTER_TIMEOUT_MS);
    bot.setControlState("forward", false);
  }

  /**
   * Romper bloques, de un solo uso: "between" rompe uno tras otro los que cortan la recta
   * hasta el rival (hasta DIG_MAX_BLOCKS); "nearest", solo el más cercano. Cada bloque se
   * rompe con la mejor herramienta del inventario.
   */
  private tickDig(bot: Bot, now: number): void {
    if (this.buildBusy) return;
    this.clearGoal(bot);
    bot.clearControlStates();
    const generation = ++this.buildGeneration;
    const chain = ++this.buildChain;
    this.buildBusy = true;
    const deadline = now + DIG_TIMEOUT_MS;
    const limit = this.digTarget === "between" ? DIG_MAX_BLOCKS : 1;
    this.lastResult = "rompiendo bloques";
    (async () => {
      const broken: string[] = [];
      let stop = "";
      while (broken.length < limit && Date.now() < deadline && this.buildActive(generation)) {
        const targets = this.digCandidates(bot, this.opponent(bot), this.digTarget);
        if (typeof targets === "string") {
          if (broken.length === 0) stop = targets;
          break;
        }
        const block = targets[0];
        if (!block) break;
        const outcome = await this.digOne(bot, block, generation);
        if (outcome !== null) {
          stop = outcome;
          break;
        }
        broken.push(block.name.replaceAll("_", " "));
        this.lastResult = `rompiste ${broken.length} bloques`;
      }
      return { broken, stop };
    })()
      .then(({ broken, stop }) => {
        if (!this.buildActive(generation)) return;
        if (broken.length === 0) {
          this.enterWait(bot, stop || "no rompiste ningún bloque");
          return;
        }
        const opponent = this.opponent(bot);
        const still = opponent && this.digTarget === "between" ? this.blocksBetween(bot, opponent).length : 0;
        const tail = stop ? ` (${stop})` : still > 0 ? `; todavía hay ${still} bloques entre tú y el rival` : "";
        this.enterWait(bot, `rompiste ${broken.length} bloques: ${broken.join(", ")}${tail}`);
      })
      .catch((err: unknown) => {
        this.log("warn", `Error al romper bloques: ${errorText(err)}`);
        if (this.buildActive(generation)) this.enterWait(bot, "no pudiste terminar de romper");
      })
      .finally(() => {
        this.digging = false;
        if (chain === this.buildChain) this.buildBusy = false;
      });
  }

  /** Rompe un bloque con la mejor herramienta; null si quedó roto, o el motivo si no. */
  private async digOne(bot: Bot, block: Block, generation: number): Promise<string | null> {
    const name = block.name.replaceAll("_", " ");
    const inventory = bot.inventory.items();
    const toolName = bestDigTool(block.name, inventory.map((item) => item.name));
    const tool = toolName ? inventory.find((item) => item.name === toolName) : undefined;
    if (tool && bot.heldItem?.name !== tool.name) {
      try {
        await bot.equip(tool, "hand");
      } catch {
        // Sin la herramienta igual se puede romper, más lento.
      }
    }
    if (!this.buildActive(generation)) return "se interrumpió";
    const ms = bot.digTime(block);
    if (!Number.isFinite(ms) || ms > DIG_MAX_SECONDS * 1000) {
      const seconds = Number.isFinite(ms) ? `${round1(ms / 1000)} s` : "demasiado";
      return `romper ${name} con lo que tienes tomaría ${seconds}`;
    }
    this.digging = true;
    try {
      await Promise.race([bot.dig(block, true), delay(ms + 2000)]);
    } catch {
      // Cortado (otra acción) o rechazado por el servidor: se revisa el mundo abajo.
    } finally {
      this.digging = false;
    }
    const after = bot.blockAt(block.position);
    if (after && isBreakable(after.name)) {
      try {
        bot.stopDigging();
      } catch {
        // nada
      }
      return `no se pudo romper ${name}`;
    }
    return null;
  }

  private buildActive(generation: number): boolean {
    return generation === this.buildGeneration && this.alive && !this.stopped && !this.ended;
  }

  /** Un bloque no se puede poner donde hay un luchador parado (ni el rival ni uno mismo). */
  private cellOccupied(bot: Bot, cell: Vec3Like): boolean {
    // Un luchador ocupa de sus pies a 1.8 bloques más arriba: el techo de la caja, sobre su
    // cabeza, no lo toca.
    const near = (position: Vec3Like): boolean =>
      Math.abs(cell.x + 0.5 - position.x) < BUILD_CLEARANCE &&
      Math.abs(cell.z + 0.5 - position.z) < BUILD_CLEARANCE &&
      cell.y < position.y + 1.8 &&
      cell.y + 1 > position.y;
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
    // estimateVelocity deja en cero cualquier muestra sobre 15 bloques/s: es el rival
    // teletransportándose con su perla, no una velocidad con la que adelantar el tiro.
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
