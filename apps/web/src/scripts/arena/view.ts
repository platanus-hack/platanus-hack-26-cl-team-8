/**
 * Dibujo del leaderboard: cabecera con progreso, tabla de posiciones, matriz y calibración.
 * Todo el texto entra por textContent (dom.ts); los logos, por renderModelTag.
 *
 * La tabla de posiciones y la de calibración llevan un gráfico de intervalos en cada fila
 * (plot.ts), todas sobre el mismo eje.
 */
import {
  REFERENCE_RATING,
  type CalibrationRow,
  type FrozenModel,
  type MatrixCell,
  type StandingRow,
  type TournamentReport,
} from "@phack/protocol";
import { byId, el } from "../dom";
import { describeModel, renderModelTag } from "../models";
import {
  STAGE_LABEL,
  VERDICT_LABEL,
  formatDate,
  formatMinutes,
  formatMs,
  formatPct,
  formatRating,
  formatSigned,
  formatUsd,
  fraction,
  scoreColor,
  takeaway,
} from "./format";
import { axis, makeScale, plot, type Scale } from "./plot";

/** Modelos del torneo por key, para nombres y tooltips. */
export function modelIndex(report: TournamentReport): Map<string, FrozenModel> {
  const out = new Map<string, FrozenModel>();
  out.set(report.config.reference.key, report.config.reference);
  for (const m of report.config.candidates) out.set(m.key, m);
  return out;
}

/** "gatewayId · proveedor fijado" para la ayuda al pasar el mouse. */
function modelDetail(gatewayId: string, provider: string | null): string {
  return provider ? `${gatewayId} · servido por ${provider}` : `${gatewayId} · proveedor que elija el gateway`;
}

/**
 * Logo + nombre de un modelo. `tip` = ayuda al pasar el mouse (data-tip). Las marcas sin
 * logo llevan la inicial en un cuadro del mismo tamaño: así los nombres quedan alineados y
 * en la matriz, donde la columna solo muestra el logo, siempre hay algo que ver.
 */
export function modelTag(gatewayId: string, name: string, tip?: string): HTMLElement {
  const tag = el("span", "model-tag");
  renderModelTag(tag, describeModel(gatewayId, name));
  if (!tag.querySelector(".model-tag__icon")) {
    const letter = (tag.textContent ?? "").trim().charAt(0).toUpperCase();
    const mark = el("span", "model-tag__icon model-tag__letter", letter);
    mark.setAttribute("aria-hidden", "true");
    tag.prepend(mark);
  }
  if (tip === undefined) delete tag.dataset.tip;
  else tag.dataset.tip = tip;
  return tag;
}

/** Barra de victorias, empates y derrotas con sus tres números. */
export function record(wins: number, draws: number, losses: number): HTMLElement {
  const root = el("span", "record");
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", `${wins} victorias, ${draws} empates, ${losses} derrotas`);
  const bar = el("span", "record__bar");
  const nums = el("span", "record__nums");
  const parts: [string, number][] = [
    ["w", wins],
    ["d", draws],
    ["l", losses],
  ];
  parts.forEach(([kind, count], index) => {
    if (count > 0) {
      const piece = el("i", kind);
      piece.style.flexGrow = String(count);
      bar.append(piece);
    }
    if (index > 0) nums.append(el("span", "sep", " · "));
    nums.append(el("b", kind, String(count)));
  });
  root.append(bar, nums);
  return root;
}

// ---------- (1) Cabecera y progreso ----------

type BarKind = "work" | "budget";

/**
 * Una barra de la cabecera. "work" es avance (llena = listo); "budget" es consumo de un
 * límite (llena = el torneo se detiene), y avisa en ámbar cuando queda poco.
 */
function bar(kind: BarKind, label: string, done: number, total: number, value: string, note?: string): HTMLElement {
  const item = el("div", "progress");
  item.dataset.kind = kind;
  const share = fraction(done, total);
  if (kind === "work" && total > 0 && done >= total) item.dataset.state = "done";
  if (kind === "budget" && share >= 0.85) item.dataset.state = "tight";
  const head = el("div", "progress__head");
  head.append(el("span", "progress__label", label), el("span", "progress__value", value));
  const track = el("div", "progress__track");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", label);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(Math.max(0, Math.round(total))));
  track.setAttribute("aria-valuenow", String(Math.max(0, Math.round(Math.min(done, total)))));
  track.setAttribute("aria-valuetext", value);
  const fill = el("span", "progress__fill");
  fill.style.width = `${share * 100}%`;
  track.append(fill);
  item.append(head, track);
  if (note) item.append(el("span", "progress__note", note));
  return item;
}

const retries = (count: number): string | undefined =>
  count > 0 ? `${count} ${count === 1 ? "intento falló" : "intentos fallaron"} por infraestructura` : undefined;

export function renderSummary(report: TournamentReport): void {
  const { config, progress } = report;
  byId("t-name").textContent = config.name;

  const take = byId("t-take");
  take.textContent = takeaway(report);
  take.hidden = take.textContent === "";

  const meta = byId("t-meta");
  meta.replaceChildren();
  const stage = el("span", "badge", STAGE_LABEL[progress.stage]);
  stage.dataset.stage = progress.stage;
  if (progress.stage === "calibration" || progress.stage === "league") {
    stage.dataset.tip = "El torneo está corriendo: esta página se actualiza sola cada 20 segundos.";
  }
  const mode = el("span", "badge", config.mode === "real" ? "Minecraft real" : "Simulado");
  mode.dataset.mode = config.mode;
  const models = report.standings.length;
  meta.append(
    stage,
    mode,
    el("span", "", `Creado el ${formatDate(config.createdAt)}`),
    el("span", "", `${models} ${models === 1 ? "modelo" : "modelos"} en la liga`),
    el("span", "", `Peleas de ${config.benchmark.matchSeconds} s`),
    el("span", "mono", config.benchmark.id),
  );

  const { calibration: cal, league, limits } = progress;
  const budget = bar(
    "budget",
    "Tiempo",
    progress.elapsedMinutes,
    limits.maxMinutes,
    `${formatMinutes(progress.elapsedMinutes)} de ${limits.maxMinutes} min`,
  );
  // Primera barra de presupuesto: lleva la raya que la separa de las de avance.
  budget.classList.add("progress--split");
  byId("t-progress").replaceChildren(
    bar("work", "Calibración", cal.valid, cal.planned, `${cal.valid} de ${cal.planned}`, retries(cal.infra)),
    bar("work", "Liga", league.valid, league.planned, `${league.valid} de ${league.planned}`, retries(league.infra)),
    bar("work", "Semillas de la liga", league.seedsDone, league.seedsPlanned, `${league.seedsDone} de ${league.seedsPlanned}`),
    budget,
    bar("budget", "Gasto", progress.costUsd, limits.maxUsd, `${formatUsd(progress.costUsd)} de ${formatUsd(limits.maxUsd)}`),
  );

  const stop = byId("t-stop");
  stop.hidden = !progress.stopReason;
  stop.textContent = progress.stopReason ? `Se detuvo: ${progress.stopReason}` : "";

  const notice = byId("t-provisional");
  notice.hidden = !report.provisional;
  const list = byId("t-provisional-why");
  list.replaceChildren(...report.provisionalWhy.map((why) => el("li", "", why)));
}

// ---------- (2) Tabla ----------

/** Etiqueta de una celda para la vista de tarjetas (pantallas angostas), donde no hay encabezado. */
function labeled<T extends HTMLElement>(cell: T, label: string): T {
  cell.dataset.label = label;
  return cell;
}

export function renderStandings(report: TournamentReport): void {
  const body = byId("standings-body");
  body.replaceChildren();
  const rows = report.standings;
  const some = rows.length > 0;
  byId("standings-empty").hidden = some;
  byId("standings-table").hidden = !some;
  byId("standings-note").hidden = !some;
  if (!some) return;

  // Un solo eje para todas las filas: cubre todos los ratings y sus intervalos.
  const scale = makeScale(
    rows.flatMap((row) => [row.rating, row.lo, row.hi]),
    REFERENCE_RATING,
  );
  for (const id of ["standings-axis", "standings-axis-solo"]) {
    byId(id).replaceChildren(...axis(scale, REFERENCE_RATING, formatRating));
  }
  rows.forEach((row, index) => body.append(standingRow(row, scale, index)));

  const methods = new Set(rows.filter((row) => !row.isReference).map((row) => row.ciMethod));
  const how =
    methods.size !== 1
      ? "Los intervalos se calculan por bootstrap cuando hay suficientes semillas completas, y por aproximación de Laplace cuando no."
      : methods.has("bootstrap")
        ? "Intervalos por bootstrap: se remuestrean grupos completos de escenario + semilla."
        : "Intervalos por aproximación de Laplace: todavía hay pocas semillas completas para un bootstrap.";
  byId("standings-note").textContent = `${how} El costo y la latencia son los de las partidas de la liga.`;
}

function standingRow(row: StandingRow, scale: Scale, index: number): HTMLTableRowElement {
  const tr = el("tr");
  tr.style.setProperty("--i", String(index));
  if (row.isReference) tr.classList.add("is-reference");
  const above = !row.isReference && row.lo > REFERENCE_RATING;
  const below = !row.isReference && row.hi < REFERENCE_RATING;
  const tone = row.isReference ? "reference" : above ? "above" : below ? "below" : "cross";

  tr.append(el("td", "board__rank", String(row.rank)));

  const model = el("th", "board__model");
  model.scope = "row";
  model.append(modelTag(row.gatewayId, row.name, modelDetail(row.gatewayId, row.inferenceProvider)));
  const sub = el("span", "board__sub");
  // Si juega con razonamiento (no se podía apagar), se dice: piensa antes de cada acción.
  sub.append(el("span", "", row.reasoning === "none" ? row.version : `${row.version} · razonamiento ${row.reasoning}`));
  if (row.isReference) sub.append(el("span", "ref-badge", "Referencia"));
  model.append(sub, el("span", "sr-only", ` (${modelDetail(row.gatewayId, row.inferenceProvider)})`));
  tr.append(model);

  const rating = el("td", "num board__rating");
  rating.append(el("span", "board__points", formatRating(row.rating)));
  if (row.isReference) {
    rating.append(el("span", "board__diff", "fijo"));
    rating.dataset.tip = `Fijo en ${REFERENCE_RATING}: es el origen de la escala.`;
  } else {
    const diff = el("span", "board__diff", formatSigned(row.rating - REFERENCE_RATING));
    diff.dataset.tone = tone;
    rating.append(diff);
    rating.dataset.tip = `${formatSigned(row.rating - REFERENCE_RATING)} respecto de la referencia.`;
  }
  tr.append(rating);

  const chart = el("td", "board__plot");
  chart.append(
    plot(scale, {
      at: row.rating,
      lo: row.isReference ? undefined : row.lo,
      hi: row.isReference ? undefined : row.hi,
      anchor: REFERENCE_RATING,
      tone,
    }),
  );
  tr.append(chart);

  const range = el("td", "num board__range");
  if (row.isReference) {
    range.append(el("span", "sr-only", "Sin intervalo: es la referencia"));
  } else {
    const lo = formatRating(row.lo);
    const hi = formatRating(row.hi);
    range.textContent = `${lo} a ${hi}`;
    const verdict = above
      ? "Todo el intervalo está sobre la referencia."
      : below
        ? "Todo el intervalo está bajo la referencia."
        : "El intervalo cruza la referencia: todavía no se distingue de ella.";
    range.dataset.tip = `Intervalo del rating: de ${lo} a ${hi} (±${Math.round((row.hi - row.lo) / 2)}). ${verdict}`;
  }
  tr.append(range);

  tr.append(labeled(el("td", "num board__games", String(row.games)), "Partidas"));

  const wdl = labeled(el("td", "board__record"), "V · E · D");
  wdl.append(record(row.wins, row.draws, row.losses));
  tr.append(wdl);

  tr.append(labeled(el("td", "num board__cost", formatUsd(row.costUsd)), "Costo"));

  const latency = labeled(el("td", "num board__latency"), "Latencia");
  latency.append(el("span", "", formatMs(row.latencyMs.p50)), el("span", "board__p95", `p95 ${formatMs(row.latencyMs.p95)}`));
  latency.dataset.tip = `Mediana y percentil 95 de ${row.latencyMs.count} decisiones: desde que el agente recibe el estado hasta que entrega una acción válida.`;
  tr.append(latency);

  return tr;
}

// ---------- (3) Matriz ----------

export type CellHandler = (row: string, col: string, button: HTMLButtonElement) => void;

export function cellKey(row: string, col: string): string {
  return `${row}\u0000${col}`;
}

/** Texto para lectores de pantalla: "GPT Luna vs Gemini Flash: 62 %, 8 partidas". */
export function cellLabel(rowName: string, colName: string, cell: MatrixCell | undefined): string {
  const games = cell?.games ?? 0;
  if (!cell || cell.score === null || games === 0) return `${rowName} vs ${colName}: sin partidas válidas`;
  return `${rowName} vs ${colName}: ${formatPct(cell.score)}, ${games} ${games === 1 ? "partida" : "partidas"}`;
}

export function renderMatrix(report: TournamentReport, onCell: CellHandler): void {
  const table = byId<HTMLTableElement>("matrix");
  table.replaceChildren();
  const models = report.standings;
  byId("matrix-empty").hidden = models.length > 1;
  byId("matrix-wrap").hidden = models.length < 2;
  if (models.length < 2) return;

  const cells = new Map(report.matrix.map((c) => [cellKey(c.row, c.col), c]));

  // Encabezado de columnas: posición + logo; el nombre completo va en el título y para lectores.
  const head = el("tr");
  const corner = el("td", "matrix__corner", "Fila vs columna");
  head.append(corner);
  for (const col of models) {
    const th = el("th", "matrix__colhead");
    th.scope = "col";
    th.dataset.model = col.model;
    th.title = `${col.rank}. ${col.name}`;
    if (col.isReference) th.classList.add("is-reference");
    th.append(el("span", "matrix__colrank", String(col.rank)), modelTag(col.gatewayId, col.name));
    head.append(th);
  }
  const thead = el("thead");
  thead.append(head);

  const tbody = el("tbody");
  for (const row of models) {
    const tr = el("tr");
    const rh = el("th", "matrix__rowhead");
    rh.scope = "row";
    rh.dataset.model = row.model;
    if (row.isReference) rh.classList.add("is-reference");
    rh.append(el("span", "matrix__rank", String(row.rank)), modelTag(row.gatewayId, row.name));
    tr.append(rh);

    for (const col of models) {
      const td = el("td", "matrix__cell");
      if (row.model === col.model) {
        td.classList.add("is-diagonal");
        td.append(el("span", "sr-only", "No aplica"));
        tr.append(td);
        continue;
      }
      const cell = cells.get(cellKey(row.model, col.model));
      const label = cellLabel(row.name, col.name, cell);
      const button = el("button", "cell");
      button.type = "button";
      button.dataset.row = row.model;
      button.dataset.col = col.model;
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", label);
      button.title = label;
      if (!cell || cell.score === null || cell.games === 0) {
        button.classList.add("is-empty");
        button.append(el("span", "cell__score", "—"));
      } else {
        button.style.background = scoreColor(cell.score);
        button.append(el("span", "cell__score", formatPct(cell.score)), el("span", "cell__games", String(cell.games)));
      }
      button.addEventListener("click", () => onCell(row.model, col.model, button));
      td.append(button);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);

  // Al pasar por una celda (o enfocarla) se destacan su fila y su columna: en una matriz
  // grande cuesta seguir con la vista a qué modelos corresponde.
  matrixHeads = Array.from(table.querySelectorAll<HTMLTableCellElement>("th[data-model]"));
  if (!matrixWired) {
    matrixWired = true;
    table.addEventListener("pointerover", (event) => pointAt(event.target));
    table.addEventListener("pointerleave", () => pointAt(null));
    table.addEventListener("focusin", (event) => pointAt(event.target));
    table.addEventListener("focusout", () => pointAt(null));
  }
}

let matrixHeads: HTMLTableCellElement[] = [];
let matrixWired = false;

function pointAt(target: EventTarget | null): void {
  const button = target instanceof Element ? target.closest<HTMLButtonElement>(".cell") : null;
  for (const head of matrixHeads) {
    const mine = head.scope === "row" ? button?.dataset.row : button?.dataset.col;
    head.classList.toggle("is-hot", mine !== undefined && mine === head.dataset.model);
  }
}

/** Marca la celda abierta en el panel (y desmarca las demás). */
export function markCell(row: string | null, col: string | null): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("#matrix .cell")) {
    const on = button.dataset.row === row && button.dataset.col === col;
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

// ---------- (5) Calibración ----------

const VERDICT_ORDER: Record<CalibrationRow["verdict"], number> = { inside: 0, pending: 1, outside: 2 };

/** Fila que separa a los que entraron a la liga de los que quedaron fuera. */
function groupRow(text: string, count: number): HTMLTableRowElement {
  const tr = el("tr", "board__group");
  const th = el("th");
  th.colSpan = 6;
  th.scope = "colgroup";
  th.append(el("span", "", text), el("span", "board__count", String(count)));
  tr.append(th);
  return tr;
}

export function renderCalibration(report: TournamentReport): void {
  const { rule } = report.config;
  const conf = Math.round((2 * normalCdf(rule.z) - 1) * 100);
  byId("calibration-rule").textContent =
    `Entra a la liga quien juega parecido a ${report.config.reference.name}: su diferencia de rating, con un intervalo ` +
    `de ${conf} %, tiene que caber en la banda de ±${rule.bandElo} (la franja verde). Si el intervalo se sale de la ` +
    `banda queda pendiente: se juegan más cruces mientras haya presupuesto, y entra como provisional si su ` +
    `estimación cae adentro.`;

  const models = modelIndex(report);
  const body = byId("calibration-body");
  body.replaceChildren();
  const some = report.calibration.length > 0;
  byId("calibration-empty").hidden = some;
  byId("calibration-table").hidden = !some;
  if (some) {
    const band = { lo: -rule.bandElo, hi: rule.bandElo };
    // Marcas en múltiplos de la banda: el borde de la banda siempre cae en una marca.
    const scale = makeScale(
      [band.lo, band.hi, ...report.calibration.flatMap((row) => [row.diff, row.lo, row.hi])],
      0,
      rule.bandElo,
    );
    for (const id of ["calibration-axis", "calibration-axis-solo"]) {
      byId(id).replaceChildren(...axis(scale, 0, formatSigned));
    }

    const rows = [...report.calibration].sort(
      (x, y) => Number(y.league) - Number(x.league) || VERDICT_ORDER[x.verdict] - VERDICT_ORDER[y.verdict] || y.diff - x.diff,
    );
    const inLeague = rows.filter((row) => row.league).length;
    rows.forEach((row, index) => {
      if (index === 0 && row.league) body.append(groupRow("Entran a la liga", inLeague));
      if (!row.league && (index === 0 || rows[index - 1]!.league)) body.append(groupRow("Quedan fuera", rows.length - inLeague));

      const tr = el("tr");
      tr.style.setProperty("--i", String(index));
      const frozen = models.get(row.model);
      const th = el("th", "board__model");
      th.scope = "row";
      th.append(
        modelTag(frozen?.gatewayId ?? row.model, row.name, frozen ? modelDetail(frozen.gatewayId, frozen.inferenceProvider) : row.model),
      );
      tr.append(th);

      const chart = el("td", "board__plot");
      chart.append(plot(scale, { at: row.diff, lo: row.lo, hi: row.hi, anchor: 0, band, tone: row.verdict }));
      tr.append(chart);

      // lo/hi vienen en la escala de la diferencia con la referencia (diff ± z·se).
      const diff = labeled(el("td", "num board__diffcell"), "Diferencia");
      diff.append(el("span", "", `${formatSigned(row.diff)} ± ${Math.round(row.se)}`));
      diff.append(el("span", "board__p95", `${formatSigned(row.lo)} a ${formatSigned(row.hi)}`));
      diff.dataset.tip = `Diferencia con la referencia ± error estándar. Intervalo de decisión: de ${formatSigned(row.lo)} a ${formatSigned(row.hi)}.`;
      tr.append(diff);

      const games = labeled(el("td", "num"), "Partidas");
      games.append(el("span", "", String(row.games)), el("span", "board__p95", `${row.opponents} ${row.opponents === 1 ? "rival" : "rivales"}`));
      tr.append(games);

      const verdict = el("td", "calib__verdict");
      const badge = el("span", "verdict", VERDICT_LABEL[row.verdict]);
      badge.dataset.verdict = row.verdict;
      verdict.append(badge);
      tr.append(verdict);

      tr.append(el("td", "calib__why", row.why));
      body.append(tr);
    });
  }

  const omitted = byId("omitted-list");
  omitted.replaceChildren();
  const lines = report.config.omitted.length;
  byId("omitted").hidden = lines === 0;
  byId("omitted-title").textContent =
    lines === 1 ? "1 línea del catálogo quedó fuera antes de jugar" : `${lines} líneas del catálogo quedaron fuera antes de jugar`;
  for (const line of report.config.omitted) {
    const li = el("li", "omitted__item");
    li.append(el("span", "omitted__line mono", line.line), el("span", "omitted__id mono", line.latestId), el("span", "omitted__why", line.reason));
    omitted.append(li);
  }

  const { catalog } = report.config;
  byId("catalog-meta").textContent =
    `Catálogo congelado el ${formatDate(catalog.fetchedAt)} (${catalog.source}, sha256 ${catalog.sha256.slice(0, 12)}…). ` +
    `${report.config.candidates.length} candidatos, como máximo ${report.config.limits.maxCandidates}.`;
}

/** Φ(z) (Abramowitz–Stegun 7.1.26), solo para mostrar el % del intervalo. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
