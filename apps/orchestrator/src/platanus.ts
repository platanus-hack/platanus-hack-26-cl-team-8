import { FLOOR_LOGO_PALETTE, FLOOR_LOGO_RADIUS, FLOOR_LOGO_ROWS, type BuiltArena } from "@phack/protocol";

/**
 * Arena Platanus: se construye entera por RCON sobre un mundo vacío (void).
 * Funciones puras que devuelven comandos de Minecraft Java 1.20.4, para poder testearlas.
 *
 * Es una plataforma lisa: piso de piedra, el logo de Platanus al centro y la marca de cada
 * lado, rodeada por muros de vidrio sobre la fila del borde. Sin techo: la cámara ve desde
 * arriba y lo que sale por encima de los muros cae al vacío. Nada de barrier.
 */

export const FLOOR_BLOCK = "minecraft:smooth_stone";
/** Muros del borde: vidrio, la cámara ve a través. */
export const WALL_BLOCK = "minecraft:glass";
/** Marca en el piso del lugar donde empieza cada lado. */
export const SPAWN_MARKS = { red: "minecraft:red_concrete", blue: "minecraft:blue_concrete" } as const;
/** Bloques de aire que se limpian por encima de los muros (restos de flechas, bloques puestos). */
export const CLEAR_ABOVE_WALLS = 6;
/**
 * Franja alrededor de la plataforma que se deja en aire al construir. El mundo se guarda
 * entre peleas: si antes hubo una arena más grande (la de 57×45, con su piso negro y sus
 * muros de vidrio), sus restos quedarían a la vista alrededor de la plataforma y el límite
 * parecería estar allá lejos. Con esto, lo único que se ve es la plataforma con sus muros.
 */
export const SURROUND_MARGIN = 16;
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

/** Caja del piso (incluye la fila del borde, donde van los muros). */
export function floorBounds(arena: BuiltArena): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const { center, floor } = arena;
  return {
    minX: center.x - floor.halfX,
    maxX: center.x + floor.halfX,
    minZ: center.z - floor.halfZ,
    maxZ: center.z + floor.halfZ,
  };
}

/** Caja de la plataforma más la franja que se limpia alrededor (ver SURROUND_MARGIN). */
export function surroundBounds(arena: BuiltArena): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const { minX, maxX, minZ, maxZ } = floorBounds(arena);
  return {
    minX: minX - SURROUND_MARGIN,
    maxX: maxX + SURROUND_MARGIN,
    minZ: minZ - SURROUND_MARGIN,
    maxZ: maxZ + SURROUND_MARGIN,
  };
}

/**
 * Deja en aire la franja que rodea la plataforma, desde el nivel del piso hasta donde
 * llega la limpieza de adentro: cuatro tiras (norte, sur, oeste y este), cada una muy por
 * debajo del límite de bloques de un /fill.
 */
export function surroundClearCommands(arena: BuiltArena): string[] {
  const { minX, maxX, minZ, maxZ } = floorBounds(arena);
  const out = surroundBounds(arena);
  const y = arena.center.y;
  const top = y + arena.wallHeight + CLEAR_ABOVE_WALLS;
  return [
    `fill ${out.minX} ${y} ${out.minZ} ${out.maxX} ${top} ${minZ - 1} minecraft:air`,
    `fill ${out.minX} ${y} ${maxZ + 1} ${out.maxX} ${top} ${out.maxZ} minecraft:air`,
    `fill ${out.minX} ${y} ${minZ} ${minX - 1} ${top} ${maxZ} minecraft:air`,
    `fill ${maxX + 1} ${y} ${minZ} ${out.maxX} ${top} ${maxZ} minecraft:air`,
  ];
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
    // Interior y muros viejos: todo a aire (también lo que alguien haya puesto encima).
    `fill ${minX} ${y + 1} ${minZ} ${maxX} ${wallTop + CLEAR_ABOVE_WALLS} ${maxZ} minecraft:air`,
    // Alrededor no queda nada de una arena anterior más grande.
    ...surroundClearCommands(arena),
    `fill ${minX} ${y} ${minZ} ${maxX} ${y} ${maxZ} ${FLOOR_BLOCK}`,
    ...logo,
    `fill ${red.x} ${y} ${red.z} ${red.x} ${y} ${red.z} ${SPAWN_MARKS.red}`,
    `fill ${blue.x} ${y} ${blue.z} ${blue.x} ${y} ${blue.z} ${SPAWN_MARKS.blue}`,
    // Cuatro muros de vidrio sobre el borde del piso; las esquinas quedan en dos de ellos, sin huecos.
    `fill ${minX} ${y + 1} ${minZ} ${maxX} ${wallTop} ${minZ} ${WALL_BLOCK}`,
    `fill ${minX} ${y + 1} ${maxZ} ${maxX} ${wallTop} ${maxZ} ${WALL_BLOCK}`,
    `fill ${minX} ${y + 1} ${minZ} ${minX} ${wallTop} ${maxZ} ${WALL_BLOCK}`,
    `fill ${maxX} ${y + 1} ${minZ} ${maxX} ${wallTop} ${maxZ} ${WALL_BLOCK}`,
    ...DEBRIS.map((type) => `kill @e[type=minecraft:${type},${box}]`),
  ];
}
