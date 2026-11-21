import { readFileSync } from "node:fs";
import { z } from "zod";
import { ISLAND_STRUCTURE_SIZE, type ArenaPoint, type ArenaSpawn, type ChunkIsland, type IslandsArena, type Side } from "@phack/protocol";

/**
 * Chunk Battle: dos islas flotantes construidas por RCON en el mundo vacío `arena`.
 * Funciones puras que devuelven comandos de Minecraft Java 1.20.4, para poder testearlas.
 *
 * Las estructuras vienen del mapa "Chunk Battle" descargado por el usuario y están en el
 * datapack del repo `infra/minecraft/datapacks/phack-chunkbattle/` (namespace `phack`):
 *  - `phack:chunk/<tema>`: islas temáticas de 22×48×22. Su núcleo de 16×16 (relativo
 *    3..18, alturas 0..31) viene vacío (structure_void): el mapa original lo rellena con
 *    capas de mineral apiladas al azar, y aquí se hace igual.
 *  - `phack:layer/<n>`: las 25 capas de 16×1×16 con las que se rellena el núcleo.
 * `structures.json`, junto al datapack, guarda por tema el spawn calculado al exportar
 * (columna más cercana al centro con suelo firme, dos de aire encima, cielo abierto y sin
 * lava cerca) y el alto de la superficie.
 *
 * Todo lo que varía entre peleas lo decide la semilla: qué tema le toca a cada isla y qué
 * capas lleva el núcleo. La roja siempre es la oeste: la ida y la vuelta de una pareja (con
 * la misma semilla y lados intercambiados) juegan en las mismas islas.
 */

/** Límite de bloques de un /fill en 1.20.4. */
export const MAX_FILL_VOLUME = 32_768;
/** Capas que se apilan en el núcleo (alturas relativas 0..31), como el generador original. */
export const CORE_LAYERS = 32;

/**
 * Bloques que se retiran de las islas tras colocarlas: administrativos (el mapa original
 * trae un command_block), invisibles (light) y fluidos (una isla trae lava en la
 * superficie, que mataría sin que el agente lo vea).
 */
export const ISLAND_CLEANUP_BLOCKS = [
  "minecraft:command_block",
  "minecraft:chain_command_block",
  "minecraft:repeating_command_block",
  "minecraft:structure_block",
  "minecraft:jigsaw",
  "minecraft:spawner",
  "minecraft:barrier",
  "minecraft:light",
  "minecraft:lava",
  "minecraft:water",
] as const;

const PointSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() });

const MetadataSchema = z.object({
  source: z.string(),
  size: z.tuple([z.number(), z.number(), z.number()]),
  core: z.object({ min: z.number().int(), max: z.number().int(), top: z.number().int() }),
  layers: z.array(z.object({ id: z.string() })).min(1),
  themes: z
    .array(
      z.object({
        name: z.string(),
        id: z.string(),
        /** Bloque del suelo del spawn, relativo a la estructura sin rotar. */
        spawn: PointSchema.extend({ openSky: z.boolean() }),
        /** Alto (relativo) del bloque más alto de la columna central. */
        centerTopY: z.number().int(),
      }),
    )
    .min(2),
});
export type ChunkBattleMetadata = z.infer<typeof MetadataSchema>;
export type ChunkBattleTheme = ChunkBattleMetadata["themes"][number];

const METADATA_URL = new URL("../../../infra/minecraft/datapacks/phack-chunkbattle/structures.json", import.meta.url);

/** Valida los metadatos del datapack (tamaño y núcleo deben calzar con el contrato). */
export function parseChunkBattleMetadata(raw: unknown): ChunkBattleMetadata {
  const meta = MetadataSchema.parse(raw);
  const { x, y, z: sz } = ISLAND_STRUCTURE_SIZE;
  if (meta.size[0] !== x || meta.size[1] !== y || meta.size[2] !== sz) {
    throw new Error(`Las islas de Chunk Battle deben medir ${x}×${y}×${sz} (el datapack dice ${meta.size.join("×")})`);
  }
  if (meta.core.max - meta.core.min + 1 !== 16 || meta.core.top + 1 !== CORE_LAYERS) {
    throw new Error("El núcleo de las islas de Chunk Battle debe ser de 16×16 con 32 capas");
  }
  return meta;
}

let cachedMetadata: ChunkBattleMetadata | null = null;

/** Metadatos del datapack del repo (se leen una vez). */
export function loadChunkBattleMetadata(): ChunkBattleMetadata {
  cachedMetadata ??= parseChunkBattleMetadata(JSON.parse(readFileSync(METADATA_URL, "utf8")));
  return cachedMetadata;
}

/** Ids `phack:…` de todas las estructuras que usa el escenario (temas + capas). */
export function chunkBattleStructures(meta: ChunkBattleMetadata = loadChunkBattleMetadata()): string[] {
  return [...meta.themes.map((theme) => theme.id), ...meta.layers.map((layer) => layer.id)];
}

/** Semilla nueva para peleas sin semilla (las de la web). Entero de 31 bits. */
export function randomChunkBattleSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 2 ** 31);
}

/** PRNG determinista (mulberry32): el mismo número da siempre la misma secuencia. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export type IslandLayout = {
  side: Side;
  island: ChunkIsland;
  theme: ChunkBattleTheme;
  /** Capa de cada altura del núcleo, de abajo hacia arriba (ids `phack:layer/n`). */
  layers: string[];
  /** Spawn real: sobre la superficie de la isla, mirando a la otra. */
  spawn: ArenaSpawn;
};

export type ChunkBattleLayout = { seed: number; red: IslandLayout; blue: IslandLayout };

/** Celda relativa (sin rotar) → posición absoluta, según la rotación de la isla. */
export function islandToWorld(island: ChunkIsland, rel: ArenaPoint): ArenaPoint {
  const last = { x: ISLAND_STRUCTURE_SIZE.x - 1, z: ISLAND_STRUCTURE_SIZE.z - 1 };
  const { origin } = island;
  if (island.rotation === "180") {
    return { x: origin.x + last.x - rel.x, y: origin.y + rel.y, z: origin.z + last.z - rel.z };
  }
  return { x: origin.x + rel.x, y: origin.y + rel.y, z: origin.z + rel.z };
}

/**
 * Dónde va el `place template`: con rotación 180 la estructura gira en torno a ese punto,
 * así que el punto es la esquina máxima de la caja.
 */
export function templateAnchor(island: ChunkIsland): ArenaPoint {
  return islandToWorld(island, { x: 0, y: 0, z: 0 });
}

function islandSide(arena: IslandsArena, side: Side): ChunkIsland {
  const island = arena.islands.find((candidate) => candidate.side === side);
  if (!island) throw new Error(`El escenario ${arena.name} no tiene isla para el lado ${side}`);
  return island;
}

/**
 * Islas de una semilla: dos temas distintos (rojo, azul) y las 32 capas de cada núcleo.
 * Solo depende de la semilla y de los metadatos del datapack.
 */
export function chunkBattleLayout(
  arena: IslandsArena,
  seed: number,
  meta: ChunkBattleMetadata = loadChunkBattleMetadata(),
): ChunkBattleLayout {
  if (!Number.isSafeInteger(seed)) throw new Error(`Semilla inválida para Chunk Battle: ${seed}`);
  const random = seededRandom(seed);
  const pick = (n: number) => Math.floor(random() * n);
  const redTheme = pick(meta.themes.length);
  let blueTheme = pick(meta.themes.length - 1);
  if (blueTheme >= redTheme) blueTheme += 1;
  const layersFor = () => Array.from({ length: CORE_LAYERS }, () => meta.layers[pick(meta.layers.length)]!.id);

  const build = (side: Side, theme: ChunkBattleTheme): IslandLayout => {
    const island = islandSide(arena, side);
    const ground = islandToWorld(island, theme.spawn);
    return {
      side,
      island,
      theme,
      layers: layersFor(),
      // De pie sobre el bloque del suelo; la roja (oeste) mira al este y la azul al oeste.
      spawn: { x: ground.x, y: ground.y + 1, z: ground.z, yaw: side === "red" ? -90 : 90 },
    };
  };
  const red = build("red", meta.themes[redTheme]!);
  const blue = build("blue", meta.themes[blueTheme]!);
  return { seed, red, blue };
}

export type Box = { from: ArenaPoint; to: ArenaPoint };

/** Bloques de una caja (inclusiva). */
export function boxVolume({ from, to }: Box): number {
  return (Math.abs(to.x - from.x) + 1) * (Math.abs(to.y - from.y) + 1) * (Math.abs(to.z - from.z) + 1);
}

/**
 * Trocea una caja en tajadas a lo largo de x (y, si una tajada de 1 bloque no cabe, también
 * de y) para que ningún /fill pase de `max` bloques. Las tajadas cubren la caja sin solaparse.
 */
export function splitBox(box: Box, max: number = MAX_FILL_VOLUME): Box[] {
  const min = { x: Math.min(box.from.x, box.to.x), y: Math.min(box.from.y, box.to.y), z: Math.min(box.from.z, box.to.z) };
  const maxP = { x: Math.max(box.from.x, box.to.x), y: Math.max(box.from.y, box.to.y), z: Math.max(box.from.z, box.to.z) };
  const depth = maxP.z - min.z + 1;
  const height = maxP.y - min.y + 1;
  if (depth > max) throw new Error(`Una fila de ${depth} bloques no cabe en un /fill`);
  const out: Box[] = [];
  if (height * depth <= max) {
    const step = Math.floor(max / (height * depth));
    for (let x = min.x; x <= maxP.x; x += step) {
      out.push({ from: { x, y: min.y, z: min.z }, to: { x: Math.min(maxP.x, x + step - 1), y: maxP.y, z: maxP.z } });
    }
    return out;
  }
  const rows = Math.floor(max / depth);
  for (let x = min.x; x <= maxP.x; x += 1) {
    for (let y = min.y; y <= maxP.y; y += rows) {
      out.push({ from: { x, y, z: min.z }, to: { x, y: Math.min(maxP.y, y + rows - 1), z: maxP.z } });
    }
  }
  return out;
}

const fill = ({ from, to }: Box, block: string, filter?: string): string =>
  `fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} ${block}${filter ? ` replace ${filter}` : ""}`;

/** Caja de la estructura de una isla (22×48×22). */
export function islandBox(island: ChunkIsland): Box {
  const { origin } = island;
  return {
    from: origin,
    to: {
      x: origin.x + ISLAND_STRUCTURE_SIZE.x - 1,
      y: origin.y + ISLAND_STRUCTURE_SIZE.y - 1,
      z: origin.z + ISLAND_STRUCTURE_SIZE.z - 1,
    },
  };
}

/** Todo lo que no es jugador dentro de la zona: ítems, flechas, xp, mobs, bloques cayendo. */
export function clearEntitiesCommand(arena: IslandsArena): string {
  const { from, to } = arena.clearBox;
  return `kill @e[type=!minecraft:player,x=${from.x},y=${from.y},z=${from.z},dx=${to.x - from.x},dy=${to.y - from.y},dz=${to.z - from.z}]`;
}

function islandCommands(layout: IslandLayout): string[] {
  const { island, theme, layers } = layout;
  const { core, origin } = island;
  // El núcleo ocupa las mismas celdas relativas con o sin rotación (3..18 en x y z).
  const bedrock = fill(
    { from: { x: core.minX, y: origin.y - 1, z: core.minZ }, to: { x: core.maxX, y: origin.y - 1, z: core.maxZ } },
    "minecraft:bedrock",
  );
  // Las capas no necesitan girar: son mineral al azar; se colocan en la esquina mínima del núcleo.
  const layerCommands = layers.map((id, dy) => `place template ${id} ${core.minX} ${origin.y + dy} ${core.minZ}`);
  const anchor = templateAnchor(island);
  const themeCommand = `place template ${theme.id} ${anchor.x} ${anchor.y} ${anchor.z} ${island.rotation}`;
  const box = islandBox(island);
  const cleanup = ISLAND_CLEANUP_BLOCKS.map((block) => fill(box, "minecraft:air", block));
  return [bedrock, ...layerCommands, themeCommand, ...cleanup];
}

/**
 * Comandos para (re)construir Chunk Battle desde cero. El primero es un /fill de limpieza:
 * si el chunk todavía no cargó, ese es el que hay que reintentar.
 *  1. Todo el volumen a aire, troceado (islas viejas, puentes, pilares).
 *  2. Fuera entidades que no sean jugadores.
 *  3. Cada isla: piso de bedrock bajo el núcleo, 32 capas de mineral, la isla temática
 *     encima (sus structure_void dejan ver las capas) y limpieza de bloques prohibidos.
 *  4. Otra vez fuera entidades (lo que haya soltado la construcción).
 */
export function chunkBattleBuildCommands(arena: IslandsArena, layout: ChunkBattleLayout): string[] {
  const clear = splitBox(arena.clearBox).map((box) => fill(box, "minecraft:air"));
  return [
    ...clear,
    clearEntitiesCommand(arena),
    ...islandCommands(layout.red),
    ...islandCommands(layout.blue),
    clearEntitiesCommand(arena),
  ];
}

/**
 * Respuesta de `place template` que indica que la estructura no se colocó. Paper 1.20.4
 * responde `Loaded template "phack:…" at x, y, z` si la colocó y, si no, p. ej.
 * `There is no template with id "…"` o `Failed to place template …`.
 */
export function placeTemplateFailed(response: string): boolean {
  return !/^Loaded template /i.test(response.trim());
}
