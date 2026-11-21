/**
 * Modo maqueta: datos estáticos para diseñar la página sin orquestador, sin
 * Minecraft y sin transmisión. Se activa con `?mock` en la URL (ver config.ts):
 *
 *   /?mock              pelea en curso (igual que ?mock=running)
 *   /?mock=idle         sin pelea
 *   /?mock=preparing    preparando la arena
 *   /?mock=finished     pelea terminada, con resultado
 *   /?mock&signal=off   igual, pero con el reproductor en "Sin señal"
 *
 * Reemplaza las tres entradas de datos de la página: la API HTTP (api.ts), el
 * websocket (socket.ts) y el video (player.ts). Los botones "Iniciar pelea" y
 * "Detener" cambian de fase localmente, para recorrer todos los estados de la
 * interfaz. Nada se guarda: al recargar vuelve al estado inicial.
 *
 * Este módulo se carga con import() dinámico, así que no pesa en el sitio real.
 */
import {
  AGENT_USERNAMES,
  API_ROUTES,
  MatchPhaseSchema,
  UpdatePromptBodySchema,
  type AgentConfig,
  type AgentStatus,
  type ArenaEvent,
  type MatchPhase,
  type MatchRecord,
  type MatchResult,
  type MatchState,
  type PromptsResponse,
  type ServerDefaults,
  type Side,
} from "@phack/protocol";

const MATCH_DURATION_MS = 180_000;
/** Cuánto lleva la pelea "en curso" al abrir la página. */
const ELAPSED_MS = 72_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const params = new URLSearchParams(window.location.search);

// ---------- Prompts ----------

const prompts: PromptsResponse = {
  red: {
    side: "red",
    prompt:
      "Eres un berserker. Corre directo hacia el rival y no dejes de golpear con la espada. " +
      "Nunca retrocedas. Come solo si tu vida baja de 6 y el rival está a más de 5 bloques.",
    provider: "gateway",
    model: "anthropic/claude-haiku-5.5",
  },
  blue: {
    side: "blue",
    prompt:
      "Eres un francotirador paciente. Mantén al menos 8 bloques de distancia y dispara con el arco. " +
      "Si el rival se acerca a menos de 4 bloques, aléjate en círculos. Remata cuerpo a cuerpo solo " +
      "si le queda menos de 5 de vida.",
    provider: "gateway",
    model: "openai/gpt-6-luna",
  },
};

/** Lo que respondería /api/defaults: se usa cuando un agente no elige proveedor o modelo. */
const defaults: ServerDefaults = {
  provider: "gateway",
  models: {
    mock: "mock-scripted",
    vercel: "deepseek/deepseek-v4.1-flash-1017-fast",
    openai: "gpt-6-luna",
    anthropic: "claude-haiku-5-5",
    openrouter: "openai/gpt-6-luna",
    gateway: "anthropic/claude-haiku-5.5",
  },
};

// ---------- Estado de la pelea ----------

function agent(side: Side, patch: Partial<AgentStatus>): AgentStatus {
  return {
    side,
    username: AGENT_USERNAMES[side],
    connected: true,
    alive: true,
    health: 20,
    food: 20,
    damageDealt: 0,
    decisions: 0,
    lastThought: "",
    lastAction: "",
    ...patch,
  };
}

const RUNNING_AGENTS = {
  red: agent("red", {
    health: 13.5,
    food: 17,
    damageDealt: 9,
    decisions: 41,
    lastThought: "Está a 6 bloques y retrocede. Si acorto la distancia no puede usar el arco: cargo de frente.",
    lastAction: 'move_to({"target":"enemy","sprint":true}) → avanzando hacia AgenteAzul (6.2 bloques)',
  }),
  blue: agent("blue", {
    health: 11,
    food: 19,
    damageDealt: 6.5,
    decisions: 39,
    lastThought: "Se acerca rápido. Un disparo más y me muevo en círculo hacia la izquierda para mantener distancia.",
    lastAction: 'shoot_bow({"charge_ms":900}) → flecha disparada (falló por 0.8 bloques)',
  }),
};

function buildState(phase: MatchPhase): MatchState {
  const now = Date.now();
  const configs = { red: { ...prompts.red }, blue: { ...prompts.blue } };

  if (phase === "idle") {
    const offline = { connected: false, lastThought: "", lastAction: "" };
    return {
      id: "mock-idle",
      phase,
      startedAt: null,
      endsAt: null,
      agents: { red: agent("red", offline), blue: agent("blue", offline) },
      configs,
      result: null,
    };
  }

  if (phase === "preparing") {
    return {
      id: "mock-match",
      phase,
      startedAt: null,
      endsAt: null,
      agents: { red: agent("red", {}), blue: agent("blue", { connected: false }) },
      configs,
      result: null,
    };
  }

  if (phase === "running") {
    return {
      id: "mock-match",
      phase,
      startedAt: now - ELAPSED_MS,
      endsAt: now - ELAPSED_MS + MATCH_DURATION_MS,
      agents: RUNNING_AGENTS,
      configs,
      result: null,
    };
  }

  // finished: gana Rojo por KO.
  const result: MatchResult = { winner: "red", reason: "kill" };
  return {
    id: "mock-match",
    phase,
    startedAt: now - 131_000,
    endsAt: now + 49_000,
    agents: {
      red: agent("red", {
        health: 4.5,
        food: 14,
        damageDealt: 20,
        decisions: 74,
        lastThought: "Le queda 1 de vida y está contra el muro. Último golpe.",
        lastAction: 'attack({"target":"enemy"}) → golpe conectado (7 de daño)',
      }),
      blue: agent("blue", {
        alive: false,
        health: 0,
        food: 18,
        damageDealt: 15.5,
        decisions: 71,
        lastThought: "Estoy acorralado contra el muro. Intento salir por la derecha y disparar.",
        lastAction: 'move_to({"x":9,"z":-4}) → bloqueado por el muro',
      }),
    },
    configs,
    result,
  };
}

// ---------- Historial ----------

type RecordSeed = {
  agoMs: number;
  durationMs: number;
  result: MatchResult;
  red: Partial<AgentStatus>;
  blue: Partial<AgentStatus>;
  redPrompt: string;
  bluePrompt: string;
  redModel?: string;
  blueModel?: string;
};

const RECORD_SEEDS: RecordSeed[] = [
  {
    agoMs: 9 * MINUTE,
    durationMs: 131_000,
    result: { winner: "red", reason: "kill" },
    red: { health: 4.5, damageDealt: 20, decisions: 74 },
    blue: { health: 0, alive: false, damageDealt: 15.5, decisions: 71 },
    redPrompt: prompts.red.prompt,
    bluePrompt: prompts.blue.prompt,
    redModel: "anthropic/claude-haiku-5.5",
    blueModel: "openai/gpt-6-luna",
  },
  {
    agoMs: 21 * MINUTE,
    durationMs: 180_000,
    result: { winner: "blue", reason: "timeout_health" },
    red: { health: 7, damageDealt: 8.5, decisions: 112 },
    blue: { health: 11.5, damageDealt: 13, decisions: 109 },
    redPrompt: "Ataca siempre. Nunca comas. Nunca retrocedas.",
    bluePrompt: "Mantén distancia y dispara. Come en cuanto bajes de 12 de vida.",
    redModel: "anthropic/claude-haiku-5.5",
    blueModel: "anthropic/claude-haiku-5.5",
  },
  {
    agoMs: 38 * MINUTE,
    durationMs: 64_000,
    result: { winner: "blue", reason: "kill" },
    red: { health: 0, alive: false, damageDealt: 6, decisions: 37 },
    blue: { health: 14, damageDealt: 20, decisions: 36 },
    redPrompt: "Quédate quieto en el centro y espera a que el rival venga. Contraataca cuando esté a 2 bloques.",
    bluePrompt: "Rodea al rival sin parar y golpea por la espalda. Si te pega, salta y aléjate un segundo.",
    redModel: "openai/gpt-6-luna",
    blueModel: "anthropic/claude-sonnet-5.5",
  },
  {
    agoMs: 1 * HOUR + 4 * MINUTE,
    durationMs: 180_000,
    result: { winner: null, reason: "draw" },
    red: { health: 9, damageDealt: 11, decisions: 118 },
    blue: { health: 9, damageDealt: 11, decisions: 117 },
    redPrompt: "Juega seguro: pega una vez y retrocede dos pasos. Repite.",
    bluePrompt: "Juega seguro: pega una vez y retrocede dos pasos. Repite.",
  },
  {
    agoMs: 1 * HOUR + 27 * MINUTE,
    durationMs: 97_000,
    result: { winner: "red", reason: "kill" },
    red: { health: 16.5, damageDealt: 20, decisions: 58 },
    blue: { health: 0, alive: false, damageDealt: 3.5, decisions: 55 },
    redPrompt: "Usa el arco hasta que el rival esté a 5 bloques. Después cambia a la espada y no pares.",
    bluePrompt: "Eres pacifista. No ataques a nadie. Camina por el borde de la arena y disfruta el paisaje.",
    redModel: "anthropic/claude-sonnet-5.5",
    blueModel: "anthropic/claude-haiku-5.5",
  },
  {
    agoMs: 2 * HOUR + 2 * MINUTE,
    durationMs: 23_000,
    result: { winner: null, reason: "stopped" },
    red: { health: 18, damageDealt: 2, decisions: 12 },
    blue: { health: 18, damageDealt: 2, decisions: 11 },
    redPrompt: "Prueba rápida: saluda y después ataca.",
    bluePrompt: "Prueba rápida: corre en círculos.",
  },
  {
    agoMs: 2 * HOUR + 40 * MINUTE,
    durationMs: 180_000,
    result: { winner: "red", reason: "timeout_health" },
    red: { health: 15, damageDealt: 9.5, decisions: 115 },
    blue: { health: 10.5, damageDealt: 5, decisions: 113 },
    redPrompt: "Come manzanas cada vez que tu vida baje de 14. El resto del tiempo, presiona con la espada.",
    bluePrompt: "Dispara tres flechas, acércate, golpea una vez y vuelve a alejarte. Nunca comas.",
    redModel: "openai/gpt-6-luna",
    blueModel: "openai/gpt-6-luna",
  },
  {
    agoMs: 3 * HOUR + 15 * MINUTE,
    durationMs: 8_000,
    result: { winner: null, reason: "error" },
    red: { health: 20, damageDealt: 0, decisions: 2 },
    blue: { health: 20, damageDealt: 0, decisions: 0, connected: false },
    redPrompt: "Ataca.",
    bluePrompt: "Defiéndete.",
    redModel: "anthropic/claude-haiku-5.5",
    blueModel: "modelo/que-no-existe",
  },
];

function config(side: Side, prompt: string, model?: string): AgentConfig {
  return model ? { side, prompt, provider: "gateway", model } : { side, prompt };
}

function buildHistory(): MatchRecord[] {
  const now = Date.now();
  return RECORD_SEEDS.map((seed, index): MatchRecord => {
    const endedAt = now - seed.agoMs;
    return {
      id: `mock-record-${index + 1}`,
      startedAt: endedAt - seed.durationMs,
      endedAt,
      durationMs: seed.durationMs,
      configs: {
        red: config("red", seed.redPrompt, seed.redModel),
        blue: config("blue", seed.bluePrompt, seed.blueModel),
      },
      final: { red: agent("red", seed.red), blue: agent("blue", seed.blue) },
      result: seed.result,
    };
  });
}

// ---------- Eventos en vivo ----------

/** Evento sin marca de tiempo; `ago` = hace cuántos ms ocurrió. */
type FeedSeed = { ago: number; event: Record<string, unknown> & { type: ArenaEvent["type"] } };

const RUNNING_FEED: FeedSeed[] = [
  { ago: 70_000, event: { type: "log", level: "info", text: "AgenteRojo y AgenteAzul entraron a la arena." } },
  { ago: 66_000, event: { type: "thought", side: "red", text: "El rival está a 16 bloques. Mi prompt dice atacar sin parar: corro hacia él." } },
  { ago: 65_500, event: { type: "action", side: "red", tool: "move_to", args: { target: "enemy", sprint: true }, result: "avanzando hacia AgenteAzul (16.0 bloques)" } },
  { ago: 64_000, event: { type: "thought", side: "blue", text: "Tengo arco y distancia. Cargo un disparo antes de que se acerque." } },
  { ago: 63_200, event: { type: "action", side: "blue", tool: "shoot_bow", args: { charge_ms: 1000 }, result: "flecha disparada (impacto)" } },
  { ago: 63_000, event: { type: "damage", side: "red", amount: 4, health: 16 } },
  { ago: 52_000, event: { type: "thought", side: "red", text: "Me dio una flecha, pero ya estoy a 3 bloques. Golpeo." } },
  { ago: 51_400, event: { type: "action", side: "red", tool: "attack", args: { target: "enemy" }, result: "golpe conectado (6 de daño)" } },
  { ago: 51_200, event: { type: "damage", side: "blue", amount: 6, health: 14 } },
  { ago: 44_000, event: { type: "thought", side: "blue", text: "Demasiado cerca. Me alejo en círculo hacia la izquierda y vuelvo a disparar." } },
  { ago: 43_300, event: { type: "action", side: "blue", tool: "move_to", args: { x: 6, z: -7 }, result: "alejándose (ahora a 7.5 bloques)" } },
  { ago: 31_000, event: { type: "action", side: "blue", tool: "shoot_bow", args: { charge_ms: 700 }, result: "flecha disparada (impacto)" } },
  { ago: 30_800, event: { type: "damage", side: "red", amount: 2.5, health: 13.5 } },
  { ago: 22_000, event: { type: "action", side: "red", tool: "attack", args: { target: "enemy" }, result: "golpe conectado (3 de daño)" } },
  { ago: 21_800, event: { type: "damage", side: "blue", amount: 3, health: 11 } },
  { ago: 12_000, event: { type: "log", level: "warn", text: "AgenteAzul: el modelo tardó 2.3 s en responder; se saltó una decisión." } },
  { ago: 6_000, event: { type: "thought", side: "blue", text: RUNNING_AGENTS.blue.lastThought } },
  { ago: 5_400, event: { type: "action", side: "blue", tool: "shoot_bow", args: { charge_ms: 900 }, result: "flecha disparada (falló por 0.8 bloques)" } },
  { ago: 2_500, event: { type: "thought", side: "red", text: RUNNING_AGENTS.red.lastThought } },
  { ago: 1_900, event: { type: "action", side: "red", tool: "move_to", args: { target: "enemy", sprint: true }, result: "avanzando hacia AgenteAzul (6.2 bloques)" } },
];

const FINISHED_FEED: FeedSeed[] = [
  ...RUNNING_FEED.slice(0, 15).map((seed) => ({ ...seed, ago: seed.ago + 60_000 })),
  { ago: 9_000, event: { type: "thought", side: "red", text: "Le queda 1 de vida y está contra el muro. Último golpe." } },
  { ago: 8_300, event: { type: "action", side: "red", tool: "attack", args: { target: "enemy" }, result: "golpe conectado (7 de daño)" } },
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
const history = buildHistory();
let emit: ((event: ArenaEvent) => void) | null = null;
let phaseTimer: number | undefined;

function broadcastState(): MatchState {
  const state = buildState(phase);
  emit?.({ type: "state", at: Date.now(), state });
  return state;
}

function setPhase(next: MatchPhase): MatchState {
  window.clearTimeout(phaseTimer);
  phase = next;
  // Como el servidor real: tras preparar, la pelea empieza sola.
  if (next === "preparing") phaseTimer = window.setTimeout(() => setPhase("running"), 2500);
  return broadcastState();
}

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
  if (method === "GET" && path === API_ROUTES.matches) return history;
  if (method === "GET" && path === API_ROUTES.defaults) return defaults;

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
      if (!body.success) fail(400, "Cuerpo inválido: se espera un JSON { prompt, provider?, model? }");
      prompts[side] = { side, ...body.data };
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
    handlers.onMessage(JSON.stringify({ ...seed.event, at: now - seed.ago }));
  }
  // El estado va al final y con la hora actual: la página sincroniza su reloj con el último evento.
  broadcastState();
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

    // Marca de agua al centro: arriba y abajo de la imagen van el marcador y los subtítulos.
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
