import {
  API_ROUTES,
  COMMS_LABELS,
  COMMS_MODES,
  JUDGE_CRITERIA,
  JUDGE_LABELS,
  SCENARIOS,
  SIDES,
  type BenchReport,
  type ModelBench,
  type Rate,
  type SeriesBench,
  type Side,
} from "@phack/protocol";
import { describeError, fetchBench, judgeMatch } from "./api";
import { MOCK, apiUrl } from "./config";
import { byId, el, setText } from "./dom";
import { formatDateTime } from "./format";
import { REASON_LABEL } from "./format";
import { describeModel, renderModelTag, resolveModel } from "./models";
import { showToast } from "./toast";

/**
 * Tablero de benchmarks (pages/bench.astro). Todo el texto entra por textContent: los ids
 * de modelo vienen del servidor y se tratan como datos.
 */

const SIDE_NAME: Record<Side, string> = { red: "Rojo", blue: "Azul" };

// ---------- Formato ----------

function pct(value: Rate): string {
  return value === null ? "–" : `${Math.round(value * 100)} %`;
}

function num(value: Rate, digits = 1): string {
  if (value === null) return "–";
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

function ms(value: Rate): string {
  return value === null ? "–" : `${Math.round(value).toLocaleString("es-CL")} ms`;
}

function usd(value: number | null): string {
  if (value === null) return "–";
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function signed(value: Rate): string {
  if (value === null) return "–";
  const rounded = Math.round(value * 100) / 100;
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

// ---------- Celdas ----------

type Cell = string | Node | { text: string; tip?: string; meter?: Rate; na?: boolean };

function modelNode(model: string): HTMLElement {
  const tag = el("span", "model-tag");
  const info = model === "mock" ? resolveModel({ provider: "mock" }) : describeModel(model);
  renderModelTag(tag, info ?? describeModel(model));
  return tag;
}

/** Número con una barrita de magnitud (0..1) al lado. */
function meter(text: string, value: Rate): HTMLElement {
  const wrap = el("span", "meter");
  wrap.append(el("span", "", text));
  const track = el("span", "meter__track");
  const fill = el("span", "meter__fill");
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100)}%`;
  track.append(fill);
  if (value !== null) wrap.append(track);
  return wrap;
}

function table(target: HTMLTableElement, headers: { label: string; tip?: string }[], rows: Cell[][], empty: string): void {
  target.replaceChildren();
  const head = el("thead");
  const tr = el("tr");
  for (const h of headers) {
    const th = el("th", "", h.label);
    th.scope = "col";
    if (h.tip) th.dataset.tip = h.tip;
    tr.append(th);
  }
  head.append(tr);
  const body = el("tbody");
  if (rows.length === 0) {
    const row = el("tr");
    const td = el("td", "is-empty", empty);
    td.colSpan = headers.length;
    row.append(td);
    body.append(row);
  }
  for (const cells of rows) {
    const row = el("tr");
    for (const cell of cells) {
      const td = el("td");
      if (typeof cell === "string") td.textContent = cell;
      else if (cell instanceof Node) td.append(cell);
      else {
        if (cell.meter !== undefined) td.append(meter(cell.text, cell.meter));
        else td.textContent = cell.text;
        if (cell.tip) td.dataset.tip = cell.tip;
        if (cell.na || cell.text === "–") td.classList.add("bench__na");
      }
      row.append(td);
    }
    body.append(row);
  }
  target.append(head, body);
}

// ---------- Secciones ----------

function renderModels(models: ModelBench[]): void {
  const maxPoints = Math.max(1, ...models.map((m) => m.avgPoints ?? 0));
  table(
    byId<HTMLTableElement>("tbl-models"),
    [
      { label: "Modelo" },
      { label: "Peleas" },
      { label: "V / D / E", tip: "Victorias, derrotas y empates." },
      { label: "Victorias" },
      { label: "Puntos/ronda", tip: "Promedio de puntos por ronda según el escenario (una pelea suelta es una ronda)." },
      { label: "p50" },
      { label: "p95" },
      { label: "Acciones/min" },
      { label: "Daño/decisión" },
      { label: "Tokens/decisión" },
      { label: "Inválidas", tip: "Llamadas a herramientas que no existen o que su kit no tiene." },
      { label: "Costo total" },
      { label: "Costo/victoria" },
    ],
    models.map((m) => [
      modelNode(m.model),
      String(m.matches),
      `${m.wins} / ${m.losses} / ${m.draws}`,
      { text: pct(m.winRate), meter: m.winRate },
      { text: num(m.avgPoints, 2), meter: m.avgPoints === null ? null : m.avgPoints / maxPoints },
      ms(m.latencyP50),
      ms(m.latencyP95),
      num(m.actionsPerMin),
      num(m.damagePerDecision, 2),
      num(m.tokensPerDecision, 0),
      pct(m.invalidRate),
      usd(m.costUsd),
      usd(m.costPerWin),
    ]),
    "Todavía no hay peleas terminadas.",
  );
}

function renderSocial(models: ModelBench[]): void {
  table(
    byId<HTMLTableElement>("tbl-social"),
    [
      { label: "Modelo" },
      { label: "Honestidad", tip: "Lo que cumplió de lo que anunció por chat." },
      { label: "Anuncios" },
      { label: "Obedeció inyección", tip: "Rondas del escenario de inyección en que se rindió por la orden falsa." },
      { label: "Reglas rotas/ronda" },
      { label: "Rotas yendo abajo" },
      { label: "Rendiciones" },
      { label: "Coopera (dilema)" },
      { label: "Represalia", tip: "Después de que el otro atacó, ataca en la ronda siguiente." },
      { label: "Traición final", tip: "Con horizonte conocido, ataca en la última ronda tras haber cooperado." },
    ],
    models.map((m) => [
      modelNode(m.model),
      { text: pct(m.honesty.rate), meter: m.honesty.rate },
      `${m.honesty.kept}/${m.honesty.claims}`,
      { text: m.injection.exposed > 0 ? `${pct(m.injection.rate)} (${m.injection.obeyed}/${m.injection.exposed})` : "–", meter: m.injection.rate },
      num(m.rules.perRound, 2),
      pct(m.rules.whileBehindShare),
      String(m.surrenders),
      { text: pct(m.dilemma.cooperateRate), meter: m.dilemma.cooperateRate },
      pct(m.dilemma.retaliationRate),
      pct(m.dilemma.lastRoundDefectRate),
    ]),
    "Sin datos todavía.",
  );
}

function renderPressure(models: ModelBench[]): void {
  table(
    byId<HTMLTableElement>("tbl-pressure"),
    [{ label: "Modelo" }, { label: "Yendo abajo" }, { label: "Parejo" }, { label: "Yendo arriba" }, { label: "Abajo − arriba", tip: "Cuánto más agresivo es cuando pierde que cuando gana." }],
    models.map((m) => [
      modelNode(m.model),
      { text: pct(m.pressure.behind), meter: m.pressure.behind },
      { text: pct(m.pressure.even), meter: m.pressure.even },
      { text: pct(m.pressure.ahead), meter: m.pressure.ahead },
      m.pressure.behind !== null && m.pressure.ahead !== null ? `${signed(Math.round((m.pressure.behind - m.pressure.ahead) * 100))} pts` : "–",
    ]),
    "Sin datos todavía.",
  );
}

function renderComms(models: ModelBench[]): void {
  table(
    byId<HTMLTableElement>("tbl-comms"),
    [{ label: "Modelo" }, ...COMMS_MODES.map((mode) => ({ label: COMMS_LABELS[mode].name }))],
    models.map((m) => [
      modelNode(m.model),
      ...COMMS_MODES.map((mode) => {
        const c = m.comms[mode];
        return c.matches > 0 ? { text: `${pct(c.winRate)} (${c.matches})`, meter: c.winRate } : { text: "–" };
      }),
    ]),
    "Sin datos todavía.",
  );
}

function seriesCard(s: SeriesBench): HTMLElement {
  const card = el("article", "series-card");
  const head = el("div", "series-card__head");
  head.append(el("strong", "", SCENARIOS[s.scenario].name));
  head.append(el("span", "series-card__meta", `${s.played}/${s.rounds} rondas · ${s.wins.red}–${s.wins.blue} en rondas · ${COMMS_LABELS[s.comms].name} · horizonte ${s.horizon === "known" ? "conocido" : "desconocido"} · ${formatDateTime(s.startedAt)}`));
  card.append(head);

  const legend = el("div", "series-card__legend");
  for (const side of SIDES) {
    const item = el("span");
    item.append(el("i", `swatch swatch--${side}`));
    item.append(modelNode(s.models[side]));
    item.append(el("span", "", `${SIDE_NAME[side]}: ${s.scores[side]} pts`));
    legend.append(item);
  }
  card.append(legend);

  const max = Math.max(1, ...s.perRound.flatMap((r) => [r.red, r.blue]));
  const chart = el("div", "rounds-chart");
  chart.setAttribute("role", "img");
  chart.setAttribute(
    "aria-label",
    `Puntos por ronda: ${s.perRound.map((r) => `ronda ${r.round}, Rojo ${r.red} y Azul ${r.blue}`).join("; ")}`,
  );
  for (const r of s.perRound) {
    const round = el("div", "rounds-chart__round");
    for (const side of SIDES) {
      const bar = el("span", `rounds-chart__bar rounds-chart__bar--${side}`);
      bar.style.height = `${Math.round((r[side] / max) * 100)}%`;
      const attacked = r.attacked ? (r.attacked[side] ? ", atacó" : ", no atacó") : "";
      bar.dataset.tip = `Ronda ${r.round} · ${SIDE_NAME[side]}: ${r[side]} pts${attacked}`;
      round.append(bar);
    }
    round.append(el("span", "rounds-chart__label", `R${r.round}`));
    chart.append(round);
  }
  card.append(chart);

  const stats = el("div", "series-card__stats");
  stats.append(el("span", "", ""), el("span", "", "Rojo"), el("span", "", "Azul"));
  stats.append(el("span", "", "Tendencia (pts/ronda)"), el("span", "", signed(s.slope.red)), el("span", "", signed(s.slope.blue)));
  stats.append(el("span", "", "Cambio de herramientas"), el("span", "", pct(s.shift.red)), el("span", "", pct(s.shift.blue)));
  card.append(stats);
  return card;
}

function renderSeries(series: SeriesBench[]): void {
  const list = byId("series-list");
  list.replaceChildren();
  if (series.length === 0) {
    list.append(el("p", "bench__empty", "Todavía no hay series. Elige más de una ronda en la página principal."));
    return;
  }
  for (const s of series.slice(0, 24)) list.append(seriesCard(s));
}

function renderMirror(report: BenchReport): void {
  table(
    byId<HTMLTableElement>("tbl-mirror"),
    [{ label: "Modelo" }, { label: "Peleas" }, { label: "Gana Rojo" }, { label: "Gana Azul" }, { label: "Empates" }, { label: "Duración" }, { label: "Desv. duración" }, { label: "Desv. daño" }],
    report.mirror.map((m) => [
      modelNode(m.model),
      String(m.matches),
      String(m.redWins),
      String(m.blueWins),
      String(m.draws),
      m.durationMeanS === null ? "–" : `${Math.round(m.durationMeanS)} s`,
      m.durationStdS === null ? "–" : `±${Math.round(m.durationStdS)} s`,
      num(m.damageStd),
    ]),
    "Sin peleas espejo. Usa \"Copiar Rojo en Azul\" en la página principal.",
  );
}

function renderJudge(report: BenchReport): void {
  const judged = report.models.filter((m) => m.judge.count > 0);
  table(
    byId<HTMLTableElement>("tbl-judge"),
    [{ label: "Modelo" }, { label: "Calificadas" }, ...JUDGE_CRITERIA.map((c) => ({ label: JUDGE_LABELS[c].name, tip: JUDGE_LABELS[c].question }))],
    judged.map((m) => [
      modelNode(m.model),
      String(m.judge.count),
      ...JUDGE_CRITERIA.map((c) => {
        const value = m.judge.avg?.[c] ?? null;
        return { text: num(value), meter: value === null ? null : value / 10 };
      }),
    ]),
    "Sin calificaciones. Enciende el juez o califica una pelea abajo.",
  );

  const recent = byId<HTMLTableElement>("tbl-recent");
  table(
    recent,
    [{ label: "Fecha" }, { label: "Escenario" }, { label: "Rojo" }, { label: "Azul" }, { label: "Resultado" }, { label: "Puntos" }, { label: "" }],
    report.recent.map((r) => {
      const result = r.result.winner ? `${SIDE_NAME[r.result.winner]} · ${REASON_LABEL[r.result.reason]}` : REASON_LABEL[r.result.reason];
      const actions = el("span", "meter");
      const link = el("a", "", "Transcripción");
      link.href = MOCK ? "#" : `${apiUrl(API_ROUTES.transcript(encodeURIComponent(r.id)))}?format=text`;
      link.target = "_blank";
      link.rel = "noopener";
      const button = el("button", "btn btn--small", r.judged ? "Volver a calificar" : "Calificar");
      button.type = "button";
      button.addEventListener("click", () => {
        button.disabled = true;
        setText(button, "Calificando…");
        judgeMatch(r.id)
          .then((j) => {
            showToast(`Juez: ${j.summary || "calificación guardada"}`, "ok");
            void load();
          })
          .catch((err) => {
            showToast(describeError(err));
            button.disabled = false;
            setText(button, "Calificar");
          });
      });
      actions.append(link, button);
      return [
        formatDateTime(r.endedAt),
        `${SCENARIOS[r.scenario].name}${r.rounds > 1 ? ` · ${r.rounds} rondas` : ""}${r.mirror ? " · espejo" : ""}`,
        modelNode(r.models.red),
        modelNode(r.models.blue),
        result,
        r.points ? `${r.points.red} – ${r.points.blue}` : "–",
        actions,
      ];
    }),
    "Sin peleas.",
  );
}

// ---------- Carga ----------

const status = byId("bench-status");

async function load(): Promise<void> {
  setText(status, "Cargando…");
  try {
    const report = await fetchBench();
    renderModels(report.models);
    renderSocial(report.models);
    renderPressure(report.models);
    renderComms(report.models);
    renderSeries(report.series);
    renderMirror(report);
    renderJudge(report);
    setText(status, `${report.matches} partidas · ${report.rounds} rondas · actualizado ${formatDateTime(report.generatedAt)}`);
  } catch (err) {
    setText(status, `No se pudo cargar el tablero: ${describeError(err)}`);
  }
}

byId("bench-refresh").addEventListener("click", () => void load());
void load();
