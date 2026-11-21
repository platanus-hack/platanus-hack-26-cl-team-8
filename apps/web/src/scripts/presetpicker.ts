import { BENCH_PRESETS, COMMS_LABELS, SCENARIOS, SUITE_ALL, findPreset, type PresetsResponse, type SuiteStatus } from "@phack/protocol";
import { describeError, fetchPresets, runPreset, stopPresets } from "./api";
import { byId, el, setText } from "./dom";
import { showToast } from "./toast";

/**
 * Selector de pre-ajustes: cargar una configuración guardada (escenario, rondas, chat,
 * reglas, prompts y kits) o ejecutarla. "Todos" corre la batería completa, una partida
 * tras otra. Lo usan la página principal y el tablero, con sus propios ids (`prefix`).
 */

function describe(id: string): string {
  if (id === SUITE_ALL) {
    return `Corre los ${BENCH_PRESETS.length} pre-ajustes uno tras otro, cada uno cuando termina el anterior. Usa los modelos elegidos en cada lado.`;
  }
  const preset = findPreset(id);
  if (!preset) return "";
  const s = preset.settings;
  const rounds = s.rounds ?? 1;
  const parts = [
    s.scenario ? SCENARIOS[s.scenario].name : "Duelo",
    `${rounds} ${rounds === 1 ? "ronda" : "rondas"}`,
    s.comms ? COMMS_LABELS[s.comms].name.toLowerCase() : "",
    s.timerSeconds ? `${Math.round(s.timerSeconds / 60)} min por ronda` : "",
    s.horizon === "unknown" ? "horizonte desconocido" : "",
    preset.mirrorModel ? "Azul con el modelo de Rojo" : "",
  ].filter(Boolean);
  return `${preset.description} (${parts.join(" · ")}.) No cambia los modelos.`;
}

function suiteLine(suite: SuiteStatus): string {
  if (suite.queue.length === 0) return "";
  const current = findPreset(suite.queue[suite.index] ?? "")?.name ?? "";
  if (suite.running) return `Batería en curso: ${suite.index + 1} de ${suite.queue.length} (${current}).`;
  if (suite.stoppedReason) return `Batería ${suite.stoppedReason}, tras ${suite.done} ${suite.done === 1 ? "partida" : "partidas"}.`;
  return `Batería completa: ${suite.done} ${suite.done === 1 ? "partida" : "partidas"}.`;
}

export type PresetPicker = { refresh(): Promise<void> };

/**
 * Engancha el selector `${prefix}-preset` y sus botones `${prefix}-preset-load`,
 * `${prefix}-preset-run`, `${prefix}-preset-stop`, la descripción y el estado.
 * `onChange` se llama tras cargar o ejecutar (por ejemplo, para recargar el tablero).
 */
export function initPresetPicker(prefix: string, onChange?: () => void): PresetPicker {
  const select = byId<HTMLSelectElement>(`${prefix}-preset`);
  const description = byId(`${prefix}-preset-description`);
  const status = byId(`${prefix}-preset-status`);
  const load = byId<HTMLButtonElement>(`${prefix}-preset-load`);
  const run = byId<HTMLButtonElement>(`${prefix}-preset-run`);
  const stop = byId<HTMLButtonElement>(`${prefix}-preset-stop`);

  select.replaceChildren();
  for (const preset of BENCH_PRESETS) {
    const option = el("option", "", preset.name);
    option.value = preset.id;
    select.append(option);
  }
  const all = el("option", "", `Todos (batería de ${BENCH_PRESETS.length})`);
  all.value = SUITE_ALL;
  select.append(all);

  let poll: number | undefined;
  const render = (data: PresetsResponse | null): void => {
    setText(description, describe(select.value));
    const running = data?.suite.running ?? false;
    load.hidden = select.value === SUITE_ALL;
    load.disabled = running;
    run.disabled = running;
    stop.hidden = !running;
    const line = data ? suiteLine(data.suite) : "";
    setText(status, line);
    status.hidden = line === "";
    window.clearInterval(poll);
    // Mientras corre la batería se revisa cada tanto cómo va.
    if (running) poll = window.setInterval(() => void refresh(), 4000);
  };

  const refresh = async (): Promise<void> => {
    try {
      render(await fetchPresets());
    } catch {
      render(null);
    }
  };

  const act = async (button: HTMLButtonElement, call: () => Promise<PresetsResponse>, done: string): Promise<void> => {
    button.disabled = true;
    try {
      render(await call());
      showToast(done, "ok");
      onChange?.();
    } catch (err) {
      showToast(describeError(err));
      void refresh();
    } finally {
      button.disabled = false;
    }
  };

  select.addEventListener("change", () => render(null));
  load.addEventListener("click", () => {
    const name = findPreset(select.value)?.name ?? select.value;
    void act(load, () => runPreset(select.value, false), `Pre-ajuste cargado: ${name}. Revisa los prompts y ajustes, y empieza cuando quieras.`);
  });
  run.addEventListener("click", () => {
    const what = select.value === SUITE_ALL ? "Batería en marcha" : `Ejecutando: ${findPreset(select.value)?.name ?? select.value}`;
    void act(run, () => runPreset(select.value, true), what);
  });
  stop.addEventListener("click", () => {
    void act(stop, stopPresets, "Batería detenida: la partida en curso termina igual, pero no empieza otra.");
  });

  render(null);
  void refresh();
  return { refresh };
}
