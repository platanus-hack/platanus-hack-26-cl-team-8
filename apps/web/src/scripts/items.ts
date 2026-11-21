/**
 * Ítems de Minecraft en pantalla: qué ícono y qué nombre le toca a cada id del juego
 * ("iron_sword", "ender_pearl"...). Lo comparten el inventario del kit de cada editor
 * y el casillero "en la mano" del marcador.
 */
import { CUSTOM_KIT_ITEMS, KIT_LIST } from "@phack/protocol";
import type { IconName, IconRef, Material } from "./pixelicons";

/** Prefijo del id ("iron_sword", "wooden_axe") -> material con el que se tiñe el ícono. */
const PREFIX_MATERIAL: Record<string, Material> = {
  wooden: "wood",
  stone: "stone",
  iron: "iron",
  diamond: "diamond",
  chainmail: "chainmail",
  golden: "gold",
  netherite: "netherite",
  leather: "leather",
};

/** Formas que cambian de color según el material: "<material>_<forma>". */
const SHAPES = ["sword", "axe", "pickaxe", "helmet", "chestplate", "leggings", "boots"] as const satisfies readonly IconName[];

const FIXED: Record<string, IconRef> = {
  bow: { name: "bow" },
  arrow: { name: "arrow" },
  ender_pearl: { name: "pearl" },
  golden_apple: { name: "gapple" },
  enchanted_golden_apple: { name: "gapple" },
  cobblestone: { name: "tile", material: "stone" },
  shield: { name: "shield" },
  potion: { name: "potion" },
  splash_potion: { name: "splash_potion" },
  water_bucket: { name: "water_bucket" },
  lava_bucket: { name: "lava_bucket" },
};

/** Ícono de un ítem del juego, o null si no hay uno dibujado para él. */
export function itemIcon(minecraftId: string): IconRef | null {
  const id = minecraftId.replace(/^minecraft:/, "");
  const fixed = FIXED[id];
  if (fixed) return fixed;

  const split = id.lastIndexOf("_");
  if (split > 0) {
    const shape = SHAPES.find((name) => name === id.slice(split + 1));
    const material = PREFIX_MATERIAL[id.slice(0, split)];
    // Una forma conocida de un material sin colores: mejor nada que un ícono engañoso.
    if (shape) return material ? { name: shape, material } : null;
  }
  if (id.endsWith("_planks")) return { name: "tile", material: "wood" };
  if (id.endsWith("_wool")) return { name: "tile", material: "wool" };
  // Cualquier otra comida se muestra con el filete.
  if (/beef|pork|chicken|mutton|bread|apple|carrot|potato|stew|cod|salmon/.test(id)) return { name: "steak" };
  return null;
}

/** Nombres en español: los que ya traen los kits ("Espada de hierro"). */
const LABELS = new Map<string, string>();
// Primero los del kit personalizado; los de los kits fijos pisan (son los mismos textos).
for (const [id, entry] of Object.entries(CUSTOM_KIT_ITEMS)) LABELS.set(id, entry.label);
for (const kit of KIT_LIST) {
  for (const item of kit.items) LABELS.set(item.item, item.label);
}

/** Nombre para mostrar de un ítem; si no es de ningún kit, su id sin guiones bajos. */
export function itemLabel(minecraftId: string): string {
  const id = minecraftId.replace(/^minecraft:/, "");
  return LABELS.get(id) ?? id.replaceAll("_", " ");
}
