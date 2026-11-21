import {
  MAX_ROUNDS,
  COMMS_LABELS,
  CommsModeSchema,
  MAX_TIMER_SECONDS,
  MIN_TIMER_SECONDS,
  TIMER_LABELS,
  VOICE_LABELS,
  type MatchSettings,
  type UpdateSettingsBody,
} from "@phack/protocol";
import { ApiError, describeError, fetchSettings, saveSettings } from "./api";
import { byId, setText } from "./dom";
import { getDefaults, onDefaultsChange } from "./models";
import { isSoundOn, onSoundChange, setVoiceHint } from "./sound";
import { applyRemoteBenchSettings, initBenchSettings } from "./benchsettings";
import { showToast } from "./toast";

/**
 * Ajustes de la próxima pelea: el formato de la partida (una pelea o una serie por
 * rondas), el modo de comunicación entre agentes, el límite de tiempo y la voz de los
 * agentes. Igual que los prompts: cualquiera los cambia y valen desde la próxima pelea. Se
 * guardan al elegir; si otro visitante los cambia, llega por el websocket (evento "settings").
 */

type Elements = {
  field: HTMLElement;
  /** Rondas: 1 = una pelea suelta, más = una serie (el formato sale de aquí). */
  rounds: HTMLInputElement;
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
  voice: HTMLInputElement;
  voiceState: HTMLElement;
  voiceDescription: HTMLElement;
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

/** El servidor dijo que no tiene voz configurada. Sin saberlo todavía, se deja usar. */
function voiceUnavailable(): boolean {
  return getDefaults()?.voice.available === false;
}

/** La línea de ayuda de la voz: qué hace y, si está encendida, qué falta para oírla. */
function voiceLine(settings: MatchSettings): string {
  if (voiceUnavailable()) return VOICE_LABELS.unavailable;
  if (!settings.voice) return VOICE_LABELS.off;
  const parts: string[] = [VOICE_LABELS.on];
  // Sin el modo "chat" los agentes no se mandan mensajes: no hay nada que decir.
  if (settings.comms !== "chat") parts.push(`Solo suena con "${COMMS_LABELS.chat.name}": en los otros modos no se hablan.`);
  if (!isSoundOn()) parts.push("Para oírla, enciende el sonido con el botón de arriba.");
  return parts.join(" ");
}

let els: Elements | null = null;
let saving = false;
/** Último valor conocido del servidor (al que se vuelve si guardar falla). */
let remote: MatchSettings | null = null;

function render(settings: MatchSettings): void {
  if (!els) return;
  // Mientras alguien escribe el número no se le cambia lo que lleva.
  if (document.activeElement !== els.rounds && els.rounds.value !== String(settings.rounds)) els.rounds.value = String(settings.rounds);
  setText(
    els.modeDescription,
    settings.rounds > 1
      ? `Serie de ${settings.rounds} rondas: cada agente sabe cómo va y puede rendirse en una ronda.`
      : "Una pelea suelta. Con 2 o más, una serie: cada agente sabe cómo va y puede rendirse en una ronda.",
  );
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
  const what = settings.rounds > 1 ? "Cada ronda dura" : "La pelea dura";
  setText(
    els.timerDescription,
    settings.timer ? `${what} ${spokenDuration(seconds)}. ${TIMER_LABELS.on}` : TIMER_LABELS.off,
  );

  const unavailable = voiceUnavailable();
  els.voice.checked = settings.voice && !unavailable;
  if (!saving) els.voice.disabled = unavailable;
  setText(els.voiceState, unavailable ? "No disponible" : settings.voice ? "Encendido" : "Apagado");
  setText(els.voiceDescription, voiceLine(settings));
  setVoiceHint(settings.voice && !unavailable);
}

/** Bloquea los controles mientras se guarda; la voz sigue bloqueada si el servidor no la tiene. */
function lockControls(locked: boolean): void {
  if (!els) return;
  const { rounds, comms, timer, amount, unit, voice } = els;
  for (const control of [rounds, comms, timer, amount, unit]) control.disabled = locked;
  voice.disabled = locked || voiceUnavailable();
}

/** Ajustes que llegan del servidor (carga inicial o websocket). */
export function applyRemoteSettings(settings: MatchSettings): void {
  applyRemoteBenchSettings(settings);
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
  if (remote) render({ ...remote, ...change } as MatchSettings);
  saving = true;
  lockControls(true);
  saveSettings(change)
    .then((saved) => {
      remote = saved;
      render(saved);
      applyRemoteBenchSettings(saved);
    })
    .catch((err) => {
      showToast(`No se pudo guardar ${what}: ${describeError(err)}`);
      if (remote) render(remote);
    })
    .finally(() => {
      saving = false;
      lockControls(false);
    });
}

export function initSettings(): void {
  initBenchSettings();
  els = {
    field: byId("settings-field"),
    rounds: byId<HTMLInputElement>("rounds-count"),
    modeDescription: byId("mode-description"),
    comms: byId<HTMLSelectElement>("comms"),
    commsDescription: byId("comms-description"),
    timer: byId<HTMLInputElement>("timer"),
    timerState: byId("timer-state"),
    timerDescription: byId("timer-description"),
    duration: byId("timer-duration"),
    amount: byId<HTMLInputElement>("timer-amount"),
    unit: byId<HTMLSelectElement>("timer-unit"),
    voice: byId<HTMLInputElement>("voice"),
    voiceState: byId("voice-state"),
    voiceDescription: byId("voice-description"),
  };
  const { rounds, comms, timer, amount, unit, voice } = els;

  // La duración por defecto y si hay voz los dice el servidor: al llegar, se vuelve a dibujar.
  onDefaultsChange(() => {
    if (remote && !saving) render(remote);
  });
  // La ayuda de la voz dice si falta encender el sonido de la página.
  onSoundChange(() => {
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

  rounds.addEventListener("change", () => {
    const value = Math.round(Number(rounds.value));
    if (!Number.isFinite(value) || value < 1) {
      if (remote) render(remote);
      return;
    }
    save({ rounds: Math.min(MAX_ROUNDS, value) }, "las rondas");
  });
  comms.addEventListener("change", () => {
    const parsed = CommsModeSchema.safeParse(comms.value);
    if (parsed.success) save({ comms: parsed.data }, "el modo de comunicación");
  });
  timer.addEventListener("change", () => {
    save({ timer: timer.checked }, "el límite de tiempo");
  });
  voice.addEventListener("change", () => {
    save({ voice: voice.checked }, "la voz de los agentes");
  });
}
