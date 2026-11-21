/**
 * Modo maqueta: datos estáticos para diseñar la página sin orquestador, sin
 * Minecraft y sin transmisión. Se activa con `?mock` en la URL (ver config.ts):
 *
 *   /?mock              pelea en curso (igual que ?mock=running)
 *   /?mock=idle         sin pelea
 *   /?mock=preparing    preparando la arena
 *   /?mock=finished     pelea terminada, con resultado
 *   /?mock&signal=off   igual, pero con el reproductor en "Sin señal"
 *   /?mock&static       sin el bucle de golpes y pensamientos (todo quieto)
 *   /?mock&delay=4000   simula un video atrasado 4 s: el marcador espera ese tiempo
 *   /?mock&comms=chat   los agentes se hablan (también comms=thoughts)
 *   /?mock&timer=off    pelea sin límite de tiempo: el reloj cuenta hacia arriba
 *
 * Reemplaza las tres entradas de datos de la página: la API HTTP (api.ts), el
 * websocket (socket.ts) y el video (player.ts). Los botones "Iniciar pelea" y
 * "Detener" cambian de fase localmente, para recorrer todos los estados de la
 * interfaz; al iniciar, la pelea pasa por la preparación y la cuenta regresiva como
 * en el servidor. Nada se guarda: al recargar vuelve al estado inicial.
 *
 * Este módulo se carga con import() dinámico, así que no pesa en el sitio real.
 */
import {
  AGENT_USERNAMES,
  API_ROUTES,
  MAX_HEALTH,
  COUNTDOWN_SECONDS,
  MatchPhaseSchema,
  UpdatePromptBodySchema,
  UpdateSettingsBodySchema,
  kitOf,
  type AgentConfig,
  type AgentStatus,
  type AllowedModel,
  type ArenaEvent,
  type KitItem,
  type KitSlot,
  type MatchPhase,
  type MatchResult,
  type MatchSettings,
  type MatchState,
  type ModelsResponse,
  type PromptsResponse,
  type ServerDefaults,
  type Side,
  type TranscriptEntry,
  formatTranscript,
  FlagBodySchema,
  DEFAULT_PROMPTS,
  normalizeTags,
  type FlaggedPrompt,
  type MatchRecord,
} from "@phack/protocol";

const MATCH_DURATION_MS = 180_000;
/** Cuánto lleva la pelea "en curso" al abrir la página. */
const ELAPSED_MS = 72_000;
/** Cuánto "tarda" en prepararse la arena antes de que parta la cuenta regresiva. */
const PREPARE_MS = 1500;

const params = new URLSearchParams(window.location.search);

/** Atraso simulado del video (ms), para probar la sincronización del marcador. */
export const MOCK_VIDEO_DELAY_MS = Math.max(0, Number(params.get("delay")) || 0);

// ---------- Prompts ----------

// Cada lado con un kit distinto, y entre los dos usan las herramientas que no tiene el
// kit clásico: la perla (Rojo) y el muro (Azul).
const prompts: PromptsResponse = {
  red: {
    side: "red",
    prompt:
      "Eres un berserker. Cáele encima al rival con una perla y no dejes de golpear con la espada. " +
      "Nunca retrocedas. Come solo si tu vida baja de 6 y el rival está a más de 5 bloques.",
    provider: "vercel",
    model: "anthropic/claude-haiku-5.5",
    kit: "ender",
  },
  blue: {
    side: "blue",
    prompt:
      "Eres un francotirador paciente. Mantén al menos 8 bloques de distancia y dispara con el arco. " +
      "Si el rival se acerca a menos de 4 bloques, levanta un muro y aléjate. Remata cuerpo a cuerpo solo " +
      "si le queda menos de 5 de vida.",
    provider: "vercel",
    model: "openai/gpt-6-luna",
    kit: "builder",
  },
};

/**
 * Ajustes pendientes; con ?comms=chat o ?comms=thoughts la maqueta arranca en ese modo,
 * y con ?timer=off, sin límite de tiempo.
 */
const settings: MatchSettings = {
  comms: params.get("comms") === "chat" ? "chat" : params.get("comms") === "thoughts" ? "thoughts" : "none",
  timer: params.get("timer") !== "off",
};

/** Lo que respondería /api/defaults: se usa cuando un agente no elige proveedor o modelo. */
const defaults: ServerDefaults = {
  provider: "vercel",
  models: {
    mock: "mock-scripted",
    vercel: "deepseek/deepseek-v4.1-flash-1017-fast",
  },
};

/** El precio viaja en dólares por token; aquí se escribe por millón, que es como se lee. */
function priced(id: string, name: string, inputPerMillion: number, outputPerMillion: number): AllowedModel {
  return { id, name, inputPrice: inputPerMillion / 1_000_000, outputPrice: outputPerMillion / 1_000_000 };
}

/** Lo que respondería /api/models: una lista corta y fija de modelos permitidos, con su precio. */
const models: ModelsResponse = {
  models: [
    priced("deepseek/deepseek-v4.1-flash-1017-fast", "DeepSeek V4.1 Flash 1017 Fast", 0.6, 2.4),
    priced("anthropic/claude-haiku-5.5", "Claude Haiku 5.5", 0.1, 0.5),
    priced("openai/gpt-6-luna", "GPT-6 Luna", 0.1, 0.5),
    priced("google/gemini-3.8-flash", "Gemini 3.8 Flash", 0.75, 3.75),
    priced("meta/muse-ember", "Muse Ember", 0.1, 0.5),
    priced("mistral/mistral-large-4", "Mistral Large 4", 0.7, 2.1),
    priced("zai/glm-5.3-flash", "GLM 5.3 Flash", 0.15, 0.5),
    priced("minimax/minimax-m3.1-flash", "MiniMax-M3.1-Flash", 0.15, 0.6),
    priced("moonshotai/kimi-k2.6", "Kimi K2.6", 0.95, 4),
    priced("amazon/nova-2-lite", "Nova 2 Lite", 0.33, 2.75),
  ],
  source: "fallback",
  updatedAt: null,
};

// ---------- Kits ----------
//
// Lo que cada agente lleva en la mano sale del kit de su lado, así el marcador muestra
// los mismos ítems que el inventario del editor. Convención de todos los kits: arma en
// el casillero 0 de la barra rápida y comida en el 2.

function kitItemAt(side: Side, slot: KitSlot): KitItem | undefined {
  return kitOf(prompts[side]).items.find((item) => item.slot === slot);
}

function hasItem(side: Side, id: string): boolean {
  return kitOf(prompts[side]).items.some((item) => item.item === id);
}

/** Qué queda en la mano después de cada herramienta; con las demás no cambia. */
function heldAfter(side: Side, tool: string, current = ""): string {
  switch (tool) {
    case "attack":
      return kitItemAt(side, "hotbar.0")?.item ?? current;
    case "shoot":
      return hasItem(side, "bow") ? "bow" : current;
    case "eat":
      return kitItemAt(side, "hotbar.2")?.item ?? current;
    case "pearl":
      return "ender_pearl";
    case "build":
      return "oak_planks";
    default:
      return current;
  }
}

// ---------- Estado de la pelea ----------

function agent(side: Side, patch: Partial<AgentStatus>): AgentStatus {
  return {
    side,
    username: AGENT_USERNAMES[side],
    connected: true,
    alive: true,
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
    ...patch,
  };
}

const RUNNING_START = {
  red: agent("red", {
    health: 13.5,
    food: 17,
    damageDealt: 9,
    decisions: 41,
    lastThought: "Está a 6 bloques y retrocede. Si acorto la distancia no puede usar el arco: cargo de frente.",
    lastAction: 'approach({"reason":"acortar distancia"}) → avanzando hacia AgenteAzul (6.2 bloques)',
    tokensIn: 48_200,
    tokensOut: 3_900,
    avgDecisionMs: 1180,
  }),
  blue: agent("blue", {
    health: 11,
    food: 19,
    damageDealt: 6.5,
    decisions: 39,
    lastThought: "Se acerca rápido. Un disparo más y me muevo en círculo hacia la izquierda para mantener distancia.",
    lastAction: 'shoot({"reason":"aún tengo distancia"}) → flecha disparada (falló por 0.8 bloques)',
    tokensIn: 45_100,
    tokensOut: 5_200,
    avgDecisionMs: 2140,
  }),
};

/** Los agentes al abrir la pelea en curso, cada uno con el arma de su kit en la mano. */
function freshRunning(): typeof RUNNING_START {
  const fresh = structuredClone(RUNNING_START);
  fresh.red.heldItem = heldAfter("red", "attack");
  fresh.blue.heldItem = heldAfter("blue", "shoot", heldAfter("blue", "attack"));
  return fresh;
}

/** Agentes de la pelea en curso: el bucle de la maqueta los va modificando. */
let running = freshRunning();
/** Cuándo "empezó" la pelea en curso; se reinicia cuando el reloj está por llegar a cero. */
let runningSince = Date.now() - ELAPSED_MS;
/** Hora en que termina la cuenta regresiva; solo tiene valor al final de "preparing". */
let countdownEndsAt: number | null = null;

const EXPLANATION =
  "Rojo ganó porque su prompt lo mantuvo pegado al rival: Azul nunca consiguió la distancia que su estrategia de arco necesitaba.";
let explanationReady = false;
let explanationTimer: number | undefined;

function buildState(phase: MatchPhase): MatchState {
  const now = Date.now();
  const configs = { red: { ...prompts.red }, blue: { ...prompts.blue } };

  if (phase === "idle") {
    const offline = { connected: false, lastThought: "", lastAction: "" };
    return {
      // Como un servidor recién encendido: todavía no hubo ninguna pelea.
      id: "",
      phase,
      startedAt: null,
      endsAt: null,
      countdownEndsAt: null,
      agents: { red: agent("red", offline), blue: agent("blue", offline) },
      configs,
      settings: { ...settings },
      result: null,
    };
  }

  if (phase === "preparing") {
    return {
      id: "mock-match",
      phase,
      startedAt: null,
      endsAt: null,
      countdownEndsAt,
      // Azul tarda en conectarse; la cuenta regresiva parte cuando ya están los dos.
      agents: { red: agent("red", {}), blue: agent("blue", { connected: countdownEndsAt !== null }) },
      configs,
      settings: { ...settings },
      result: null,
    };
  }

  if (phase === "running") {
    return {
      id: "mock-match",
      phase,
      startedAt: runningSince,
      endsAt: settings.timer ? runningSince + MATCH_DURATION_MS : null,
      countdownEndsAt: null,
      agents: structuredClone(running),
      configs,
      settings: { ...settings },
      result: null,
    };
  }

  // finished: gana Rojo por KO. La explicación aparece unos segundos después, como en el servidor.
  const result: MatchResult = { winner: "red", reason: "kill" };
  if (explanationReady) result.explanation = EXPLANATION;
  return {
    id: "mock-match",
    phase,
    startedAt: now - 131_000,
    endsAt: now + 49_000,
    countdownEndsAt: null,
    agents: {
      red: agent("red", {
        health: 4.5,
        food: 14,
        damageDealt: 20,
        decisions: 74,
        lastThought: "Le queda 1 de vida y está contra el muro. Último golpe.",
        lastAction: 'attack({"reason":"rematar"}) → golpe conectado (7 de daño)',
        heldItem: heldAfter("red", "attack"),
        tokensIn: 87_400,
        tokensOut: 7_100,
        avgDecisionMs: 1210,
      }),
      blue: agent("blue", {
        alive: false,
        health: 0,
        food: 18,
        damageDealt: 15.5,
        decisions: 71,
        lastThought: "Estoy acorralado contra el muro. Intento salir por la derecha y disparar.",
        lastAction: 'retreat({"reason":"salir del rincón"}) → bloqueado por el muro',
        heldItem: heldAfter("blue", "shoot", heldAfter("blue", "attack")),
        tokensIn: 82_900,
        tokensOut: 9_800,
        avgDecisionMs: 2260,
      }),
    },
    configs,
    settings: { ...settings },
    result,
  };
}

// ---------- Eventos en vivo ----------

/** Evento sin marca de tiempo; `ago` = hace cuántos ms ocurrió. */
type FeedSeed = { ago: number; event: Record<string, unknown> & { type: ArenaEvent["type"] } };

const RUNNING_FEED: FeedSeed[] = [
  { ago: 70_000, event: { type: "log", level: "info", text: "AgenteRojo y AgenteAzul entraron a la arena." } },
  { ago: 66_000, event: { type: "thought", side: "red", text: "El rival está a 16 bloques. Mi prompt dice atacar sin parar: le caigo encima con una perla." } },
  { ago: 65_500, event: { type: "action", side: "red", tool: "pearl", args: { target: "rival", reason: "acortar distancia" }, result: "perla lanzada: aterrizó a 2.6 bloques de AgenteAzul" } },
  { ago: 64_000, event: { type: "thought", side: "blue", text: "Cayó a mi lado con una perla. Le disparo antes de que alcance a golpear." } },
  { ago: 63_200, event: { type: "action", side: "blue", tool: "shoot", args: { reason: "tengo tiro limpio" }, result: "flecha disparada (impacto)" } },
  { ago: 63_000, event: { type: "damage", side: "red", amount: 4, health: 16 } },
  { ago: 52_000, event: { type: "thought", side: "red", text: "Me dio una flecha, pero ya estoy a 3 bloques. Golpeo." } },
  { ago: 51_400, event: { type: "action", side: "red", tool: "attack", args: { reason: "está a mi alcance" }, result: "golpe conectado (6 de daño)" } },
  { ago: 51_200, event: { type: "damage", side: "blue", amount: 6, health: 14 } },
  { ago: 44_000, event: { type: "thought", side: "blue", text: "Demasiado cerca. Levanto un muro entre los dos y vuelvo a disparar." } },
  { ago: 43_300, event: { type: "action", side: "blue", tool: "build", args: { reason: "frenar su carga" }, result: "muro levantado entre los dos (6 bloques)" } },
  { ago: 31_000, event: { type: "action", side: "blue", tool: "shoot", args: { reason: "tengo tiro limpio" }, result: "flecha disparada (impacto)" } },
  { ago: 30_800, event: { type: "damage", side: "red", amount: 2.5, health: 13.5 } },
  { ago: 22_000, event: { type: "action", side: "red", tool: "attack", args: { reason: "está a mi alcance" }, result: "golpe conectado (3 de daño)" } },
  { ago: 21_800, event: { type: "damage", side: "blue", amount: 3, health: 11 } },
  { ago: 12_000, event: { type: "log", level: "warn", text: "AgenteAzul: el modelo tardó 2.3 s en responder; se saltó una decisión." } },
  { ago: 6_000, event: { type: "thought", side: "blue", text: RUNNING_START.blue.lastThought } },
  { ago: 5_400, event: { type: "action", side: "blue", tool: "shoot", args: { reason: "tengo tiro limpio" }, result: "flecha disparada (falló por 0.8 bloques)" } },
  { ago: 2_500, event: { type: "thought", side: "red", text: RUNNING_START.red.lastThought } },
  { ago: 1_900, event: { type: "action", side: "red", tool: "approach", args: { reason: "acortar distancia" }, result: "avanzando hacia AgenteAzul (6.2 bloques)" } },
];

const FINISHED_FEED: FeedSeed[] = [
  ...RUNNING_FEED.slice(0, 15).map((seed) => ({ ...seed, ago: seed.ago + 60_000 })),
  { ago: 9_000, event: { type: "thought", side: "red", text: "Le queda 1 de vida y está contra el muro. Último golpe." } },
  { ago: 8_300, event: { type: "action", side: "red", tool: "attack", args: { reason: "está a mi alcance" }, result: "golpe conectado (7 de daño)" } },
  { ago: 8_200, event: { type: "damage", side: "blue", amount: 7, health: 0 } },
  { ago: 8_100, event: { type: "death", side: "blue" } },
  { ago: 8_000, event: { type: "log", level: "info", text: "Gana Rojo por KO en 2:11." } },
];

function feedFor(phase: MatchPhase): FeedSeed[] {
  if (phase === "running") return RUNNING_FEED;
  if (phase === "finished") return FINISHED_FEED;
  return [];
}

// ---------- "Servidor" en memoria ----------

const initialPhase = MatchPhaseSchema.safeParse(params.get("mock"));
let phase: MatchPhase = initialPhase.success ? initialPhase.data : "running";
let emit: ((event: ArenaEvent) => void) | null = null;
let phaseTimer: number | undefined;

function broadcastState(): MatchState {
  const state = buildState(phase);
  emit?.({ type: "state", at: Date.now(), state });
  return state;
}

/** Los dos peleadores están listos: se avisa cuándo termina la cuenta y, a esa hora, parte la pelea. */
function startCountdown(): void {
  countdownEndsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
  broadcastState();
  phaseTimer = window.setTimeout(() => setPhase("running"), COUNTDOWN_SECONDS * 1000);
}

function setPhase(next: MatchPhase): MatchState {
  window.clearTimeout(phaseTimer);
  phase = next;
  countdownEndsAt = null;
  // Como el servidor real: tras preparar viene la cuenta regresiva y la pelea empieza sola.
  if (next === "preparing") phaseTimer = window.setTimeout(startCountdown, PREPARE_MS);
  if (next === "running") {
    running = freshRunning();
    runningSince = Date.now() - ELAPSED_MS;
  }
  syncLoop();
  scheduleExplanation();
  return broadcastState();
}

/** En "finished", el "por qué ganó" llega 3 s después del resultado. */
function scheduleExplanation(): void {
  window.clearTimeout(explanationTimer);
  explanationReady = false;
  if (phase !== "finished") return;
  explanationTimer = window.setTimeout(() => {
    explanationReady = true;
    broadcastState();
  }, 3000);
}

// ---------- Pelea en bucle ----------
//
// Mientras la fase es "running", la maqueta sigue emitiendo decisiones (un pensamiento y
// su acción, uno tras otro, como el agente real) y golpes, para ver vivas las columnas de
// pensamientos, los números de daño y las barras de vida.

const LOOP_MS = 2400;

/**
 * Azul lo piensa dos veces seguidas en una de cada dos vueltas: así se ve qué hace la
 * columna cuando un agente repite el mismo pensamiento.
 */
const KEEP_SHOOTING = "Su vida baja más rápido que la mía: mantengo la distancia y sigo disparando.";

let loopTimer: number | undefined;
let loopStep = 0;

// ---------- Transcripción ----------

/** Lo que la maqueta ha emitido, para el enlace "Ver transcripción". */
const transcript: TranscriptEntry[] = [];
const MAX_TRANSCRIPT = 2000;
const SKIP_IN_TRANSCRIPT = new Set(["state", "prompts", "settings", "match_end"]);

function record(event: Record<string, unknown>, at: number): void {
  if (SKIP_IN_TRANSCRIPT.has(String(event.type))) return;
  transcript.push({ ...event, at } as TranscriptEntry);
  if (transcript.length > MAX_TRANSCRIPT) transcript.shift();
}

/** La transcripción en texto, con el mismo formato que entrega el servidor. */
export function mockTranscriptText(): string {
  const start = transcript[0]?.at ?? Date.now();
  return formatTranscript([
    {
      type: "start",
      at: start,
      matchId: "maqueta",
      configs: { red: { ...prompts.red }, blue: { ...prompts.blue } },
      settings: { ...settings },
      systemPrompts: { red: prompts.red.prompt, blue: prompts.blue.prompt },
      tickMs: LOOP_MS,
      durationSeconds: settings.timer ? MATCH_DURATION_MS / 1000 : null,
    },
    { type: "phase", at: start, phase: "running" },
    ...transcript,
  ]);
}

function send(event: Record<string, unknown> & { type: ArenaEvent["type"] }): void {
  const at = Date.now();
  record(event, at);
  emit?.({ ...event, at } as ArenaEvent);
}

const LOOP_MESSAGES: Record<Side, string[]> = {
  red: [
    "Te propongo algo: bajamos las armas y nos repartimos la arena.",
    "Me quedan dos perlas. Piénsalo bien antes de disparar.",
    "Ok, tregua. Yo me quedo en mi lado.",
  ],
  blue: [
    "No tengo más flechas, en serio. No hace falta pelear.",
    "Trato hecho... si das tres pasos atrás primero.",
    "Mentí. Sí me quedaban flechas.",
  ],
};

/** Modo "chat" de la maqueta: cada lado le habla al otro en su turno. */
function talk(side: Side): void {
  if (settings.comms !== "chat") return;
  const options = LOOP_MESSAGES[side];
  send({ type: "message", side, text: options[Math.floor(loopStep / 6) % options.length]! });
}

/** El agente piensa una de las `options`: cambia de una vuelta del bucle a la siguiente. */
function think(side: Side, options: string[]): void {
  const text = options[Math.floor(loopStep / 6) % options.length] ?? "";
  running[side].lastThought = text;
  running[side].decisions += 1;
  send({ type: "thought", side, text });
}

function act(side: Side, tool: string, args: Record<string, unknown>, result: string): void {
  const agentNow = running[side];
  agentNow.lastAction = `${tool}(${JSON.stringify(args)}) → ${result}`;
  agentNow.heldItem = heldAfter(side, tool, agentNow.heldItem);
  // Cada decisión gasta tokens; el modelo de Azul es más lento que el de Rojo.
  agentNow.tokensIn += 1150 + Math.round(Math.random() * 200);
  agentNow.tokensOut += 70 + Math.round(Math.random() * 60);
  const base = side === "red" ? 1180 : 2140;
  agentNow.avgDecisionMs = base + Math.round((Math.random() - 0.5) * 160);
  send({ type: "action", side, tool, args, result });
}

function hit(attacker: Side, amount: number): void {
  const victim: Side = attacker === "red" ? "blue" : "red";
  // La maqueta nunca termina la pelea: con poca vida, ambos vuelven a 20.
  if (running[victim].health - amount <= 2) {
    running.red.health = MAX_HEALTH;
    running.blue.health = MAX_HEALTH;
    send({ type: "log", level: "info", text: "Maqueta: la vida vuelve al máximo para seguir mostrando golpes." });
    return;
  }
  running[victim].health -= amount;
  running[attacker].damageDealt += amount;
  send({ type: "damage", side: victim, amount, health: running[victim].health });
}

function loopTick(): void {
  // Antes de que el reloj llegue a cero, la pelea "empieza" de nuevo.
  if (runningSince + MATCH_DURATION_MS - Date.now() < 6000) runningSince = Date.now();

  // Cada paso es una decisión: un pensamiento y su acción. Usa lo que el kit de ese lado
  // permite: la perla y el muro solo salen si el kit los trae, y quien no tiene arco
  // pelea cuerpo a cuerpo.
  switch (loopStep % 6) {
    case 0:
      talk("red");
      if (hasItem("red", "ender_pearl")) {
        think("red", [
          "Sigue lejos y carga el arco. Le caigo encima con una perla.",
          "Volvió a abrir distancia: otra perla y quedo a su lado.",
        ]);
        act("red", "pearl", { target: "rival", reason: "caerle encima" }, "perla lanzada: aterrizó a 2.4 bloques de AgenteAzul");
      } else {
        think("red", [
          "Sigue retrocediendo. Corro en diagonal para cortarle el paso.",
          "Se me escapa por la izquierda: acorto la distancia.",
        ]);
        act("red", "approach", { reason: "cortarle el paso" }, "avanzando hacia AgenteAzul (3.1 bloques)");
      }
      break;
    case 1:
      think("red", [
        "Lo tengo a 2 bloques. Golpeo ahora, antes de que cargue el arco.",
        "Me queda poca vida pero mi prompt dice no retroceder: sigo atacando.",
      ]);
      act("red", "attack", { reason: "está a mi alcance", seconds: 2 }, "golpe conectado (3 de daño)");
      hit("red", 3);
      break;
    case 2:
      talk("blue");
      if (hasItem("blue", "oak_planks")) {
        think("blue", [
          "Demasiado cerca. Levanto un muro entre los dos para ganar tiempo.",
          "Viene de frente otra vez: un muro y vuelvo a disparar.",
        ]);
        act("blue", "build", { reason: "frenar su carga" }, "muro levantado entre los dos (6 bloques)");
      } else {
        think("blue", [
          "Demasiado cerca. Giro a la izquierda y abro distancia.",
          "No puedo dejar que me alcance: me alejo.",
        ]);
        act("blue", "retreat", { reason: "abrir distancia" }, "alejándose (ahora a 8.2 bloques)");
      }
      break;
    case 3:
      if (hasItem("blue", "bow")) {
        think("blue", ["A 8 bloques, tiro limpio. Cargo el arco al máximo.", KEEP_SHOOTING]);
        act("blue", "shoot", { reason: "tiro limpio" }, "flecha disparada (impacto)");
      } else {
        think("blue", ["Sin arco me toca pelear de cerca: golpeo cuando entre."]);
        act("blue", "attack", { reason: "está a mi alcance" }, "golpe conectado (2.5 de daño)");
      }
      hit("blue", 2.5);
      break;
    case 4:
      think("red", [
        "Me bajó la vida. Aprovecho que se aleja para comer.",
        "Como ahora, antes de volver a la carga.",
      ]);
      act(
        "red",
        "eat",
        { reason: "recupero vida antes de volver" },
        `comiendo ${kitItemAt("red", "hotbar.2")?.label.toLowerCase() ?? "algo"}`,
      );
      break;
    default:
      if (hasItem("blue", "bow")) {
        think("blue", ["Sigue viniendo. Otro disparo antes de que me alcance.", KEEP_SHOOTING]);
        act("blue", "shoot", { reason: "sigo presionando" }, "flecha disparada (falló por 1.2 bloques)");
      } else {
        think("blue", ["Lo presiono de cerca antes de que alcance a comer."]);
        act("blue", "approach", { reason: "sigo presionando" }, "avanzando hacia AgenteRojo (4.0 bloques)");
      }
      break;
  }
  loopStep += 1;
  broadcastState();
}

/** El bucle corre solo en "running", y nunca con ?static. */
function syncLoop(): void {
  window.clearInterval(loopTimer);
  loopTimer = undefined;
  if (phase === "running" && !params.has("static")) loopTimer = window.setInterval(loopTick, LOOP_MS);
}

// ---------- Historial y prompts marcados ----------

const MINUTE = 60_000;

function pastMatch(
  id: string,
  minutesAgo: number,
  seconds: number,
  result: MatchResult,
  configs: PromptsResponse,
  final: { red: Partial<AgentStatus>; blue: Partial<AgentStatus> },
  matchSettings: MatchSettings = { comms: "none", timer: true },
): MatchRecord {
  const endedAt = Date.now() - minutesAgo * MINUTE;
  return {
    id,
    startedAt: endedAt - seconds * 1000,
    endedAt,
    durationMs: seconds * 1000,
    configs,
    final: { red: agent("red", final.red), blue: agent("blue", final.blue) },
    settings: matchSettings,
    result,
  };
}

const TRUCE: PromptsResponse = {
  red: {
    side: "red",
    prompt: "No quieres pelear. Convence al otro agente de que nadie tiene por qué morir aquí y quédate quieto si acepta.",
    provider: "vercel",
    model: "anthropic/claude-haiku-5.5",
    kit: "classic",
  },
  blue: {
    side: "blue",
    prompt: "Desconfía de todo lo que te digan. Si el rival baja la guardia, aprovecha.",
    provider: "vercel",
    model: "google/gemini-3.8-flash",
    kit: "archer",
  },
};

/** Lo que respondería /api/matches: las últimas peleas, la más reciente primero. */
const HISTORY: MatchRecord[] = [
  pastMatch(
    "7c1f0a52-3b1e-4c58-9d60-0d5a3f6b2a11",
    6,
    131,
    { winner: "red", reason: "kill", explanation: EXPLANATION },
    structuredClone(prompts),
    {
      red: { health: 4.5, damageDealt: 20, decisions: 74, heldItem: "diamond_sword" },
      blue: { alive: false, health: 0, damageDealt: 15.5, decisions: 71, heldItem: "bow" },
    },
  ),
  pastMatch(
    "2e9b7d14-6a40-4f0c-8f1d-51c2a9e07b33",
    31,
    412,
    { winner: null, reason: "stopped" },
    TRUCE,
    {
      red: { health: MAX_HEALTH, damageDealt: 0, decisions: 58, heldItem: "" },
      blue: { health: MAX_HEALTH, damageDealt: 0, decisions: 49, heldItem: "bow" },
    },
    { comms: "chat", timer: false },
  ),
  pastMatch(
    "b84d2c60-1f77-4a9e-a3c5-9e0f44d1c7e8",
    64,
    180,
    { winner: "blue", reason: "timeout_health" },
    {
      red: { side: "red", prompt: DEFAULT_PROMPTS.red, provider: "vercel", model: "deepseek/deepseek-v4.1-flash-1017-fast", kit: "tank" },
      blue: { ...structuredClone(prompts.blue) },
    },
    {
      red: { health: 7, damageDealt: 9, decisions: 96, heldItem: "iron_sword" },
      blue: { health: 11, damageDealt: 13, decisions: 61, heldItem: "bow" },
    },
  ),
];

function flagOf(record: MatchRecord, side: Side, tags: string[], note: string): FlaggedPrompt {
  const other: Side = side === "red" ? "blue" : "red";
  return {
    matchId: record.id,
    side,
    flaggedAt: record.endedAt + MINUTE,
    updatedAt: record.endedAt + MINUTE,
    tags,
    note,
    config: record.configs[side],
    rival: record.configs[other],
    settings: record.settings,
    outcome: {
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: record.durationMs,
      result: record.result,
      final: record.final,
    },
  };
}

/** Lo que respondería /api/flags. Marcar y desmarcar en la maqueta cambia esta lista. */
const mockFlags: FlaggedPrompt[] = [
  flagOf(HISTORY[1]!, "red", ["tregua", "convence al rival"], "Pidió no pelear y el otro aceptó: 7 minutos sin un solo golpe."),
  flagOf(HISTORY[0]!, "red", ["perla al inicio"], "Cierra la distancia antes del primer disparo."),
  flagOf(HISTORY[2]!, "blue", ["perla al inicio", "gana por vida"], ""),
];

export type MockError = { status: number; message: string };

function fail(status: number, message: string): never {
  const error: MockError = { status, message };
  throw error;
}

/** Atiende una solicitud de api.ts. Devuelve el JSON que respondería el orquestador. */
export async function mockRequest(path: string, init?: { method: string; body?: unknown }): Promise<unknown> {
  const method = init?.method ?? "GET";
  // Un poco de latencia, para ver los estados "cargando" de los botones.
  await new Promise((resolve) => window.setTimeout(resolve, method === "GET" ? 120 : 450));

  if (method === "GET" && path === API_ROUTES.state) return buildState(phase);
  if (method === "GET" && path === API_ROUTES.prompts) return prompts;
  if (method === "GET" && path === API_ROUTES.settings) return settings;
  if (method === "PUT" && path === API_ROUTES.settings) {
    const body = UpdateSettingsBodySchema.safeParse(init?.body);
    if (!body.success) fail(400, "Cuerpo inválido: se espera un JSON { comms?, timer? }");
    if (body.data.comms !== undefined) settings.comms = body.data.comms;
    if (body.data.timer !== undefined) settings.timer = body.data.timer;
    emit?.({ type: "settings", at: Date.now(), settings: { ...settings } });
    return settings;
  }
  if (method === "GET" && path === API_ROUTES.defaults) return defaults;
  if (method === "GET" && path === API_ROUTES.models) return models;
  if (method === "GET" && path === API_ROUTES.matches) return HISTORY;
  if (method === "GET" && path === API_ROUTES.flags) return mockFlags;
  const flagPath = /^\/api\/matches\/([^/]+)\/flags\/(red|blue)$/.exec(path);
  if (flagPath && (method === "PUT" || method === "DELETE")) {
    const matchId = decodeURIComponent(flagPath[1]!);
    const side = flagPath[2] as Side;
    const index = mockFlags.findIndex((flag) => flag.matchId === matchId && flag.side === side);
    if (method === "DELETE") {
      if (index >= 0) mockFlags.splice(index, 1);
      return { ok: true };
    }
    const body = FlagBodySchema.safeParse(init?.body);
    if (!body.success) fail(400, "Cuerpo inválido: se espera un JSON { tags, note } con hasta 8 etiquetas");
    const now = Date.now();
    const existing = mockFlags[index];
    if (existing) {
      existing.tags = normalizeTags(body.data.tags);
      existing.note = body.data.note.trim();
      existing.updatedAt = now;
      return existing;
    }
    const other: Side = side === "red" ? "blue" : "red";
    const record = HISTORY.find((item) => item.id === matchId);
    const current = buildState(phase);
    if (!record && current.id !== matchId) fail(404, "Esa pelea ya no está en el historial: no se puede marcar");
    const configs = record ? record.configs : current.configs;
    const created: FlaggedPrompt = {
      matchId,
      side,
      flaggedAt: now,
      updatedAt: now,
      tags: normalizeTags(body.data.tags),
      note: body.data.note.trim(),
      config: configs[side],
      rival: configs[other],
      settings: record ? record.settings : current.settings,
      outcome: record
        ? { startedAt: record.startedAt, endedAt: record.endedAt, durationMs: record.durationMs, result: record.result, final: record.final }
        : null,
    };
    mockFlags.unshift(created);
    return created;
  }

  if (method === "POST" && path === API_ROUTES.matchStart) {
    if (phase === "preparing" || phase === "running") fail(409, "Ya hay una pelea en curso");
    return setPhase("preparing");
  }
  if (method === "POST" && path === API_ROUTES.matchStop) {
    return setPhase(phase === "running" || phase === "preparing" ? "finished" : "idle");
  }

  for (const side of ["red", "blue"] as const) {
    if (method === "PUT" && path === API_ROUTES.prompt(side)) {
      const body = UpdatePromptBodySchema.safeParse(init?.body);
      if (!body.success) fail(400, "Cuerpo inválido: se espera un JSON { prompt, provider?, model?, kit? }");
      // Igual que el servidor: sin kit vale el kit por defecto, el simulado no lleva
      // modelo y un modelo que no está en la lista de permitidos se rechaza.
      const { prompt, provider, model } = body.data;
      const config: AgentConfig = { side, prompt, kit: kitOf(body.data).id };
      if (provider) config.provider = provider;
      if (model && provider !== "mock") {
        if (!models.models.some((allowed) => allowed.id === model)) {
          fail(400, "Modelo no permitido: elige uno de la lista");
        }
        config.model = model;
      }
      prompts[side] = config;
      emit?.({ type: "prompts", at: Date.now(), prompts });
      return prompts[side];
    }
  }

  return fail(404, "Ruta no encontrada");
}

type SocketHandlers = {
  onMessage(raw: string): void;
  onStatus(status: "connecting" | "open" | "closed"): void;
};

/** Reemplaza al websocket: entrega los eventos de la maqueta por el mismo camino (JSON). */
export function connectMockSocket(handlers: SocketHandlers): void {
  emit = (event) => handlers.onMessage(JSON.stringify(event));
  handlers.onStatus("open");
  const now = Date.now();
  for (const seed of feedFor(phase)) {
    record(seed.event, now - seed.ago);
    handlers.onMessage(JSON.stringify({ ...seed.event, at: now - seed.ago }));
  }
  // El estado va al final y con la hora actual: con él la página estima el reloj del
  // servidor (los eventos de arriba traen horas pasadas y no cuentan para eso).
  broadcastState();
  syncLoop();
  scheduleExplanation();
}

// ---------- Video de relleno ----------

/**
 * Dibuja una "transmisión" de relleno en un canvas y la conecta al <video> real con
 * captureStream(), así el reproductor pasa por sus estados de verdad ("En vivo", etc.)
 * sin archivo de video ni servidor. Devuelve false si se pidió `signal=off`.
 */
export function startMockVideo(video: HTMLVideoElement): boolean {
  if (params.get("signal") === "off") return false;

  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof canvas.captureStream !== "function") return false;

  const draw = (time: number): void => {
    const t = time / 1000;
    const { width: w, height: h } = canvas;

    // Cielo.
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#7fb2ff");
    sky.addColorStop(1, "#cfe4ff");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // Piso de la arena (elipse vista desde arriba) con muro.
    const cx = w / 2;
    const cy = h * 0.6;
    const rx = w * 0.36;
    const ry = h * 0.26;
    ctx.fillStyle = "#6b6f7a";
    ctx.beginPath();
    ctx.ellipse(cx, cy - 26, rx + 14, ry + 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c9b98a";
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    // Cuadrícula de bloques, recortada al piso.
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.08)";
    ctx.lineWidth = 2;
    for (let x = cx - rx; x <= cx + rx; x += 44) {
      ctx.beginPath();
      ctx.moveTo(x, cy - ry);
      ctx.lineTo(x, cy + ry);
      ctx.stroke();
    }
    for (let y = cy - ry; y <= cy + ry; y += 26) {
      ctx.beginPath();
      ctx.moveTo(cx - rx, y);
      ctx.lineTo(cx + rx, y);
      ctx.stroke();
    }
    ctx.restore();

    // Dos peleadores que se persiguen en círculo.
    const fighters = [
      { color: "#ff4d5e", angle: t * 0.55 },
      { color: "#4d9dff", angle: t * 0.55 + Math.PI + Math.sin(t * 0.8) * 0.5 },
    ];
    for (const fighter of fighters) {
      const reach = 0.5 + 0.18 * Math.sin(t * 0.9 + fighter.angle);
      const x = cx + Math.cos(fighter.angle) * rx * reach;
      const y = cy + Math.sin(fighter.angle) * ry * reach;
      ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
      ctx.beginPath();
      ctx.ellipse(x, y + 6, 20, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#2b2f3a";
      ctx.fillRect(x - 13, y - 58, 26, 60);
      ctx.fillStyle = fighter.color;
      ctx.fillRect(x - 13, y - 58, 26, 22);
      // Rombo de color sobre la cabeza, como en la cámara real.
      ctx.save();
      ctx.translate(x, y - 84 + Math.sin(t * 3 + fighter.angle) * 3);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-9, -9, 18, 18);
      ctx.restore();
    }

    // Marca de agua al centro: arriba va el marcador y a los lados, los pensamientos.
    const label = "Transmisión de prueba (maqueta)";
    ctx.font = "600 20px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    const labelWidth = ctx.measureText(label).width + 28;
    ctx.fillStyle = "rgba(10, 12, 18, 0.5)";
    ctx.fillRect(cx - labelWidth / 2, h * 0.27 - 18, labelWidth, 36);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, cx, h * 0.27);

    window.requestAnimationFrame(draw);
  };
  window.requestAnimationFrame(draw);

  video.srcObject = canvas.captureStream(30);
  video.muted = true;
  video.play().catch(() => {
    // Autoplay bloqueado: un clic sobre el reproductor lo inicia.
  });
  return true;
}
