import {
  COMMS_LABELS,
  CommsModeSchema,
  MAX_TIMER_SECONDS,
  MIN_TIMER_SECONDS,
  MODE_LABELS,
  MatchModeSchema,
  TIMER_LABELS,
  type MatchSettings,
  type UpdateSettingsBody,
} from "@phack/protocol";
import { ApiError, describeError, fetchSettings, saveSettings } from "./api";
import { byId, setText } from "./dom";
import { getDefaults, onDefaultsChange } from "./models";
import { showToast } from "./toast";

/**
 * Ajustes de la próxima pelea: el formato de la partida (una pelea o una serie por
 * rondas), el modo de comunicación entre agentes y el límite de tiempo. Igual que los prompts: cualquiera los cambia y valen desde la próxima pelea. Se
 * guardan al elegir; si otro visitante los cambia, llega por el websocket (evento "settings").
 */

type Elements = {
  field: HTMLElement;
  mode: HTMLSelectElement;
  modeDescription: HTMLElement;
  comms: HTMLSelectElement;
  commsDescription: HTMLElement;
  timer: HTMLInputElement;
  timerState: HTMLElement;
  timerDescription: HTMLElement;
  /** Cantidad y unidad de la duración (solo se ven con el límite encendido). */
  duration: HTMLElement;
  amount: HTMLInputElement;
  unit: HTMLSelectElement;
};

/** Lo que dura una pelea si nadie eligió otra cosa y el servidor aún no dice la suya. */
const FALLBACK_SECONDS = 180;
const HOUR = 3600;
const MINUTE = 60;

/** La duración que vale: la elegida o, sin elegir, la del servidor. */
function effectiveSeconds(settings: MatchSettings): number {
  return settings.timerSeconds ?? getDefaults()?.matchDurationSeconds ?? FALLBACK_SECONDS;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 minutos", "2 horas", "1 hora y 30 minutos". */
function spokenDuration(seconds: number): string {
  const hours = Math.floor(seconds / HOUR);
  const minutes = Math.round((seconds % HOUR) / MINUTE);
  const parts: string[] = [];
  if (hours > 0) parts.push(plural(hours, "hora", "horas"));
  if (minutes > 0 || hours === 0) parts.push(plural(minutes, "minuto", "minutos"));
  return parts.join(" y ");
}

/** Lo que muestran los dos campos: horas si son horas justas, si no minutos. */
function durationFields(seconds: number): { amount: string; unit: string } {
  if (seconds % HOUR === 0) return { amount: String(seconds / HOUR), unit: String(HOUR) };
  return { amount: String(Math.round((seconds / MINUTE) * 10) / 10), unit: String(MINUTE) };
}

let els: Elements | null = null;
let saving = false;
/** Último valor conocido del servidor (al que se vuelve si guardar falla). */
let remote: MatchSettings | null = null;

function render(settings: MatchSettings): void {
  if (!els) return;
  if (els.mode.value !== settings.mode) els.mode.value = settings.mode;
  setText(els.modeDescription, MODE_LABELS[settings.mode].description);
  if (els.comms.value !== settings.comms) els.comms.value = settings.comms;
  setText(els.commsDescription, COMMS_LABELS[settings.comms].description);
  els.timer.checked = settings.timer;
  setText(els.timerState, settings.timer ? "Encendido" : "Apagado");
  els.duration.hidden = !settings.timer;
  const seconds = effectiveSeconds(settings);
  // Mientras alguien escribe la cantidad no se le cambia lo que lleva.
  if (document.activeElement !== els.amount) {
    const fields = durationFields(seconds);
    if (els.amount.value !== fields.amount) els.amount.value = fields.amount;
    if (els.unit.value !== fields.unit) els.unit.value = fields.unit;
  }
  const what = settings.mode === "rounds" ? "Cada ronda dura" : "La pelea dura";
  setText(
    els.timerDescription,
    settings.timer ? `${what} ${spokenDuration(seconds)}. ${TIMER_LABELS.on}` : TIMER_LABELS.off,
  );
}

/** Ajustes que llegan del servidor (carga inicial o websocket). */
export function applyRemoteSettings(settings: MatchSettings): void {
  remote = settings;
  if (els) els.field.hidden = false;
  // Mientras se guarda, la respuesta propia es la que manda.
  if (!saving) render(settings);
}

export async function loadSettings(): Promise<void> {
  try {
    applyRemoteSettings(await fetchSettings());
  } catch (err) {
    // Un orquestador anterior a los ajustes no tiene la ruta: los controles quedan ocultos.
    if (err instanceof ApiError && err.status === 404 && els) els.field.hidden = true;
  }
}

/** Guarda un cambio; mientras tanto la página muestra lo elegido y, si falla, vuelve a lo del servidor. */
function save(change: UpdateSettingsBody, what: string): void {
  if (!els) return;
  const { mode, comms, timer, amount, unit } = els;
  if (remote) render({ ...remote, ...change } as MatchSettings);
  saving = true;
  for (const control of [mode, comms, timer, amount, unit]) control.disabled = true;
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
      for (const control of [mode, comms, timer, amount, unit]) control.disabled = false;
    });
}

export function initSettings(): void {
  els = {
    field: byId("settings-field"),
    mode: byId<HTMLSelectElement>("mode"),
    modeDescription: byId("mode-description"),
    comms: byId<HTMLSelectElement>("comms"),
    commsDescription: byId("comms-description"),
    timer: byId<HTMLInputElement>("timer"),
    timerState: byId("timer-state"),
    timerDescription: byId("timer-description"),
    duration: byId("timer-duration"),
    amount: byId<HTMLInputElement>("timer-amount"),
    unit: byId<HTMLSelectElement>("timer-unit"),
  };
  const { mode, comms, timer, amount, unit } = els;

  // La duración por defecto la dice el servidor: al llegar, se vuelve a dibujar.
  onDefaultsChange(() => {
    if (remote && !saving) render(remote);
  });

  /** Guarda la cantidad y unidad escritas, llevadas al rango que acepta el servidor. */
  const saveDuration = (): void => {
    const typed = Number(amount.value.replace(",", "."));
    if (!Number.isFinite(typed) || typed <= 0) {
      // Vacío o sin sentido: vuelve a lo que estaba.
      amount.blur();
      if (remote) render(remote);
      return;
    }
    const seconds = Math.min(MAX_TIMER_SECONDS, Math.max(MIN_TIMER_SECONDS, Math.round(typed * Number(unit.value))));
    amount.blur();
    save({ timerSeconds: seconds }, "la duración");
  };
  amount.addEventListener("change", saveDuration);
  unit.addEventListener("change", saveDuration);

  mode.addEventListener("change", () => {
    const parsed = MatchModeSchema.safeParse(mode.value);
    if (parsed.success) save({ mode: parsed.data }, "el formato de la partida");
  });
  comms.addEventListener("change", () => {
    const parsed = CommsModeSchema.safeParse(comms.value);
    if (parsed.success) save({ comms: parsed.data }, "el modo de comunicación");
  });
  timer.addEventListener("change", () => {
    save({ timer: timer.checked }, "el límite de tiempo");
  });
}
