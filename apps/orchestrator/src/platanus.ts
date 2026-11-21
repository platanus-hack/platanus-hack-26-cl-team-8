import { readFileSync } from "node:fs";
import type { BuiltArena } from "@phack/protocol";

/**
 * Arena Platanus: se construye entera por RCON sobre un mundo vacío (void).
 * Funciones puras que devuelven comandos de Minecraft Java 1.20.4, para poder testearlas.
 *
 * Piso rectangular de concreto negro con el isotipo de Platanus en pixel art al centro y
 * muros de vidrio en el borde. Sin techo: la cámara ve desde arriba y las flechas que
 * salen por encima caen al vacío. Nada de barrier.
 */

export const FLOOR_BLOCK = "minecraft:black_concrete";
export const WALL_BLOCK = "minecraft:glass";
/**
 * Colores del logo. El crema va en concreto blanco: el concreto amarillo es liso y
 * saturado, y los bloques "crema" de verdad (arenisca lisa, tablas de abedul, terracota
 * blanca) tienen textura o quedan demasiado cerca del amarillo; vistos desde la cámara
 * los plátanos se pierden. El blanco liso da el contraste del isotipo original.
 */
export const LOGO_BLOCKS: Record<string, string> = {
  Y: "minecraft:yellow_concrete",
  C: "minecraft:white_concrete",
};
/** Celda fuera del círculo del logo: queda el piso negro. */
export const LOGO_EMPTY = ".";
/** Bloques de aire que se limpian por encima de los muros (restos de flechas, bloques puestos). */
export const CLEAR_ABOVE_WALLS = 6;
/** Límite de bloques de un /fill en 1.20.4. */
export const MAX_FILL_VOLUME = 32_768;
/** Restos de combate que se eliminan antes de cada pelea. */
const DEBRIS = ["item", "arrow", "spectral_arrow", "experience_orb"];

/** Valida y normaliza la grilla del logo: cuadrada, de lado impar y solo con Y, C y punto. */
export function parseLogo(text: string): string[] {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0);
  const size = rows.length;
  if (size === 0 || size % 2 === 0) throw new Error(`El logo debe tener un número impar de filas (tiene ${size})`);
  for (const [i, row] of rows.entries()) {
    if (row.length !== size) throw new Error(`Fila ${i} del logo: ${row.length} columnas, se esperaban ${size}`);
    const bad = [...row].find((ch) => ch !== LOGO_EMPTY && !(ch in LOGO_BLOCKS));
    if (bad !== undefined) throw new Error(`Fila ${i} del logo: carácter inválido "${bad}"`);
  }
  return rows;
}

let cachedLogo: string[] | null = null;

/** Grilla 41×41 de apps/orchestrator/src/platanus-logo.txt (se lee una vez). */
export function loadLogo(): string[] {
  cachedLogo ??= parseLogo(readFileSync(new URL("./platanus-logo.txt", import.meta.url), "utf8"));
  return cachedLogo;
}

/** Tramo de bloques iguales en una fila del logo: z fijo, x de `fromX` a `toX` inclusive. */
export type LogoRun = { z: number; fromX: number; toX: number; block: string };

/**
 * Tramos contiguos por fila. Fila 0 = norte (z menor), columna 0 = oeste (x menor): la
 * cámara mira hacia el norte desde +Z, así el logo se lee derecho en la transmisión.
 */
export function logoRuns(grid: string[], center: { x: number; z: number }): LogoRun[] {
  const half = (grid.length - 1) / 2;
  const runs: LogoRun[] = [];
  grid.forEach((row, r) => {
    const z = center.z - half + r;
    let start = 0;
    for (let col = 1; col <= row.length; col += 1) {
      if (col < row.length && row[col] === row[start]) continue;
      const ch = row[start]!;
      if (ch !== LOGO_EMPTY) {
        runs.push({ z, fromX: center.x - half + start, toX: center.x - half + col - 1, block: LOGO_BLOCKS[ch]! });
      }
      start = col;
    }
  });
  return runs;
}

/** Caja del piso (incluye la fila de los muros). */
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
export function platanusBuildCommands(arena: BuiltArena, grid: string[] = loadLogo()): string[] {
  const { minX, maxX, minZ, maxZ } = floorBounds(arena);
  const y = arena.center.y;
  const wallTop = y + arena.wallHeight;
  const half = (grid.length - 1) / 2;
  if (half > arena.floor.halfX - 1 || half > arena.floor.halfZ - 1) {
    throw new Error("El logo no cabe dentro de los muros de la arena");
  }
  const logo = logoRuns(grid, arena.center).map(
    (run) => `fill ${run.fromX} ${y} ${run.z} ${run.toX} ${y} ${run.z} ${run.block}`,
  );
  const box = `x=${minX},y=${y - 2},z=${minZ},dx=${maxX - minX},dy=${arena.wallHeight + CLEAR_ABOVE_WALLS + 2},dz=${maxZ - minZ}`;
  return [
    // Interior y muros viejos: todo a aire (también lo que alguien haya puesto encima).
    `fill ${minX} ${y + 1} ${minZ} ${maxX} ${wallTop + CLEAR_ABOVE_WALLS} ${maxZ} minecraft:air`,
    `fill ${minX} ${y} ${minZ} ${maxX} ${y} ${maxZ} ${FLOOR_BLOCK}`,
    ...logo,
    // Cuatro muros sobre el borde del piso; las esquinas quedan en dos de ellos, sin huecos.
    `fill ${minX} ${y + 1} ${minZ} ${maxX} ${wallTop} ${minZ} ${WALL_BLOCK}`,
    `fill ${minX} ${y + 1} ${maxZ} ${maxX} ${wallTop} ${maxZ} ${WALL_BLOCK}`,
    `fill ${minX} ${y + 1} ${minZ} ${minX} ${wallTop} ${maxZ} ${WALL_BLOCK}`,
    `fill ${maxX} ${y + 1} ${minZ} ${maxX} ${wallTop} ${maxZ} ${WALL_BLOCK}`,
    ...DEBRIS.map((type) => `kill @e[type=minecraft:${type},${box}]`),
  ];
}
