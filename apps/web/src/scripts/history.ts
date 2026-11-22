/**
 * Historial: las últimas peleas y los prompts que alguien marcó.
 *
 * Marcar un prompt lo guarda aparte, tal como peleó (texto, modelo, kit, contra quién y
 * cómo le fue), con etiquetas y una nota. Desde aquí se puede filtrar por etiqueta para
 * comparar cómo les fue, abrir la transcripción de la pelea y volver a cargar el prompt
 * en un editor para repetirlo. El servidor solo recuerda las últimas peleas; lo marcado
 * queda aunque la pelea ya no esté entre ellas.
 */
import {
  seriesTally,
  API_ROUTES,
  COMMS_LABELS,
  MAX_FLAG_NOTE_LENGTH,
  MAX_FLAG_TAGS,
  SIDES,
  kitOf,
  normalizeTags,
  type AgentConfig,
  type AgentStatus,
  type FlaggedPrompt,
  type MatchRecord,
  type MatchResult,
  type MatchSettings,
  type MatchState,
  type Series,
  type Side,
} from "@phack/protocol";
import { ApiError, describeError, fetchFlags, fetchMatches, removeFlag, saveFlag } from "./api";
import { MOCK, apiUrl } from "./config";
import { byId, el } from "./dom";
import { SIDE_LABEL, formatClock, formatDateTime, formatDuration, formatNumber, resultDetail, roundTitle } from "./format";
import { pixelIcon } from "./icons";
import { onDefaultsChange, renderModelTag, resolveModel } from "./models";
import type { IconName } from "./pixelicons";
import { loadIntoEditor } from "./prompts";
import { showToast } from "./toast";

/** Una pelea del historial, venga del registro de peleas, de una marca o de la pelea en curso. */
type Bout = {
  id: string;
  /** Para ordenar: cuándo terminó, o cuándo se marcó si no hay más datos. */
  at: number;
  live: boolean;
  configs: Record<Side, AgentConfig>;
  settings: MatchSettings;
  result: MatchResult | null;
  durationMs: number | null;
  final: Record<Side, AgentStatus> | null;
  /** Solo si fue una serie por rondas. */
  series: Series | null;
  flags: Partial<Record<Side, FlaggedPrompt>>;
};

type Draft = { key: string; tags: string; note: string; saving: boolean };

let list: HTMLElement | null = null;
let filters: HTMLElement | null = null;
let summary: HTMLElement | null = null;
let count: HTMLElement | null = null;

/** Si el historial quedó abierto o plegado se recuerda en este navegador. */
const STORAGE_KEY = "arena-historial";
/** Peleas que el usuario abrió: cada una parte plegada, en una sola línea. */
const openBouts = new Set<string>();

let records: MatchRecord[] = [];
let flags: FlaggedPrompt[] = [];
/** Un servidor anterior a las marcas no tiene la ruta: se muestra el historial sin ellas. */
let flagsAvailable = true;
let live: MatchState | null = null;
let onlyFlagged = false;
let activeTag: string | null = null;
/** Marca que se está escribiendo (una a la vez). */
let draft: Draft | null = null;
/** Prompts que el usuario abrió para leerlos completos. */
const expanded = new Set<string>();

const keyOf = (matchId: string, side: Side): string => `${matchId}:${side}`;

// ---------- Datos ----------

function buildBouts(): Bout[] {
  const bouts = new Map<string, Bout>();
  for (const record of records) {
    bouts.set(record.id, {
      id: record.id,
      at: record.endedAt,
      live: false,
      configs: record.configs,
      settings: record.settings,
      result: record.result,
      durationMs: record.durationMs,
      final: record.final,
      series: record.series,
      flags: {},
    });
  }
  const underway = live !== null && (live.phase === "preparing" || live.phase === "running" || live.phase === "intermission");
  if (live && underway && !bouts.has(live.id)) {
    bouts.set(live.id, {
      id: live.id,
      at: Number.MAX_SAFE_INTEGER,
      live: true,
      configs: live.configs,
      settings: live.settings,
      result: null,
      durationMs: null,
      final: null,
      series: live.series,
      flags: {},
    });
  }
  for (const flag of flags) {
    let bout = bouts.get(flag.matchId);
    if (!bout) {
      // La pelea ya salió del historial reciente: se arma con lo que guardó la marca.
      const other: Side = flag.side === "red" ? "blue" : "red";
      bout = {
        id: flag.matchId,
        at: flag.outcome?.endedAt ?? flag.flaggedAt,
        live: false,
        configs: { [flag.side]: flag.config, [other]: flag.rival } as Record<Side, AgentConfig>,
        settings: flag.settings,
        result: flag.outcome?.result ?? null,
        durationMs: flag.outcome?.durationMs ?? null,
        final: flag.outcome?.final ?? null,
        series: null,
        flags: {},
      };
      bouts.set(flag.matchId, bout);
    }
    bout.flags[flag.side] = flag;
  }
  return [...bouts.values()].sort((a, b) => b.at - a.at);
}

function allTags(): string[] {
  const counts = new Map<string, number>();
  for (const flag of flags) for (const tag of flag.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}

async function reloadFlags(): Promise<void> {
  try {
    flags = await fetchFlags();
    flagsAvailable = true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) flagsAvailable = false;
  }
}

async function reload(): Promise<void> {
  const [matches] = await Promise.all([fetchMatches().catch(() => records), reloadFlags()]);
  records = matches;
  renderQuietly();
}

/**
 * Redibuja por algo que pasó solo (llegaron datos, cambió la pelea en curso). Si alguien
 * está escribiendo una marca se deja para después: redibujar le quitaría el cursor.
 */
function renderQuietly(): void {
  if (draft && !draft.saving && list?.contains(document.activeElement)) return;
  render();
}

// ---------- Texto ----------

type SideOutcome = "won" | "lost" | "draw" | "none";

function outcomeOf(result: MatchResult | null, side: Side): SideOutcome {
  if (!result) return "none";
  if (result.winner) return result.winner === side ? "won" : "lost";
  return result.reason === "draw" ? "draw" : "none";
}

const OUTCOME_LABEL: Record<SideOutcome, string> = { won: "Ganó", lost: "Perdió", draw: "Empate", none: "" };

function headline(bout: Bout): string {
  if (bout.live) return "Pelea en curso";
  if (!bout.result) return "Pelea sin resultado guardado";
  if (bout.result.winner) return `Gana ${SIDE_LABEL[bout.result.winner]}`;
  if (bout.result.reason === "draw") return "Empate";
  return bout.result.reason === "stopped" ? "Pelea detenida" : "Pelea interrumpida";
}

function transcriptHref(matchId: string): string {
  return `${apiUrl(API_ROUTES.transcript(encodeURIComponent(matchId)))}?format=text`;
}

/** Cómo les fue a los prompts marcados con una etiqueta: es la forma rápida de compararlos. */
function tagSummary(tag: string): string {
  const tagged = flags.filter((flag) => flag.tags.includes(tag));
  const tally: Record<SideOutcome, number> = { won: 0, lost: 0, draw: 0, none: 0 };
  for (const flag of tagged) tally[outcomeOf(flag.outcome?.result ?? null, flag.side)] += 1;
  const parts = [`${tally.won} ganaron`, `${tally.lost} perdieron`];
  if (tally.draw > 0) parts.push(`${tally.draw} empataron`);
  if (tally.none > 0) parts.push(`${tally.none} sin resultado`);
  const count = tagged.length === 1 ? "1 prompt marcado" : `${tagged.length} prompts marcados`;
  return `«${tag}»: ${count}. ${parts.join(", ")}.`;
}

// ---------- Marcar ----------

function startDraft(matchId: string, side: Side, flag: FlaggedPrompt | undefined): void {
  draft = { key: keyOf(matchId, side), tags: flag ? flag.tags.join(", ") : "", note: flag?.note ?? "", saving: false };
  render();
  list?.querySelector<HTMLInputElement>(".flag-form input")?.focus();
}

async function submitDraft(matchId: string, side: Side): Promise<void> {
  if (!draft || draft.saving) return;
  draft.saving = true;
  render();
  try {
    const saved = await saveFlag(matchId, side, { tags: normalizeTags(draft.tags.split(",")), note: draft.note.trim() });
    flags = [saved, ...flags.filter((flag) => !(flag.matchId === matchId && flag.side === side))];
    draft = null;
  } catch (err) {
    showToast(`No se pudo marcar el prompt: ${describeError(err)}`);
    if (draft) draft.saving = false;
  }
  render();
}

async function unflag(matchId: string, side: Side): Promise<void> {
  try {
    await removeFlag(matchId, side);
    flags = flags.filter((flag) => !(flag.matchId === matchId && flag.side === side));
    if (activeTag && !allTags().includes(activeTag)) activeTag = null;
  } catch (err) {
    showToast(`No se pudo quitar la marca: ${describeError(err)}`);
  }
  render();
}

// ---------- Dibujo ----------

function button(text: string, onClick: () => void, className = "btn btn--small"): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function flagForm(bout: Bout, side: Side, current: Draft): HTMLElement {
  const form = el("form", "flag-form");
  const tags = el("input");
  tags.type = "text";
  tags.value = current.tags;
  tags.placeholder = "Etiquetas, separadas por coma";
  tags.setAttribute("aria-label", "Etiquetas, separadas por coma");
  tags.autocomplete = "off";
  tags.addEventListener("input", () => {
    current.tags = tags.value;
  });
  const note = el("textarea");
  note.rows = 2;
  note.maxLength = MAX_FLAG_NOTE_LENGTH;
  note.value = current.note;
  note.placeholder = "Nota: qué tiene de interesante este prompt";
  note.setAttribute("aria-label", "Nota");
  note.addEventListener("input", () => {
    current.note = note.value;
  });
  const save = el("button", "btn btn--small", current.saving ? "Guardando…" : "Guardar marca");
  save.type = "submit";
  save.disabled = current.saving;
  const cancel = button("Cancelar", () => {
    draft = null;
    render();
  });
  const hint = el("span", "flag-form__hint", `Hasta ${MAX_FLAG_TAGS} etiquetas. Sin etiquetas también queda marcado.`);
  const row = el("div", "flag-form__row");
  row.append(save, cancel, hint);
  form.append(tags, note, row);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitDraft(bout.id, side);
  });
  return form;
}

function sideCell(bout: Bout, side: Side): HTMLElement {
  const config = bout.configs[side];
  const flag = bout.flags[side];
  const key = keyOf(bout.id, side);
  const cell = el("section", "bout__side");
  cell.dataset.side = side;
  if (flag) cell.classList.add("is-flagged");

  const who = el("div", "bout__who");
  who.append(el("h4", "bout__name", SIDE_LABEL[side]));
  const model = el("span", "model-tag");
  renderModelTag(model, resolveModel(config));
  who.append(model, el("span", "bout__kit", `Kit ${kitOf(config).name}`));
  const outcome = outcomeOf(bout.result, side);
  if (outcome !== "none") {
    const mark = el("span", "bout__outcome", OUTCOME_LABEL[outcome]);
    mark.dataset.outcome = outcome;
    who.append(mark);
  }
  cell.append(who);

  const prompt = el("p", "bout__prompt", config.prompt.trim() || "(prompt vacío)");
  const open = expanded.has(key);
  prompt.classList.toggle("is-open", open);
  cell.append(prompt);

  const status = bout.final?.[side];
  if (status) {
    cell.append(
      el(
        "p",
        "bout__stats",
        `Terminó con ${formatNumber(status.health)} de vida, hizo ${formatNumber(status.damageDealt)} de daño en ${status.decisions} decisiones.`,
      ),
    );
  }

  if (flag && draft?.key !== key) {
    const mark = el("div", "bout__flag");
    const tags = el("ul", "tags");
    if (flag.tags.length === 0) tags.append(el("li", "tags__item tags__item--plain", "Marcado"));
    for (const tag of flag.tags) tags.append(el("li", "tags__item", tag));
    mark.append(tags);
    if (flag.note) mark.append(el("p", "bout__note", flag.note));
    cell.append(mark);
  }

  if (draft?.key === key) {
    cell.append(flagForm(bout, side, draft));
    return cell;
  }

  const actions = el("div", "bout__actions");
  if (config.prompt.trim().length > 160) {
    actions.append(
      button(open ? "Ver menos" : "Ver completo", () => {
        if (open) expanded.delete(key);
        else expanded.add(key);
        render();
      }),
    );
  }
  if (flagsAvailable) {
    // Marcar prompts es del equipo (ver access.ts).
    const mark = button(flag ? "Editar marca" : "Marcar", () => startDraft(bout.id, side, flag));
    mark.dataset.needs = "admin";
    actions.append(mark);
    if (flag) {
      const unmark = button("Quitar marca", () => void unflag(bout.id, side));
      unmark.dataset.needs = "admin";
      actions.append(unmark);
    }
  }
  for (const target of SIDES) {
    actions.append(
      button(`Cargar en ${SIDE_LABEL[target]}`, () => {
        loadIntoEditor(target, config);
        showToast(`Prompt cargado en el editor ${SIDE_LABEL[target]}. Guárdalo para usarlo en la próxima pelea.`, "ok");
      }),
    );
  }
  cell.append(actions);
  return cell;
}

/** Un ícono de la fila, con su ayuda al pasar el mouse. */
function rowIcon(name: IconName, tip: string, className: string): HTMLElement {
  const holder = el("span", className);
  holder.dataset.tip = tip;
  holder.append(pixelIcon({ name }));
  return holder;
}

/**
 * Un lado en la fila: su nombre en un bloque y su modelo. El bloque va lleno, del color
 * del lado y con la corona si ganó; hueco y apagado si perdió.
 */
function rowSide(bout: Bout, side: Side): HTMLElement {
  const outcome = outcomeOf(bout.result, side);
  const cell = el("span", "row__side");
  cell.dataset.side = side;
  cell.dataset.outcome = bout.live ? "live" : outcome;
  // El lugar de la corona existe siempre, aunque vaya vacío: así los nombres y los modelos
  // quedan en la misma columna en todas las filas.
  cell.append(
    outcome === "won" ? rowIcon("crown", `Ganó ${SIDE_LABEL[side]}`, "row__crown") : el("span", "row__crown"),
    el("span", "row__name", SIDE_LABEL[side]),
  );
  const model = el("span", "model-tag row__model");
  renderModelTag(model, resolveModel(bout.configs[side]));
  cell.append(model);
  return cell;
}

/** Entre los dos lados: "vs", o el ícono de cómo terminó cuando nadie ganó. */
function rowMiddle(bout: Bout): HTMLElement {
  if (bout.live) return el("span", "row__mid row__mid--live", "En vivo");
  // Una serie muestra su marcador: rondas de Rojo y de Azul.
  if (bout.series) {
    const t = seriesTally(bout.series, bout.settings);
    const score = el("span", "row__mid row__score", `${t.red}-${t.blue}`);
    score.dataset.tip = `Serie por ${t.unit === "puntos" ? "puntos" : "rondas"}: Rojo ${t.red}, Azul ${t.blue}`;
    return score;
  }
  const result = bout.result;
  if (!result || result.winner) return el("span", "row__mid", "vs");
  const icon: IconName = result.reason === "draw" ? "tie" : result.reason === "stopped" ? "halt" : "alert";
  return rowIcon(icon, `${headline(bout)}. ${resultDetail(result)}`, "row__mid");
}

/** Todo lo que se sabe de la pelea, en una frase: va dentro, al abrirla. */
function factsLine(bout: Bout): string {
  const facts = [`${headline(bout)}.`];
  if (bout.result && !bout.live) facts.push(resultDetail(bout.result));
  if (bout.series) {
    const t = seriesTally(bout.series, bout.settings);
    facts.push(`Serie de hasta ${bout.series.maxRounds} rondas: Rojo ${t.red}, Azul ${t.blue}${t.unit === "puntos" ? " en puntos" : ""}.`);
  }
  if (bout.durationMs !== null) facts.push(`Duró ${formatDuration(bout.durationMs)}.`);
  facts.push(`${COMMS_LABELS[bout.settings.comms].name}.`);
  facts.push(bout.settings.timer ? "Con límite de tiempo." : "Sin límite de tiempo.");
  return facts.join(" ");
}

/**
 * Una pelea en una sola fila: quién contra quién, quién ganó (corona y color lleno) y, en
 * íconos, lo marcado y los ajustes. Al abrirla aparecen los datos escritos, el prompt de
 * cada lado, su marca y los botones.
 */
function boutNode(bout: Bout): HTMLElement {
  const node = el("li", "bout");
  if (bout.live) node.classList.add("is-live");
  const fold = el("details", "bout__fold");
  // La pelea que tiene una marca a medio escribir se ve abierta.
  const drafting = draft !== null && draft.key.startsWith(`${bout.id}:`);
  fold.open = openBouts.has(bout.id) || drafting;
  fold.addEventListener("toggle", () => {
    if (fold.open) openBouts.add(bout.id);
    else openBouts.delete(bout.id);
  });

  const head = el("summary", "row");
  // Los íconos no se leen: la frase completa va para lectores de pantalla.
  head.append(el("span", "sr-only", factsLine(bout)), rowSide(bout, "red"), rowMiddle(bout), rowSide(bout, "blue"));

  // Tres columnas fijas (íconos, duración y hora), existan o no: todo queda alineado entre filas.
  const meta = el("span", "row__meta");
  // Cada ícono tiene su casillero (marca de Rojo, marca de Azul, se hablaban, sin límite):
  // el que no aplica queda vacío, y el mismo ícono cae siempre en la misma columna.
  const icons = el("span", "row__icons");
  for (const side of SIDES) {
    const flag = bout.flags[side];
    if (!flag) {
      icons.append(el("span", "row__icon"));
      continue;
    }
    const tags = flag.tags.length > 0 ? flag.tags.join(", ") : "sin etiquetas";
    const mark = rowIcon("flag", `Prompt ${SIDE_LABEL[side]} marcado: ${tags}`, "row__icon row__flag");
    mark.dataset.side = side;
    icons.append(mark);
  }
  icons.append(
    bout.settings.comms !== "none"
      ? rowIcon("talk", COMMS_LABELS[bout.settings.comms].name, "row__icon")
      : el("span", "row__icon"),
    bout.settings.timer ? el("span", "row__icon") : rowIcon("endless", "Sin límite de tiempo", "row__icon"),
  );
  const length = el("span", "row__length", bout.durationMs !== null ? formatClock(bout.durationMs) : "");
  if (bout.durationMs !== null) length.dataset.tip = `Duró ${formatDuration(bout.durationMs)}`;
  meta.append(icons, length, el("time", "row__when", bout.live ? "" : formatDateTime(bout.at)));
  head.append(meta);
  fold.append(head);

  const body = el("div", "bout__body");
  body.append(el("p", "bout__facts", factsLine(bout)));
  if (bout.series && bout.series.rounds.length > 0) {
    const rounds = el("ol", "bout__rounds");
    for (const round of bout.series.rounds) {
      const item = el("li", undefined, `${roundTitle(round)}, en ${formatDuration(round.durationMs)}${round.reason === "surrender" ? " (el otro se rindió)" : ""}.`);
      rounds.append(item);
    }
    body.append(rounds);
  }
  if (bout.result?.explanation) body.append(el("p", "bout__why", bout.result.explanation));
  if (!MOCK) {
    const link = el("a", "bout__transcript", "Ver transcripción");
    link.href = transcriptHref(bout.id);
    link.target = "_blank";
    link.rel = "noopener";
    body.append(link);
  }
  const sides = el("div", "bout__sides");
  for (const side of SIDES) sides.append(sideCell(bout, side));
  body.append(sides);
  fold.append(body);
  node.append(fold);
  return node;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function filterButton(text: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const node = button(text, onClick, "filter");
  node.setAttribute("aria-pressed", String(pressed));
  return node;
}

function render(): void {
  if (!list || !filters || !summary || !count) return;

  // Lo que hay adentro, para decidir si vale la pena abrirlo.
  const total = buildBouts().length;
  count.textContent =
    total === 0
      ? "Todavía no hay peleas"
      : `${plural(total, "pelea", "peleas")}, ${plural(flags.length, "prompt marcado", "prompts marcados")}`;

  const tags = allTags();
  const nodes: HTMLElement[] = [
    filterButton("Todas las peleas", !onlyFlagged && activeTag === null, () => {
      onlyFlagged = false;
      activeTag = null;
      render();
    }),
  ];
  if (flagsAvailable) {
    nodes.push(
      filterButton("Solo marcados", onlyFlagged && activeTag === null, () => {
        onlyFlagged = true;
        activeTag = null;
        render();
      }),
    );
  }
  for (const tag of tags) {
    nodes.push(
      filterButton(tag, activeTag === tag, () => {
        activeTag = activeTag === tag ? null : tag;
        onlyFlagged = activeTag !== null;
        render();
      }),
    );
  }
  filters.replaceChildren(...nodes);

  summary.textContent = activeTag ? tagSummary(activeTag) : "";
  summary.hidden = activeTag === null;

  const tag = activeTag;
  const bouts = buildBouts().filter((bout) => {
    const marked = Object.values(bout.flags);
    if (tag !== null) return marked.some((flag) => flag.tags.includes(tag));
    return onlyFlagged ? marked.length > 0 : true;
  });

  if (bouts.length === 0) {
    const text = onlyFlagged
      ? "Ningún prompt marcado todavía. Usa «Marcar» en una pelea para guardarlo con etiquetas y una nota."
      : "Todavía no hay peleas guardadas. Inicia una y aparecerá aquí.";
    list.replaceChildren(el("li", "history__empty", text));
    return;
  }
  list.replaceChildren(...bouts.map(boutNode));
}

// ---------- Entradas del módulo ----------

export function initHistory(): void {
  list = byId("history-list");
  filters = byId("history-filters");
  summary = byId("history-summary");
  count = byId("history-count");

  const section = byId<HTMLDetailsElement>("history");
  try {
    section.open = window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Sin acceso al almacenamiento: parte plegado.
  }
  section.addEventListener("toggle", () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, section.open ? "1" : "0");
    } catch {
      // Solo no se recuerda la preferencia.
    }
  });
  // Los modelos "por defecto del servidor" recién se pueden nombrar cuando llegan los valores por defecto.
  onDefaultsChange(renderQuietly);
  render();
  void reload();
}

/** Con cada estado: la pelea en curso se puede marcar mientras ocurre. */
export function syncHistory(state: MatchState): void {
  const before = live ? `${live.id}:${live.phase}` : "";
  // Una pelea que recién parte se muestra abierta: es la que se está mirando.
  if (state.phase === "preparing" && live?.id !== state.id) openBouts.add(state.id);
  live = state;
  if (before !== `${state.id}:${state.phase}`) renderQuietly();
}

/** Terminó una pelea: entra al historial de inmediato; las marcas reciben su resultado poco después. */
export function addToHistory(record: MatchRecord): void {
  records = [record, ...records.filter((item) => item.id !== record.id)];
  renderQuietly();
  // El "por qué ganó" y el resultado de lo marcado a mitad de pelea llegan unos segundos después.
  window.setTimeout(() => void reload(), 12_000);
}
