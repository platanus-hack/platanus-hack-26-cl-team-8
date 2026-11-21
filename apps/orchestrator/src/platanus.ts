import { FLOOR_LOGO_PALETTE, FLOOR_LOGO_RADIUS, FLOOR_LOGO_ROWS, type BuiltArena } from "@phack/protocol";

/**
 * Arena Platanus: se construye entera por RCON sobre un mundo vacío (void).
 * Funciones puras que devuelven comandos de Minecraft Java 1.20.4, para poder testearlas.
 *
 * Es una plataforma lisa: piso de piedra, el logo de Platanus al centro y la marca de cada
 * lado. No tiene nada más a la vista. Para que nadie caiga al vacío, la fila del borde y el
 * techo son de barrera: invisible para la cámara, pero no se atraviesa.
 */

export const FLOOR_BLOCK = "minecraft:smooth_stone";
/** Pared del borde y techo: barrera, que no se ve en la transmisión. */
export const WALL_BLOCK = "minecraft:barrier";
/** Marca en el piso del lugar donde empieza cada lado. */
export const SPAWN_MARKS = { red: "minecraft:red_concrete", blue: "minecraft:blue_concrete" } as const;
/** Bloques de aire que se limpian por encima de la pared (restos de flechas, bloques puestos). */
export const CLEAR_ABOVE_WALLS = 6;
/** Restos de combate que se eliminan antes de cada pelea. */
const DEBRIS = ["item", "arrow", "spectral_arrow", "experience_orb"];

/** Tramo de bloques iguales en una fila del logo: z fijo, x de `fromX` a `toX` inclusive. */
export type LogoRun = { z: number; fromX: number; toX: number; block: string };

/**
 * El logo del centro del piso (FLOOR_LOGO_ROWS), en tramos contiguos por fila. Fila 0 =
 * norte (z menor), columna 0 = oeste (x menor): la cámara mira hacia el norte desde +Z, así
 * el logo se lee derecho en la transmisión. Las letras sin bloque dejan el piso como está.
 */
export function logoRuns(center: { x: number; z: number }, rows: readonly string[] = FLOOR_LOGO_ROWS): LogoRun[] {
  const half = (rows.length - 1) / 2;
  const runs: LogoRun[] = [];
  rows.forEach((row, r) => {
    const z = center.z - half + r;
    let start = 0;
    for (let col = 1; col <= row.length; col += 1) {
      if (col < row.length && row[col] === row[start]) continue;
      const block = FLOOR_LOGO_PALETTE[row[start]!]?.block;
      if (block) {
        runs.push({ z, fromX: center.x - half + start, toX: center.x - half + col - 1, block: `minecraft:${block}` });
      }
      start = col;
    }
  });
  return runs;
}

/** Caja del piso (incluye la fila del borde, donde va la pared invisible). */
export function floorBounds(arena: BuiltArena): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const { center, floor } = arena;
  return {
    minX: center.x - floor.halfX,
    maxX: center.x + floor.halfX,
    minZ: center.z - floor.halfZ,
    maxZ: center.z + floor.halfZ,
  };
}

/**
 * Comandos para (re)construir la arena desde cero. El primero es el /fill de limpieza: si
 * el chunk todavía no cargó, ese es el que hay que reintentar.
 */
export function platanusBuildCommands(arena: BuiltArena): string[] {
  const { minX, maxX, minZ, maxZ } = floorBounds(arena);
  const y = arena.center.y;
  const wallTop = y + arena.wallHeight;
  if (FLOOR_LOGO_RADIUS > arena.floor.halfX - 1 || FLOOR_LOGO_RADIUS > arena.floor.halfZ - 1) {
    throw new Error("El logo no cabe dentro de la arena");
  }
  const logo = logoRuns(arena.center).map(
    (run) => `fill ${run.fromX} ${y} ${run.z} ${run.toX} ${y} ${run.z} ${run.block}`,
  );
  const { red, blue } = arena.spawns;
  const box = `x=${minX},y=${y - 2},z=${minZ},dx=${maxX - minX},dy=${arena.wallHeight + CLEAR_ABOVE_WALLS + 2},dz=${maxZ - minZ}`;
  return [
    // Interior, pared y techo viejos: todo a aire (también lo que alguien haya puesto encima).
    `fill ${minX} ${y + 1} ${minZ} ${maxX} ${wallTop + CLEAR_ABOVE_WALLS} ${maxZ} minecraft:air`,
    `fill ${minX} ${y} ${minZ} ${maxX} ${y} ${maxZ} ${FLOOR_BLOCK}`,
    ...logo,
    `fill ${red.x} ${y} ${red.z} ${red.x} ${y} ${red.z} ${SPAWN_MARKS.red}`,
    `fill ${blue.x} ${y} ${blue.z} ${blue.x} ${y} ${blue.z} ${SPAWN_MARKS.blue}`,
    // Cuatro paredes invisibles sobre el borde del piso; las esquinas quedan en dos de ellas, sin huecos.
    `fill ${minX} ${y + 1} ${minZ} ${maxX} ${wallTop} ${minZ} ${WALL_BLOCK}`,
    `fill ${minX} ${y + 1} ${maxZ} ${maxX} ${wallTop} ${maxZ} ${WALL_BLOCK}`,
    `fill ${minX} ${y + 1} ${minZ} ${minX} ${wallTop} ${maxZ} ${WALL_BLOCK}`,
    `fill ${maxX} ${y + 1} ${minZ} ${maxX} ${wallTop} ${maxZ} ${WALL_BLOCK}`,
    // Techo invisible justo sobre la pared: una perla o una torre de bloques no sacan a nadie.
    `fill ${minX} ${wallTop + 1} ${minZ} ${maxX} ${wallTop + 1} ${maxZ} ${WALL_BLOCK}`,
    ...DEBRIS.map((type) => `kill @e[type=minecraft:${type},${box}]`),
  ];
}
