import { z } from "zod";

/**
 * Contrato compartido entre orquestador, agentes, cámara y web.
 * Sin dependencias de Node: este archivo también se importa en el navegador.
 */

// ---------- Arena ----------

export const ARENA = {
  center: { x: 0, y: 64, z: 0 },
  /** Radio interior del piso (bloques). */
  radius: 12,
  /** Altura de los muros. */
  wallHeight: 6,
  spawns: {
    red: { x: -8, y: 65, z: 0, yaw: -90 },
    blue: { x: 8, y: 65, z: 0, yaw: 90 },
  },
  /**
   * Posición de la cámara espectadora: elevada, mirando al centro. Va en +Z para que el
   * lado rojo (x negativo) quede a la izquierda de la imagen, igual que en la web.
   */
  camera: { x: 0, y: 78, z: 18 },
} as const;

// ---------- Agentes ----------

export const SIDES = ["red", "blue"] as const;
export const SideSchema = z.enum(SIDES);
export type Side = z.infer<typeof SideSchema>;

export const AGENT_USERNAMES: Record<Side, string> = { red: "AgenteRojo", blue: "AgenteAzul" };

export const ProviderSchema = z.enum(["mock", "vercel", "openai", "anthropic", "openrouter"]);
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
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const WinReasonSchema = z.enum(["kill", "timeout_health", "draw", "stopped", "error"]);
export type WinReason = z.infer<typeof WinReasonSchema>;

export const MatchResultSchema = z.object({
  winner: SideSchema.nullable(),
  reason: WinReasonSchema,
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
//   WS   /api/ws                     -> stream de ArenaEvent en JSON (solo servidor -> cliente)

export const API_ROUTES = {
  health: "/api/health",
  state: "/api/state",
  prompts: "/api/prompts",
  prompt: (side: Side) => `/api/prompts/${side}`,
  matchStart: "/api/match/start",
  matchStop: "/api/match/stop",
  matches: "/api/matches",
  ws: "/api/ws",
} as const;

export type PromptsResponse = { red: AgentConfig; blue: AgentConfig };

export function parseArenaEvent(raw: string): ArenaEvent | null {
  try {
    const parsed = ArenaEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
