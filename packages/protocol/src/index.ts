import { z } from "zod";

/**
 * Contrato compartido entre orquestador, agentes, cámara y web.
 * Sin dependencias de Node: este archivo también se importa en el navegador.
 */

// ---------- Arena ----------

export type ArenaPoint = { x: number; y: number; z: number };
export type ArenaSpawn = ArenaPoint & { yaw: number };

/**
 * Escenarios de arena. El id es también el nombre del mundo (level-name) del servidor:
 * docker-compose y scripts/local/minecraft.sh lo usan tal cual como LEVEL.
 */
export const ARENA_SCENARIOS = ["platanus", "pizza-spleef-2"] as const;
export const ArenaScenarioIdSchema = z.enum(ARENA_SCENARIOS);
export type ArenaScenarioId = z.infer<typeof ArenaScenarioIdSchema>;
export const DEFAULT_ARENA_SCENARIO: ArenaScenarioId = "platanus";

type ArenaCommon = {
  id: ArenaScenarioId;
  /** Nombre legible. */
  name: string;
  /** Nombre del mundo en el servidor (= id). */
  level: string;
  /** Centro del piso; `center.y` es la altura del bloque del piso. */
  center: ArenaPoint;
  /**
   * Radio del círculo jugable inscrito (bloques). Es lo que usan los agentes para no
   * retroceder fuera de la arena; en una arena rectangular es la media distancia menor.
   */
  radius: number;
  /** Altura sobre el piso que puede usar la arena (muros o límite de construcción). */
  wallHeight: number;
  spawns: { red: ArenaSpawn; blue: ArenaSpawn };
  /**
   * Posición de la cámara espectadora: elevada, mirando al centro. Va en +Z para que el
   * lado rojo (x negativo) quede a la izquierda de la imagen, igual que en la web.
   */
  camera: ArenaPoint;
  /** Cámara general: estática, más alta, ve toda la arena. */
  cameraWide: ArenaPoint;
};

/** Mapa importado de un ZIP: entre peleas se restaura copiando su plantilla original. */
export type TemplateArena = ArenaCommon & {
  kind: "template";
  template: { from: ArenaPoint; to: ArenaPoint; destination: ArenaPoint };
  /** Bloque que solo está en el mapa correcto: sirve para detectar un mundo equivocado. */
  check: { at: ArenaPoint; block: string };
};

/**
 * Mundo vacío (void): la arena entera se construye por RCON antes de cada pelea.
 * `floor` son las medias longitudes del piso desde el centro, incluyendo la fila de
 * los muros: el piso va de center.x - halfX a center.x + halfX (ídem en z).
 */
export type BuiltArena = ArenaCommon & {
  kind: "built";
  floor: { halfX: number; halfZ: number };
};

export type ArenaScenario = TemplateArena | BuiltArena;

export const ARENAS: Record<ArenaScenarioId, ArenaScenario> = {
  /** Mundo vacío con piso negro de 57×45, el isotipo de Platanus al centro y muros de vidrio. */
  platanus: {
    id: "platanus",
    name: "Arena Platanus",
    level: "platanus",
    kind: "built",
    center: { x: 0, y: 64, z: 0 },
    floor: { halfX: 28, halfZ: 22 },
    // Interior caminable: |x| <= 27, |z| <= 21.
    radius: 21,
    wallHeight: 5,
    spawns: {
      red: { x: -16, y: 65, z: 0, yaw: -90 },
      blue: { x: 16, y: 65, z: 0, yaw: 90 },
    },
    camera: { x: 0, y: 90, z: 40 },
    cameraWide: { x: 0, y: 104, z: 30 },
  },
  "pizza-spleef-2": {
    id: "pizza-spleef-2",
    name: "Pizza Spleef 2",
    level: "pizza-spleef-2",
    kind: "template",
    /** Disco jugable del mundo importado (no las plantillas del norte). */
    center: { x: 8, y: 3, z: 8 },
    /** Radio del piso (bloques). El borde da al vacío. */
    radius: 25,
    /** Límite de altura para kits de construcción; la pizza no tiene muros físicos. */
    wallHeight: 12,
    /** Plantilla mediana original del mapa; se copia al disco jugable entre peleas. */
    template: {
      from: { x: -25, y: 6, z: -135 },
      to: { x: 37, y: 8, z: -73 },
      destination: { x: -23, y: 3, z: -23 },
    },
    /** Bajo el spawn rojo hay masa de pizza (terracota amarilla). */
    check: { at: { x: -8, y: 3, z: 8 }, block: "minecraft:yellow_terracotta" },
    spawns: {
      red: { x: -8, y: 4, z: 8, yaw: -90 },
      blue: { x: 24, y: 4, z: 8, yaw: 90 },
    },
    camera: { x: 8, y: 33, z: 50 },
    cameraWide: { x: 8, y: 48, z: 38 },
  },
};

/**
 * Escenario por id. Vacío o ausente = el escenario por defecto; un id desconocido es un
 * error de configuración (mejor fallar al arrancar que pelear en el mapa equivocado).
 */
export function arenaFor(id?: string | null): ArenaScenario {
  const key = (id ?? "").trim();
  if (key === "") return ARENAS[DEFAULT_ARENA_SCENARIO];
  const parsed = ArenaScenarioIdSchema.safeParse(key);
  if (!parsed.success) {
    throw new Error(`Escenario de arena desconocido: "${key}" (válidos: ${ARENA_SCENARIOS.join(", ")})`);
  }
  return ARENAS[parsed.data];
}

/** Escenario por defecto. Quien conozca ARENA_SCENARIO debe usar arenaFor(...) en su lugar. */
export const ARENA: ArenaScenario = ARENAS[DEFAULT_ARENA_SCENARIO];

// ---------- Agentes ----------

export const SIDES = ["red", "blue"] as const;
export const SideSchema = z.enum(SIDES);
export type Side = z.infer<typeof SideSchema>;

export const AGENT_USERNAMES: Record<Side, string> = { red: "AgenteRojo", blue: "AgenteAzul" };

/**
 * "vercel" y "gateway" = Vercel AI Gateway (un solo endpoint y una sola clave para todos
 * los modelos): "vercel" va por el SDK `ai`, "gateway" por la API compatible con OpenAI.
 */
export const ProviderSchema = z.enum(["mock", "vercel", "openai", "anthropic", "openrouter", "gateway"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const MAX_PROMPT_LENGTH = 4000;

/** Lo que cualquiera puede editar desde la web (experimental, sin auth). */
export const AgentConfigSchema = z.object({
  side: SideSchema,
  prompt: z.string().max(MAX_PROMPT_LENGTH),
  /** Vacío = usar LLM_PROVIDER / LLM_MODEL del entorno. */
  provider: ProviderSchema.optional(),
  model: z.string().max(100).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const UpdatePromptBodySchema = AgentConfigSchema.omit({ side: true });
export type UpdatePromptBody = z.infer<typeof UpdatePromptBodySchema>;

export const DEFAULT_PROMPTS: Record<Side, string> = {
  red: "Eres agresivo: acércate y ataca sin parar. Come solo si tu vida baja de 6.",
  blue: "Eres defensivo: mantén distancia, usa el arco, y ataca cuerpo a cuerpo solo si el rival tiene poca vida.",
};

// ---------- Estado de la pelea ----------

export const MatchPhaseSchema = z.enum(["idle", "preparing", "running", "finished"]);
export type MatchPhase = z.infer<typeof MatchPhaseSchema>;

export const AgentStatusSchema = z.object({
  side: SideSchema,
  username: z.string(),
  connected: z.boolean(),
  alive: z.boolean(),
  /** 0..20 */
  health: z.number(),
  /** 0..20 */
  food: z.number(),
  damageDealt: z.number(),
  /** Cantidad de decisiones del LLM en esta pelea. */
  decisions: z.number(),
  lastThought: z.string(),
  lastAction: z.string(),
  // Los campos de abajo llevan valor por defecto: los registros guardados antes de que
  // existieran (y un servidor más viejo que la web) siguen siendo válidos.
  /** Ítem que tiene en la mano, con el nombre de Minecraft ("iron_sword", "bow", "cooked_beef"); "" = nada. */
  heldItem: z.string().default(""),
  /** Tokens que el LLM de este agente consumió en esta pelea (entrada y salida). */
  tokensIn: z.number().default(0),
  tokensOut: z.number().default(0),
  /** Promedio de lo que tarda el LLM en responder una decisión, en ms; 0 si aún no decide. */
  avgDecisionMs: z.number().default(0),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const WinReasonSchema = z.enum(["kill", "timeout_health", "draw", "stopped", "error"]);
export type WinReason = z.infer<typeof WinReasonSchema>;

export const MatchResultSchema = z.object({
  winner: SideSchema.nullable(),
  reason: WinReasonSchema,
  /**
   * "Por qué ganó": una frase que explica el resultado. La escribe el orquestador unos
   * segundos DESPUÉS de terminar la pelea, así que al principio no viene.
   */
  explanation: z.string().max(400).optional(),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

export const MatchStateSchema = z.object({
  id: z.string(),
  phase: MatchPhaseSchema,
  /** Epoch ms; null si no ha partido. */
  startedAt: z.number().nullable(),
  /** Epoch ms en que termina por tiempo; null si no ha partido. */
  endsAt: z.number().nullable(),
  agents: z.object({ red: AgentStatusSchema, blue: AgentStatusSchema }),
  /** Prompts congelados con los que se está peleando (o se peleó). */
  configs: z.object({ red: AgentConfigSchema, blue: AgentConfigSchema }),
  result: MatchResultSchema.nullable(),
});
export type MatchState = z.infer<typeof MatchStateSchema>;

/** Resumen persistido de una pelea terminada: la "respuesta" del simulador. */
export const MatchRecordSchema = z.object({
  id: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  durationMs: z.number(),
  configs: z.object({ red: AgentConfigSchema, blue: AgentConfigSchema }),
  final: z.object({ red: AgentStatusSchema, blue: AgentStatusSchema }),
  result: MatchResultSchema,
});
export type MatchRecord = z.infer<typeof MatchRecordSchema>;

// ---------- Eventos en tiempo real (WS orquestador -> web) ----------

export const ArenaEventSchema = z.discriminatedUnion("type", [
  /** Se envía al conectar y cada vez que cambia el estado (como máximo ~4/s). */
  z.object({ type: z.literal("state"), at: z.number(), state: MatchStateSchema }),
  /** Prompts pendientes para la PRÓXIMA pelea cambiaron. */
  z.object({
    type: z.literal("prompts"),
    at: z.number(),
    prompts: z.object({ red: AgentConfigSchema, blue: AgentConfigSchema }),
  }),
  z.object({ type: z.literal("thought"), at: z.number(), side: SideSchema, text: z.string() }),
  z.object({
    type: z.literal("action"),
    at: z.number(),
    side: SideSchema,
    tool: z.string(),
    args: z.record(z.unknown()),
    result: z.string(),
  }),
  z.object({
    type: z.literal("damage"),
    at: z.number(),
    /** Quién recibió el daño. */
    side: SideSchema,
    amount: z.number(),
    health: z.number(),
  }),
  z.object({ type: z.literal("death"), at: z.number(), side: SideSchema }),
  z.object({ type: z.literal("match_end"), at: z.number(), record: MatchRecordSchema }),
  z.object({ type: z.literal("log"), at: z.number(), level: z.enum(["info", "warn", "error"]), text: z.string() }),
]);
export type ArenaEvent = z.infer<typeof ArenaEventSchema>;

// ---------- HTTP API del orquestador ----------
//
// Todas las rutas cuelgan de /api (el proxy inverso las expone tal cual):
//   GET  /api/health                 -> { ok: true }
//   GET  /api/state                  -> MatchState
//   GET  /api/prompts                -> { red: AgentConfig, blue: AgentConfig }
//   PUT  /api/prompts/:side          body UpdatePromptBody -> AgentConfig
//   POST /api/match/start            -> MatchState        (409 si ya hay una pelea en curso)
//   POST /api/match/stop             -> MatchState
//   GET  /api/matches                -> MatchRecord[]     (más recientes primero, máx. 50)
//   GET  /api/defaults               -> ServerDefaults    (proveedor y modelos por defecto del servidor)
//   WS   /api/ws                     -> stream de ArenaEvent en JSON (solo servidor -> cliente)

export const API_ROUTES = {
  health: "/api/health",
  state: "/api/state",
  prompts: "/api/prompts",
  prompt: (side: Side) => `/api/prompts/${side}`,
  matchStart: "/api/match/start",
  matchStop: "/api/match/stop",
  matches: "/api/matches",
  defaults: "/api/defaults",
  ws: "/api/ws",
} as const;

export type PromptsResponse = { red: AgentConfig; blue: AgentConfig };

/**
 * Qué se usa cuando un agente no elige proveedor o modelo: el proveedor por defecto
 * del servidor y el modelo por defecto de cada proveedor. La web lo usa para mostrar
 * el modelo real de cada agente.
 */
export const ServerDefaultsSchema = z.object({
  provider: ProviderSchema,
  models: z.object({
    mock: z.string(),
    vercel: z.string(),
    openai: z.string(),
    anthropic: z.string(),
    openrouter: z.string(),
    gateway: z.string(),
  }),
});
export type ServerDefaults = z.infer<typeof ServerDefaultsSchema>;

export function parseArenaEvent(raw: string): ArenaEvent | null {
  try {
    const parsed = ArenaEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export * from "./tournament";
