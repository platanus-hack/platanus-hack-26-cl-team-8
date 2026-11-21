import type { AgentConfig, MatchRecord, Side } from "@phack/protocol";
import { describeError, fetchMatches } from "./api";
import { byId, el, setText } from "./dom";
import { REASON_LABEL, SIDE_LABEL, formatDateTime, formatDuration, formatNumber } from "./format";
import { renderModelTag, resolveModel } from "./models";
import { showToast } from "./toast";

const MAX_RECORDS = 50;
const COLUMN_COUNT = 7;

let records: MatchRecord[] = [];
let loaded = false;
let requestSeq = 0;
/** Celdas de prompt expandidas ("<id>:<lado>"), para conservarlas al re-renderizar. */
const expanded = new Set<string>();

function promptCell(record: MatchRecord, side: Side): HTMLTableCellElement {
  const config: AgentConfig = record.configs[side];
  const key = `${record.id}:${side}`;
  const cell = el("td", `history__prompt history__prompt--${side}`);
  cell.dataset.label = `Prompt ${SIDE_LABEL[side]}`;

  // textContent: los prompts los escribe cualquiera, jamás se interpretan como HTML.
  const snippet = el("button", "snippet");
  snippet.append(el("span", "snippet__text", config.prompt.trim() === "" ? "(prompt vacío)" : config.prompt));
  snippet.type = "button";
  snippet.title = "Clic para expandir o contraer";
  snippet.setAttribute("aria-expanded", String(expanded.has(key)));
  snippet.addEventListener("click", () => {
    const open = !expanded.has(key);
    if (open) expanded.add(key);
    else expanded.delete(key);
    snippet.setAttribute("aria-expanded", String(open));
  });
  cell.append(snippet);

  // Solo si el registro guardó con qué se peleó: no se adivina con los valores de hoy.
  if (config.provider !== undefined || (config.model ?? "") !== "") {
    const tag = el("span", "model-tag history__model");
    renderModelTag(tag, resolveModel(config));
    cell.append(tag);
  }
  return cell;
}

/** Celda con data-label: en pantallas angostas la tabla se muestra como tarjetas. */
function labelled(label: string, className?: string, text?: string): HTMLTableCellElement {
  const cell = el("td", className, text);
  cell.dataset.label = label;
  return cell;
}

function row(record: MatchRecord): HTMLTableRowElement {
  const tr = el("tr", "history__row");
  const winner = record.result.winner;
  tr.dataset.winner = winner ?? "none";

  const winnerCell = labelled("Ganador");
  winnerCell.append(
    el("span", `badge badge--${winner ?? "none"}`, winner ? SIDE_LABEL[winner] : "Sin ganador"),
  );

  const health = `${formatNumber(record.final.red.health)} – ${formatNumber(record.final.blue.health)}`;

  tr.append(
    labelled("Fecha", "history__date", formatDateTime(record.startedAt)),
    winnerCell,
    labelled("Motivo", undefined, REASON_LABEL[record.result.reason]),
    labelled("Duración", "history__num", formatDuration(record.durationMs)),
    labelled("Vida final (Rojo – Azul)", "history__num", health),
    promptCell(record, "red"),
    promptCell(record, "blue"),
  );
  return tr;
}

function emptyRow(text: string): HTMLTableRowElement {
  const tr = el("tr");
  const cell = el("td", "history__empty", text);
  cell.colSpan = COLUMN_COUNT;
  tr.append(cell);
  return tr;
}

function renderTally(): void {
  let red = 0;
  let blue = 0;
  let none = 0;
  for (const record of records) {
    if (record.result.winner === "red") red += 1;
    else if (record.result.winner === "blue") blue += 1;
    else none += 1;
  }
  setText(byId("tally-red"), String(red));
  setText(byId("tally-blue"), String(blue));
  setText(byId("tally-none"), String(none));
  byId("tally-bar-red").style.flexGrow = String(red);
  byId("tally-bar-none").style.flexGrow = String(none);
  byId("tally-bar-blue").style.flexGrow = String(blue);

  const total = records.length;
  let summary = "Aún no hay peleas: inicia una para descubrir qué prompt gana.";
  if (total > 0) {
    const fights = total === 1 ? "1 pelea registrada" : `${total} peleas registradas`;
    if (red > blue) summary = `${fights}: va ganando Rojo.`;
    else if (blue > red) summary = `${fights}: va ganando Azul.`;
    else summary = `${fights}: Rojo y Azul van igualados.`;
  }
  setText(byId("tally-summary"), summary);
}

function render(): void {
  const body = byId("history-body");
  if (records.length === 0) {
    body.replaceChildren(emptyRow(loaded ? "Aún no hay peleas registradas." : "Cargando historial…"));
  } else {
    body.replaceChildren(...records.map(row));
  }
  renderTally();
}

/** Agrega al tiro el resultado recién llegado por websocket (sin duplicar). */
export function addRecord(record: MatchRecord): void {
  records = [record, ...records.filter((existing) => existing.id !== record.id)].slice(0, MAX_RECORDS);
  loaded = true;
  render();
}

export async function refreshHistory(options: { silent?: boolean } = {}): Promise<void> {
  const seq = ++requestSeq;
  try {
    const fetched = await fetchMatches();
    if (seq !== requestSeq) return; // llegó una respuesta más nueva
    records = fetched.slice(0, MAX_RECORDS);
    loaded = true;
    render();
  } catch (err) {
    if (seq !== requestSeq) return;
    if (!loaded) {
      byId("history-body").replaceChildren(emptyRow("No se pudo cargar el historial."));
    }
    if (!options.silent) showToast(`No se pudo cargar el historial: ${describeError(err)}`);
  }
}

export function initHistory(): void {
  render();
}
