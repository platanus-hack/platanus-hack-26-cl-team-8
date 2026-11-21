import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { ARENA, MAX_HEALTH } from "@phack/protocol";
import type { ChatMessage, LlmResponse, TokenUsage, ToolDef } from "@phack/llm";
import { CommsInbox, MESSAGE_INTERVAL_MS, type InboxSnapshot } from "./comms";
import { computeAim, estimateVelocity, PEARL_LAUNCH_HEIGHT, pearlPitch, type VelocitySample } from "./aim";
import { clampToArena, distance3, distanceXZ, retreatTarget, round1, type Vec3Like } from "./geometry";
import { buildTurnMessages, MAX_HISTORY_MESSAGES, trimHistory } from "./history";
import { profileContext } from "./context-profile";
import {
  ALWAYS_EDIBLE,
  attackCooldownMs,
  bestDigTool,
  FOOD_NAMES,
  isArrow,
  isAxe,
  isBow,
  isBreakable,
  isDrinkPotion,
  isLavaBucket,
  isPearl,
  isShield,
  isSplashPotion,
  isSword,
  isWaterBucket,
} from "./items";
import { keepDistanceTarget, orbitTarget, placeTarget, strafeTarget, type MovePlace } from "./tactics";
import { ConstructionPlan, inside, parseBlueprint, type PlannedBlock } from "./construction";
import { lineOfSight, scanWorld } from "./spatial";
import { describeResources, type ResourceItem } from "./resources";
import { buildObservation, type Observation } from "./observation";
import { ActionPlan, isOpenEnded, QUEUE_STEP_DEFAULT_MS, replyResults, stepSeconds, type PlanStep } from "./plan";
import { buildSystemPrompt } from "./prompt";
import {
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
  THROW_MAX_DISTANCE,
  WATER_BETWEEN_MIN_DISTANCE,
  type DigTarget,
  type MoveStyle,
  type ThrowAt,
  type ParsedToolArgs,
  type PearlTarget,
  type ToolName,
  type WaterPlace,
} from "./tools";
import type { DecisionReport, Fighter, FighterOptions } from "./types";
import { countedAbsorption, storeAttributes } from "./vitals";

// mineflayer y mineflayer-pathfinder son CommonJS puro. Se cargan con createRequire
// (en vez de import ESM) para no depender de la detección de exports con nombre de
// Node; los tipos salen de sus .d.ts mediante `typeof import(...)`.
const requireCjs = createRequire(import.meta.url);
const mineflayer = requireCjs("mineflayer") as typeof import("mineflayer");
const { pathfinder, Movements, goals } = requireCjs("mineflayer-pathfinder") as typeof import("mineflayer-pathfinder");

type Entity = NonNullable<Bot["players"][string]["entity"]>;
type Vec3 = Entity["position"];
type Block = NonNullable<ReturnType<Bot["blockAt"]>>;
type InventoryItem = NonNullable<Bot["heldItem"]>;

/**
 * Tipo de una poción ("healing"), leído de su NBT (`Potion: "minecraft:healing"` en
 * 1.20.4); null si no es poción o no lo trae.
 */
function potionOf(item: InventoryItem | null | undefined): string | null {
  if (!item) return null;
  const nbt = (item as unknown as { nbt?: { value?: Record<string, { value?: unknown }> } }).nbt;
  const raw = nbt?.value?.["Potion"]?.value;
  return typeof raw === "string" ? raw.replace(/^minecraft:/, "") : null;
}

type Mode = ToolName;
type GoalKind = "none" | "follow" | "point" | "center";
type HeldState = "held" | "pending" | "missing";

const CONNECT_TIMEOUT_MS = 30_000;
const LLM_TIMEOUT_MS = 60_000;
const BODY_TICK_MS = 100;
const MELEE_REACH = 3.2;
const FOLLOW_RANGE = 2;
const BOW_CHARGE_MS = 1100;
const BOW_PAUSE_MS = 250;
const EAT_MS = 1800;
/** Lo que tarda beber una poción (32 ticks) más un margen. */
const DRINK_MS = 1800;
/** Cada cuánto cambia de lado al esquivar. */
const STRAFE_SWITCH_MS = 1200;
/** Con "guard", el escudo solo se levanta con el rival a esta distancia o menos (más lejos, se persigue a toda velocidad). */
const GUARD_RANGE = 5;
/** Tras bajar el escudo, cuánto se espera antes de pegar (el servidor debe ver el escudo abajo). */
const GUARD_LOWER_MS = 100;
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
/**
 * Un teletransporte forzado solo puede ser el aterrizaje de una perla lanzada hace menos que
 * esto. Dentro del plazo, el primero cuenta como aterrizaje aunque sea corto: con un muro a
 * 1 o 2 bloques la perla cae casi donde está el bot.
 */
const PEARL_LANDING_WINDOW_MS = 2000;
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

const BUILD_PLACE_TIMEOUT_MS = 1500;
const BUILD_CLEARANCE = 0.8;
const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);
const BUILD_REACH = 4.5;
const BUILD_STEP_TIMEOUT_MS = 10_000;
const BUILD_BOUNDS = {
  min: { x: ARENA.center.x - ARENA.radius, y: FLOOR_Y, z: ARENA.center.z - ARENA.radius },
  max: { x: ARENA.center.x + ARENA.radius, y: ARENA.center.y + ARENA.wallHeight, z: ARENA.center.z + ARENA.radius },
};
const WORLD_BOUNDS = {
  min: { x: BUILD_BOUNDS.min.x - 1, y: ARENA.center.y, z: BUILD_BOUNDS.min.z - 1 },
  max: { x: BUILD_BOUNDS.max.x + 1, y: BUILD_BOUNDS.max.y + 1, z: BUILD_BOUNDS.max.z + 1 },
};
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

/** La respuesta del LLM tal cual, para el registro: todas las llamadas, aunque no se ejecuten. */
function rawResponse(response: LlmResponse): DecisionReport["response"] {
  const calls: unknown[] = Array.isArray(response.toolCalls) ? response.toolCalls : [];
  return {
    text: typeof response.text === "string" ? response.text : "",
    toolCalls: calls.map((call) => {
      const { name, args } = (typeof call === "object" && call !== null ? call : {}) as { name?: unknown; args?: unknown };
      return {
        name: typeof name === "string" ? name : "",
        args: typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
      };
    }),
  };
}

class MineflayerFighter implements Fighter {
  private bot: Bot | null = null;
  readonly systemPrompt: string;
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
  /**
   * Vida más corazones amarillos en la última lectura: el daño se mide contra esto, porque
   * lo que absorben los corazones amarillos no baja `bot.health`.
   */
  private lastHealthTotal = 20;
  /** Corazones amarillos que se informaron en el último onStatus. */
  private lastAbsorption = 0;
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
  private sayReadyAt = 0;
  /**
   * Lo que llegó del rival y la conversación. Una línea sale de la bandeja recién cuando
   * responde el LLM que la vio: si la llamada falla, va de nuevo en la próxima observación.
   */
  private readonly inbox = new CommsInbox();

  // Cuerpo (máquina de estados que corre cada BODY_TICK_MS)
  private bodyTimer: ReturnType<typeof setInterval> | null = null;
  private mode: Mode = "wait";
  private modeUntil: number | null = null;
  /** Lo que queda por hacer de la última respuesta que llamó herramientas (ver plan.ts). */
  private readonly plan = new ActionPlan();
  /**
   * true cuando el cuerpo terminó solo la acción en curso (enterWait). El próximo tick del
   * cuerpo empieza entonces la siguiente acción en cola. Se hace en el tick y no dentro de
   * enterWait porque enterWait también corre dentro de cadenas asíncronas (muro, cubo...)
   * que todavía tienen que soltar sus marcas.
   */
  private modeFinished = false;
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
  /** Momento en que partió la acción de un solo uso en curso (perla o construcción). */
  private oneShotStartedAt = 0;
  /** Ticks de física de mineflayer vistos hasta ahora (cada uno envía posición y mirada al servidor). */
  private physicsTicks = 0;

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

  // Construcción y usos de ítems: una sola operación asíncrona del cuerpo a la vez.
  private buildBusy = false;
  /** Sube cada vez que se sale de un modo; una cadena de otra generación se detiene sola. */
  private buildGeneration = 0;
  /** Número de la última cadena lanzada: solo ella suelta `buildBusy` al terminar. */
  private buildChain = 0;
  private construction: ConstructionPlan | null = null;
  private buildCellKey = "";
  private buildNavigationKey = "";
  private buildStepStartedAt = 0;
  // Movimiento táctico ("move").
  private moveStyle: MoveStyle = "strafe";
  private keepDistance = 8;
  private movePlace: MovePlace = "center";
  private strafeSide: 1 | -1 = 1;
  private strafeSwitchAt = 0;
  // Elecciones del modelo: arma, escudo entre golpes, comida, poción y a quién arrojarla.
  private attackWeapon: string | null = null;
  private attackGuard = false;
  /** Momento en que se bajó el escudo para pegar (0 = está arriba o no se usa). */
  private guardLoweredAt = 0;
  private eatFood: string | null = null;
  private potionChoice: string | null = null;
  private throwAt: ThrowAt = "rival";
  private movePosition: Vec3Like | null = null;
  private digPosition: Vec3Like | null = null;
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
    // Solo limpieza técnica (ver cleanMessage): llega tal cual lo escribió el rival.
    this.inbox.hear(kind, text);
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
    this.plan.clear();
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
      this.plan.clear();
      this.modeFinished = false;
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
        if (typeof bot.health === "number" && Number.isFinite(bot.health)) this.lastHealthTotal = this.healthTotal(bot);
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
        this.checkDamage(bot);
        this.emitStatus();
      });
    });

    // Los corazones amarillos llegan en los metadatos de la entidad propia, no en "health":
    // un golpe que solo los gasta no cambia `bot.health` y se detecta aquí.
    bot.on("entityUpdate", (entity) => {
      if (entity !== bot.entity) return;
      this.guard("entityUpdate", () => {
        this.checkDamage(bot);
        if (round1(this.ownAbsorption(bot)) !== this.lastAbsorption) this.emitStatus();
      });
    });

    // Se acabó el efecto de absorción: sus corazones amarillos dejan de contar sin que sea daño.
    bot.on("entityEffectEnd", (entity) => {
      if (entity !== bot.entity) return;
      this.guard("entityEffectEnd", () => {
        if (typeof bot.health === "number" && Number.isFinite(bot.health)) this.lastHealthTotal = this.healthTotal(bot);
        if (round1(this.ownAbsorption(bot)) !== this.lastAbsorption) this.emitStatus();
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
    // le dice a la perla que su mirada ya salió. Sin `guard`: corre 20 veces por segundo y
    // no hace nada que pueda fallar.
    bot.on("physicsTick", () => {
      this.physicsTicks++;
    });

    // El servidor movió al bot a la fuerza. El listener es global (no del modo "pearl")
    // porque el teletransporte ocurre igual aunque el LLM ya haya elegido otra acción, y
    // porque no todo movimiento forzado es una perla: también lo son el `tp` de la
    // preparación, la reaparición y las correcciones del servidor por lag.
    bot.on("forcedMove", () => {
      this.guard("forcedMove", () => {
        const now = Date.now();
        // Siempre: la ruta del pathfinder se calculó desde otro lugar. El modo en curso
        // vuelve a pedir la suya en su próximo tick.
        this.clearGoal(bot);

        // Con una perla propia en vuelo, el primer movimiento forzado es su aterrizaje, sin
        // importar cuánto movió al bot (una perla contra un muro cercano cae casi al lado).
        const pearlInFlight = this.pearlFlightUntil > 0 && now < this.pearlFlightUntil;
        if (!pearlInFlight) return;
        this.pearlFlightUntil = 0;
        this.pearlLandedAt = now;
        this.selfDamageUntil = now + SELF_DAMAGE_WINDOW_MS;
      });
    });

    // mineflayer guarda los atributos de una entidad bajo `prop.key`, pero hasta 1.20.4 ese
    // campo del paquete se llama `name` (recién es `key` desde 1.20.5): quedan todos bajo
    // "undefined" y la física nunca ve el modificador de velocidad, así que Velocidad I no
    // movería más rápido al bot. Aquí se guardan los atributos propios con su nombre (ver
    // storeAttributes).
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
   * con la misma forma que usa mineflayer ({ value, modifiers }), bajo el nombre que manda
   * el servidor y bajo el que busca la física (ver storeAttributes).
   */
  private storeOwnAttributes(bot: Bot, packet: unknown): void {
    const own = bot.entity as unknown as { id?: unknown; attributes?: Record<string, unknown> } | undefined;
    if (!own || typeof packet !== "object" || packet === null) return;
    const { entityId, properties } = packet as { entityId?: unknown; properties?: unknown };
    if (entityId !== own.id || !Array.isArray(properties)) return;
    const attributes = own.attributes ?? {};
    own.attributes = attributes;
    storeAttributes(attributes, properties as unknown[]);
  }

  /**
   * Corazones amarillos propios que cuentan como vida (ver countedAbsorption). Si no se
   * sabe qué número tiene el efecto de absorción, se cuentan los que haya.
   */
  private ownAbsorption(bot: Bot): number {
    const entity = bot.entity;
    if (!entity) return 0;
    const absorption = readAbsorption(entity);
    const effectId = (bot.registry as unknown as { effectsByName?: Record<string, { id?: unknown }> }).effectsByName
      ?.Absorption?.id;
    if (typeof effectId !== "number") return absorption;
    const effects = (entity as unknown as { effects?: Record<number, unknown> }).effects;
    return countedAbsorption(absorption, effects?.[effectId] !== undefined);
  }

  /** Vida más los corazones amarillos que cuentan. */
  private healthTotal(bot: Bot): number {
    const health = typeof bot.health === "number" && Number.isFinite(bot.health) ? bot.health : 0;
    return health + this.ownAbsorption(bot);
  }

  /**
   * Informa el daño recibido desde la última lectura, medido sobre vida + corazones
   * amarillos: un golpe que solo gasta corazones amarillos también es daño del rival.
   */
  private checkDamage(bot: Bot): void {
    const health = bot.health;
    if (typeof health !== "number" || !Number.isFinite(health)) return;
    const total = this.healthTotal(bot);
    if (this.alive && total < this.lastHealthTotal && !this.stopped) {
      const amount = round1(this.lastHealthTotal - total);
      const rounded = round1(health);
      // La caída de la perla propia es una sola baja de vida, justo después de
      // aterrizar: la ventana se consume con ella para no quitarle golpes al rival.
      const bySelf = Date.now() < this.selfDamageUntil;
      this.selfDamageUntil = 0;
      this.safe(() => this.opts.events.onDamageTaken(amount, rounded, bySelf));
    }
    this.lastHealthTotal = total;
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
    const absorption = bot && this.alive ? round1(this.ownAbsorption(bot)) : 0;
    this.lastAbsorption = absorption;
    const status = {
      connected: this.connected,
      alive: this.alive,
      health: this.alive ? round1(health) : 0,
      absorption,
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

    const heard = this.inbox.snapshot();
    const observation = this.observe(bot, heard);
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
    // El LLM respondió: lo que vio del rival ya no se repite.
    this.inbox.confirm(heard.upTo);
    if (this.stopped) return;

    // Latencia, tokens, lo que vio y lo que respondió: se informan antes de actuar, una vez por respuesta.
    const report: DecisionReport = {
      ms: Date.now() - llmStartedAt,
      contextProfile: profileContext(messages, this.toolDefs),
      observation,
      response: rawResponse(response),
    };
    const usage = validUsage(response.usage);
    if (usage) report.usage = usage;
    this.safe(() => this.opts.events.onDecision(report));

    const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    const text = typeof response.text === "string" ? response.text : "";
    const normalized: LlmResponse = { text, toolCalls };

    // Sin herramientas no cambia nada: el cuerpo sigue con su acción y con su cola.
    let ran: string[] = [];
    if (toolCalls.length > 0) {
      this.plan.replace(toolCalls);
      this.modeFinished = false;
      ran = this.runQueued(text.trim()).results;
    } else if (text.trim().length > 0) {
      this.safe(() => this.opts.events.onThought(text.trim()));
    }

    const results = replyResults(toolCalls.length, ran);
    const turn = buildTurnMessages(observationJson, normalized, (index) => results[index] ?? "");
    this.history = trimHistory([...this.history, ...turn], MAX_HISTORY_MESSAGES);
  }

  /**
   * Empieza la siguiente acción de la cola. Una que no se puede usar ahora no la traba:
   * queda su resultado y se sigue con la próxima. Devuelve los resultados en orden.
   * `thought` es lo que se muestra como pensamiento si la primera no trae "reason".
   * `started` dice si alguna empezó.
   */
  private runQueued(thought: string): { results: string[]; started: boolean } {
    const results: string[] = [];
    let fallback = thought;
    for (let step = this.plan.next(); step; step = this.plan.next()) {
      const { result, started } = this.runStep(step, fallback);
      fallback = "";
      results.push(result);
      if (started) return { results, started };
    }
    return { results, started: false };
  }

  /** Ejecuta una llamada: su "reason" y su "say" salen al empezar ella, no antes. */
  private runStep(step: PlanStep, fallbackThought: string): { result: string; started: boolean } {
    const parsed = parseToolArgs(step.args);
    const thought = parsed.reason ?? fallbackThought;
    if (thought.length > 0) this.safe(() => this.opts.events.onThought(thought));
    const said = this.opts.comms === "chat" ? parsed.say : null;
    const canSay = Date.now() >= this.sayReadyAt;
    if (said && canSay) {
      this.sayReadyAt = Date.now() + MESSAGE_INTERVAL_MS;
      this.inbox.said(said);
      this.safe(() => this.opts.events.onMessage(said));
    }

    const args: ParsedToolArgs = { ...parsed, seconds: stepSeconds(step.name, parsed.seconds, this.plan.hasNext()) };
    let result: string;
    try {
      result = this.executeTool(step.name, args);
    } catch (err) {
      result = `error al ejecutar la acción: ${errorText(err)}`;
      this.log("warn", `Error ejecutando "${step.name}": ${errorText(err)}`);
    }
    // Si el cuerpo quedó en esa acción, empezó (o continúa); si no, no se pudo usar.
    const started = this.mode === step.name;
    if (said && !canSay) result += "; mensaje no enviado: espera a que termine sayCooldown";
    this.safe(() => this.opts.events.onAction(step.name, step.args, result));
    return { result, started };
  }

  private observe(bot: Bot, heard: InboxSnapshot): Observation {
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
      queuedActions: this.plan.pending(),
      pearlReadyAt: this.pearlReadyAt,
      terrain: this.terrain(bot, opponent),
      world: scanWorld(WORLD_BOUNDS, (p) => this.readWorldCell(bot, p), (p) => inside(p, BUILD_BOUNDS), {
        center: bot.entity.position, radius: this.opts.observationRadius ?? 16,
      }),
      buildBounds: BUILD_BOUNDS,
      resources: describeResources(this.resourceItems(bot), {
        health: bot.health, food: bot.food, absorption: readAbsorption(bot.entity),
        pearlCooldown: Math.max(0, (this.pearlReadyAt - Date.now()) / 1000), tools: this.toolNames,
      }),
      equipment: this.equipment(bot),
      motion: { velocity: bot.entity.velocity, yaw: bot.entity.yaw, pitch: bot.entity.pitch, onGround: bot.entity.onGround },
      effects: Object.values(bot.entity.effects ?? {}).map((effect) => ({
        id: effect.id, name: bot.registry.effects[effect.id]?.name ?? String(effect.id), amplifier: effect.amplifier, durationTicks: effect.duration,
      })),
      opponentState: opponent ? {
        position: opponent.position, velocity: this.opponentVelocity, yaw: opponent.yaw, pitch: opponent.pitch,
        lineOfSight: lineOfSight(bot.entity.position.offset(0, EYE_HEIGHT, 0), opponent.position.offset(0, EYE_HEIGHT, 0), (p) => this.readWorldCell(bot, p)),
        equipment: opponent.equipment.map((item) => item ? { name: item.name, count: item.count } : null),
      } : null,
      construction: this.construction?.snapshot() ?? null,
      nearbyEntities: Object.values(bot.entities).filter((entity) => entity.id !== bot.entity.id && distanceXZ(entity.position, bot.entity.position) <= (this.opts.observationRadius ?? 16)).map((entity) => {
        const item = entity.name === "item" ? entity.getDroppedItem() : null;
        return { id: entity.id, name: entity.username ?? entity.name ?? "unknown", type: entity.type, position: entity.position, velocity: entity.velocity, ...(item ? { item: { name: item.name, count: item.count } } : {}) };
      }),

      rivalThoughts: heard.rivalThoughts,
      rivalMessages: heard.rivalMessages,
      // La conversación solo existe en modo "chat".
      conversation: this.opts.comms === "chat" ? heard.conversation : [],
      sayReadyAt: this.opts.comms === "chat" ? this.sayReadyAt : undefined,
    });
  }

  private readWorldCell(bot: Bot, position: Vec3Like) {
    const block = bot.blockAt(this.vec(bot, position.x, position.y, position.z));
    return block ? { name: block.name, solid: block.boundingBox === "block" } : null;
  }

  private resourceItem(item: InventoryItem): ResourceItem {
    const potion = potionOf(item);
    return {
      name: potion ? `${item.name}:${potion}` : item.name,
      count: item.count, slot: item.slot,
      ...(item.maxDurability > 0 ? { durabilityUsed: item.durabilityUsed, maxDurability: item.maxDurability } : {}),
      enchantments: item.enchants.map((enchantment) => ({ name: enchantment.name, level: enchantment.lvl })),
    };
  }

  private resourceItems(bot: Bot): ResourceItem[] {
    const items = bot.inventory.items();
    const offhand = bot.inventory.slots[OFFHAND_SLOT];
    if (offhand && !items.some((item) => item.slot === OFFHAND_SLOT)) items.push(offhand);
    return items.map((item) => this.resourceItem(item));
  }

  private equipment(bot: Bot) {
    return Object.fromEntries(([ ["head", 5], ["chest", 6], ["legs", 7], ["feet", 8], ["offhand", OFFHAND_SLOT] ] as const).map(([name, slot]) => {
      const item = bot.inventory.slots[slot];
      return [name, item ? this.resourceItem(item) : null];
    }));
  }

  private startConstruction(bot: Bot, args: ParsedToolArgs): string {
    let plan = this.construction;
    if (args.blocks !== undefined) {
      const blocks = parseBlueprint(args.blocks, BUILD_BOUNDS);
      if (typeof blocks === "string") return refusalText(blocks, this.mode);
      if (!plan || JSON.stringify(plan.blocks) !== JSON.stringify(blocks)) plan = new ConstructionPlan(blocks);
    }
    if (!plan) return refusalText("no hay un plano pendiente: envía blocks con coordenadas y materiales", this.mode);
    if (plan.snapshot().status === "complete") return refusalText("ese plano ya está completo; envía un plano nuevo para construir o reparar", this.mode);
    if (this.mode !== "build" || this.construction !== plan) {
      this.leaveMode(bot);
      this.construction = plan;
      this.mode = "build";
      this.modeUntil = null;
      this.buildCellKey = "";
      this.buildNavigationKey = "";
    }
    plan.resume();
    const progress = plan.snapshot();
    this.lastResult = `construcción libre: ${progress.completed}/${progress.total} bloques; consulta construction para ver el plano y sus obstáculos`;
    return this.lastResult;
  }

  private constructionSupport(bot: Bot, cell: PlannedBlock, reachable: boolean) {
    const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0);
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const block = bot.blockAt(this.vec(bot, cell.x + dx!, cell.y + dy!, cell.z + dz!));
      if (!block || block.boundingBox !== "block") continue;
      const face = this.vec(bot, -dx!, -dy!, -dz!);
      const aim = block.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      if (reachable) {
        const delta = aim.minus(eye);
        if (delta.norm() > BUILD_REACH) continue;
        if (!lineOfSight(eye, aim, (p) => this.readWorldCell(bot, p))) continue;
      }
      return { block, face, aim };
    }
    return null;
  }

  private prepareConstruction(bot: Bot, cell: PlannedBlock): { status: "ready" | "moving" | "blocked"; reason?: string } {
    const key = `${cell.x},${cell.y},${cell.z}`;
    if (this.buildCellKey !== key) {
      this.buildCellKey = key;
      this.buildStepStartedAt = Date.now();
    }
    if (Date.now() - this.buildStepStartedAt > BUILD_STEP_TIMEOUT_MS) return { status: "blocked", reason: "no pude llegar o equipar el material en 10 s; cambia el plano o muévete" };
    if (!this.constructionSupport(bot, cell, false)) return { status: "blocked", reason: "falta un bloque vecino de apoyo; ponlo antes en el plano" };
    if (!this.constructionSupport(bot, cell, true)) {
      if (this.buildNavigationKey !== key) {
        // El .d.ts de pathfinder exige faces/facing, pero su implementación los hace opcionales.
        const options = { range: BUILD_REACH, LOS: true } as ConstructorParameters<typeof goals.GoalPlaceBlock>[2];
        bot.pathfinder.setGoal(new goals.GoalPlaceBlock(this.vec(bot, cell.x, cell.y, cell.z), bot.world, options));
        this.goalKind = "point";
        this.followTarget = null;
        this.buildNavigationKey = key;
      }
      return { status: "moving", reason: `buscando una posición con alcance y línea de visión para ${key}` };
    }
    this.clearGoal(bot);
    this.buildNavigationKey = "";
    const held = this.ensureHeld(bot, (name) => name === cell.material);
    if (held !== "held") return { status: held === "missing" ? "blocked" : "moving", reason: `equipando ${cell.material}` };
    return { status: "ready" };
  }

  private tickConstruction(bot: Bot): void {
    const plan = this.construction;
    if (!plan || this.buildBusy) return;
    const generation = this.buildGeneration;
    const active = () => this.buildActive(generation) && this.mode === "build" && this.construction === plan;
    void plan.step({
      read: (p) => bot.blockAt(this.vec(bot, p.x, p.y, p.z))?.name ?? null,
      occupied: (p) => this.cellOccupied(bot, p),
      count: (material) => this.countItems(bot, (name) => name === material),
      prepare: (cell) => this.prepareConstruction(bot, cell),
      place: async (cell) => {
        const support = this.constructionSupport(bot, cell, true);
        if (!support) throw new Error("el apoyo dejó de estar al alcance");
        const chain = ++this.buildChain;
        this.buildBusy = true;
        try {
          await bot.lookAt(support.aim, true);
          if (!active()) return;
          // Timeout no significa éxito: ConstructionPlan verifica el bloque en el mundo.
          await Promise.race([bot.placeBlock(support.block, support.face), delay(BUILD_PLACE_TIMEOUT_MS)]);
        } finally {
          if (chain === this.buildChain) this.buildBusy = false;
        }
      },
    }, active).then(() => {
      if (!active()) return;
      const progress = plan.snapshot();
      this.lastResult = `construcción: ${progress.completed}/${progress.total}${progress.reason ? `; ${progress.reason}` : ""}`;
      if (progress.status === "blocked" || progress.status === "complete") this.enterWait(bot, `${progress.status === "complete" ? "plano completo" : "plano bloqueado"}: ${this.lastResult}`);
    }).catch((error: unknown) => {
      if (active()) this.enterWait(bot, `error al construir: ${errorText(error)}`);
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
    if ((name === "move" || name === "dig") && args.positionInvalid) return refusalText("position debe contener x, y, z numéricos finitos", this.mode);
    if (name === "move" && args.position && args.style !== "goto") return refusalText("usa style=goto para moverte a position", this.mode);
    if (name === "move" && args.position && !inside(args.position, { min: BUILD_BOUNDS.min, max: { ...BUILD_BOUNDS.max, y: BUILD_BOUNDS.max.y - 1 } })) return refusalText("destino fuera de la arena o sin altura para tu cuerpo", this.mode);
    if (name === "build") return this.startConstruction(bot, args);
    const sameDig = name !== "dig" || (args.digTarget === this.digTarget && JSON.stringify(args.position) === JSON.stringify(this.digPosition));
    if (name === this.mode && sameDig) {
      // Repetir la herramienta continúa la acción en curso (no reinicia cargas ni comidas),
      // pero sí toma los argumentos nuevos que cambian cómo se hace.
      if (isOpenEnded(name)) this.modeUntil = args.seconds !== null ? now + args.seconds * 1000 : null;
      if (name === "attack") {
        this.attackWeapon = args.weapon;
        this.attackGuard = args.guard;
      }
      if (name === "move") {
        this.moveStyle = args.style;
        this.keepDistance = args.distance;
        this.movePlace = args.place;
        this.movePosition = args.position;
        this.lastRetreatPlanAt = 0;
      }
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
      case "attack": {
        const chosen = args.weapon && itemNames.includes(args.weapon) ? args.weapon : null;
        const missing = args.weapon && !chosen ? `no tienes ${args.weapon}; ` : "";
        const how = chosen
          ? `con ${chosen.replaceAll("_", " ")}`
          : has(isSword)
            ? "con la espada"
            : has(isAxe)
              ? "con el hacha"
              : "sin arma";
        const guard = args.guard ? (this.hasShield(bot) ? ", cubriéndote con el escudo entre golpes" : " (no tienes escudo para cubrirte)") : "";
        result = `${missing}atacando cuerpo a cuerpo ${how}${guard}`;
        break;
      }
      case "move": {
        if (args.style !== "goto" && !opponent) return refusalText("no ves al rival: no hay respecto de quién moverte", this.mode);
        result =
          args.style === "strafe"
            ? "esquivando de lado a lado"
            : args.style === "circle"
              ? "rodeando al rival"
              : args.style === "keep"
                ? `manteniéndote a ${args.distance} bloques del rival`
                : `yendo a ${args.place === "center" ? "el centro" : args.place === "far_corner" ? "la esquina más lejos del rival" : "detrás del rival"}`;
        break;
      }
      case "drink": {
        const potions = this.potionsIn(bot, isDrinkPotion);
        if (potions.length === 0) return refusalText("no te quedan pociones para beber", this.mode);
        if (args.potion && !potions.includes(args.potion)) {
          return refusalText(`no tienes poción de ${args.potion} para beber; tienes: ${potions.join(", ")}`, this.mode);
        }
        result = `bebiendo poción de ${args.potion ?? potions[0]}`;
        break;
      }
      case "throw": {
        const potions = this.potionsIn(bot, isSplashPotion);
        if (potions.length === 0) return refusalText("no te quedan pociones arrojadizas", this.mode);
        if (args.potion && !potions.includes(args.potion)) {
          return refusalText(`no tienes poción arrojadiza de ${args.potion}; tienes: ${potions.join(", ")}`, this.mode);
        }
        if (args.at === "rival") {
          if (!opponent) return refusalText("no ves al rival: no hay a quién arrojarle la poción", this.mode);
          const dist = round1(distance3(bot.entity.position, opponent.position));
          if (dist > THROW_MAX_DISTANCE) return refusalText(`el rival está a ${dist} bloques: la poción no llega (máximo ${THROW_MAX_DISTANCE})`, this.mode);
        }
        result = `arrojando poción de ${args.potion ?? potions[0]} ${args.at === "self" ? "a tus pies" : "al rival"}`;
        break;
      }
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
        if (args.food) {
          if (!itemNames.includes(args.food) || !this.isFood(bot, args.food)) {
            return refusalText(`no tienes ${args.food} para comer`, this.mode);
          }
          if (bot.food >= 20 && !ALWAYS_EDIBLE.has(args.food)) {
            return refusalText(`no puedes comer ${args.food}: no tienes hambre (comida 20/20)`, this.mode);
          }
        }
        result = args.food ? `empezando a comer ${args.food.replaceAll("_", " ")}` : "empezando a comer";
        break;
      }
      case "pearl": {
        const refusal = this.pearlRefusal(bot, opponent, args.target, now);
        if (refusal) return refusalText(refusal, this.mode);
        result =
          args.target === "away" ? "preparando la perla para alejarte del rival" : "preparando la perla para caer junto al rival";
        break;
      }
      case "dig": {
        const targets = this.digCandidates(bot, opponent, args.digTarget, args.position);
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
    this.modeUntil = isOpenEnded(name) && args.seconds !== null ? now + args.seconds * 1000 : null;
    this.hits = 0;
    this.shots = 0;
    this.nextShotAt = 0;
    this.lastRetreatPlanAt = 0;
    this.oneShotStartedAt = now;
    this.pearlTarget = args.target;
    this.waterPlace = args.where;
    this.digTarget = args.digTarget;
    this.digPosition = args.position;
    this.movePosition = args.position;
    this.moveStyle = args.style;
    this.keepDistance = args.distance;
    this.movePlace = args.place;
    this.strafeSwitchAt = now + STRAFE_SWITCH_MS;
    this.attackWeapon = args.weapon;
    this.attackGuard = args.guard;
    this.guardLoweredAt = 0;
    this.eatFood = args.food;
    this.potionChoice = args.potion;
    this.throwAt = args.at;
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

  /**
   * Bloques que rompería "dig" (el primero es el siguiente), o por qué no hay ninguno.
   * "between": los que cortan la recta hasta el rival, a la altura de los pies o de la
   * cabeza. "nearest": el más cercano. Siempre dentro del alcance y nunca de la arena.
   */
  private digCandidates(bot: Bot, opponent: Entity | null, target: DigTarget, position: Vec3Like | null = null): Block[] | string {
    const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0);
    const reachable = (block: Block): boolean => distance3(eye, block.position.offset(0.5, 0.5, 0.5)) <= DIG_REACH;
    if (position) {
      if (![position.x, position.y, position.z].every(Number.isSafeInteger) || !inside(position, BUILD_BOUNDS)) return "bloque fuera del volumen modificable o coordenadas no enteras";
      const block = bot.blockAt(this.vec(bot, position.x, position.y, position.z));
      if (!block || !isBreakable(block.name)) return "ese bloque no se puede romper";
      if (!reachable(block)) return "bloque fuera de alcance: usa move con position para acercarte";
      return [block];
    }
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
        if (seen.has(key) || !inside({ x, y, z }, BUILD_BOUNDS)) continue;
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
          if (!block || !inside(block.position, BUILD_BOUNDS) || !isBreakable(block.name)) continue;
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

  /**
   * Inventario para la observación: items() no trae la mano secundaria, donde va el
   * escudo. Las pociones van con su tipo ("potion:healing"), que es lo que elige el modelo.
   */
  private inventoryWithOffhand(bot: Bot): { name: string; count: number }[] {
    return this.resourceItems(bot).map(({ name, count }) => ({ name, count }));
  }

  /** Tipos de las pociones del inventario que calzan con `match` (bebibles o arrojadizas), sin repetir. */
  private potionsIn(bot: Bot, match: (name: string) => boolean): string[] {
    const types = new Set<string>();
    for (const item of bot.inventory.items()) {
      if (!match(item.name)) continue;
      const potion = potionOf(item);
      if (potion) types.add(potion);
    }
    return [...types];
  }

  /** ¿Tiene un escudo, en la mano secundaria o en el inventario? */
  private hasShield(bot: Bot): boolean {
    if (bot.inventory.slots[OFFHAND_SLOT]?.name === "shield") return true;
    return bot.inventory.items().some((item) => isShield(item.name));
  }

  private enterWait(bot: Bot, result: string): string {
    this.leaveMode(bot);
    this.mode = "wait";
    this.modeUntil = null;
    this.lastResult = result;
    // El cuerpo terminó la acción por su cuenta: en el próximo tick sigue la cola.
    this.modeFinished = true;
    return result;
  }

  /** Limpia lo que el modo actual dejó a medias (uso de ítem, ruta del pathfinder, construcción a medio poner). */
  private leaveMode(bot: Bot): void {
    this.construction?.pause();
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
    this.construction = null;
    this.mode = "wait";
    this.modeUntil = null;
    // Morir o reaparecer corta lo que quedaba en cola.
    this.plan.clear();
    this.modeFinished = false;
    this.using = false;
    // La operación pendiente se corta sola al cambiar la generación; la marca se suelta ya,
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
    if (this.modeFinished) {
      this.modeFinished = false;
      if (this.mode === "wait" && this.plan.hasNext()) {
        const { results, started } = this.runQueued("");
        // Si ninguna pudo empezar, la observación cuenta por qué no se pudo la última.
        const last = results[results.length - 1];
        if (!started && last !== undefined) this.lastResult = last;
      }
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
      case "move":
        this.tickMove(bot, opponent, now);
        break;
      case "drink":
        this.tickDrink(bot, now);
        break;
      case "throw":
        this.tickThrow(bot, opponent, now);
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
        this.tickConstruction(bot);
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
    // El arma que eligió el modelo; si no eligió (o no la tiene), espada; si no hay, hacha;
    // si no, a puño limpio.
    const items = bot.inventory.items();
    const chosen = this.attackWeapon;
    if (chosen && items.some((item) => item.name === chosen)) this.ensureHeld(bot, (name) => name === chosen);
    else if (items.some((item) => isSword(item.name))) this.ensureHeld(bot, isSword);
    else if (items.some((item) => isAxe(item.name))) this.ensureHeld(bot, isAxe);

    this.follow(bot, opponent);
    const dist = distance3(bot.entity.position, opponent.position);
    // La recarga depende del arma que está en la mano (un hacha es más lenta que una espada).
    const ready = now - this.lastAttackAt >= attackCooldownMs(heldItemName(bot));
    const guarding = this.attackGuard && bot.inventory.slots[OFFHAND_SLOT]?.name === "shield";
    if (dist <= MELEE_REACH) this.look(bot, opponent.position.offset(0, EYE_HEIGHT, 0));
    if (guarding) {
      // Con escudo no se puede pegar: se baja justo antes del golpe y se vuelve a subir
      // mientras el arma recarga (o mientras el rival se acerca).
      if (dist <= MELEE_REACH && ready) {
        if (this.using) {
          bot.deactivateItem();
          this.using = false;
          this.guardLoweredAt = now;
        } else if (now - this.guardLoweredAt >= GUARD_LOWER_MS) {
          this.lastAttackAt = now;
          bot.attack(opponent);
          this.hits++;
        }
      } else if (dist <= GUARD_RANGE && !this.using) {
        bot.activateItem(true);
        this.using = true;
        this.useStartedAt = now;
      } else if (dist > GUARD_RANGE && this.using) {
        // Lejos, el escudo solo frena la persecución.
        bot.deactivateItem();
        this.using = false;
      }
    } else if (dist <= MELEE_REACH && ready) {
      this.lastAttackAt = now;
      bot.attack(opponent);
      this.hits++;
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

  /**
   * Movimiento táctico: cada RETREAT_REPLAN_MS vuelve a calcular el punto (el rival se
   * mueve) y se lo da al pathfinder. Las cuentas están en tactics.ts.
   */
  private tickMove(bot: Bot, opponent: Entity | null, now: number): void {
    if (this.moveStyle !== "goto" && !opponent) {
      this.clearGoal(bot);
      this.lastResult = "rival no visible; te quedas donde estás";
      return;
    }
    if (now - this.lastRetreatPlanAt < RETREAT_REPLAN_MS) return;
    this.lastRetreatPlanAt = now;
    if (now >= this.strafeSwitchAt) {
      this.strafeSide = this.strafeSide === 1 ? -1 : 1;
      this.strafeSwitchAt = now + STRAFE_SWITCH_MS;
    }
    const self = bot.entity.position;
    const arena = { center: ARENA.center, radius: ARENA.radius };
    const rival = opponent ? opponent.position : null;
    const dist = rival ? round1(distance3(self, rival)) : null;
    let target: Vec3Like;
    switch (this.moveStyle) {
      case "strafe":
        target = strafeTarget(self, rival as Vec3, this.strafeSide, arena);
        this.lastResult = `esquivando de lado (rival a ${dist} bloques)`;
        break;
      case "circle":
        // Siempre en el mismo sentido: rodear es dar la vuelta, no ir y volver.
        target = orbitTarget(self, rival as Vec3, 1, arena);
        this.lastResult = `rodeando al rival (a ${dist} bloques)`;
        break;
      case "keep": {
        const point = keepDistanceTarget(self, rival as Vec3, this.keepDistance, arena);
        // Ya a la distancia pedida: se esquiva de lado para no ser un blanco quieto.
        target = point ?? strafeTarget(self, rival as Vec3, this.strafeSide, arena);
        this.lastResult = point
          ? `${(dist ?? 0) > this.keepDistance ? "acercándote" : "alejándote"} hasta quedar a ${this.keepDistance} bloques (ahora a ${dist})`
          : `a ${dist} bloques del rival, como querías; esquivando de lado`;
        break;
      }
      case "goto":
        target = this.movePosition ?? placeTarget(this.movePlace, self, rival, arena);
        this.lastResult =
          distanceXZ(self, target) <= 1.5
            ? "llegaste al lugar"
            : `yendo al lugar (te faltan ${round1(distanceXZ(self, target))} bloques)`;
        break;
    }
    bot.pathfinder.setGoal(new goals.GoalNear(target.x, Math.floor(self.y), target.z, 1));
    this.goalKind = "point";
    this.followTarget = null;
  }

  /** Beber: como comer, pero con la poción del tipo elegido. */
  private tickDrink(bot: Bot, now: number): void {
    if (this.using) {
      if (now - this.useStartedAt >= DRINK_MS) {
        this.using = false;
        try {
          bot.deactivateItem();
        } catch {
          // nada
        }
        this.enterWait(bot, `bebiste la poción (vida ${round1(bot.health)}/${MAX_HEALTH})`);
      }
      return;
    }
    const chosen = this.potionChoice;
    const held = this.ensureHeldItem(bot, (item) => isDrinkPotion(item.name) && (!chosen || potionOf(item) === chosen));
    if (held === "missing") {
      this.enterWait(bot, chosen ? `no te quedan pociones de ${chosen}` : "no te quedan pociones para beber");
      return;
    }
    if (held === "pending") {
      if (now - this.oneShotStartedAt >= EQUIP_TIMEOUT_MS) this.enterWait(bot, "no pudiste sacar la poción");
      return;
    }
    this.clearGoal(bot);
    bot.activateItem();
    this.using = true;
    this.useStartedAt = now;
    this.lastResult = "bebiendo (tarda unos 2 segundos)";
  }

  /** Arrojar una poción: sacarla, mirar (a los pies del rival o hacia abajo) y lanzarla. */
  private tickThrow(bot: Bot, opponent: Entity | null, now: number): void {
    if (this.buildBusy) return;
    const chosen = this.potionChoice;
    const held = this.ensureHeldItem(bot, (item) => isSplashPotion(item.name) && (!chosen || potionOf(item) === chosen));
    if (held === "missing") {
      this.enterWait(bot, chosen ? `no te quedan pociones arrojadizas de ${chosen}` : "no te quedan pociones arrojadizas");
      return;
    }
    this.clearGoal(bot);
    bot.clearControlStates();
    if (held === "pending") {
      if (now - this.oneShotStartedAt >= EQUIP_TIMEOUT_MS) this.enterWait(bot, "no pudiste sacar la poción");
      return;
    }
    const self = bot.entity.position;
    let aim: Vec3;
    if (this.throwAt === "self") {
      aim = self.offset(0, -1, 0);
    } else {
      if (!opponent) {
        this.enterWait(bot, "no ves al rival: no lanzaste la poción");
        return;
      }
      // Un poco por encima de sus pies: la poción cae en arco.
      const dist = distance3(self, opponent.position);
      aim = opponent.position.offset(0, Math.min(2, dist * 0.15), 0);
    }
    const generation = ++this.buildGeneration;
    const chain = ++this.buildChain;
    this.buildBusy = true;
    const potion = potionOf(bot.heldItem) ?? "?";
    (async () => {
      await bot.lookAt(aim, true);
      if (!this.buildActive(generation)) return false;
      bot.activateItem();
      await delay(150);
      return true;
    })()
      .then((thrown) => {
        if (!thrown || !this.buildActive(generation)) return;
        this.enterWait(bot, `arrojaste la poción de ${potion} ${this.throwAt === "self" ? "a tus pies" : "al rival"}`);
      })
      .catch((err: unknown) => {
        this.log("warn", `Error al arrojar la poción: ${errorText(err)}`);
        if (this.buildActive(generation)) this.enterWait(bot, "no pudiste arrojar la poción");
      })
      .finally(() => {
        if (chain === this.buildChain) this.buildBusy = false;
      });
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
        this.enterWait(bot, `terminaste de comer (comida ${round1(bot.food)}/20, vida ${round1(bot.health)}/${MAX_HEALTH})`);
      }
      return;
    }
    // Con la barra de hambre llena el servidor solo deja comer ciertas comidas (manzana dorada).
    const full = bot.food >= 20;
    const chosen = this.eatFood;
    const held = this.ensureHeld(bot, (name) =>
      chosen ? name === chosen : full ? ALWAYS_EDIBLE.has(name) : this.isFood(bot, name),
    );
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
    // Cayó junto al rival: pasa directo a atacar, sin esperar la próxima decisión. Si hay
    // otra acción en cola, ataca lo mismo que cualquier acción que no termina sola antes de otra.
    this.mode = "attack";
    this.modeUntil = this.plan.hasNext() ? Date.now() + QUEUE_STEP_DEFAULT_MS : null;
    this.hits = 0;
    this.pearlNote = `te teletransportaste junto al rival (${where}); `;
    this.lastResult = `${this.pearlNote}atacando`;
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
    const limit = this.digPosition ? 1 : this.digTarget === "between" ? DIG_MAX_BLOCKS : 1;
    this.lastResult = "rompiendo bloques";
    (async () => {
      const broken: string[] = [];
      let stop = "";
      while (broken.length < limit && Date.now() < deadline && this.buildActive(generation)) {
        const targets = this.digCandidates(bot, this.opponent(bot), this.digTarget, this.digPosition);
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
    if (!after || !AIR_BLOCKS.has(after.name)) {
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
    return this.ensureHeldItem(bot, (item) => match(item.name));
  }

  /** Igual que ensureHeld, pero mirando el ítem entero (las pociones se distinguen por su tipo). */
  private ensureHeldItem(bot: Bot, match: (item: InventoryItem) => boolean): HeldState {
    const held = bot.heldItem;
    if (held && match(held)) return "held";
    const item = bot.inventory.items().find((candidate) => match(candidate));
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
