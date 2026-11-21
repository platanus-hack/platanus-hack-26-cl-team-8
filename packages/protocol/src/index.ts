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

// ---------- Kits ----------
//
// Datos puros: el orquestador arma con ellos los comandos de RCON, el agente decide qué
// herramientas ofrecer y la web dibuja el inventario. Van antes de "Agentes" porque
// AgentConfigSchema usa KitIdSchema.

export const KIT_IDS = ["classic", "archer", "tank", "berserker", "ender", "builder"] as const;
export const KitIdSchema = z.enum(KIT_IDS);
export type KitId = z.infer<typeof KitIdSchema>;
export const DEFAULT_KIT: KitId = "classic";

type HotbarIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
/** Nombres de slot del comando `item replace entity` de Minecraft Java 1.20.4. */
export type KitSlot =
  | "armor.head"
  | "armor.chest"
  | "armor.legs"
  | "armor.feet"
  | "weapon.offhand"
  | `hotbar.${HotbarIndex}`
  | `inventory.${number}`;

/** `id` sin el prefijo "minecraft:" (ids de 1.20.4: "punch", "feather_falling", "sharpness"...). */
export type KitEnchantment = { id: string; level: number };

export type KitItem = {
  slot: KitSlot;
  /** Id de Minecraft sin prefijo: "iron_sword". */
  item: string;
  count: number;
  /** Nombre en español para tooltips y lectores de pantalla. */
  label: string;
  enchantments?: readonly KitEnchantment[];
};

/** Efecto permanente que se da con `effect give ... infinite`. `amplifier` 0 = nivel I. */
export type KitEffect = { id: string; amplifier: number; label: string };

export type Kit = {
  id: KitId;
  name: string;
  description: string;
  items: readonly KitItem[];
  effects: readonly KitEffect[];
};

const ARMOR_SLOTS = ["armor.head", "armor.chest", "armor.legs", "armor.feet"] as const;
const ARMOR_PIECES = ["helmet", "chestplate", "leggings", "boots"] as const;
const ARMOR_LABELS = {
  iron: ["Casco de hierro", "Peto de hierro", "Grebas de hierro", "Botas de hierro"],
  chainmail: ["Casco de malla", "Cota de malla", "Grebas de malla", "Botas de malla"],
  diamond: ["Casco de diamante", "Peto de diamante", "Grebas de diamante", "Botas de diamante"],
} as const;
type ArmorMaterial = keyof typeof ARMOR_LABELS;

/** Cuatro piezas en orden casco, peto, grebas, botas; cada una con su material. */
function armor(
  materials: readonly [ArmorMaterial, ArmorMaterial, ArmorMaterial, ArmorMaterial],
  bootEnchantments?: readonly KitEnchantment[],
): KitItem[] {
  return ARMOR_SLOTS.map((slot, i) => {
    const material = materials[i] as ArmorMaterial;
    const piece: KitItem = {
      slot,
      item: `${material}_${ARMOR_PIECES[i] as string}`,
      count: 1,
      label: ARMOR_LABELS[material][i] as string,
    };
    if (i === 3 && bootEnchantments) piece.enchantments = bootEnchantments;
    return piece;
  });
}

function item(slot: KitSlot, id: string, label: string, count = 1, enchantments?: readonly KitEnchantment[]): KitItem {
  return enchantments ? { slot, item: id, count, label, enchantments } : { slot, item: id, count, label };
}

const SPEED_I: KitEffect = { id: "speed", amplifier: 0, label: "Velocidad I" };

export const KITS: Record<KitId, Kit> = {
  classic: {
    id: "classic",
    name: "Clásico",
    description: "Armadura de hierro, espada, arco con 16 flechas y 4 filetes. El kit equilibrado de siempre.",
    items: [
      ...armor(["iron", "iron", "iron", "iron"]),
      item("hotbar.0", "iron_sword", "Espada de hierro"),
      item("hotbar.1", "bow", "Arco"),
      item("hotbar.2", "cooked_beef", "Filete", 4),
      item("hotbar.8", "arrow", "Flechas", 16),
    ],
    effects: [],
  },
  archer: {
    id: "archer",
    name: "Arquero",
    description:
      "Armadura de malla, arco con Empuje I y 32 flechas, espada de piedra y Velocidad I. Fuerte de lejos, débil cuerpo a cuerpo.",
    items: [
      ...armor(["chainmail", "chainmail", "chainmail", "chainmail"]),
      item("hotbar.0", "stone_sword", "Espada de piedra"),
      item("hotbar.1", "bow", "Arco", 1, [{ id: "punch", level: 1 }]),
      item("hotbar.2", "cooked_beef", "Filete", 4),
      item("hotbar.8", "arrow", "Flechas", 32),
    ],
    effects: [SPEED_I],
  },
  tank: {
    id: "tank",
    name: "Tanque",
    description:
      "Peto y grebas de diamante con casco y botas de hierro. Aguanta mucho, pero solo lleva una espada de piedra y no tiene arco.",
    items: [
      ...armor(["iron", "diamond", "diamond", "iron"]),
      item("hotbar.0", "stone_sword", "Espada de piedra"),
      item("hotbar.2", "cooked_beef", "Filete", 4),
    ],
    effects: [],
  },
  berserker: {
    id: "berserker",
    name: "Berserker",
    description:
      "Hacha de diamante que pega fuerte pero lento, armadura mixta de hierro y malla, y Velocidad I. Sin arco: todo es cerrar distancia.",
    items: [
      ...armor(["chainmail", "iron", "iron", "chainmail"]),
      item("hotbar.0", "diamond_axe", "Hacha de diamante"),
      item("hotbar.2", "cooked_beef", "Filete", 4),
    ],
    effects: [SPEED_I],
  },
  ender: {
    id: "ender",
    name: "Enderman",
    description:
      "Espada de diamante, armadura de malla y 4 perlas de ender para caerle encima al rival o escapar al otro lado de la arena.",
    items: [
      ...armor(["chainmail", "chainmail", "chainmail", "chainmail"], [{ id: "feather_falling", level: 4 }]),
      item("hotbar.0", "diamond_sword", "Espada de diamante"),
      item("hotbar.1", "ender_pearl", "Perla de ender", 4),
      item("hotbar.2", "cooked_beef", "Filete", 4),
    ],
    effects: [],
  },
  builder: {
    id: "builder",
    name: "Constructor",
    description:
      "Estilo UHC: armadura y espada de hierro, arco con 8 flechas, 3 manzanas doradas y 16 bloques para levantar muros.",
    items: [
      ...armor(["iron", "iron", "iron", "iron"]),
      item("hotbar.0", "iron_sword", "Espada de hierro"),
      item("hotbar.1", "bow", "Arco"),
      item("hotbar.2", "golden_apple", "Manzana dorada", 3),
      item("hotbar.3", "oak_planks", "Tablones de roble", 16),
      item("hotbar.8", "arrow", "Flechas", 8),
    ],
    effects: [],
  },
};

export const KIT_LIST: readonly Kit[] = KIT_IDS.map((id) => KITS[id]);

export const ENCHANTMENT_LABELS: Record<string, string> = {
  punch: "Empuje",
  feather_falling: "Caída de pluma",
};
const ROMAN = ["", "I", "II", "III", "IV", "V"];

/** "Arco (Empuje I)", "Flechas x32": texto del tooltip de un slot. */
export function kitItemTitle(i: KitItem): string {
  const enchants = (i.enchantments ?? []).map((e) => `${ENCHANTMENT_LABELS[e.id] ?? e.id} ${ROMAN[e.level] ?? e.level}`);
  const base = enchants.length > 0 ? `${i.label} (${enchants.join(", ")})` : i.label;
  return i.count > 1 ? `${base} x${i.count}` : base;
}

/** Slot de la ventana de inventario del jugador (el que usa mineflayer): armadura 5-8, principal 9-35, hotbar 36-44, mano secundaria 45. */
export function kitWindowSlot(slot: KitSlot): number {
  switch (slot) {
    case "armor.head":
      return 5;
    case "armor.chest":
      return 6;
    case "armor.legs":
      return 7;
    case "armor.feet":
      return 8;
    case "weapon.offhand":
      return 45;
    default: {
      const [group, index] = slot.split(".");
      return (group === "hotbar" ? 36 : 9) + Number(index);
    }
  }
}

/** Kit de una configuración; si falta o es desconocido, el kit por defecto. */
export function kitOf(config: { kit?: KitId | undefined }): Kit {
  return KITS[config.kit ?? DEFAULT_KIT];
}

// ---------- Agentes ----------

export const SIDES = ["red", "blue"] as const;
export const SideSchema = z.enum(SIDES);
export type Side = z.infer<typeof SideSchema>;

export const AGENT_USERNAMES: Record<Side, string> = { red: "AgenteRojo", blue: "AgenteAzul" };

/**
 * "vercel" = Vercel AI Gateway por el SDK `ai` (un solo endpoint y una sola clave para todos
 * los modelos). "mock" = LLM simulado, sin red ni costo: para pruebas.
 */
export const ProviderSchema = z.enum(["mock", "vercel"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const MAX_PROMPT_LENGTH = 4000;

/** Lo que cualquiera puede editar desde la web (experimental, sin auth). */
export const AgentConfigSchema = z.object({
  side: SideSchema,
  prompt: z.string().max(MAX_PROMPT_LENGTH),
  /** Vacío = usar LLM_PROVIDER / LLM_MODEL del entorno. */
  provider: ProviderSchema.optional(),
  model: z.string().max(100).optional(),
  /**
   * Kit con el que pelea este lado. Opcional y tolerante: si falta (registros viejos,
   * servidor más antiguo que la web) o trae un id desconocido, vale DEFAULT_KIT (ver kitOf).
   */
  kit: KitIdSchema.optional().catch(undefined),
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
//   PUT  /api/prompts/:side          body UpdatePromptBody { prompt, provider?, model?, kit? } -> AgentConfig
//                                    (400 si el modelo no está en la lista de permitidos)
//   POST /api/match/start            -> MatchState        (409 si ya hay una pelea en curso)
//   POST /api/match/stop             -> MatchState
//   GET  /api/matches                -> MatchRecord[]     (más recientes primero, máx. 50)
//   GET  /api/defaults               -> ServerDefaults    (proveedor y modelos por defecto del servidor)
//   GET  /api/models                 -> ModelsResponse    (modelos permitidos: los que no pasan de MODEL_PRICE_CAP)
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
  models: "/api/models",
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
  }),
});
export type ServerDefaults = z.infer<typeof ServerDefaultsSchema>;

/** Tope de precio de un modelo permitido, en dólares por millón de tokens. */
export const MODEL_PRICE_CAP = { inputPerMillion: 1, outputPerMillion: 5 } as const;

/** Un modelo que se puede elegir: el del catálogo público que no pasa de MODEL_PRICE_CAP. */
export const AllowedModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Dólares POR TOKEN. */
  inputPrice: z.number(),
  outputPrice: z.number(),
});
export type AllowedModel = z.infer<typeof AllowedModelSchema>;

export const ModelsResponseSchema = z.object({
  models: z.array(AllowedModelSchema),
  /** "catalog" = lista viva del catálogo; "fallback" = lista fija porque no se pudo descargar. */
  source: z.enum(["catalog", "fallback"]),
  /** Epoch ms de la última descarga buena; null si nunca hubo una. */
  updatedAt: z.number().nullable(),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

export function parseArenaEvent(raw: string): ArenaEvent | null {
  try {
    const parsed = ArenaEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
