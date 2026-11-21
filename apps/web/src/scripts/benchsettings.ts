import {
  PRESET_BASE_SETTINGS,
  RULE_LABELS,
  SCENARIOS,
  SERIES_WIN_LABELS,
  SIDES,
  type MatchSettings,
  type Side,
  type UpdatePromptBody,
} from "@phack/protocol";
import { describeError, fetchPrompts, savePrompt, saveSettings } from "./api";
import { byId, setText } from "./dom";
import { initPresetPicker } from "./presetpicker";
import { showToast } from "./toast";

/**
 * Lo de benchmark que queda a la vista en la página principal: el pre-ajuste, el juez,
 * una línea con el escenario activo (que no tiene control propio: lo fijan los
 * pre-ajustes) y los botones "Copiar del rojo / del azul" de cada editor. Los demás
 * ajustes de escenario (puntaje, horizonte, cómo se gana la serie, reponer el kit, reglas)
 * siguen existiendo, pero solo los cambian los pre-ajustes.
 */

type Elements = {
  judge: HTMLInputElement;
  judgeState: HTMLElement;
  active: HTMLElement;
  reset: HTMLButtonElement;
};

let els: Elements | null = null;
let saving = false;
let remote: MatchSettings | null = null;

/** ¿Quedó algún ajuste de escenario distinto de un duelo libre? */
function isPlainDuel(s: MatchSettings): boolean {
  const base = PRESET_BASE_SETTINGS;
  return (
    s.scenario === base.scenario &&
    s.horizon === base.horizon &&
    s.seriesWin === base.seriesWin &&
    s.refillKit === base.refillKit &&
    s.rules.red.length === 0 &&
    s.rules.blue.length === 0
  );
}

/** "Dilema del prisionero · horizonte desconocido · reglas de Rojo: …" */
function activeLine(s: MatchSettings): string {
  if (isPlainDuel(s)) return "Escenario: duelo libre (sin puntaje especial ni reglas). Lo que deben lograr lo dice cada prompt.";
  const parts = [SCENARIOS[s.scenario].name];
  if (s.horizon === "unknown") parts.push("horizonte desconocido");
  if (s.seriesWin !== "auto") parts.push(`gana la serie por ${SERIES_WIN_LABELS[s.seriesWin].name.toLowerCase()}`);
  if (s.refillKit) parts.push("el kit se repone en cada ronda");
  for (const side of SIDES) {
    const rules = s.rules[side];
    if (rules.length > 0) parts.push(`reglas de ${side === "red" ? "Rojo" : "Azul"}: ${rules.map((r) => RULE_LABELS[r].name.toLowerCase()).join(", ")}`);
  }
  return `Escenario activo (lo fijó un pre-ajuste, para medir): ${parts.join(" · ")}.`;
}

function render(settings: MatchSettings): void {
  if (!els) return;
  els.judge.checked = settings.judge;
  setText(els.judgeState, settings.judge ? "Encendido" : "Apagado");
  setText(els.active, activeLine(settings));
  els.reset.hidden = isPlainDuel(settings);
}

/** Cada versión de los ajustes que llega del servidor (la pasa settings.ts). */
export function applyRemoteBenchSettings(settings: MatchSettings): void {
  remote = settings;
  if (!saving) render(settings);
}

function save(change: Parameters<typeof saveSettings>[0], what: string, button: HTMLInputElement | HTMLButtonElement): void {
  saving = true;
  button.disabled = true;
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
      button.disabled = false;
    });
}

/** Espejo: el prompt guardado del otro lado (texto, modelo y kit) pasa tal cual a `side`. */
async function copyFrom(side: Side, button: HTMLButtonElement): Promise<void> {
  const from: Side = side === "red" ? "blue" : "red";
  button.disabled = true;
  try {
    const source = (await fetchPrompts())[from];
    const body: UpdatePromptBody = { prompt: source.prompt };
    if (source.kit) body.kit = source.kit;
    if (source.provider) body.provider = source.provider;
    if (source.model) body.model = source.model;
    await savePrompt(side, body);
    showToast(`${side === "red" ? "Rojo" : "Azul"} ahora tiene el mismo prompt, modelo y kit que ${from === "red" ? "Rojo" : "Azul"}.`, "ok");
  } catch (err) {
    showToast(`No se pudo copiar el prompt: ${describeError(err)}`);
  } finally {
    button.disabled = false;
  }
}

export function initBenchSettings(): void {
  initPresetPicker("main");
  els = {
    judge: byId<HTMLInputElement>("judge"),
    judgeState: byId("judge-state"),
    active: byId("preset-active"),
    reset: byId<HTMLButtonElement>("preset-reset"),
  };
  const { judge, reset } = els;
  judge.addEventListener("change", () => save({ judge: judge.checked }, "el juez", judge));
  reset.addEventListener("click", () => save({ ...PRESET_BASE_SETTINGS, rules: { red: [], blue: [] } }, "el escenario", reset));
  for (const side of SIDES) {
    const button = byId<HTMLButtonElement>(`copy-${side}`);
    button.addEventListener("click", () => void copyFrom(side, button));
  }
}
