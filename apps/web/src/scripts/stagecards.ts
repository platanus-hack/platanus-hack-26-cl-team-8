/**
 * Carteles del escenario, lo que se dibuja al centro del video fuera del combate:
 *
 *  - La presentación ("Rojo VS Azul"): una franja partida en los dos colores que entra
 *    desde los lados mientras se prepara la arena, con el modelo y el kit de cada lado y si
 *    ya está conectado. La cuenta regresiva (countdown.ts) cae en el cuadro del centro, en
 *    lugar del "VS"; cuando parte la pelea, cada mitad se va por su lado.
 *  - La comparación de los dos lados que acompaña al resultado final (vida, daño,
 *    decisiones…) y el marcador de la serie en la tarjeta de ronda.
 *  - Lo que falta para la ronda siguiente, en la pausa entre rondas.
 *
 * El cartel de resultado en sí (quién ganó y por qué) lo llena scoreboard.ts; aquí están
 * las partes que necesitan más que un texto. Cómo entra y sale cada cosa lo decide global.css.
 */
import { DEFAULT_SETTINGS, SIDES, kitOf, seriesTally, type MatchSettings, type MatchState, type Series, type Side } from "@phack/protocol";
import { byId, el, setText } from "./dom";
import { SIDE_LABEL, formatNumber } from "./format";
import { onDefaultsChange, renderModelTag, resolveModel } from "./models";
import { videoServerNow } from "./player";

// ---------- Presentación ----------

type VersusSide = { model: HTMLElement; kit: HTMLElement; ready: HTMLElement };

let versus: { root: HTMLElement; sides: Record<Side, VersusSide> } | null = null;
let lastState: MatchState | null = null;

function renderVersus(state: MatchState): void {
  if (!versus) return;
  // Está en pantalla mientras se prepara la pelea; sale cuando empieza (o si se cancela).
  versus.root.dataset.state = state.phase === "preparing" ? "in" : "out";
  if (state.phase !== "preparing") return;
  for (const side of SIDES) {
    const target = versus.sides[side];
    const config = state.configs[side];
    renderModelTag(target.model, resolveModel(config));
    setText(target.kit, `Kit ${kitOf(config).name}`);
    const ready = state.agents[side].connected;
    target.ready.dataset.ready = String(ready);
    setText(target.ready, ready ? "Listo" : "Conectando");
  }
}

// ---------- Comparación de los dos lados ----------

/** Una fila: el valor de Rojo, qué se compara y el valor de Azul. `best` destaca al que va mejor. */
export type TapeRow = { label: string; red: string; blue: string; best: Side | null };

const better = (red: number, blue: number, lowerWins = false): Side | null => {
  if (red === blue) return null;
  return red > blue !== lowerWins ? "red" : "blue";
};

/** Marcador de la serie: rondas ganadas, o puntos si la serie se decide por puntos. */
export function seriesRow(series: Pick<Series, "wins" | "points">, settings: Pick<MatchSettings, "seriesWin" | "scenario">): TapeRow {
  const tally = seriesTally(series, settings);
  return {
    label: tally.unit === "puntos" ? "Puntos de la serie" : "Rondas ganadas",
    red: formatNumber(tally.red),
    blue: formatNumber(tally.blue),
    best: better(tally.red, tally.blue),
  };
}

/** Lo que se compara al terminar una partida, con los números de la última vez que se supo de cada agente. */
export function matchRows(state: MatchState): TapeRow[] {
  const { red, blue } = state.agents;
  const rows: TapeRow[] = [];
  if (state.series) rows.push(seriesRow(state.series, state.settings ?? DEFAULT_SETTINGS));
  rows.push({ label: "Vida al final", red: formatNumber(red.health), blue: formatNumber(blue.health), best: better(red.health, blue.health) });
  rows.push({ label: "Daño hecho", red: formatNumber(red.damageDealt), blue: formatNumber(blue.damageDealt), best: better(red.damageDealt, blue.damageDealt) });
  rows.push({ label: "Decisiones", red: String(red.decisions), blue: String(blue.decisions), best: null });
  if (red.avgDecisionMs > 0 && blue.avgDecisionMs > 0) {
    const seconds = (ms: number): string => `${formatNumber(ms / 1000)} s`;
    rows.push({
      label: "Tiempo por decisión",
      red: seconds(red.avgDecisionMs),
      blue: seconds(blue.avgDecisionMs),
      best: better(red.avgDecisionMs, blue.avgDecisionMs, true),
    });
  }
  return rows;
}

/** Dibuja la comparación en `holder`; sin filas la esconde. `head` agrega el nombre de cada lado arriba. */
export function renderTape(holder: HTMLElement, rows: TapeRow[], head = true): void {
  const key = `${head}|${rows.map((r) => `${r.label}:${r.red}:${r.blue}:${r.best ?? ""}`).join("|")}`;
  holder.hidden = rows.length === 0;
  // Los estados llegan varias veces por segundo: solo se redibuja si algo cambió, así la
  // animación de entrada no parte de nuevo.
  if (holder.dataset.key === key) return;
  holder.dataset.key = key;
  const cells: HTMLElement[] = [];
  if (head) {
    cells.push(el("span", "tape__side tape__side--red", SIDE_LABEL.red), el("span"), el("span", "tape__side tape__side--blue", SIDE_LABEL.blue));
  }
  rows.forEach((row, index) => {
    const delay = `${index * 60}ms`;
    for (const side of SIDES) {
      const value = el("span", `tape__value tape__value--${side}`, row[side]);
      if (row.best === side) value.classList.add("is-best");
      value.style.setProperty("--delay", delay);
      // El orden en la fila es: Rojo, qué se compara, Azul.
      if (side === "blue") {
        const label = el("span", "tape__label", row.label);
        label.style.setProperty("--delay", delay);
        cells.push(label);
      }
      cells.push(value);
    }
  });
  holder.replaceChildren(...cells);
}

// ---------- Lo que falta para la ronda siguiente ----------

let next: { root: HTMLElement; text: HTMLElement; bar: HTMLElement } | null = null;
/** Hora en que termina la pausa y cuánto duraba cuando se supo de ella. */
let pause: { endsAt: number; total: number } | null = null;

function renderNext(): void {
  if (!next) return;
  const state = lastState;
  const endsAt = state && state.phase === "intermission" ? state.countdownEndsAt : null;
  if (!state || endsAt === null || !state.series) {
    pause = null;
    next.root.hidden = true;
    return;
  }
  const remaining = Math.max(0, endsAt - videoServerNow());
  if (!pause || pause.endsAt !== endsAt) pause = { endsAt, total: Math.max(remaining, 1) };
  setText(next.text, `Ronda ${state.series.round} en ${Math.ceil(remaining / 1000)} s`);
  next.bar.style.transform = `scaleX(${Math.min(1, remaining / pause.total).toFixed(3)})`;
  next.root.hidden = false;
}

// ---------- Entradas del módulo ----------

export function initStageCards(): void {
  const versusSide = (side: Side): VersusSide => ({
    model: byId(`versus-model-${side}`),
    kit: byId(`versus-kit-${side}`),
    ready: byId(`versus-ready-${side}`),
  });
  versus = { root: byId("versus"), sides: { red: versusSide("red"), blue: versusSide("blue") } };
  next = { root: byId("winner-next"), text: byId("winner-next-text"), bar: byId("winner-next-bar") };
  window.setInterval(renderNext, 200);
  // El nombre del modelo por defecto llega con los datos del servidor.
  onDefaultsChange(() => {
    if (lastState) renderVersus(lastState);
  });
}

/** Con cada estado de la pelea. */
export function updateStageCards(state: MatchState): void {
  lastState = state;
  renderVersus(state);
  renderNext();
}
