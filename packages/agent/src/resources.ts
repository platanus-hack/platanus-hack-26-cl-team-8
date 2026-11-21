import { CUSTOM_KIT_POTIONS } from "@phack/protocol";
import { round1 } from "./geometry";
import { ALWAYS_EDIBLE, isArrow, isAxe, isBow, isBuildBlock, isFoodName, isLavaBucket, isPearl, isPickaxe, isShield, isSword, isWaterBucket } from "./items";
import { PEARL_MIN_HEALTH } from "./tools";

/** Un ítem tal como lo lee el cuerpo del inventario del bot. */
export type ResourceItem = { name: string; count: number; slot?: number; durabilityUsed?: number; maxDurability?: number; enchantments?: { name: string; level: number }[] };
/** Con qué herramienta y argumentos se usa un ítem; `blocked` solo si ahora no se puede, con el motivo. */
export type ResourceUse = { tool: string; args?: Record<string, unknown>; blocked?: string };
export type ResourceContext = { health: number; food: number; pearlCooldown: number; tools: readonly string[]; /** Vida con la que ya no se lanza la perla con este kit. */ pearlMinHealth?: number };
/** Lo que cambia de un ítem durante la pelea. Qué hace cada objeto está una sola vez, en TU KIT (item-guide.ts). */
export type WornItem = { name: string; durabilityLeft?: number; enchantments?: { name: string; level: number }[] };
export type ResourceView = WornItem & { count: number; uses: ResourceUse[] };

/** Nombre, usos que le quedan (si se desgasta) y encantamientos (si tiene): sin campos vacíos. */
export function wornItem(item: ResourceItem): WornItem {
  const wears = item.maxDurability !== undefined && item.maxDurability > 0;
  return {
    name: item.name,
    ...(wears ? { durabilityLeft: (item.maxDurability as number) - (item.durabilityUsed ?? 0) } : {}),
    ...(item.enchantments && item.enchantments.length > 0 ? { enchantments: item.enchantments } : {}),
  };
}

/**
 * Estado vivo del inventario, por casilla: cantidad, desgaste y con qué herramienta se usa
 * cada cosa ahora mismo. Se recalcula cada turno, así que solo lleva lo que cambia.
 */
export function describeResources(items: ResourceItem[], context: ResourceContext): ResourceView[] {
  const has = (match: (name: string) => boolean): boolean => items.some((item) => match(item.name) && item.count > 0);
  const pearlMin = context.pearlMinHealth ?? PEARL_MIN_HEALTH;
  return items.map((item) => {
    const [name, potion] = item.name.split(":");
    const id = name ?? item.name;
    const uses: ResourceUse[] = [];
    const add = (tool: string, args?: Record<string, unknown>, blocked?: string): void => {
      const why = blocked ?? (context.tools.includes(tool) ? undefined : "tu kit no ofrece esta herramienta");
      uses.push({ tool, ...(args ? { args } : {}), ...(why ? { blocked: why } : {}) });
    };
    if (isSword(id) || isAxe(id)) add("attack", { weapon: id });
    if (isAxe(id) || isPickaxe(id)) add("dig");
    if (isBuildBlock(id)) add("build");
    if (isBow(id) || isArrow(id)) add("shoot", undefined, !has(isBow) ? "falta arco" : !has(isArrow) ? "faltan flechas" : undefined);
    if (isFoodName(id)) add("eat", { food: id }, context.food >= 20 && !ALWAYS_EDIBLE.has(id) ? "barra de comida llena" : undefined);
    if (isPearl(id)) {
      add("pearl", undefined, context.health <= pearlMin ? `vida insuficiente (${pearlMin} o menos)` : context.pearlCooldown > 0 ? `recarga: ${round1(context.pearlCooldown)} s` : undefined);
    }
    if (isShield(id)) {
      add("shield");
      add("attack", { guard: true });
    }
    if (isWaterBucket(id)) add("water");
    if (isLavaBucket(id)) add("lava");
    if (id === "potion" || id === "splash_potion") {
      const harmful = potion ? CUSTOM_KIT_POTIONS[potion]?.harmful : undefined;
      add(id === "potion" ? "drink" : "throw", potion ? { potion, ...(id === "splash_potion" ? { at: harmful ? "rival" : "self" } : {}) } : undefined);
    }
    // `uses` vacío: un ítem que ninguna herramienta usa (un cubo ya vaciado, una botella vacía).
    const { name: shown, ...state } = wornItem(item);
    return { name: shown, count: item.count, ...state, uses };
  });
}
