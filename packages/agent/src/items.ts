/**
 * Clasificación de ítems por su nombre de Minecraft y recarga de ataque de cada arma.
 * Puro (sin mineflayer): lo usan el cuerpo del agente, las herramientas y el prompt.
 */

export const isSword = (name: string): boolean => name.endsWith("_sword");
export const isAxe = (name: string): boolean => name.endsWith("_axe");
export const isBow = (name: string): boolean => name === "bow";
export const isArrow = (name: string): boolean => name === "arrow" || name.endsWith("_arrow");
export const isPearl = (name: string): boolean => name === "ender_pearl";
/**
 * Bloques con los que se levanta el muro o la torre: tablones y lana (no piedra ni tierra,
 * que el pathfinder usaría de andamio si se le permitiera).
 */
export const isBuildBlock = (name: string): boolean => name.endsWith("_planks") || name.endsWith("_wool");
export const isShield = (name: string): boolean => name === "shield";
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
