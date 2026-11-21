import {
  BENCH_PRESETS,
  COMMS_LABELS,
  SCENARIOS,
  SIDES,
  findPreset,
  kitOf,
  presetSettings,
  type BenchPreset,
  type MatchSettings,
  type PromptsResponse,
} from "@phack/protocol";
import { describeError, runPreset } from "./api";
import { byId, el, setText } from "./dom";
import { showToast } from "./toast";

/**
 * Selector de pre-ajustes. Elegir uno lo carga en el acto (ajustes, prompts y kits); el
 * selector muestra el pre-ajuste que coincide con lo guardado y, si se cambia cualquier
 * cosa que el pre-ajuste fija, vuelve solo a "Personalizado". No guarda estado propio:
 * lo deduce de los ajustes y prompts que llegan del servidor.
 */

let select: HTMLSelectElement | null = null;
let description: HTMLElement | null = null;
let settings: MatchSettings | null = null;
let prompts: PromptsResponse | null = null;
let loading = false;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** ¿Lo guardado es exactamente este pre-ajuste? (Los modelos y el juez no cuentan.) */
export function matchesPreset(preset: BenchPreset, s: MatchSettings, p: PromptsResponse): boolean {
  const fixed = presetSettings(preset) as Record<string, unknown>;
  const current = s as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(fixed)) {
    if (!same(current[key], value)) return false;
  }
  for (const side of SIDES) {
    if (p[side].prompt.trim() !== preset.prompts[side].prompt.trim()) return false;
    if (kitOf(p[side]).id !== preset.prompts[side].kit) return false;
  }
  return true;
}

function describe(preset: BenchPreset | undefined): string {
  if (!preset) return "Tu propia configuración. Elige un pre-ajuste para cargar uno de los casos de medición.";
  const s = preset.settings;
  const rounds = s.rounds ?? 1;
  const parts = [
    s.scenario ? SCENARIOS[s.scenario].name : "Duelo",
    `${rounds} ${rounds === 1 ? "ronda" : "rondas"}`,
    s.comms ? COMMS_LABELS[s.comms].name.toLowerCase() : "",
  ].filter(Boolean);
  return `${preset.description} (${parts.join(" · ")}.) Cambiar cualquier cosa lo vuelve "Personalizado".`;
}

function render(): void {
  if (!select || !description || loading) return;
  const current = settings && prompts ? BENCH_PRESETS.find((preset) => matchesPreset(preset, settings as MatchSettings, prompts as PromptsResponse)) : undefined;
  const value = current?.id ?? "";
  if (select.value !== value) select.value = value;
  setText(description, describe(current));
}

/** Ajustes que llegan del servidor (los pasa benchsettings.ts). */
export function notePresetSettings(next: MatchSettings): void {
  settings = next;
  render();
}

/** Prompts guardados que llegan del servidor (los pasa prompts.ts). */
export function notePresetPrompts(next: PromptsResponse): void {
  prompts = next;
  render();
}

export function initPresetPicker(): void {
  select = byId<HTMLSelectElement>("preset");
  description = byId("preset-description");
  for (const preset of BENCH_PRESETS) {
    const option = el("option", "", preset.name);
    option.value = preset.id;
    select.append(option);
  }
  const picker = select;
  picker.addEventListener("change", () => {
    const preset = findPreset(picker.value);
    // "Personalizado" no carga nada: deja lo que hay.
    if (!preset) {
      render();
      return;
    }
    loading = true;
    picker.disabled = true;
    runPreset(preset.id, false)
      .then(() => showToast(`Pre-ajuste cargado: ${preset.name}.`, "ok"))
      .catch((err) => showToast(`No se pudo cargar el pre-ajuste: ${describeError(err)}`))
      .finally(() => {
        loading = false;
        picker.disabled = false;
        render();
      });
  });
  render();
}
