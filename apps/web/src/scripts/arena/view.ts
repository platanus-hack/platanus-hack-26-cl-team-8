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
  formatAverage,
  formatSigned,
  formatSpan,
  formatUsd,
  fraction,
  scoreColor,
  tierOf,
  type Tier,
} from "./format";
import { pixelIcon } from "../icons";
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

/**
 * Barra de las peleas de un modelo: victorias, empates y derrotas. Si se sabe cuántas
 * terminaron por K.O., ese tramo va en color lleno y el resto (decididas por vida al acabar
 * el tiempo) más suave.
 */
export function recordBar(row: Pick<StandingRow, "wins" | "draws" | "losses" | "fight">): HTMLElement {
  const bar = el("span", "record__bar");
  const koWins = Math.min(row.wins, row.fight?.koWins ?? row.wins);
  const koLosses = Math.min(row.losses, row.fight?.koLosses ?? row.losses);
  const parts: [string, number][] = [
    ["w", koWins],
    ["w is-soft", row.wins - koWins],
    ["d", row.draws],
    ["l is-soft", row.losses - koLosses],
    ["l", koLosses],
  ];
  for (const [kind, count] of parts) {
    if (count <= 0) continue;
    const piece = el("i", kind);
    piece.style.flexGrow = String(count);
    bar.append(piece);
  }
  return bar;
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

const TIERS: { tier: Tier; label: string; none: string }[] = [
  { tier: "above", label: "Sobre la referencia", none: "Ninguno todavía" },
  { tier: "level", label: "A la par", none: "Ninguno" },
  { tier: "below", label: "Bajo la referencia", none: "Ninguno todavía" },
];

/** Quién va primero: logo grande, nombre, rating y cómo ganó sus peleas. */
function leadBlock(report: TournamentReport, leader: StandingRow): HTMLElement[] {
  const reference = report.config.reference;
  const tag = modelTag(leader.gatewayId, leader.name, modelDetail(leader.gatewayId, leader.inferenceProvider));
  tag.classList.add("lead__model");

  const score = el("p", "lead__score");
  score.append(el("span", "lead__points", formatRating(leader.rating)));
  if (leader.isReference) {
    score.append(el("span", "lead__diff", "Es la referencia: ningún candidato la supera por ahora."));
  } else {
    const diff = el("span", "lead__diff");
    const over = modelTag(reference.gatewayId, reference.name);
    diff.append(`${formatSigned(leader.rating - REFERENCE_RATING)} sobre `, over);
    score.append(diff);
  }

  const kos = leader.fight ? `, ${leader.fight.koWins} por K.O.` : "";
  const won = el("p", "lead__won", `Ganó ${leader.wins} de sus ${leader.games} peleas${kos}`);
  return [el("p", "lead__label", "Va primero"), tag, score, won];
}

/** Los modelos en tres grupos según cómo quedan respecto de la referencia, cada uno con su logo. */
function tierRows(report: TournamentReport): HTMLElement[] {
  return TIERS.map(({ tier, label, none }) => {
    const rows = report.standings.filter((row) => tierOf(row) === tier);
    const line = el("div", "tier");
    line.dataset.tier = tier;
    const head = el("p", "tier__label", label);
    const chips = el("div", "tier__models");
    if (rows.length === 0) chips.append(el("span", "tier__none", none));
    for (const row of rows) {
      const chip = el("span", "chip");
      if (row.isReference) chip.classList.add("is-reference");
      chip.append(modelTag(row.gatewayId, row.name), el("span", "chip__points", formatRating(row.rating)));
      chip.dataset.tip = row.isReference
        ? `La referencia: fija en ${REFERENCE_RATING}.`
        : `Rating ${formatRating(row.rating)}, intervalo de ${formatRating(row.lo)} a ${formatRating(row.hi)}.`;
      chips.append(chip);
    }
    line.append(head, chips);
    return line;
  });
}

export function renderSummary(report: TournamentReport): void {
  const { config, progress, standings } = report;
  const running = progress.stage === "calibration" || progress.stage === "league";
  const fights = progress.league.valid;

  const models = standings.length > 0 ? standings.length : config.candidates.length + 1;
  const sub = byId("t-sub");
  sub.textContent =
    standings.length > 0
      ? `${models} modelos ${progress.stage === "done" ? "pelearon" : "han peleado"} ${fights} veces uno contra uno ` +
        `en Minecraft, todos con el mismo prompt. Lo único que cambia de un lado al otro es el modelo.`
      : `${models} modelos van a pelear uno contra uno en Minecraft, todos con el mismo prompt. La liga todavía no tiene peleas válidas.`;

  const board = byId("t-board");
  board.hidden = standings.length === 0;
  if (standings.length > 0) {
    byId("t-lead").replaceChildren(...leadBlock(report, standings[0]!));
    byId("t-tiers").replaceChildren(...tierRows(report));
    const note = byId("t-ref");
    note.replaceChildren(
      "La referencia es ",
      modelTag(config.reference.gatewayId, config.reference.name),
      `, fija en ${REFERENCE_RATING}. Un modelo queda sobre o bajo ella cuando todo su intervalo cae a ese lado; si lo cruza, con estas peleas no se distinguen.`,
    );
  }

  const meta = byId("t-meta");
  meta.replaceChildren();
  const stage = el("span", "badge", STAGE_LABEL[progress.stage]);
  stage.dataset.stage = progress.stage;
  if (running) stage.dataset.tip = "El torneo está corriendo: esta página se actualiza sola cada 20 segundos.";
  meta.append(
    el("span", "summary__tournament", config.name),
    stage,
    el("span", "", `Creado el ${formatDate(config.createdAt)}`),
    el("span", "", `${formatSpan(progress.elapsedMinutes)} de peleas`),
    el("span", "", `${formatUsd(progress.costUsd)} gastados`),
    el("span", "", `Peleas de ${config.benchmark.matchSeconds} s`),
    el("span", "mono", config.benchmark.id),
  );

  // Las barras de avance solo importan mientras el torneo no ha terminado.
  const bars = byId("t-progress");
  bars.hidden = progress.stage === "done";
  if (progress.stage !== "done") {
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
    bars.replaceChildren(
      bar("work", "Calibración", cal.valid, cal.planned, `${cal.valid} de ${cal.planned}`, retries(cal.infra)),
      bar("work", "Liga", league.valid, league.planned, `${league.valid} de ${league.planned}`, retries(league.infra)),
      bar("work", "Semillas de la liga", league.seedsDone, league.seedsPlanned, `${league.seedsDone} de ${league.seedsPlanned}`),
      budget,
      bar("budget", "Gasto", progress.costUsd, limits.maxUsd, `${formatUsd(progress.costUsd)} de ${formatUsd(limits.maxUsd)}`),
    );
  }

  const stop = byId("t-stop");
  stop.hidden = !progress.stopReason;
  stop.textContent = progress.stopReason ? `Se detuvo: ${progress.stopReason}` : "";
}

// ---------- (2) Tabla ----------

/** Etiqueta de una celda para la vista de tarjetas (pantallas angostas), donde no hay encabezado. */
function labeled<T extends HTMLElement>(cell: T, label: string): T {
  cell.dataset.label = label;
  return cell;
}

/**
 * Lo que cuesta cada victoria de la liga: el gasto de esas peleas si el reporte lo trae (si
 * no, todo lo gastado en el modelo) repartido entre las que ganó. Sin victorias no hay dato.
 */
export function costPerWin(row: StandingRow): number | null {
  if (!(row.wins > 0)) return null;
  return (row.fight ? row.fight.costUsd : row.costUsd) / row.wins;
}

/** Decisiones por pelea de la liga. */
export function decisionsPerFight(row: StandingRow): number | null {
  if (!(row.games > 0)) return null;
  return (row.fight ? row.fight.decisions : row.latencyMs.count) / row.games;
}

/** Fila con el menor valor (> 0) de una lectura: el más rápido, el más barato. */
function lowest(rows: StandingRow[], value: (row: StandingRow) => number | null): StandingRow | null {
  let best: StandingRow | null = null;
  let bestValue = Infinity;
  for (const row of rows) {
    const v = value(row);
    if (v !== null && v > 0 && v < bestValue) {
      best = row;
      bestValue = v;
    }
  }
  return best;
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
  const best = {
    fastest: lowest(rows, (row) => row.latencyMs.p50),
    cheapest: lowest(rows, costPerWin),
  };
  rows.forEach((row, index) => body.append(standingRow(row, scale, index, best)));
  // Un orquestador anterior no informa las lecturas de pelea: sin ellas, la columna de daño no se muestra.
  const readings = rows.some((row) => row.fight !== undefined);
  byId("standings-table").classList.toggle("no-readings", !readings);

  const methods = new Set(rows.filter((row) => !row.isReference).map((row) => row.ciMethod));
  const how =
    methods.size !== 1
      ? "Los intervalos se calculan por bootstrap cuando hay suficientes semillas completas, y por aproximación de Laplace cuando no."
      : methods.has("bootstrap")
        ? "Intervalos por bootstrap: se remuestrean grupos completos de escenario + semilla."
        : "Intervalos por aproximación de Laplace.";
  const bars = readings
    ? " En la barra de peleas, el color lleno son las que terminaron por K.O. y el suave, las que se decidieron por vida al acabar el tiempo."
    : "";
  byId("standings-note").textContent =
    `${how}${bars} La estrella marca al más rápido en decidir y al que gana más barato.`;
}

/** Celda con un número principal y una segunda línea más chica. */
function twoLines(className: string, label: string, main: string, sub: string): HTMLTableCellElement {
  const td = labeled(el("td", `num ${className}`), label);
  td.append(el("span", "board__main", main));
  if (sub !== "") td.append(el("span", "board__p95", sub));
  return td;
}

function star(cell: HTMLElement, tip: string): void {
  const mark = el("span", "board__star");
  mark.append(pixelIcon({ name: "star" }));
  cell.querySelector(".board__main")?.prepend(mark);
  cell.classList.add("is-best");
  cell.dataset.tip = tip;
}

function standingRow(
  row: StandingRow,
  scale: Scale,
  index: number,
  best: { fastest: StandingRow | null; cheapest: StandingRow | null },
): HTMLTableRowElement {
  const tr = el("tr");
  tr.style.setProperty("--i", String(index));
  if (row.isReference) tr.classList.add("is-reference");
  const tier = tierOf(row);
  const tone = row.isReference ? "reference" : tier === "level" ? "cross" : tier;

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
    const where =
      tier === "above"
        ? "Todo el intervalo está sobre la referencia."
        : tier === "below"
          ? "Todo el intervalo está bajo la referencia."
          : "El intervalo cruza la referencia: todavía no se distingue de ella.";
    rating.dataset.tip = `Intervalo del rating: de ${formatRating(row.lo)} a ${formatRating(row.hi)}. ${where}`;
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

  // Peleas: cuántas ganó, y de qué manera.
  const fights = labeled(el("td", "board__fights"), "Ganadas");
  const share = el("span", "board__main", row.games > 0 ? formatPct(row.wins / row.games) : "–");
  const head = el("span", "board__won");
  head.append(share, recordBar(row));
  const detail = [`${row.wins} de ${row.games}`];
  if (row.fight) detail.push(`${row.fight.koWins} por K.O.`);
  fights.append(head, el("span", "board__p95", detail.join(" · ")));
  fights.setAttribute(
    "aria-label",
    `${row.wins} victorias, ${row.draws} empates y ${row.losses} derrotas en ${row.games} peleas`,
  );
  tr.append(fights);

  const damage = twoLines(
    "board__damage",
    "Daño",
    row.fight ? formatAverage(row.fight.damageDealt, row.games) : "–",
    row.fight ? `recibe ${formatAverage(row.fight.damageTaken, row.games)}` : "",
  );
  damage.dataset.tip = "Puntos de vida que le quita al rival y que pierde en una pelea promedio. Cada jugador parte con 30.";
  tr.append(damage);

  const perFight = decisionsPerFight(row);
  const decisions = twoLines(
    "board__decisions",
    "Decisiones",
    perFight === null ? "–" : perFight.toFixed(1),
    row.fight && row.fight.decisions > 0 ? `${formatPct(row.fight.invalidActions / row.fight.decisions)} rechazadas` : "",
  );
  decisions.dataset.tip = "Cuántas veces alcanza a decidir en una pelea, y qué parte de esas acciones rechazó el juego.";
  tr.append(decisions);

  const latency = twoLines("board__latency", "Latencia", formatMs(row.latencyMs.p50), `p95 ${formatMs(row.latencyMs.p95)}`);
  latency.dataset.tip = `Mediana y percentil 95 de ${row.latencyMs.count} decisiones: desde que el agente recibe el estado hasta que entrega una acción válida.`;
  if (best.fastest === row) star(latency, "El más rápido en decidir de toda la liga.");
  tr.append(latency);

  const each = costPerWin(row);
  const cost = twoLines("board__cost", "Costo por victoria", each === null ? "–" : formatUsd(each), `total ${formatUsd(row.costUsd)}`);
  cost.dataset.tip = "Lo que cuesta cada victoria de este modelo en la liga, y lo gastado en él en todo el torneo.";
  if (best.cheapest === row) star(cost, "El que gana más barato de toda la liga.");
  tr.append(cost);

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

  const candidates = report.calibration.length;
  const entered = report.calibration.filter((row) => row.league).length;
  byId("calibration-brief").textContent =
    candidates === 0
      ? "Todavía sin resultados"
      : `${candidates} ${candidates === 1 ? "candidato" : "candidatos"}, ${entered} ${entered === 1 ? "entra" : "entran"} a la liga`;

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
