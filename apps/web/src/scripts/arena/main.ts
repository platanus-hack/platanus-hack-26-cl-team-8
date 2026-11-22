/**
 * Leaderboard del torneo de modelos (/arena). Lee los reportes del orquestador por
 * HTTP (solo GET): la lista de torneos, el reporte del elegido y, al hacer clic en
 * una celda de la matriz, las partidas de esa pareja.
 *
 * El torneo elegido va en la URL (?id=); sin id se muestra el más reciente. Mientras
 * el torneo corre, el reporte se vuelve a pedir cada REFRESH_MS.
 */
import type { TournamentReport, TournamentSummary } from "@phack/protocol";
import { describeError } from "../api";
import { MOCK } from "../config";
import { byId, el } from "../dom";
import { fetchPair, fetchReport, fetchTournaments } from "./api";
import { STAGE_LABEL, formatDate } from "./format";
import { cellSummary, renderPair } from "./pair";
import { markCell, modelIndex, modelTag, renderCalibration, renderMatrix, renderStandings, renderSummary } from "./view";

const REFRESH_MS = 20_000;

const select = byId<HTMLSelectElement>("arena-select");
const status = byId("arena-status");
const content = byId("arena-content");
const panel = byId("pair");
const panelEmpty = byId("pair-empty");

let report: TournamentReport | null = null;
let openPair: { row: string; col: string } | null = null;
/** Descarta respuestas viejas si el usuario cambió de torneo o de celda entretanto. */
let reportToken = 0;
let pairToken = 0;
let timer: number | null = null;
/** Torneo que ya se mostró: la animación de entrada de los gráficos corre una vez por torneo. */
let shown: string | null = null;
let freshTimer: number | null = null;

function setStatus(text: string, kind: "info" | "error" = "info"): void {
  status.textContent = text;
  status.dataset.kind = kind;
  status.hidden = text === "";
}

function selectedFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("id");
}

/** Escribe ?id= en la URL sin recargar (conserva ?mock y lo demás). */
function writeUrl(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("id", id);
  window.history.replaceState(null, "", url);
}

function fillSelect(list: TournamentSummary[], current: string): void {
  select.replaceChildren();
  for (const t of list) {
    const mode = t.mode === "simulated" ? " · simulado" : "";
    const option = el("option", "", `${t.name} — ${formatDate(t.createdAt)} · ${STAGE_LABEL[t.stage]}${mode}`);
    option.value = t.id;
    option.selected = t.id === current;
    select.append(option);
  }
  select.disabled = list.length < 2;
}

function schedule(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  const stage = report?.progress.stage;
  if (stage === "calibration" || stage === "league") {
    timer = window.setTimeout(() => {
      if (document.visibilityState === "visible" && report) void load(report.config.id, true);
      else schedule();
    }, REFRESH_MS);
  }
}

async function load(id: string, quiet = false): Promise<void> {
  const token = ++reportToken;
  if (!quiet) setStatus("Cargando el torneo…");
  try {
    const next = await fetchReport(id);
    if (token !== reportToken) return;
    report = next;
    render();
    setStatus("");
  } catch (err) {
    if (token !== reportToken) return;
    // En una actualización de fondo se conserva lo que ya se veía.
    if (!quiet || !report) {
      content.hidden = true;
      setStatus(describeError(err), "error");
    }
  }
  schedule();
}

function render(): void {
  if (!report) return;
  content.hidden = false;
  // Los intervalos se despliegan solo la primera vez; en las actualizaciones de fondo no.
  if (shown !== report.config.id) {
    shown = report.config.id;
    content.classList.add("is-fresh");
    if (freshTimer !== null) window.clearTimeout(freshTimer);
    freshTimer = window.setTimeout(() => content.classList.remove("is-fresh"), 1600);
  }
  renderSummary(report);
  renderStandings(report);
  renderMatrix(report, (row, col) => void showPair(row, col, true));
  renderCalibration(report);

  // Si había una pareja abierta y sigue en la tabla, se refresca; si no, se cierra.
  const keys = new Set(report.standings.map((s) => s.model));
  if (openPair && keys.has(openPair.row) && keys.has(openPair.col)) void showPair(openPair.row, openPair.col, false);
  else closePair();
}

async function showPair(row: string, col: string, focus: boolean): Promise<void> {
  if (!report) return;
  const current = report;
  const token = ++pairToken;
  openPair = { row, col };
  markCell(row, col);

  const models = modelIndex(current);
  const rowModel = models.get(row);
  const colModel = models.get(col);
  const rowName = rowModel?.name ?? row;
  const colName = colModel?.name ?? col;
  const cell = current.matrix.find((c) => c.row === row && c.col === col);

  panel.hidden = false;
  panelEmpty.hidden = true;
  const title = byId("pair-title");
  title.replaceChildren(modelTag(rowModel?.gatewayId ?? row, rowName), el("span", "pair__vs", "vs"), modelTag(colModel?.gatewayId ?? col, colName));
  title.setAttribute("aria-label", `${rowName} contra ${colName}`);
  byId("pair-summary").textContent = cellSummary(rowName, cell);
  const body = byId("pair-body");
  if (focus) {
    body.replaceChildren(el("p", "empty", "Cargando partidas…"));
    title.focus({ preventScroll: true });
    panel.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
  }

  try {
    const attempts = await fetchPair(current.config.id, row, col);
    if (token !== pairToken) return;
    renderPair(body, models, attempts, row);
  } catch (err) {
    if (token !== pairToken) return;
    body.replaceChildren(el("p", "empty is-error", describeError(err)));
  }
}

function closePair(): void {
  openPair = null;
  pairToken++;
  panel.hidden = true;
  panelEmpty.hidden = false;
  markCell(null, null);
}

byId("pair-close").addEventListener("click", () => {
  const was = openPair;
  closePair();
  // Devuelve el foco a la celda que abrió el panel.
  if (was) {
    for (const b of document.querySelectorAll<HTMLButtonElement>("#matrix .cell")) {
      if (b.dataset.row === was.row && b.dataset.col === was.col) b.focus();
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openPair) byId("pair-close").click();
});

select.addEventListener("change", () => {
  writeUrl(select.value);
  closePair();
  void load(select.value);
});

async function boot(): Promise<void> {
  if (MOCK) byId("arena-mock").hidden = false;
  setStatus("Buscando torneos…");
  let list: TournamentSummary[];
  try {
    list = await fetchTournaments();
  } catch (err) {
    setStatus(describeError(err), "error");
    return;
  }
  if (list.length === 0) {
    select.disabled = true;
    setStatus("Todavía no hay torneos. Crea uno con `pnpm tournament create` y córrelo con `pnpm tournament run`.");
    return;
  }
  const sorted = [...list].sort((x, y) => y.createdAt - x.createdAt);
  const wanted = selectedFromUrl();
  const current = sorted.find((t) => t.id === wanted)?.id ?? sorted[0]!.id;
  fillSelect(sorted, current);
  await load(current);
}

void boot();
