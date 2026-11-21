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

/** "custom" = el inventario lo describe el usuario dentro de su prompt (ver CUSTOM_KIT_ITEMS). */
export const KIT_IDS = ["classic", "archer", "tank", "berserker", "ender", "builder", "custom"] as const;
export const KitIdSchema = z.enum(KIT_IDS);
export type KitId = z.infer<typeof KitIdSchema>;
export const DEFAULT_KIT: KitId = "classic";

type HotbarIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
/** Las tres filas del inventario principal: 27 casillas, de `inventory.0` a `inventory.26`. */
type InventoryIndex =
  | HotbarIndex
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26;
/** Nombres de slot del comando `item replace entity` de Minecraft Java 1.20.4. */
export type KitSlot =
  | "armor.head"
  | "armor.chest"
  | "armor.legs"
  | "armor.feet"
  | "weapon.offhand"
  | `hotbar.${HotbarIndex}`
  | `inventory.${InventoryIndex}`;

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
      "Armadura de malla, espada de piedra y arco con Empuje I y 32 flechas. Su fuerza es que cada flecha empuja lejos al rival y que le sobra munición; cuerpo a cuerpo es débil.",
    items: [
      ...armor(["chainmail", "chainmail", "chainmail", "chainmail"]),
      item("hotbar.0", "stone_sword", "Espada de piedra"),
      item("hotbar.1", "bow", "Arco", 1, [{ id: "punch", level: 1 }]),
      item("hotbar.2", "cooked_beef", "Filete", 4),
      item("hotbar.8", "arrow", "Flechas", 32),
    ],
    // Sin Velocidad I: el Empuje de sus flechas ya le basta para sacarse al rival de encima.
    effects: [],
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
      "Espada de diamante, armadura mixta de hierro y malla, y 4 perlas de ender para caerle encima al rival o escapar al otro lado de la arena.",
    items: [
      ...armor(["chainmail", "iron", "iron", "chainmail"], [{ id: "feather_falling", level: 4 }]),
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
      "Estilo UHC: armadura y espada de hierro, arco con 8 flechas, 2 manzanas doradas y 16 bloques para levantar muros.",
    items: [
      ...armor(["iron", "iron", "iron", "iron"]),
      item("hotbar.0", "iron_sword", "Espada de hierro"),
      item("hotbar.1", "bow", "Arco"),
      item("hotbar.2", "golden_apple", "Manzana dorada", 2),
      item("hotbar.3", "oak_planks", "Tablones de roble", 16),
      item("hotbar.8", "arrow", "Flechas", 8),
    ],
    effects: [],
  },
  // Molde vacío: el kit real lo arma el orquestador al iniciar la pelea a partir del
  // prompt (AgentConfig.customKit). Mientras no exista, se pelea con lo de aquí: nada.
  custom: {
    id: "custom",
    name: "Personalizado",
    description:
      "Describe tu inventario dentro del prompt (p. ej. \"armadura de diamante, espada de netherita con Filo III, arco, 32 flechas y 3 manzanas doradas\"). Se arma al iniciar la pelea, sin límites.",
    items: [],
    effects: [],
  },
};

export const KIT_LIST: readonly Kit[] = KIT_IDS.map((id) => KITS[id]);

export const ENCHANTMENT_LABELS: Record<string, string> = {
  punch: "Empuje",
  feather_falling: "Caída de pluma",
  sharpness: "Filo",
  fire_aspect: "Aspecto ígneo",
  power: "Poder",
  flame: "Fuego",
  infinity: "Infinidad",
  protection: "Protección",
  thorns: "Espinas",
  unbreaking: "Irrompibilidad",
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
export function kitOf(config: { kit?: KitId | undefined; customKit?: Kit | undefined }): Kit {
  if (config.kit === "custom" && config.customKit) return config.customKit;
  return KITS[config.kit ?? DEFAULT_KIT];
}

// ---------- Kit personalizado ----------
//
// Lista cerrada de lo que se puede pedir: son los ítems que el cuerpo del agente sabe
// usar (armas, arco, comida, perlas, tablones y armadura). No hay presupuesto: el
// usuario decide cuánto lleva. Lo que no esté aquí se ignora.

type CatalogEntry = { label: string; /** Tamaño de un stack en Minecraft. */ stack: number };

const TOOL_MATERIALS = {
  wooden: "madera",
  stone: "piedra",
  iron: "hierro",
  golden: "oro",
  diamond: "diamante",
  netherite: "netherita",
} as const;
const ARMOR_MATERIALS = {
  leather: "cuero",
  chainmail: "malla",
  iron: "hierro",
  golden: "oro",
  diamond: "diamante",
  netherite: "netherita",
} as const;
const ARMOR_PIECE_LABELS = ["Casco", "Peto", "Grebas", "Botas"] as const;
/** Colores de la lana (bloques para construir): id de Minecraft -> adjetivo en español. */
const WOOL_COLORS = {
  white: "blanca",
  orange: "naranja",
  magenta: "magenta",
  light_blue: "celeste",
  yellow: "amarilla",
  lime: "verde lima",
  pink: "rosada",
  gray: "gris",
  light_gray: "gris claro",
  cyan: "cian",
  purple: "morada",
  blue: "azul",
  brown: "café",
  green: "verde",
  red: "roja",
  black: "negra",
} as const;

function buildCatalog(): Record<string, CatalogEntry> {
  const catalog: Record<string, CatalogEntry> = {};
  for (const [id, name] of Object.entries(TOOL_MATERIALS)) {
    catalog[`${id}_sword`] = { label: `Espada de ${name}`, stack: 1 };
    catalog[`${id}_axe`] = { label: `Hacha de ${name}`, stack: 1 };
  }
  for (const [id, name] of Object.entries(ARMOR_MATERIALS)) {
    ARMOR_PIECES.forEach((piece, i) => {
      catalog[`${id}_${piece}`] = { label: `${ARMOR_PIECE_LABELS[i] as string} de ${name}`, stack: 1 };
    });
  }
  Object.assign(catalog, {
    bow: { label: "Arco", stack: 1 },
    arrow: { label: "Flechas", stack: 64 },
    ender_pearl: { label: "Perla de ender", stack: 16 },
    oak_planks: { label: "Tablones de roble", stack: 64 },
    water_bucket: { label: "Cubo de agua", stack: 1 },
    lava_bucket: { label: "Cubo de lava", stack: 1 },
    shield: { label: "Escudo", stack: 1 },
    cooked_beef: { label: "Filete", stack: 64 },
    cooked_porkchop: { label: "Chuleta cocinada", stack: 64 },
    cooked_chicken: { label: "Pollo asado", stack: 64 },
    bread: { label: "Pan", stack: 64 },
    baked_potato: { label: "Papa asada", stack: 64 },
    apple: { label: "Manzana", stack: 64 },
    golden_carrot: { label: "Zanahoria dorada", stack: 64 },
    golden_apple: { label: "Manzana dorada", stack: 64 },
    enchanted_golden_apple: { label: "Manzana dorada encantada", stack: 64 },
  } satisfies Record<string, CatalogEntry>);
  for (const [id, name] of Object.entries(WOOL_COLORS)) {
    catalog[`${id}_wool`] = { label: `Lana ${name}`, stack: 64 };
  }
  return catalog;
}

/** Ítems que se pueden pedir en un kit personalizado (id de Minecraft -> nombre y stack). */
export const CUSTOM_KIT_ITEMS: Readonly<Record<string, CatalogEntry>> = buildCatalog();

/** Encantamientos permitidos y el nivel máximo que acepta cada uno. */
export const CUSTOM_KIT_ENCHANTMENTS: Readonly<Record<string, number>> = {
  sharpness: 5,
  fire_aspect: 2,
  power: 5,
  punch: 2,
  flame: 1,
  infinity: 1,
  protection: 4,
  feather_falling: 4,
  thorns: 3,
  unbreaking: 3,
};

/** Efectos permanentes permitidos: id -> nombre en español (el nivel va aparte). */
export const CUSTOM_KIT_EFFECTS: Readonly<Record<string, string>> = {
  speed: "Velocidad",
  strength: "Fuerza",
  resistance: "Resistencia",
  regeneration: "Regeneración",
  jump_boost: "Salto",
  fire_resistance: "Resistencia al fuego",
};
/** Nivel máximo de un efecto (amplifier 4 = nivel V). */
export const CUSTOM_KIT_MAX_AMPLIFIER = 4;

/** Lo que se pide para un kit personalizado, antes de validar. */
export type CustomKitRequest = {
  items: { item: string; count?: number; enchantments?: { id: string; level?: number }[] }[];
  effects?: { id: string; level?: number }[];
};

const ARMOR_SLOT_BY_PIECE: Record<string, KitSlot> = {
  helmet: "armor.head",
  chestplate: "armor.chest",
  leggings: "armor.legs",
  boots: "armor.feet",
};

function armorSlotOf(id: string): KitSlot | null {
  const piece = id.slice(id.lastIndexOf("_") + 1);
  return ARMOR_SLOT_BY_PIECE[piece] ?? null;
}

/** Convención de los kits fijos: arma en la 1, arco en la 2, comida en la 3, flechas en la 9. */
function preferredHotbar(id: string): number {
  if (/_(sword|axe)$/.test(id)) return 0;
  if (id === "bow") return 1;
  if (id === "arrow") return 8;
  if (id === "ender_pearl" || id === "oak_planks" || id.endsWith("_wool") || id.endsWith("_bucket")) return 3;
  return 2;
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Arma un kit personalizado a partir de lo pedido: descarta lo que no está en la lista,
 * acomoda cada ítem en un slot (armadura puesta; arma en la hotbar 1, arco en la 2,
 * comida en la 3, flechas en la 9, lo demás donde quepa) y parte las cantidades en stacks.
 * `ignored` dice qué se descartó y por qué, para el registro.
 */
export function buildCustomKit(request: CustomKitRequest): { kit: Kit; ignored: string[] } {
  const ignored: string[] = [];
  const items: KitItem[] = [];
  const used = new Set<KitSlot>();
  const hotbarFree = (preferred: number): KitSlot | null => {
    const order = [preferred, 3, 4, 5, 6, 7, 2, 1, 0, 8];
    for (const i of order) {
      const slot = `hotbar.${i}` as KitSlot;
      if (!used.has(slot)) return slot;
    }
    for (let i = 0; i < 27; i += 1) {
      const slot = `inventory.${i}` as KitSlot;
      if (!used.has(slot)) return slot;
    }
    return null;
  };

  const sources = Array.isArray(request.items) ? request.items : [];
  for (const raw of sources) {
    const id = typeof raw?.item === "string" ? raw.item.trim().toLowerCase().replace(/^minecraft:/, "") : "";
    const entry = CUSTOM_KIT_ITEMS[id];
    if (!entry) {
      if (id) ignored.push(`${id}: no está en la lista de ítems permitidos`);
      continue;
    }
    const enchantments: KitEnchantment[] = [];
    for (const e of Array.isArray(raw.enchantments) ? raw.enchantments : []) {
      const eid = typeof e?.id === "string" ? e.id.trim().toLowerCase().replace(/^minecraft:/, "") : "";
      const max = CUSTOM_KIT_ENCHANTMENTS[eid];
      if (max === undefined) {
        if (eid) ignored.push(`encantamiento ${eid}: no permitido`);
        continue;
      }
      if (!enchantments.some((x) => x.id === eid)) enchantments.push({ id: eid, level: intIn(e.level, 1, max, 1) });
    }

    const armorSlot = /_(helmet|chestplate|leggings|boots)$/.test(id) ? armorSlotOf(id) : null;
    if (armorSlot) {
      if (used.has(armorSlot)) {
        ignored.push(`${id}: ya hay otra pieza en ese lugar de la armadura`);
        continue;
      }
      used.add(armorSlot);
      items.push(enchantments.length ? { slot: armorSlot, item: id, count: 1, label: entry.label, enchantments } : { slot: armorSlot, item: id, count: 1, label: entry.label });
      continue;
    }

    // El escudo va en la mano secundaria: así se levanta sin soltar el arma.
    if (id === "shield" && !used.has("weapon.offhand")) {
      used.add("weapon.offhand");
      items.push({ slot: "weapon.offhand", item: id, count: 1, label: entry.label });
      continue;
    }

    const preferred = preferredHotbar(id);
    let remaining = intIn(raw.count, 1, 36 * 64, 1);
    while (remaining > 0) {
      const slot = hotbarFree(preferred);
      if (!slot) {
        ignored.push(`${id}: no cabe en el inventario`);
        break;
      }
      const count = Math.min(remaining, entry.stack);
      used.add(slot);
      items.push(enchantments.length ? { slot, item: id, count, label: entry.label, enchantments } : { slot, item: id, count, label: entry.label });
      remaining -= count;
    }
  }

  const effects: KitEffect[] = [];
  for (const e of Array.isArray(request.effects) ? request.effects : []) {
    const eid = typeof e?.id === "string" ? e.id.trim().toLowerCase().replace(/^minecraft:/, "") : "";
    const label = CUSTOM_KIT_EFFECTS[eid];
    if (!label) {
      if (eid) ignored.push(`efecto ${eid}: no permitido`);
      continue;
    }
    if (effects.some((x) => x.id === eid)) continue;
    const amplifier = intIn(e.level, 1, CUSTOM_KIT_MAX_AMPLIFIER + 1, 1) - 1;
    effects.push({ id: eid, amplifier, label: `${label} ${ROMAN[amplifier + 1] ?? amplifier + 1}` });
  }

  const base = KITS.custom;
  return { kit: { id: "custom", name: base.name, description: base.description, items, effects }, ignored };
}

const KIT_SLOT_RE = /^(armor\.(head|chest|legs|feet)|weapon\.offhand|hotbar\.[0-8]|inventory\.([0-9]|1[0-9]|2[0-6]))$/;

/** Kit completo (el personalizado ya armado) tal como viaja en el estado y el historial. */
export const KitSchema = z.object({
  id: KitIdSchema,
  name: z.string().max(80),
  description: z.string().max(600),
  items: z
    .array(
      z.object({
        slot: z.custom<KitSlot>((v) => typeof v === "string" && KIT_SLOT_RE.test(v)),
        item: z.string().regex(/^[a-z0-9_]+$/).max(64),
        count: z.number().int().min(1).max(64),
        label: z.string().max(80),
        enchantments: z
          .array(z.object({ id: z.string().regex(/^[a-z_]+$/).max(40), level: z.number().int().min(1).max(10) }))
          .max(12)
          .readonly()
          .optional(),
      }),
    )
    .max(41)
    .readonly(),
  effects: z
    .array(z.object({ id: z.string().regex(/^[a-z_]+$/).max(40), amplifier: z.number().int().min(0).max(9), label: z.string().max(80) }))
    .max(12)
    .readonly(),
});

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
  /**
   * Solo con kit "custom": el kit que armó el orquestador al iniciar la pelea a partir del
   * prompt. Lo escribe el servidor (en el estado y el historial), nunca la web.
   */
  customKit: KitSchema.optional().catch(undefined),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const UpdatePromptBodySchema = AgentConfigSchema.omit({ side: true, customKit: true });
export type UpdatePromptBody = z.infer<typeof UpdatePromptBodySchema>;

export const DEFAULT_PROMPTS: Record<Side, string> = {
  red: "Eres agresivo: acércate y ataca sin parar. Come solo si tu vida baja de 6.",
  blue: "Eres defensivo: mantén distancia, usa el arco, y ataca cuerpo a cuerpo solo si el rival tiene poca vida.",
};

// ---------- Comunicación entre agentes ----------

/**
 * Qué sabe cada agente del otro, además de lo que ve en el mundo:
 * - "none": nada.
 * - "thoughts": lee los razonamientos ("reason") del rival, pero no pueden hablarse.
 * - "chat": pueden mandarse mensajes (para negociar, persuadir o engañar); los
 *   razonamientos siguen siendo privados.
 */
export const COMMS_MODES = ["none", "thoughts", "chat"] as const;
export const CommsModeSchema = z.enum(COMMS_MODES);
export type CommsMode = z.infer<typeof CommsModeSchema>;
export const DEFAULT_COMMS: CommsMode = "none";

export const COMMS_LABELS: Record<CommsMode, { name: string; description: string }> = {
  none: { name: "Sin comunicación", description: "Cada agente solo ve lo que pasa en la arena." },
  thoughts: {
    name: "Leen la mente",
    description: "Cada agente lee lo que piensa el otro en cada decisión, pero no pueden hablarse.",
  },
  chat: {
    name: "Pueden hablarse",
    description: "Los agentes se mandan mensajes: pueden negociar, persuadir o engañar al rival.",
  },
};

/** Largo máximo de un mensaje entre agentes (modo "chat"). */
export const MAX_AGENT_MESSAGE_LENGTH = 240;

/** Ajustes de la pelea (no de un lado): se editan en la web y valen desde la próxima. */
export const MatchSettingsSchema = z.object({
  comms: CommsModeSchema.catch(DEFAULT_COMMS).default(DEFAULT_COMMS),
});
export type MatchSettings = z.infer<typeof MatchSettingsSchema>;
export const DEFAULT_SETTINGS: MatchSettings = { comms: DEFAULT_COMMS };

export const UpdateSettingsBodySchema = z.object({ comms: CommsModeSchema });
export type UpdateSettingsBody = z.infer<typeof UpdateSettingsBodySchema>;

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

/** Segundos de cuenta regresiva entre que los dos peleadores quedan listos y empieza la pelea. */
export const COUNTDOWN_SECONDS = 3;

export const MatchStateSchema = z.object({
  id: z.string(),
  phase: MatchPhaseSchema,
  /** Epoch ms; null si no ha partido. */
  startedAt: z.number().nullable(),
  /** Epoch ms en que termina por tiempo; null si no ha partido. */
  endsAt: z.number().nullable(),
  /**
   * Epoch ms en que termina la cuenta regresiva y empieza la pelea. Solo tiene valor durante la
   * fase "preparing", desde que los dos peleadores están listos; null el resto del tiempo.
   */
  countdownEndsAt: z.number().nullable().default(null),
  agents: z.object({ red: AgentStatusSchema, blue: AgentStatusSchema }),
  /** Prompts congelados con los que se está peleando (o se peleó). */
  configs: z.object({ red: AgentConfigSchema, blue: AgentConfigSchema }),
  /** Ajustes congelados con los que se está peleando (o se peleó). */
  settings: MatchSettingsSchema.default(DEFAULT_SETTINGS),
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
  /** Falta en los registros de antes de que existieran los ajustes: valen los de por defecto. */
  settings: MatchSettingsSchema.default(DEFAULT_SETTINGS),
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
  /** Ajustes pendientes para la PRÓXIMA pelea cambiaron. */
  z.object({ type: z.literal("settings"), at: z.number(), settings: MatchSettingsSchema }),
  z.object({ type: z.literal("thought"), at: z.number(), side: SideSchema, text: z.string() }),
  /** Modo "chat": `side` le dijo `text` al rival. */
  z.object({ type: z.literal("message"), at: z.number(), side: SideSchema, text: z.string() }),
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
//   GET  /api/settings               -> MatchSettings     (ajustes pendientes para la próxima pelea)
//   PUT  /api/settings               body UpdateSettingsBody { comms } -> MatchSettings
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
  settings: "/api/settings",
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
