/**
 * Íconos de píxeles, dibujados a mano en una cuadrícula de 11x11 (no son texturas del
 * juego, solo evocan su HUD). Este módulo es TypeScript puro, sin DOM: lo usa
 * components/PixelIcon.astro al compilar la página y scripts/icons.ts en el navegador,
 * así un ícono se dibuja igual venga de donde venga.
 *
 *   food       muslo de carne, como la barra de hambre de Minecraft
 *   decisions  letrero de madera con dos flechas opuestas: elegir un camino
 *   clock      reloj de oro: cuánto tarda el modelo en decidir
 *   emerald    esmeralda (la moneda del juego): cuánto cuesta el modelo
 *   forward, back, pause   acercarse, alejarse y esperar (para las acciones)
 *   sound-on, sound-off    botón de sonido
 *
 *   sword, axe, bow, arrow, steak, gapple, pearl, tile   ítems de los kits (tile = un bloque)
 *   helmet, chestplate, leggings, boots                  las cuatro piezas de armadura
 *
 * Cada ícono es una lista de filas; cada letra es un color de su paleta y "." es
 * transparente. Para retocar un ícono basta editar las filas (siempre 11 de 11 letras).
 *
 * Las letras a, b y c están reservadas para el MATERIAL (claro, medio y oscuro): una
 * misma espada sirve para hierro, piedra o diamante cambiando solo esos tres colores.
 * Ningún ícono las usa para un color fijo.
 */
export type Icon = { palette: Record<string, string>; rows: string[] };

type MaterialColors = { a: string; b: string; c: string };

export const MATERIALS = {
  iron: { a: "#eef1f5", b: "#9ea9b8", c: "#5d6675" },
  stone: { a: "#b9b9b9", b: "#8a8a8a", c: "#5f5f5f" },
  diamond: { a: "#b5fbf2", b: "#4fe0d2", c: "#1f9c93" },
  wood: { a: "#d2a468", b: "#a97c44", c: "#7b5730" },
  chainmail: { a: "#a7adb8", b: "#6a717d", c: "#3e434c" },
  /** Lana (un solo tono neutro para todos los colores: el nombre del ítem dice cuál es). */
  wool: { a: "#f4f1ea", b: "#d9d4c8", c: "#a9a397" },
} satisfies Record<string, MaterialColors>;

export type Material = keyof typeof MATERIALS;

const OUTLINE = "#17120e";
/** Mango de madera de espadas y hachas. */
const HANDLE = "#99632f";

/** Cubo visto de frente: `w`/`h` son el líquido (y su brillo), `m`/`l`/`d` el metal. */
const BUCKET_ROWS = [
  "...........",
  ".kkkkkkkkk.",
  ".kwwwwwwwk.",
  ".kwwhwwwwk.",
  ".kmmmmmmmk.",
  "..kmmmmmk..",
  "..kmlmmmk..",
  "..kmmmmdk..",
  "..kmmmmdk..",
  "...kkkkk...",
  "...........",
];
const BUCKET_METAL = { m: "#c7ced8", l: "#eef1f5", d: "#7d8794" };

export const ICONS = {
  food: {
    palette: { k: OUTLINE, m: "#b96a34", l: "#e0a063", d: "#8a4821", o: "#f1e8d4" },
    rows: [
      ".....kkkk..",
      "....kmmmmk.",
      "...kmllmmmk",
      "...kmlmmmmk",
      "...kmmmmmdk",
      "...kmmmmddk",
      "..kokmdddk.",
      ".koookkkk..",
      "koook......",
      "kokok......",
      ".k.k.......",
    ],
  },
  decisions: {
    palette: { k: OUTLINE, o: "#d2a468", s: "#a97c44", p: "#7b5730" },
    rows: [
      "....kkk....",
      "..kkkpkkk..",
      "..kooooook.",
      "..koooooook",
      "..kssssssk.",
      ".kkkkpkkk..",
      ".kooooook..",
      "koooooook..",
      ".kssssssk..",
      "..kkkpkkk..",
      "....kkk....",
    ],
  },
  clock: {
    palette: { k: OUTLINE, g: "#e3b53e", w: "#f5f0e3" },
    rows: [
      "...kkkkk...",
      "..kgggggk..",
      ".kgwwwwwgk.",
      "kgwwwkwwwgk",
      "kgwwwkwwwgk",
      "kgwwwkkkwgk",
      "kgwwwwwwwgk",
      "kgwwwwwwwgk",
      ".kgwwwwwgk.",
      "..kgggggk..",
      "...kkkkk...",
    ],
  },
  emerald: {
    palette: { k: OUTLINE, e: "#3fcf6e", l: "#aaf5c4", d: "#1f8f48" },
    rows: [
      "....kkk....",
      "...keeek...",
      "..kelleek..",
      ".keleeeeek.",
      ".keleeeedk.",
      ".keeeeeedk.",
      ".keeeeeddk.",
      ".keeeeeddk.",
      "..keeeddk..",
      "...keddk...",
      "....kkk....",
    ],
  },
  forward: {
    palette: { w: "#edece8" },
    rows: [
      "...........",
      "...........",
      ".w....w....",
      ".ww...ww...",
      ".www..www..",
      ".wwww.wwww.",
      ".www..www..",
      ".ww...ww...",
      ".w....w....",
      "...........",
      "...........",
    ],
  },
  back: {
    palette: { w: "#edece8" },
    rows: [
      "...........",
      "...........",
      "....w....w.",
      "...ww...ww.",
      "..www..www.",
      ".wwww.wwww.",
      "..www..www.",
      "...ww...ww.",
      "....w....w.",
      "...........",
      "...........",
    ],
  },
  pause: {
    palette: { w: "#edece8" },
    rows: [
      "...........",
      "...........",
      "..www.www..",
      "..www.www..",
      "..www.www..",
      "..www.www..",
      "..www.www..",
      "..www.www..",
      "..www.www..",
      "...........",
      "...........",
    ],
  },
  "sound-on": {
    palette: { w: "#edece8" },
    rows: [
      "...........",
      "....w......",
      "...ww..w...",
      ".wwww...w..",
      ".wwww.w.w..",
      ".wwww.w.w..",
      ".wwww.w.w..",
      ".wwww...w..",
      "...ww..w...",
      "....w......",
      "...........",
    ],
  },
  "sound-off": {
    palette: { w: "#edece8" },
    rows: [
      "...........",
      "....w......",
      "...ww......",
      ".wwww.w...w",
      ".wwww..w.w.",
      ".wwww...w..",
      ".wwww..w.w.",
      ".wwww.w...w",
      "...ww......",
      "....w......",
      "...........",
    ],
  },

  // ---------- Ítems de los kits ----------

  // Espada en diagonal. Sin material es de hierro (así se usa para el daño hecho).
  sword: {
    palette: { k: OUTLINE, h: HANDLE, ...MATERIALS.iron },
    rows: [
      "........kkk",
      ".......kaak",
      "......kaabk",
      ".kk..kaabk.",
      ".kckkaabk..",
      "..kcaabk...",
      "..kkcbk....",
      "..khkckk...",
      ".khhkkck...",
      "khhk..kk...",
      "kkk........",
    ],
  },
  axe: {
    palette: { k: OUTLINE, h: HANDLE, ...MATERIALS.iron },
    rows: [
      "...kkkk....",
      "..kaabbkkk.",
      ".kaabbbbhhk",
      ".kabbbbhhk.",
      ".kbbcchhk..",
      "..kkkhhk...",
      "...khhk....",
      "..khhk.....",
      ".khhk......",
      "khhk.......",
      "kkk........",
    ],
  },
  bow: {
    palette: { k: OUTLINE, w: "#9a6a36", s: "#e9edf2" },
    rows: [
      "....kkk....",
      "...kwwkk...",
      "..kwwkksk..",
      ".kwwk.ksk..",
      ".kwk..ksk..",
      ".kwk..ksk..",
      ".kwk..ksk..",
      ".kwwk.ksk..",
      "..kwwkksk..",
      "...kwwkk...",
      "....kkk....",
    ],
  },
  // Flecha: punta de piedra, astil de madera y plumas.
  arrow: {
    palette: { k: OUTLINE, t: "#c9ced6", s: "#9a6a36", f: "#eef1f5" },
    rows: [
      "........kk.",
      ".......kttk",
      "......ktttk",
      "......kstk.",
      ".....kskk..",
      "..k.ksk....",
      ".kfksk.....",
      "kffsk......",
      ".ksffk.....",
      "kskfk......",
      ".k.k.......",
    ],
  },
  steak: {
    palette: { k: OUTLINE, m: "#a35d30", l: "#edd3ad", d: "#6f3b1b" },
    rows: [
      "...........",
      "...kkkkk...",
      "..kllmmmk..",
      ".klmmdmmmk.",
      "klmmmmmdmmk",
      "kmmdmmmmmmk",
      "kmmmmdmmmk.",
      ".kmmmmmmk..",
      "..kkmmkk...",
      "....kk.....",
      "...........",
    ],
  },
  // Manzana dorada.
  gapple: {
    palette: { k: OUTLINE, y: "#f2c63f", l: "#fff3a8", d: "#c58a1c", h: "#7b5730" },
    rows: [
      ".....kkk...",
      ".....khk...",
      "..kkkkhkkk.",
      ".kyyykkyyyk",
      "kyllyyyyyyk",
      "kylyyyyyydk",
      "kyyyyyyyydk",
      "kyyyyyyyddk",
      ".kyyyyyddk.",
      "..kyydddk..",
      "...kkkkk...",
    ],
  },
  // Perla de ender.
  pearl: {
    palette: { k: OUTLINE, p: "#258474", l: "#8ce0c8", d: "#0f4a40" },
    rows: [
      "...kkkkk...",
      "..kpppppk..",
      ".kplllpppk.",
      "kpllpppdppk",
      "kplpdddpdpk",
      "kppdpppdppk",
      "kppdpdpddpk",
      "kpppdddpdpk",
      ".kpppppddk.",
      "..kpddddk..",
      "...kkkkk...",
    ],
  },
  // Escudo: tablas de madera con borde de hierro y una franja en cruz.
  shield: {
    palette: { k: OUTLINE, b: "#9ea9b8", a: "#a97c44", d: "#7b5730" },
    rows: [
      ".kkkkkkkkk.",
      ".kbbbbbbbk.",
      ".kbaadaabk.",
      ".kbaadaabk.",
      ".kbaadaabk.",
      ".kbdddddbk.",
      ".kbaadaabk.",
      "..kbadabk..",
      "..kbbabbk..",
      "...kbbbk...",
      "....kkk....",
    ],
  },
  water_bucket: {
    palette: { k: OUTLINE, ...BUCKET_METAL, w: "#3f76e4", h: "#8fb4ff" },
    rows: BUCKET_ROWS,
  },
  lava_bucket: {
    palette: { k: OUTLINE, ...BUCKET_METAL, w: "#e2591b", h: "#ffc23d" },
    rows: BUCKET_ROWS,
  },
  // Un bloque visto de frente (un cubo en perspectiva no se entiende a 11 px). Sin material, madera.
  tile: {
    palette: { k: OUTLINE, ...MATERIALS.wood },
    rows: [
      "...........",
      ".kkkkkkkkk.",
      ".kaaaaaabk.",
      ".kabbbbbck.",
      ".kabbcbbck.",
      ".kabbbbbck.",
      ".kabcbbbck.",
      ".kabbbbcck.",
      ".kbcccccck.",
      ".kkkkkkkkk.",
      "...........",
    ],
  },
  helmet: {
    palette: { k: OUTLINE, ...MATERIALS.iron },
    rows: [
      "...........",
      "..kkkkkkk..",
      ".kaaaaaaak.",
      "kaabbbbbbck",
      "kabbbbbbbck",
      "kabbbbbbbck",
      "kabkkkkkbck",
      "kabk...kbck",
      "kkkk...kkkk",
      "...........",
      "...........",
    ],
  },
  chestplate: {
    palette: { k: OUTLINE, ...MATERIALS.iron },
    rows: [
      ".kkk...kkk.",
      "kaabk.kbbck",
      "kabbbkbbbck",
      "kabbbbbbbck",
      "kkabbbbbckk",
      ".kabbbbbck.",
      ".kabbbbbck.",
      ".kabbbbbck.",
      ".kabbbbbck.",
      ".kabbbbcck.",
      ".kkkkkkkkk.",
    ],
  },
  leggings: {
    palette: { k: OUTLINE, ...MATERIALS.iron },
    rows: [
      ".kkkkkkkkk.",
      ".kaabbbbck.",
      ".kabbbbbck.",
      ".kabbkbbck.",
      ".kabk.kbck.",
      ".kabk.kbck.",
      ".kabk.kbck.",
      ".kabk.kbck.",
      ".kabk.kbck.",
      ".kabk.kbck.",
      ".kkkk.kkkk.",
    ],
  },
  boots: {
    palette: { k: OUTLINE, ...MATERIALS.iron },
    rows: [
      "...........",
      "...........",
      ".kkkk.kkkk.",
      ".kabk.kbck.",
      ".kabk.kbck.",
      ".kabk.kbck.",
      "kkabk.kbckk",
      "kabbk.kbbck",
      "kkkkk.kkkkk",
      "...........",
      "...........",
    ],
  },
} satisfies Record<string, Icon>;

export type IconName = keyof typeof ICONS;

/** Un ícono listo para dibujar: su forma y, si la forma lo admite, de qué material es. */
export type IconRef = { name: IconName; material?: Material };

/** Lado de la cuadrícula: todos los íconos son de 11x11. */
export const ICON_SIZE = 11;

/** Un tramo horizontal de píxeles del mismo color: se dibuja como un solo rectángulo. */
export type IconRun = { x: number; y: number; width: number; fill: string };

/** Une los píxeles consecutivos del mismo color de cada fila en un solo tramo. */
export function iconRuns(name: IconName, material?: Material): IconRun[] {
  const icon: Icon = ICONS[name];
  const palette: Record<string, string> = material ? { ...icon.palette, ...MATERIALS[material] } : icon.palette;
  const runs: IconRun[] = [];
  icon.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const char = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === char) end += 1;
      const fill = palette[char];
      if (fill) runs.push({ x, y, width: end - x, fill });
      x = end;
    }
  });
  return runs;
}
