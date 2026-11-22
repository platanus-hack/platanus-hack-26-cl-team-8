/**
 * "Rating frente a…": cada modelo es su logo en un plano. Hacia arriba, más rating; hacia la
 * derecha, la lectura elegida (latencia, costo por victoria o decisiones por pelea). La línea
 * vertical de cada logo es el intervalo de su rating, el mismo de la tabla.
 *
 * Los botones cambian la lectura del eje horizontal; los logos se deslizan a su lugar nuevo.
 */
import { REFERENCE_RATING, type StandingRow, type TournamentReport } from "@phack/protocol";
import { byId, el } from "../dom";
import { formatMs, formatRating, formatUsd } from "./format";
import { makeScale, position, type Scale } from "./plot";
import { costPerWin, decisionsPerFight, modelTag } from "./view";

type Metric = {
  id: string;
  label: string;
  /** Cómo leer el plano con esta lectura. */
  hint: string;
  value: (row: StandingRow) => number | null;
  format: (value: number) => string;
  /** Escala logarítmica: para lecturas que van de muy chico a muy grande. */
  log: boolean;
};

const METRICS: Metric[] = [
  {
    id: "latency",
    label: "Latencia",
    hint: "Lo que tarda en decidir (mediana). Arriba y a la izquierda: gana más y decide más rápido.",
    value: (row) => (row.latencyMs.p50 > 0 ? row.latencyMs.p50 : null),
    format: formatMs,
    log: true,
  },
  {
    id: "cost",
    label: "Costo por victoria",
    hint: "Lo que cuesta cada victoria en la liga. Arriba y a la izquierda: gana más y cada victoria sale más barata.",
    value: (row) => {
      const usd = costPerWin(row);
      return usd !== null && usd > 0 ? usd : null;
    },
    format: formatUsd,
    log: true,
  },
  {
    id: "decisions",
    label: "Decisiones por pelea",
    hint: "Cuántas veces alcanza a decidir en una pelea. Arriba y a la derecha: gana más y actúa más seguido.",
    value: decisionsPerFight,
    format: (value) => (value >= 10 ? String(Math.round(value)) : value.toFixed(1)),
    log: false,
  },
];

/** Lado del cuadro de cada logo y aire entre un logo y su nombre, en px. */
const MARK = 28;
const GAP = 6;

type Point = { row: StandingRow; node: HTMLElement; whisker: HTMLElement; label: HTMLElement };
type Axis = { at: (value: number) => number; ticks: number[] };

let current = METRICS[0]!;
let points: Point[] = [];
let ratingScale: Scale | null = null;
let observer: ResizeObserver | null = null;

/** Eje horizontal: posiciones en % y marcas en números redondos (1, 2 y 5 por década si es logarítmico). */
function horizontal(values: number[], log: boolean): Axis {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!log) {
    const scale = makeScale([0, ...values], 0);
    return { at: (v) => position({ ...scale, min: 0 }, v), ticks: scale.ticks.filter((t) => t >= 0) };
  }
  const lo = Math.log10(min / 1.3);
  const hi = Math.log10(max * 1.3);
  const at = (v: number): number => ((Math.log10(v) - lo) / (hi - lo)) * 100;
  const ticks: number[] = [];
  for (let decade = Math.floor(lo); decade <= Math.ceil(hi); decade++) {
    for (const step of [1, 2, 5]) {
      const tick = step * 10 ** decade;
      if (Math.log10(tick) >= lo && Math.log10(tick) <= hi) ticks.push(tick);
    }
  }
  return { at, ticks };
}

type Box = { left: number; top: number; right: number; bottom: number };

const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Pone cada logo en su lugar y busca dónde cabe su nombre: a la derecha, a la izquierda,
 * arriba o abajo, sin tapar otro logo ni otro nombre. Si no cabe en ninguno, el nombre se
 * esconde (queda en la ayuda al pasar el mouse).
 */
function place(): void {
  const area = byId("scatter-area");
  const scale = ratingScale;
  if (!scale || points.length === 0) return;
  const shown = points.filter((p) => current.value(p.row) !== null);
  const x = horizontal(
    shown.map((p) => current.value(p.row)!),
    current.log,
  );

  const xAxis = byId("scatter-x");
  xAxis.replaceChildren(
    ...x.ticks.map((tick) => {
      const mark = el("span", "scatter__xtick", current.format(tick));
      mark.style.left = `${x.at(tick).toFixed(2)}%`;
      return mark;
    }),
  );
  byId("scatter-hint").textContent = current.hint;

  const width = area.clientWidth;
  const height = area.clientHeight;
  const taken: Box[] = [];
  const spots = new Map<Point, { x: number; y: number }>();
  for (const p of points) {
    const value = current.value(p.row);
    p.node.hidden = value === null;
    p.whisker.hidden = value === null || p.row.isReference;
    p.label.hidden = value === null;
    if (value === null) continue;
    const left = x.at(value);
    const bottom = position(scale, p.row.rating);
    p.node.style.left = `${left.toFixed(2)}%`;
    p.node.style.bottom = `${bottom.toFixed(2)}%`;
    p.node.classList.toggle("is-right", left > 55);
    p.node.dataset.tip = `${p.row.name}: rating ${formatRating(p.row.rating)}, ${current.label.toLowerCase()} ${current.format(value)}.`;
    p.whisker.style.left = `${left.toFixed(2)}%`;
    p.whisker.style.bottom = `${position(scale, p.row.lo).toFixed(2)}%`;
    p.whisker.style.height = `${(position(scale, p.row.hi) - position(scale, p.row.lo)).toFixed(2)}%`;
    const spot = { x: (left / 100) * width, y: height - (bottom / 100) * height };
    spots.set(p, spot);
    taken.push({ left: spot.x - MARK / 2, right: spot.x + MARK / 2, top: spot.y - MARK / 2, bottom: spot.y + MARK / 2 });
  }

  for (const p of points) {
    const spot = spots.get(p);
    if (!spot) continue;
    const w = p.label.offsetWidth;
    const h = p.label.offsetHeight;
    const reach = MARK / 2 + GAP;
    const options: Box[] = [
      { left: spot.x + reach, top: spot.y - h / 2, right: spot.x + reach + w, bottom: spot.y + h / 2 },
      { left: spot.x - reach - w, top: spot.y - h / 2, right: spot.x - reach, bottom: spot.y + h / 2 },
      { left: spot.x - w / 2, top: spot.y - reach - h, right: spot.x + w / 2, bottom: spot.y - reach },
      { left: spot.x - w / 2, top: spot.y + reach, right: spot.x + w / 2, bottom: spot.y + reach + h },
    ];
    const free = options.find(
      (box) => box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= height && !taken.some((other) => overlaps(box, other)),
    );
    p.label.classList.toggle("is-hidden", !free);
    if (!free) continue;
    taken.push(free);
    p.label.style.left = `${free.left.toFixed(1)}px`;
    p.label.style.top = `${free.top.toFixed(1)}px`;
  }
}

function renderTabs(): void {
  const tabs = byId("scatter-metrics");
  tabs.replaceChildren(
    ...METRICS.map((metric) => {
      const button = el("button", "axis-pick__item", metric.label);
      button.type = "button";
      button.setAttribute("aria-pressed", metric === current ? "true" : "false");
      button.addEventListener("click", () => {
        if (metric === current) return;
        current = metric;
        renderTabs();
        place();
      });
      return button;
    }),
  );
}

export function renderScatter(report: TournamentReport): void {
  const section = byId("scatter");
  const rows = report.standings.filter((row) => row.games > 0);
  section.hidden = rows.length < 2;
  if (rows.length < 2) return;

  const area = byId("scatter-area");
  const scale = makeScale(
    rows.flatMap((row) => [row.rating, row.lo, row.hi]),
    REFERENCE_RATING,
  );
  ratingScale = scale;

  const yAxis = byId("scatter-y");
  yAxis.replaceChildren(
    ...scale.ticks.map((tick) => {
      const mark = el("span", "scatter__ytick", formatRating(tick));
      if (tick === REFERENCE_RATING) mark.classList.add("is-anchor");
      mark.style.bottom = `${position(scale, tick).toFixed(2)}%`;
      return mark;
    }),
  );

  const lines = scale.ticks.map((tick) => {
    const line = el("span", tick === REFERENCE_RATING ? "scatter__line is-anchor" : "scatter__line");
    line.style.bottom = `${position(scale, tick).toFixed(2)}%`;
    return line;
  });

  // Los nombres se buscan lugar de arriba hacia abajo: el primero de la tabla elige primero.
  points = rows.map((row) => {
    const node = el("span", "scatter__point");
    if (row.isReference) node.classList.add("is-reference");
    node.tabIndex = 0;
    const mark = modelTag(row.gatewayId, row.name);
    mark.classList.add("model-tag--mark");
    node.append(mark);
    const label = el("span", "scatter__label", row.name);
    label.setAttribute("aria-hidden", "true");
    return { row, node, whisker: el("span", "scatter__whisker"), label };
  });
  area.replaceChildren(...lines, ...points.map((p) => p.whisker), ...points.map((p) => p.node), ...points.map((p) => p.label));

  renderTabs();
  place();
  if (!observer) {
    observer = new ResizeObserver(() => place());
    observer.observe(area);
  }
}
