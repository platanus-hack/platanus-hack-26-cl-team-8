/**
 * Partes puras del cuerpo del bot (atributos y corazones amarillos), separadas de
 * fighter.ts para poder probarlas sin Minecraft.
 */

/** Atributo de una entidad con la forma que usa mineflayer. */
export type StoredAttribute = { value: number; modifiers: unknown[] };

/**
 * Guarda los atributos de un paquete `entity_update_attributes` en `attributes`.
 * El servidor 1.20.4 los manda con espacio de nombres ("minecraft:generic.movement_speed"),
 * pero la física de mineflayer busca la velocidad sin él ("generic.movement_speed", que es
 * lo que trae minecraft-data). Se guardan bajo los dos nombres para que la encuentre.
 * Hasta 1.20.4 el nombre viene en `name`; desde 1.20.5, en `key`.
 */
export function storeAttributes(attributes: Record<string, unknown>, properties: unknown[]): void {
  for (const property of properties) {
    if (typeof property !== "object" || property === null) continue;
    const { key, name, value, modifiers } = property as Record<string, unknown>;
    const id = typeof key === "string" ? key : name;
    if (typeof id !== "string" || typeof value !== "number") continue;
    const stored: StoredAttribute = { value, modifiers: Array.isArray(modifiers) ? modifiers : [] };
    attributes[id] = stored;
    const bare = id.startsWith("minecraft:") ? id.slice("minecraft:".length) : id;
    if (bare !== id) attributes[bare] = stored;
  }
}

/**
 * Corazones amarillos que cuentan como vida: solo mientras dura el efecto de absorción.
 * Al acabarse el efecto el servidor avisa primero que terminó y después baja la absorción
 * a 0; esa baja no es daño, así que sin efecto activo no se cuentan.
 */
export function countedAbsorption(absorption: number, effectActive: boolean): number {
  return effectActive && Number.isFinite(absorption) && absorption > 0 ? absorption : 0;
}
