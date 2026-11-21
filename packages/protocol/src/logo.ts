/**
 * Logo del centro del piso de la arena, como el del centro de una jaula de pelea: un
 * disco oscuro con un anillo y, adentro, los tres plátanos del logo, dibujados bloque por bloque.
 *
 * Cada letra es un bloque del piso. La fila 0 es la más lejana a la cámara (z menor) y la
 * columna 0 la del lado rojo (x menor), así el dibujo se ve derecho en la transmisión.
 * " " deja el piso como está. Para retocarlo basta editar las filas (siempre 15 de 15).
 *
 * Lo usan el orquestador (lo construye con comandos al armar la arena) y la maqueta de la
 * web (lo dibuja en el piso de su video de relleno).
 */
export const FLOOR_LOGO_ROWS = [
  "     ooooo     ",
  "   oo.....oo   ",
  "  o.......Y.o  ",
  " o......y.YY.o ",
  " o....g.yy.YYo ",
  "o....gg.yy.YY.o",
  "o..gggg.yy.YY.o",
  "o.ggg..yy..YY.o",
  "o.....yyy..YY.o",
  "o....yyy...YY.o",
  " o..yyy...YY.o ",
  " o........YY.o ",
  "  o......YY.o  ",
  "   oo.....oo   ",
  "     ooooo     ",
] as const;

/**
 * Qué es cada letra: el bloque de Minecraft del piso y su color para dibujarlo en la web.
 * Los tres plátanos van en tres tonos (del más claro al más anaranjado) para que se
 * distingan aunque casi se toquen.
 */
export const FLOOR_LOGO_PALETTE: Readonly<Record<string, { block: string; color: string }>> = {
  /** Fondo del disco. */
  ".": { block: "black_concrete", color: "#11131a" },
  /** Anillo. */
  o: { block: "white_concrete", color: "#e6e9ea" },
  /** Plátano de la derecha, el más claro. */
  Y: { block: "gold_block", color: "#f6d03d" },
  /** Plátano del medio. */
  y: { block: "yellow_concrete", color: "#f1af15" },
  /** Plátano de la izquierda, el más anaranjado. */
  g: { block: "honeycomb_block", color: "#e5941d" },
};

/** Mitad del ancho del dibujo: sus bloques van de -FLOOR_LOGO_RADIUS a +FLOOR_LOGO_RADIUS desde el centro. */
export const FLOOR_LOGO_RADIUS = (FLOOR_LOGO_ROWS.length - 1) / 2;
