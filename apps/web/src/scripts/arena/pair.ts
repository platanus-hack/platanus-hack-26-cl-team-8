/**
 * Panel de una pareja: todas sus partidas (calibración y liga), contadas desde el lado del
 * modelo de la fila: de qué color jugó, si ganó y con cuánta vida terminó cada uno. Los
 * intentos con fallo de infraestructura van aparte: no cuentan para el rating.
 */
import { MAX_HEALTH, type FrozenModel, type MatchAttempt, type MatrixCell, type Side } from "@phack/protocol";
import { el } from "../dom";
import { SIDE_LABEL, formatTime } from "../format";
import { MATCH_STAGE_LABEL, REASON_LABEL, formatDuration, formatPct } from "./format";
import { modelTag } from "./view";

type Names = Map<string, FrozenModel>;

function nameOf(models: Names, key: string): string {
  return models.get(key)?.name ?? key;
}

/** Solo el logo del modelo (el nombre queda para lectores de pantalla). */
function mark(models: Names, key: string): HTMLElement {
  const m = models.get(key);
  const tag = modelTag(m?.gatewayId ?? key, m?.name ?? key);
  tag.classList.add("model-tag--mark");
  return tag;
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
 * Resumen de la celda desde el punto de vista de la fila: "En la liga: 5 V · 1 E · 2 D en
 * 8 partidas (69 %)". Si no hay partidas válidas en la liga, lo dice.
 */
export function cellSummary(rowName: string, cell: MatrixCell | undefined): string {
  if (!cell || cell.score === null || cell.games === 0) {
    return `Sin partidas válidas en la liga todavía. Abajo, lo que hay, visto desde ${rowName}.`;
  }
  return (
    `En la liga: ${cell.wins} V · ${cell.draws} E · ${cell.losses} D para ${rowName} ` +
    `en ${cell.games} ${cell.games === 1 ? "partida" : "partidas"} (${formatPct(cell.score)}). ` +
    `Abajo, cada partida vista desde su lado.`
  );
}

const RESULT_LABEL = { win: "Victoria", draw: "Empate", loss: "Derrota" } as const;

function resultCell(a: MatchAttempt, row: string): HTMLElement {
  const td = el("td", "pair__result");
  if (!a.outcome) return td;
  const { winner, reason } = a.outcome;
  const result = winner === null ? "draw" : winner === row ? "win" : "loss";
  td.dataset.result = result;
  // Un K.O. dice cuándo fue; las que llegan al final duran siempre lo mismo.
  const how = reason === "kill" ? `${REASON_LABEL.kill} a los ${formatDuration(a.startedAt, a.endedAt)}` : REASON_LABEL[reason];
  td.append(el("span", "pair__outcome", RESULT_LABEL[result]), el("span", "pair__reason", how));
  return td;
}

/** Vida con que terminó un lado: logo del modelo, barra del color del lado y el número. */
function healthBar(models: Names, a: MatchAttempt, side: Side): HTMLElement {
  const stats = a.sides[side];
  const health = Math.max(0, Math.round(stats.health));
  const line = el("span", "hp");
  line.dataset.side = side;
  const track = el("span", "hp__bar");
  const fill = el("i");
  fill.style.width = `${Math.min(100, (health / MAX_HEALTH) * 100)}%`;
  track.append(fill);
  line.append(mark(models, stats.model), track, el("span", "hp__num", String(health)));
  line.setAttribute("aria-label", `${nameOf(models, stats.model)}, ${SIDE_LABEL[side]}: ${health} de vida`);
  line.setAttribute("role", "img");
  return line;
}

function validTable(models: Names, attempts: MatchAttempt[], row: string): HTMLElement {
  const table = el("table", "board pair__table");
  const head = el("tr");
  for (const label of ["Partida", "Resultado", "Vida al final"]) {
    const th = el("th", "", label);
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

    // Lado en que partió el modelo de la fila; su barra de vida va primero.
    const mine: Side = a.spec.red === row ? "red" : "blue";
    const rival: Side = mine === "red" ? "blue" : "red";

    const match = el("td", "pair__match");
    const where = el("span", "pair__seed", `semilla ${a.spec.seed} · `);
    const side = el("span", "pair__sideword", `de ${SIDE_LABEL[mine]}`);
    side.dataset.side = mine;
    where.append(side);
    match.append(el("span", "", MATCH_STAGE_LABEL[a.spec.stage]), where);
    if (duplicate) match.append(el("span", "pair__dup", "Repetida, no cuenta"));
    match.dataset.tip =
      `Escenario ${a.spec.scenario}, ${a.spec.leg === "ida" ? "ida" : "vuelta"}: cada cruce se juega dos veces con ` +
      `la misma semilla, cambiando los lados.`;

    const health = el("td", "pair__hp");
    health.append(healthBar(models, a, mine), healthBar(models, a, rival));

    tr.append(match, resultCell(a, row), health);
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
