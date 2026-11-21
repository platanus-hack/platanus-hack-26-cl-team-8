import {
  HORIZON_LABELS,
  HorizonSchema,
  MAX_ROUNDS,
  RuleIdSchema,
  SCENARIOS,
  SERIES_WIN_LABELS,
  ScenarioIdSchema,
  SeriesWinSchema,
  SIDES,
  seriesByPoints,
  type MatchSettings,
  type RuleId,
  type Side,
  type UpdatePromptBody,
  type UpdateSettingsBody,
} from "@phack/protocol";
import { describeError, fetchPrompts, savePrompt, saveSettings } from "./api";
import { byId, setText } from "./dom";
import { showToast } from "./toast";

/**
 * Ajustes de benchmark de la próxima partida: escenario, rondas, horizonte, cómo se gana
 * la serie, reponer el kit, juez y las reglas de cada lado. Viven junto a los demás
 * ajustes (settings.ts le pasa cada versión que llega del servidor) y se guardan al elegir.
 */

type Elements = {
  scenario: HTMLSelectElement;
  scenarioDescription: HTMLElement;
  scenarioHint: HTMLElement;
  seriesOptions: HTMLElement;
  rounds: HTMLInputElement;
  horizon: HTMLSelectElement;
  seriesWin: HTMLSelectElement;
  refillKit: HTMLInputElement;
  seriesDescription: HTMLElement;
  judge: HTMLInputElement;
  judgeState: HTMLElement;
  mirror: HTMLButtonElement;
  rules: Record<Side, HTMLElement>;
};

let els: Elements | null = null;
let saving = false;
let remote: MatchSettings | null = null;

function ruleBoxes(side: Side): HTMLInputElement[] {
  return els ? Array.from(els.rules[side].querySelectorAll<HTMLInputElement>("input[data-rule]")) : [];
}

function controls(): (HTMLInputElement | HTMLSelectElement)[] {
  if (!els) return [];
  return [els.scenario, els.rounds, els.horizon, els.seriesWin, els.refillKit, els.judge, ...SIDES.flatMap(ruleBoxes)];
}

function render(settings: MatchSettings): void {
  if (!els) return;
  const scenario = SCENARIOS[settings.scenario];
  if (els.scenario.value !== settings.scenario) els.scenario.value = settings.scenario;
  setText(els.scenarioDescription, `${scenario.description} Puntos: ${scenario.scoring}`);

  // Lo que el servidor va a forzar con este escenario (ver effectiveSettings en el orquestador).
  const hints: string[] = [];
  if (settings.scenario !== "duel" && settings.mode !== "rounds") hints.push("Se jugará por rondas.");
  if (settings.scenario === "injection" && settings.comms !== "chat") hints.push("Se jugará con chat: las órdenes falsas llegan por ahí.");
  else if (scenario.wantsChat && settings.comms !== "chat") hints.push("Recomendado: que los agentes puedan hablarse.");
  if (settings.scenario === "dilemma" && !settings.timer) hints.push("Se jugará con límite de tiempo.");
  setText(els.scenarioHint, hints.join(" "));
  els.scenarioHint.hidden = hints.length === 0;

  const series = settings.mode === "rounds" || settings.scenario !== "duel";
  els.seriesOptions.hidden = !series;
  if (document.activeElement !== els.rounds) els.rounds.value = String(settings.rounds);
  if (els.horizon.value !== settings.horizon) els.horizon.value = settings.horizon;
  if (els.seriesWin.value !== settings.seriesWin) els.seriesWin.value = settings.seriesWin;
  els.refillKit.checked = settings.refillKit;
  const byPoints = seriesByPoints(settings);
  setText(
    els.seriesDescription,
    `${settings.rounds} rondas. ${HORIZON_LABELS[settings.horizon]} ${SERIES_WIN_LABELS[settings.seriesWin].description}` +
      (settings.seriesWin === "auto" ? ` Con este escenario: por ${byPoints ? "puntos" : "rondas ganadas"}.` : "") +
      (settings.refillKit ? " El kit se repone en cada ronda." : " Lo gastado no vuelve en las rondas siguientes."),
  );

  els.judge.checked = settings.judge;
  setText(els.judgeState, settings.judge ? "Encendido" : "Apagado");
  for (const side of SIDES) {
    for (const box of ruleBoxes(side)) box.checked = settings.rules[side].includes(box.value as RuleId);
  }
}

/** Cada versión de los ajustes que llega del servidor (la pasa settings.ts). */
export function applyRemoteBenchSettings(settings: MatchSettings): void {
  remote = settings;
  if (!saving) render(settings);
}

function save(change: UpdateSettingsBody, what: string): void {
  if (remote) {
    const rules = change.rules ? { ...remote.rules, ...change.rules } : remote.rules;
    render({ ...remote, ...change, rules } as MatchSettings);
  }
  saving = true;
  for (const control of controls()) control.disabled = true;
  saveSettings(change)
    .then((saved) => {
      remote = saved;
      render(saved);
    })
    .catch((err) => {
      showToast(`No se pudo guardar ${what}: ${describeError(err)}`);
      if (remote) render(remote);
    })
    .finally(() => {
      saving = false;
      for (const control of controls()) control.disabled = false;
    });
}

/** Espejo: el prompt guardado de Rojo (texto, modelo y kit) pasa tal cual a Azul. */
async function mirrorRedToBlue(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const { red } = await fetchPrompts();
    const body: UpdatePromptBody = { prompt: red.prompt };
    if (red.kit) body.kit = red.kit;
    if (red.provider) body.provider = red.provider;
    if (red.model) body.model = red.model;
    await savePrompt("blue", body);
    showToast("Azul ahora tiene el mismo prompt, modelo y kit que Rojo.", "ok");
  } catch (err) {
    showToast(`No se pudo copiar el prompt: ${describeError(err)}`);
  } finally {
    button.disabled = false;
  }
}

export function initBenchSettings(): void {
  els = {
    scenario: byId<HTMLSelectElement>("scenario"),
    scenarioDescription: byId("scenario-description"),
    scenarioHint: byId("scenario-hint"),
    seriesOptions: byId("series-options"),
    rounds: byId<HTMLInputElement>("rounds"),
    horizon: byId<HTMLSelectElement>("horizon"),
    seriesWin: byId<HTMLSelectElement>("series-win"),
    refillKit: byId<HTMLInputElement>("refill-kit"),
    seriesDescription: byId("series-description"),
    judge: byId<HTMLInputElement>("judge"),
    judgeState: byId("judge-state"),
    mirror: byId<HTMLButtonElement>("btn-mirror"),
    rules: { red: byId("rules-red"), blue: byId("rules-blue") },
  };
  const { scenario, rounds, horizon, seriesWin, refillKit, judge, mirror } = els;
  scenario.addEventListener("change", () => {
    const parsed = ScenarioIdSchema.safeParse(scenario.value);
    if (parsed.success) save({ scenario: parsed.data }, "el escenario");
  });
  rounds.addEventListener("change", () => {
    const value = Math.round(Number(rounds.value));
    if (Number.isFinite(value)) save({ rounds: Math.min(MAX_ROUNDS, Math.max(2, value)) }, "las rondas");
  });
  horizon.addEventListener("change", () => {
    const parsed = HorizonSchema.safeParse(horizon.value);
    if (parsed.success) save({ horizon: parsed.data }, "el horizonte");
  });
  seriesWin.addEventListener("change", () => {
    const parsed = SeriesWinSchema.safeParse(seriesWin.value);
    if (parsed.success) save({ seriesWin: parsed.data }, "cómo se gana la serie");
  });
  refillKit.addEventListener("change", () => save({ refillKit: refillKit.checked }, "reponer el kit"));
  judge.addEventListener("change", () => save({ judge: judge.checked }, "el juez"));
  for (const side of SIDES) {
    els.rules[side].addEventListener("change", () => {
      const rules = ruleBoxes(side)
        .filter((box) => box.checked)
        .map((box) => RuleIdSchema.parse(box.value));
      save({ rules: { [side]: rules } }, "las reglas");
    });
  }
  mirror.addEventListener("click", () => void mirrorRedToBlue(mirror));
}
