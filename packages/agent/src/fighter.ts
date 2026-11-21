import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { ARENA } from "@phack/protocol";
import type { ChatMessage, LlmResponse } from "@phack/llm";
import { computeAim, estimateVelocity, type VelocitySample } from "./aim";
import { distance3, retreatTarget, round1, type Vec3Like } from "./geometry";
import { buildTurnMessages, MAX_HISTORY_MESSAGES, trimHistory } from "./history";
import { buildObservation, type Observation } from "./observation";
import { buildSystemPrompt } from "./prompt";
import { isToolName, parseToolArgs, TOOL_DEFS, type ParsedToolArgs, type ToolName } from "./tools";
import type { Fighter, FighterOptions } from "./types";

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
const LLM_TIMEOUT_MS = 20_000;
const BODY_TICK_MS = 100;
/** Recarga de la espada (velocidad de ataque 1.6/s = 625 ms). */
const ATTACK_COOLDOWN_MS = 625;
const MELEE_REACH = 3.2;
const FOLLOW_RANGE = 2;
const BOW_CHARGE_MS = 1100;
const BOW_PAUSE_MS = 250;
const EAT_MS = 1800;
const RETREAT_REPLAN_MS = 400;
const EYE_HEIGHT = 1.62;

const FALLBACK_FOODS = new Set([
  "bread",
  "cooked_beef",
  "cooked_porkchop",
  "cooked_chicken",
  "cooked_mutton",
  "cooked_salmon",
  "cooked_cod",
  "baked_potato",
  "golden_carrot",
  "golden_apple",
  "enchanted_golden_apple",
  "apple",
  "carrot",
  "melon_slice",
  "cookie",
  "pumpkin_pie",
]);
/** Comidas que se pueden comer aunque la barra de hambre esté llena. */
const ALWAYS_EDIBLE = new Set(["golden_apple", "enchanted_golden_apple", "chorus_fruit"]);

const isSword = (name: string): boolean => name.endsWith("_sword");
const isAxe = (name: string): boolean => name.endsWith("_axe");
const isBow = (name: string): boolean => name === "bow";
const isArrow = (name: string): boolean => name === "arrow" || name.endsWith("_arrow");

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
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

  // Ciclo de vida
  private stopped = false;
  private started = false;
  private spawnedOnce = false;
  private connected = false;
  private ended = false;
  private alive = false;
  private lastHealth = 20;
  private connectPromise: Promise<void> | null = null;
  private settleConnect: ((err?: Error) => void) | null = null;
  private stopPromise: Promise<void> | null = null;

  // Bucle de decisiones
  private history: ChatMessage[] = [];
  private llmAbort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private wakeSleep: (() => void) | null = null;
  private startedAt = Date.now();

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

  constructor(private readonly opts: FighterOptions) {
    this.systemPrompt = buildSystemPrompt({
      side: opts.side,
      username: opts.username,
      opponentUsername: opts.opponentUsername,
      strategy: opts.prompt,
      tickMs: opts.tickMs,
    });
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
          this.safe(() => this.opts.events.onDamageTaken(amount, rounded));
        }
        this.lastHealth = health;
        this.emitStatus();
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
    const status = {
      connected: this.connected,
      alive: this.alive,
      health: this.alive ? round1(health) : 0,
      food: round1(food),
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
    let response: LlmResponse;
    try {
      response = await this.opts.llm.complete({ messages, tools: TOOL_DEFS, signal: abort.signal });
    } catch (err) {
      if (!this.stopped) this.log("warn", `Falló la llamada al LLM (se mantiene la acción actual): ${errorText(err)}`);
      return;
    } finally {
      clearTimeout(timeout);
      if (this.llmAbort === abort) this.llmAbort = null;
    }
    if (this.stopped) return;

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
    });
  }

  // ------------------------------------------------------------------
  // Ejecución de herramientas: solo cambian el modo del cuerpo
  // ------------------------------------------------------------------

  private executeTool(name: string, args: ParsedToolArgs): string {
    const bot = this.bot;
    if (!bot || !this.connected) return "no estás conectado al servidor";
    if (!this.alive) return "estás muerto";
    if (!isToolName(name)) {
      return `herramienta desconocida "${name}"; usa approach, attack, retreat, shoot, eat o wait`;
    }

    const now = Date.now();
    if (name === this.mode) {
      // Repetir la herramienta continúa la acción en curso (no reinicia cargas ni comidas).
      if (name === "attack") this.modeUntil = args.seconds !== null ? now + args.seconds * 1000 : null;
      return `continúas con "${name}": ${this.lastResult}`;
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
        result = has(isSword) ? "atacando cuerpo a cuerpo con la espada" : "atacando cuerpo a cuerpo sin espada";
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
    this.lastResult = result;
    return result;
  }

  private enterWait(bot: Bot, result: string): string {
    this.leaveMode(bot);
    this.mode = "wait";
    this.modeUntil = null;
    this.lastResult = result;
    return result;
  }

  /** Limpia lo que el modo actual dejó a medias (uso de ítem, ruta del pathfinder). */
  private leaveMode(bot: Bot): void {
    if (this.using) {
      this.using = false;
      try {
        bot.deactivateItem();
      } catch {
        // nada
      }
    }
    this.clearGoal(bot);
  }

  /** Vuelve a "wait" sin tocar al bot (para muerte / reaparición). */
  private resetBody(result: string): void {
    this.mode = "wait";
    this.modeUntil = null;
    this.using = false;
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
      if (now - this.lastAttackAt >= ATTACK_COOLDOWN_MS) {
        this.lastAttackAt = now;
        bot.attack(opponent);
        this.hits++;
      }
    }
    this.lastResult =
      this.hits > 0
        ? `atacando: ${this.hits} golpes lanzados (distancia ${round1(dist)})`
        : `persiguiendo al rival para golpear (distancia ${round1(dist)})`;
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
    return FALLBACK_FOODS.has(name);
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
