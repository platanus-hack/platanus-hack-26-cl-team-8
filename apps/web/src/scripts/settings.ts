import { COMMS_LABELS, CommsModeSchema, TIMER_LABELS, type MatchSettings, type UpdateSettingsBody } from "@phack/protocol";
import { ApiError, describeError, fetchSettings, saveSettings } from "./api";
import { byId, setText } from "./dom";
import { showToast } from "./toast";

/**
 * Ajustes de la próxima pelea: el modo de comunicación entre agentes y el límite de
 * tiempo. Igual que los prompts: cualquiera los cambia y valen desde la próxima pelea. Se
 * guardan al elegir; si otro visitante los cambia, llega por el websocket (evento "settings").
 */

type Elements = {
  field: HTMLElement;
  comms: HTMLSelectElement;
  commsDescription: HTMLElement;
  timer: HTMLInputElement;
  timerState: HTMLElement;
  timerDescription: HTMLElement;
};

let els: Elements | null = null;
let saving = false;
/** Último valor conocido del servidor (al que se vuelve si guardar falla). */
let remote: MatchSettings | null = null;

function render(settings: MatchSettings): void {
  if (!els) return;
  if (els.comms.value !== settings.comms) els.comms.value = settings.comms;
  setText(els.commsDescription, COMMS_LABELS[settings.comms].description);
  els.timer.checked = settings.timer;
  setText(els.timerState, settings.timer ? "Encendido" : "Apagado");
  setText(els.timerDescription, settings.timer ? TIMER_LABELS.on : TIMER_LABELS.off);
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
  const { comms, timer } = els;
  if (remote) render({ ...remote, ...change } as MatchSettings);
  saving = true;
  comms.disabled = true;
  timer.disabled = true;
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
      comms.disabled = false;
      timer.disabled = false;
    });
}

export function initSettings(): void {
  els = {
    field: byId("settings-field"),
    comms: byId<HTMLSelectElement>("comms"),
    commsDescription: byId("comms-description"),
    timer: byId<HTMLInputElement>("timer"),
    timerState: byId("timer-state"),
    timerDescription: byId("timer-description"),
  };
  const { comms, timer } = els;

  comms.addEventListener("change", () => {
    const parsed = CommsModeSchema.safeParse(comms.value);
    if (parsed.success) save({ comms: parsed.data }, "el modo de comunicación");
  });
  timer.addEventListener("change", () => {
    save({ timer: timer.checked }, "el límite de tiempo");
  });
}
