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
  type AgentStatus,
  type ArenaEvent,
  type MatchPhase,
  type MatchResult,
  type MatchState,
  type PromptsResponse,
  type ServerDefaults,
  type Side,
} from "@phack/protocol";

const MATCH_DURATION_MS = 180_000;
/** Cuánto lleva la pelea "en curso" al abrir la página. */
const ELAPSED_MS = 72_000;

const params = new URLSearchParams(window.location.search);

/** Atraso simulado del video (ms), para probar la sincronización del marcador. */
export const MOCK_VIDEO_DELAY_MS = Math.max(0, Number(params.get("delay")) || 0);

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

const RUNNING_START = {
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

/** Agentes de la pelea en curso: el bucle de la maqueta los va modificando. */
let running = structuredClone(RUNNING_START);
/** Cuándo "empezó" la pelea en curso; se reinicia cuando el reloj está por llegar a cero. */
let runningSince = Date.now() - ELAPSED_MS;

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
      startedAt: runningSince,
      endsAt: runningSince + MATCH_DURATION_MS,
      agents: structuredClone(running),
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
  { ago: 6_000, event: { type: "thought", side: "blue", text: RUNNING_START.blue.lastThought } },
  { ago: 5_400, event: { type: "action", side: "blue", tool: "shoot_bow", args: { charge_ms: 900 }, result: "flecha disparada (falló por 0.8 bloques)" } },
  { ago: 2_500, event: { type: "thought", side: "red", text: RUNNING_START.red.lastThought } },
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
  if (next === "running") {
    running = structuredClone(RUNNING_START);
    runningSince = Date.now() - ELAPSED_MS;
  }
  syncLoop();
  return broadcastState();
}

// ---------- Pelea en bucle ----------
//
// Mientras la fase es "running", la maqueta sigue emitiendo pensamientos, acciones y
// golpes, para ver vivos los subtítulos, los números de daño y las barras de vida.

const LOOP_MS = 2400;

const LOOP_THOUGHTS: Record<Side, string[]> = {
  red: [
    "Sigue retrocediendo. Corro en diagonal para cortarle el paso.",
    "Lo tengo a 2 bloques. Golpeo ahora, antes de que cargue el arco.",
    "Me queda poca vida pero mi prompt dice no retroceder: sigo atacando.",
  ],
  blue: [
    "Demasiado cerca. Giro a la izquierda y abro distancia.",
    "A 8 bloques, tiro limpio. Cargo el arco al máximo.",
    "Su vida baja más rápido que la mía: mantengo la distancia y sigo disparando.",
  ],
};

let loopTimer: number | undefined;
let loopStep = 0;

function send(event: Record<string, unknown> & { type: ArenaEvent["type"] }): void {
  emit?.({ ...event, at: Date.now() } as ArenaEvent);
}

function think(side: Side): void {
  const options = LOOP_THOUGHTS[side];
  const text = options[Math.floor(loopStep / 6) % options.length]!;
  running[side].lastThought = text;
  running[side].decisions += 1;
  send({ type: "thought", side, text });
}

function act(side: Side, tool: string, args: Record<string, unknown>, result: string): void {
  running[side].lastAction = `${tool}(${JSON.stringify(args)}) → ${result}`;
  send({ type: "action", side, tool, args, result });
}

function hit(attacker: Side, amount: number): void {
  const victim: Side = attacker === "red" ? "blue" : "red";
  // La maqueta nunca termina la pelea: con poca vida, ambos vuelven a 20.
  if (running[victim].health - amount <= 2) {
    running.red.health = 20;
    running.blue.health = 20;
    send({ type: "log", level: "info", text: "Maqueta: la vida vuelve a 20 para seguir mostrando golpes." });
    return;
  }
  running[victim].health -= amount;
  running[attacker].damageDealt += amount;
  send({ type: "damage", side: victim, amount, health: running[victim].health });
}

function loopTick(): void {
  // Antes de que el reloj llegue a cero, la pelea "empieza" de nuevo.
  if (runningSince + MATCH_DURATION_MS - Date.now() < 6000) runningSince = Date.now();

  switch (loopStep % 6) {
    case 0:
      think("red");
      act("red", "move_to", { target: "enemy", sprint: true }, "avanzando hacia AgenteAzul (3.1 bloques)");
      break;
    case 1:
      act("red", "attack", { target: "enemy" }, "golpe conectado (3 de daño)");
      hit("red", 3);
      break;
    case 2:
      think("blue");
      act("blue", "move_to", { x: 7, z: -6 }, "alejándose (ahora a 8.2 bloques)");
      break;
    case 3:
      act("blue", "shoot_bow", { charge_ms: 1000 }, "flecha disparada (impacto)");
      hit("blue", 2.5);
      break;
    case 4:
      think("red");
      break;
    default:
      act("blue", "shoot_bow", { charge_ms: 600 }, "flecha disparada (falló por 1.2 bloques)");
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
  syncLoop();
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
