/**
 * Clasificación de ítems por su nombre de Minecraft y recarga de ataque de cada arma.
 * Puro (sin mineflayer): lo usan el cuerpo del agente, las herramientas y el prompt.
 */
import { FLOOR_LOGO_PALETTE } from "@phack/protocol";

export const isSword = (name: string): boolean => name.endsWith("_sword");
export const isAxe = (name: string): boolean => name.endsWith("_axe");
export const isBow = (name: string): boolean => name === "bow";
export const isArrow = (name: string): boolean => name === "arrow" || name.endsWith("_arrow");
export const isPearl = (name: string): boolean => name === "ender_pearl";
/**
 * Bloques que "build" acepta como material. Un kit solo trae tablones de roble y roca; la
 * obsidiana aparece cuando el agua toca la lava y se puede recoger con pico de diamante.
 */
const BUILD_BLOCK_NAMES: ReadonlySet<string> = new Set(["cobblestone", "dirt", "obsidian"]);
export const isBuildBlock = (name: string): boolean =>
  (name.endsWith("_planks") || name.endsWith("_wool") || BUILD_BLOCK_NAMES.has(name)) && !isAdminBlock(name);
export const isPickaxe = (name: string): boolean => name.endsWith("_pickaxe");

/**
 * Lista negra: bloques administrativos o indestructibles que nunca se rompen ni se colocan,
 * en ningún mapa (barreras, roca madre, bloques de comandos y de estructuras, luz
 * invisible, portales, generadores de mobs).
 */
export const ADMIN_BLOCKS: ReadonlySet<string> = new Set([
  "barrier",
  "bedrock",
  "command_block",
  "chain_command_block",
  "repeating_command_block",
  "structure_block",
  "structure_void",
  "jigsaw",
  "light",
  "end_portal",
  "end_portal_frame",
  "end_gateway",
  "nether_portal",
  "reinforced_deepslate",
  "spawner",
]);

/** ¿Es un bloque de la lista negra (ADMIN_BLOCKS)? Acepta el id con o sin "minecraft:". */
export const isAdminBlock = (name: string): boolean => ADMIN_BLOCKS.has(name.replace(/^minecraft:/, ""));

/**
 * Bloques de la arena: no se rompen nunca (piso con el logo del centro, muros de vidrio con
 * su base de linternas, marcas de spawn y la tapa invisible). Todo lo demás que esté sobre
 * el piso lo puso alguien. Importa: bajo el piso no hay nada, quien lo rompa cae al vacío.
 */
export const ARENA_BLOCKS: ReadonlySet<string> = new Set([
  "smooth_stone",
  "glass",
  "sea_lantern",
  "red_concrete",
  "blue_concrete",
  ...ADMIN_BLOCKS,
  // Los bloques del logo del piso.
  ...Object.values(FLOOR_LOGO_PALETTE).map((entry) => entry.block),
]);

/** Lo que no es un bloque que se pueda romper: aire y líquidos. */
const NOT_SOLID: ReadonlySet<string> = new Set(["air", "cave_air", "void_air", "water", "lava", "fire"]);

/**
 * Qué se puede romper en un mapa: "placed" = solo lo colocado por los luchadores, nunca la
 * arena (Platanus y la pizza: su piso y sus muros son la arena); "terrain" = también el
 * terreno del mapa (las islas de Chunk Battle), menos la lista negra.
 */
export type BreakRule = "placed" | "terrain";

/** ¿Se puede romper este bloque? Con "placed", nunca la arena; con "terrain", todo menos ADMIN_BLOCKS. */
export const isBreakable = (name: string, rule: BreakRule = "placed"): boolean => {
  if (NOT_SOLID.has(name)) return false;
  return rule === "terrain" ? !isAdminBlock(name) : !ARENA_BLOCKS.has(name);
};

/** Calidad de un material de herramienta: más alto, rompe más rápido. */
const TIER: Record<string, number> = { wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 };
const tierOf = (name: string): number => TIER[name.slice(0, name.indexOf("_"))] ?? 0;

/**
 * Herramienta del inventario que mejor rompe un bloque (null = a mano): hacha para la
 * madera, pico para la piedra y la obsidiana; la de mejor material.
 */
export function bestDigTool(blockName: string, inventory: readonly string[]): string | null {
  let match: ((name: string) => boolean) | null = null;
  if (blockName.endsWith("_planks") || blockName.endsWith("_log")) match = isAxe;
  else if (blockName === "dirt" || blockName === "sand" || blockName === "gravel") match = null;
  else match = isPickaxe;
  if (!match) return null;
  const candidates = inventory.filter(match);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, name) => (tierOf(name) > tierOf(best) ? name : best));
}

/**
 * Arma que saca "attack" cuando no se le nombra una: la espada de mejor material y, si no
 * hay espada, el hacha de mejor material. Lo usan el cuerpo y el prompt: una sola regla.
 */
export function defaultMeleeWeapon(inventory: readonly string[]): string | null {
  const best = (match: (name: string) => boolean): string | null => {
    const found = inventory.filter(match);
    return found.length === 0 ? null : found.reduce((top, name) => (tierOf(name) > tierOf(top) ? name : top));
  };
  return best(isSword) ?? best(isAxe);
}

/** Daño de un golpe a recarga completa, antes de la armadura del rival (Minecraft Java 1.20.4). */
const SWORD_DAMAGE: Record<string, number> = { wooden: 4, golden: 4, stone: 5, iron: 6, diamond: 7, netherite: 8 };
const AXE_DAMAGE: Record<string, number> = { wooden: 7, golden: 7, stone: 9, iron: 9, diamond: 9, netherite: 10 };
/** A puño limpio, o con un ítem que no es arma en la mano. */
export const FIST_DAMAGE = 1;

export function meleeDamage(heldItem: string): number {
  const material = heldItem.slice(0, heldItem.indexOf("_"));
  if (isSword(heldItem)) return SWORD_DAMAGE[material] ?? FIST_DAMAGE;
  if (isAxe(heldItem)) return AXE_DAMAGE[material] ?? FIST_DAMAGE;
  return FIST_DAMAGE;
}

export const isShield = (name: string): boolean => name === "shield";
export const isDrinkPotion = (name: string): boolean => name === "potion";
export const isSplashPotion = (name: string): boolean => name === "splash_potion";
export const isWaterBucket = (name: string): boolean => name === "water_bucket";
export const isLavaBucket = (name: string): boolean => name === "lava_bucket";

/** Comidas conocidas, por si el registro de mineflayer no trae la tabla de comidas. */
export const FOOD_NAMES: ReadonlySet<string> = new Set([
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
export const ALWAYS_EDIBLE: ReadonlySet<string> = new Set(["golden_apple", "enchanted_golden_apple", "chorus_fruit"]);

export const isFoodName = (name: string): boolean => FOOD_NAMES.has(name);

/** Recarga de las espadas (velocidad de ataque 1.6/s = 625 ms) más el margen. */
const SWORD_COOLDOWN_MS = 650;
/** Recarga con la mano vacía o con un ítem que no es arma (4/s = 250 ms) más el margen. */
const HAND_COOLDOWN_MS = 300;

/**
 * Milisegundos entre golpes a daño completo según el ítem en la mano (Minecraft 1.20.4).
 * Golpear antes sale mucho más débil, así que el cuerpo espera esta recarga.
 * Hachas: madera y piedra 0.8/s, hierro 0.9/s, oro, diamante y netherita 1/s.
 *
 * Cada valor lleva un margen de hasta un tick de servidor (50 ms) sobre la recarga
 * exacta: el servidor cuenta en ticks, y un golpe que llega justo a los 1000 ms puede caer
 * en el tick 19 y salir con ~96% del daño.
 */
export function attackCooldownMs(heldItem: string): number {
  if (isSword(heldItem)) return SWORD_COOLDOWN_MS;
  if (isAxe(heldItem)) {
    if (heldItem.startsWith("wooden_") || heldItem.startsWith("stone_")) return 1300;
    if (heldItem.startsWith("iron_")) return 1150;
    return 1050;
  }
  return HAND_COOLDOWN_MS;
}
