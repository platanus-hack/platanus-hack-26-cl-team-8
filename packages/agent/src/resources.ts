import { CUSTOM_KIT_POTIONS } from "@phack/protocol";
import { ALWAYS_EDIBLE, attackCooldownMs, isArrow, isAxe, isBow, isBuildBlock, isFoodName, isPickaxe, isSword } from "./items";

export type ResourceItem = { name: string; count: number; slot?: number; durabilityUsed?: number; maxDurability?: number; enchantments?: { name: string; level: number }[] };
export type ResourceUse = { tool: string; description: string; args?: Record<string, unknown>; available: boolean; constraint?: string };
export type ResourceContext = { health: number; food: number; absorption: number; pearlCooldown: number; tools: readonly string[] };

/** Usos soportados por el cuerpo; cantidades y disponibilidad se recalculan cada turno. */
export function describeResources(items: ResourceItem[], context: ResourceContext) {
  const has = (name: string) => items.some((item) => item.name === name && item.count > 0);
  return items.map((item) => {
    const [name, potion] = item.name.split(":");
    const id = name ?? item.name;
    const uses: ResourceUse[] = [];
    const add = (tool: string, description: string, args?: Record<string, unknown>, constraint?: string) => {
      const unavailable = constraint ?? (context.tools.includes(tool) ? undefined : "el cuerpo no ofrece esta herramienta con este kit");
      uses.push({ tool, description, args, available: item.count > 0 && !unavailable, ...(unavailable ? { constraint: unavailable } : {}) });
    };
    if (isSword(id) || isAxe(id)) add("attack", `arma cuerpo a cuerpo; recarga de ${attackCooldownMs(id) / 1000} s${isAxe(id) ? "; puede desactivar escudos" : ""}`, { weapon: id });
    if (isAxe(id) || isPickaxe(id) || id === "shears") add("dig", id === "shears" ? "rompe lana rápidamente" : isAxe(id) ? "rompe madera rápidamente" : "rompe piedra y obsidiana; el tiempo depende del material");
    if (isBuildBlock(id)) add("build", "material para cualquier plano: cobertura, caminos, escaleras, plataformas, pasajes o modificaciones de construcciones existentes; decide su geometría con blocks");
    if (isBow(id) || isArrow(id)) add("shoot", "disparar a distancia; cada tiro consume una flecha", undefined, !has("bow") ? "falta arco" : !items.some((i) => isArrow(i.name) && i.count > 0) ? "faltan flechas" : undefined);
    if (isFoodName(id)) add("eat", ALWAYS_EDIBLE.has(id) ? "se puede comer con hambre llena; la manzana dorada da regeneración y absorción que no se acumula" : "recupera hambre y permite regenerar vida gradualmente", { food: id }, context.food >= 20 && !ALWAYS_EDIBLE.has(id) ? "barra de comida llena" : undefined);
    if (id === "ender_pearl") add("pearl", "reposicionarse cerca del rival o escapar; cuesta vida al aterrizar", undefined, context.health <= 4 ? "vida insuficiente (4 o menos)" : context.pearlCooldown > 0 ? `recarga: ${context.pearlCooldown} s` : undefined);
    if (id === "shield") add("shield", "bloquea daño frontal; attack con guard=true permite cubrirse entre golpes; un hacha puede desactivarlo");
    if (id === "water_bucket") add("water", "controla movimiento y apaga fuego; where=feet amortigua caídas, where=between frena al rival");
    if (id === "lava_bucket") add("lava", "crea una zona peligrosa a los pies del rival; puede quemarte también; requiere rival a entre 3 y 5 bloques");
    if (id === "potion" || id === "splash_potion") {
      const effect = potion ? CUSTOM_KIT_POTIONS[potion] : undefined;
      add(id === "potion" ? "drink" : "throw", effect?.effect ?? "efecto desconocido: no asumas un efecto", potion ? { potion, ...(id === "splash_potion" ? { at: effect?.harmful ? "rival" : "self" } : {}) } : undefined);
    }
    return { ...item, uses, ...(id === "golden_apple" && context.absorption > 0 ? { note: `quedan ${context.absorption} de absorción; otra manzana no la suma` } : {}), ...(uses.length === 0 ? { note: "equipo pasivo o ítem sin uso activo soportado; no puedes fabricar ni abrir menús" } : {}) };
  });
}
