/**
 * Gráfico de intervalos del leaderboard: cada fila de una tabla dibuja su valor (un
 * cuadrado) y su intervalo (una línea con topes) sobre un eje común. Todas las filas usan
 * la misma escala, así que se comparan de un vistazo: si dos líneas se traslapan, esos dos
 * modelos todavía no se distinguen.
 *
 * Se usa en la tabla de posiciones (rating, con la referencia en 1000) y en la calibración
 * (diferencia con la referencia, con la banda de entrada a la liga sombreada).
 */
import { el } from "../dom";

/** Escala lineal: de `min` a `max`, con marcas en `ticks`. */
export type Scale = { min: number; max: number; ticks: number[] };

const STEPS = [10, 25, 50, 100, 150, 200, 250, 500, 1000];

/**
 * Escala que cubre `values` y siempre incluye `anchor` (la referencia). Las marcas van en
 * `anchor ± k·paso`; sin `step`, se elige el paso más chico que deja pocas marcas.
 */
export function makeScale(values: number[], anchor: number, step?: number): Scale {
  const finite = values.filter((v) => Number.isFinite(v));
  let min = Math.min(anchor, ...finite);
  let max = Math.max(anchor, ...finite);
  if (max - min < 1) {
    min -= 50;
    max += 50;
  }
  const pad = (max - min) * 0.05;
  min -= pad;
  max += pad;

  const span = max - min;
  // Con un paso pedido (la banda de la calibración) se aceptan más marcas antes de doblarlo.
  let size = step ?? STEPS.find((s) => span / s <= 6) ?? 1000;
  while (span / size > 9) size *= 2;
  const ticks: number[] = [];
  for (let t = anchor + Math.ceil((min - anchor) / size) * size; t <= max; t += size) ticks.push(t);
  return { min, max, ticks };
}

/** Posición de un valor en la escala, en % del ancho (recortado al gráfico). */
export function position(scale: Scale, value: number): number {
  const p = ((value - scale.min) / (scale.max - scale.min)) * 100;
  return Math.min(100, Math.max(0, p));
}

const pct = (n: number): string => `${n.toFixed(2)}%`;

/** Etiquetas del eje, para el encabezado de la columna del gráfico. */
export function axis(scale: Scale, anchor: number, label: (value: number) => string): HTMLElement[] {
  return scale.ticks.map((tick) => {
    const mark = el("span", "axis__tick", label(tick));
    if (tick === anchor) mark.classList.add("is-anchor");
    mark.style.left = pct(position(scale, tick));
    return mark;
  });
}

export type PlotOptions = {
  /** Valor estimado: dónde va el cuadrado. */
  at: number;
  /** Intervalo; sin él (la referencia, que es fija) solo se dibuja el cuadrado. */
  lo?: number;
  hi?: number;
  /** Valor de la referencia: su línea cruza todas las filas. */
  anchor: number;
  /** Banda sombreada (calibración): quien cae adentro juega parecido a la referencia. */
  band?: { lo: number; hi: number };
  /** Tono de la fila (`data-tone`): arena.css le da el color. */
  tone: string;
};

/** El gráfico de una fila. */
export function plot(scale: Scale, options: PlotOptions): HTMLElement {
  const root = el("div", "plot");
  root.dataset.tone = options.tone;

  if (options.band) {
    const band = el("span", "plot__band");
    const from = position(scale, options.band.lo);
    band.style.left = pct(from);
    band.style.width = pct(position(scale, options.band.hi) - from);
    root.append(band);
  }
  for (const tick of scale.ticks) {
    const line = el("span", tick === options.anchor ? "plot__anchor" : "plot__tick");
    line.style.left = pct(position(scale, tick));
    root.append(line);
  }

  const center = position(scale, options.at);
  const { lo, hi } = options;
  if (lo !== undefined && hi !== undefined && Number.isFinite(lo) && Number.isFinite(hi)) {
    const from = position(scale, lo);
    const width = position(scale, hi) - from;
    const range = el("span", "plot__range");
    range.style.left = pct(from);
    range.style.width = pct(width);
    // La línea crece desde el cuadrado hacia los dos lados la primera vez que se muestra.
    range.style.setProperty("--origin", width > 0 ? pct(((center - from) / width) * 100) : "50%");
    root.append(range);
  }
  const dot = el("span", "plot__dot");
  dot.style.left = pct(center);
  root.append(dot);
  return root;
}
