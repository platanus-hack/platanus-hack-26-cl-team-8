/**
 * Dibujo del leaderboard: cabecera con progreso, tabla, matriz y calibración.
 * Todo el texto entra por textContent (dom.ts); los logos, por renderModelTag.
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
  formatInterval,
  formatMinutes,
  formatMs,
  formatPct,
  formatRating,
  formatSigned,
  formatUsd,
  fraction,
  scoreColor,
} from "./format";

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

/** Logo + nombre de un modelo. `tip` = ayuda al pasar el mouse (data-tip). */
export function modelTag(gatewayId: string, name: string, tip?: string): HTMLElement {
  const tag = el("span", "model-tag");
  renderModelTag(tag, describeModel(gatewayId, name));
  if (tip === undefined) delete tag.dataset.tip;
  else tag.dataset.tip = tip;
  return tag;
}

// ---------- (1) Cabecera y progreso ----------

function bar(label: string, done: number, total: number, value: string, note?: string): HTMLElement {
  const item = el("div", "progress");
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
  fill.style.width = `${fraction(done, total) * 100}%`;
  track.append(fill);
  item.append(head, track);
  if (note) item.append(el("span", "progress__note", note));
  return item;
}

export function renderSummary(report: TournamentReport): void {
  const { config, progress } = report;
  byId("t-name").textContent = config.name;

  const meta = byId("t-meta");
  meta.replaceChildren();
  const stage = el("span", "badge", STAGE_LABEL[progress.stage]);
  stage.dataset.stage = progress.stage;
  const mode = el("span", "badge", config.mode === "real" ? "Minecraft real" : "Simulado");
  mode.dataset.mode = config.mode;
  meta.append(
    stage,
    mode,
    el("span", "", `Creado ${formatDate(config.createdAt)}`),
    el("span", "", `${config.benchmark.matchSeconds} s por pelea`),
    el("span", "mono", config.benchmark.id),
  );

  const { calibration: cal, league, limits } = progress;
  const bars = byId("t-progress");
  bars.replaceChildren(
    bar(
      "Calibración",
      cal.valid,
      cal.planned,
      `${cal.valid} / ${cal.planned}`,
      cal.infra > 0 ? `${cal.infra} intentos con fallo de infraestructura` : undefined,
    ),
    bar(
      "Liga",
      league.valid,
      league.planned,
      `${league.valid} / ${league.planned}`,
      league.infra > 0 ? `${league.infra} intentos con fallo de infraestructura` : undefined,
    ),
    bar("Semillas de la liga", league.seedsDone, league.seedsPlanned, `${league.seedsDone} / ${league.seedsPlanned}`),
    bar(
      "Minutos",
      progress.elapsedMinutes,
      limits.maxMinutes,
      `${formatMinutes(progress.elapsedMinutes)} / ${limits.maxMinutes} min`,
    ),
    bar("Costo", progress.costUsd, limits.maxUsd, `${formatUsd(progress.costUsd)} / ${formatUsd(limits.maxUsd)}`),
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

export function renderStandings(report: TournamentReport): void {
  const body = byId("standings-body");
  body.replaceChildren();
  const empty = byId("standings-empty");
  empty.hidden = report.standings.length > 0;

  for (const row of report.standings) body.append(standingRow(row));
}

function standingRow(row: StandingRow): HTMLTableRowElement {
  const tr = el("tr");
  if (row.isReference) tr.classList.add("is-reference");

  tr.append(el("td", "num board__rank", String(row.rank)));

  const model = el("th", "board__model");
  model.scope = "row";
  const tag = modelTag(row.gatewayId, row.name, modelDetail(row.gatewayId, row.inferenceProvider));
  model.append(tag);
  // Si juega con razonamiento (no se podía apagar), se dice: piensa antes de cada acción.
  const version = row.reasoning === "none" ? row.version : `${row.version} · razonamiento ${row.reasoning}`;
  const sub = el("span", "board__version", version);
  model.append(sub);
  if (row.isReference) model.append(el("span", "ref-badge", "Referencia"));
  model.append(el("span", "sr-only", ` (${modelDetail(row.gatewayId, row.inferenceProvider)})`));
  tr.append(model);

  const rating = el("td", "num board__rating", formatRating(row.rating));
  if (row.isReference) rating.dataset.tip = `Fijo en ${REFERENCE_RATING}: es el origen de la escala.`;
  tr.append(rating);

  const ci = el("td", "num board__ci");
  if (row.isReference) {
    ci.append(el("span", "muted", "fijo"));
  } else {
    const { half, range } = formatInterval(row.lo, row.hi);
    ci.append(el("span", "", half), el("span", "board__range", range));
    ci.dataset.tip =
      row.ciMethod === "bootstrap"
        ? "Intervalo por bootstrap: se remuestrean grupos completos de escenario + semilla."
        : "Intervalo por aproximación de Laplace (hay pocos grupos de escenario + semilla para un bootstrap).";
  }
  const method = el("span", "board__method", row.isReference ? "" : row.ciMethod === "bootstrap" ? "bootstrap" : "Laplace");
  ci.append(method);
  tr.append(ci);

  tr.append(el("td", "num", String(row.games)));

  const wdl = el("td", "num board__wdl");
  wdl.append(
    el("span", "w", String(row.wins)),
    el("span", "sep", " / "),
    el("span", "d", String(row.draws)),
    el("span", "sep", " / "),
    el("span", "l", String(row.losses)),
  );
  wdl.setAttribute("aria-label", `${row.wins} victorias, ${row.draws} empates, ${row.losses} derrotas`);
  tr.append(wdl);

  tr.append(el("td", "num", formatUsd(row.costUsd)));

  const latency = el("td", "num board__latency");
  latency.append(el("span", "", formatMs(row.latencyMs.p50)), el("span", "sep", " / "), el("span", "muted", formatMs(row.latencyMs.p95)));
  latency.dataset.tip = `Mediana / percentil 95 de ${row.latencyMs.count} decisiones: desde que el agente recibe el estado hasta que entrega una acción válida.`;
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

export function renderCalibration(report: TournamentReport): void {
  const { rule } = report.config;
  const conf = Math.round((2 * normalCdf(rule.z) - 1) * 100);
  byId("calibration-rule").textContent =
    `Entra a la liga quien juega parecido a DeepSeek: diferencia de rating dentro de ±${rule.bandElo} Elo ` +
    `con intervalo de ${conf} % (z = ${rule.z}). Si el intervalo cruza el borde queda pendiente: se juegan más ` +
    `cruces mientras haya presupuesto, y entra como provisional si su estimación cae dentro.`;

  const models = modelIndex(report);
  const body = byId("calibration-body");
  body.replaceChildren();
  byId("calibration-empty").hidden = report.calibration.length > 0;
  const rows = [...report.calibration].sort(
    (x, y) => Number(y.league) - Number(x.league) || VERDICT_ORDER[x.verdict] - VERDICT_ORDER[y.verdict] || Math.abs(x.diff) - Math.abs(y.diff),
  );
  for (const row of rows) {
    const tr = el("tr");
    const frozen = models.get(row.model);
    const th = el("th", "board__model");
    th.scope = "row";
    th.append(
      modelTag(frozen?.gatewayId ?? row.model, row.name, frozen ? modelDetail(frozen.gatewayId, frozen.inferenceProvider) : row.model),
    );
    tr.append(th);

    const verdict = el("td");
    const badge = el("span", "verdict", VERDICT_LABEL[row.verdict]);
    badge.dataset.verdict = row.verdict;
    verdict.append(badge);
    tr.append(verdict);

    const league = el("td");
    const lb = el("span", "verdict", row.league ? "En la liga" : "Fuera");
    lb.dataset.league = row.league ? "yes" : "no";
    league.append(lb);
    tr.append(league);

    const diff = el("td", "num", `${formatSigned(row.diff)} ± ${Math.round(row.se)}`);
    tr.append(diff);
    // lo/hi vienen en la escala de la diferencia con la referencia (diff ± z·se).
    tr.append(el("td", "num muted", `[${formatSigned(row.lo)}, ${formatSigned(row.hi)}]`));
    tr.append(el("td", "num", `${row.games} · ${row.opponents}`));
    tr.append(el("td", "calib__why", row.why));
    body.append(tr);
  }

  const omitted = byId("omitted-list");
  omitted.replaceChildren();
  byId("omitted-empty").hidden = report.config.omitted.length > 0;
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
