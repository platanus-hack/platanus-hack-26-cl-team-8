/**
 * Panel de una pareja: todas sus partidas (calibración y liga), con lados, resultado y
 * motivo. Los intentos con fallo de infraestructura van aparte: no cuentan para el rating.
 */
import type { FrozenModel, MatchAttempt, MatrixCell } from "@phack/protocol";
import { el } from "../dom";
import { formatTime } from "../format";
import { MATCH_STAGE_LABEL, REASON_LABEL, formatDuration, formatPct } from "./format";
import { modelTag } from "./view";

type Names = Map<string, FrozenModel>;

function nameOf(models: Names, key: string): string {
  return models.get(key)?.name ?? key;
}

function who(models: Names, key: string): HTMLElement {
  const m = models.get(key);
  return modelTag(m?.gatewayId ?? key, m?.name ?? key);
}

/** Orden estable: etapa, semilla, ronda, id, intento. */
function byOrder(x: MatchAttempt, y: MatchAttempt): number {
  const stage = (a: MatchAttempt) => (a.spec.stage === "calibration" ? 0 : 1);
  return (
    stage(x) - stage(y) ||
    x.spec.seed - y.spec.seed ||
    x.spec.round - y.spec.round ||
    (x.matchId < y.matchId ? -1 : x.matchId > y.matchId ? 1 : 0) ||
    x.attempt - y.attempt
  );
}

/**
 * Resumen de la celda desde el punto de vista de la fila: "Liga: 5 V · 1 E · 2 D (69 %)".
 * Si no hay partidas válidas en la liga, lo dice.
 */
export function cellSummary(rowName: string, cell: MatrixCell | undefined): string {
  if (!cell || cell.score === null || cell.games === 0) return `Sin partidas válidas en la liga todavía.`;
  return (
    `Liga, para ${rowName}: ${cell.wins} V · ${cell.draws} E · ${cell.losses} D ` +
    `en ${cell.games} ${cell.games === 1 ? "partida" : "partidas"} (${formatPct(cell.score)}).`
  );
}

function resultCell(models: Names, a: MatchAttempt, row: string): HTMLElement {
  const td = el("td", "pair__result");
  if (!a.outcome) return td;
  const { winner, reason } = a.outcome;
  const label = el("span", "pair__outcome", winner === null ? "Empate" : `Gana ${nameOf(models, winner)}`);
  label.dataset.result = winner === null ? "draw" : winner === row ? "win" : "loss";
  td.append(label, el("span", "pair__reason", REASON_LABEL[reason]));
  return td;
}

function validTable(models: Names, attempts: MatchAttempt[], row: string): HTMLElement {
  const table = el("table", "board pair__table");
  const head = el("tr");
  for (const h of ["Etapa", "Escenario", "Semilla", "Lado", "Rojo", "Azul", "Resultado", "Vida", "Duración"]) {
    const th = el("th", "", h);
    th.scope = "col";
    head.append(th);
  }
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  const counted = new Set<string>();
  for (const a of attempts) {
    const tr = el("tr");
    // Por matchId solo cuenta el primer intento válido (los repetidos se muestran, marcados).
    const duplicate = counted.has(a.matchId);
    counted.add(a.matchId);
    if (duplicate) tr.classList.add("is-duplicate");

    const stage = el("td", "", MATCH_STAGE_LABEL[a.spec.stage]);
    if (duplicate) stage.append(el("span", "pair__dup", " (repetida, no cuenta)"));
    tr.append(stage, el("td", "mono", a.spec.scenario), el("td", "num", String(a.spec.seed)));
    tr.append(el("td", "", a.spec.leg === "ida" ? "Ida" : "Vuelta"));
    const red = el("td", "pair__side");
    red.dataset.side = "red";
    red.append(who(models, a.spec.red));
    const blue = el("td", "pair__side");
    blue.dataset.side = "blue";
    blue.append(who(models, a.spec.blue));
    tr.append(red, blue, resultCell(models, a, row));
    tr.append(el("td", "num", `${Math.round(a.sides.red.health)}–${Math.round(a.sides.blue.health)}`));
    tr.append(el("td", "num muted", formatDuration(a.startedAt, a.endedAt)));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

function infraList(models: Names, attempts: MatchAttempt[]): HTMLElement {
  const list = el("ol", "infra");
  for (const a of attempts) {
    const li = el("li", "infra__item");
    const what =
      `${MATCH_STAGE_LABEL[a.spec.stage]} · s${a.spec.seed} · ${a.spec.leg === "ida" ? "ida" : "vuelta"} · ` +
      `intento ${a.attempt} · ${nameOf(models, a.spec.red)} (rojo) vs ${nameOf(models, a.spec.blue)} (azul) · ${formatTime(a.startedAt)}`;
    li.append(el("span", "infra__what", what), el("span", "infra__error", a.error ?? "Fallo de infraestructura"));
    list.append(li);
  }
  return list;
}

/** Contenido del panel una vez que llegaron las partidas. */
export function renderPair(target: HTMLElement, models: Names, attempts: MatchAttempt[], row: string): void {
  target.replaceChildren();
  const sorted = [...attempts].sort(byOrder);
  const valid = sorted.filter((a) => a.status === "valid");
  const infra = sorted.filter((a) => a.status === "infra");

  if (valid.length === 0 && infra.length === 0) {
    target.append(el("p", "empty", "Esta pareja todavía no ha jugado ninguna partida."));
    return;
  }

  if (valid.length > 0) target.append(validTable(models, valid, row));
  else target.append(el("p", "empty", "Sin partidas válidas: solo intentos fallidos por infraestructura."));

  if (infra.length > 0) {
    const box = el("div", "infra__box");
    box.append(
      el("h4", "infra__title", `Fallos de infraestructura (${infra.length})`),
      el("p", "section__hint", "429, caídas o desconexiones: se reintentan y no entran al rating."),
      infraList(models, infra),
    );
    target.append(box);
  }
}
