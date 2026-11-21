import { COMMS_LABELS, CommsModeSchema, type CommsMode, type MatchSettings } from "@phack/protocol";
import { ApiError, describeError, fetchSettings, saveSettings } from "./api";
import { byId, setText } from "./dom";
import { showToast } from "./toast";

/**
 * Ajustes de la próxima pelea (hoy, solo el modo de comunicación entre agentes). Igual
 * que los prompts: cualquiera los cambia y valen desde la próxima pelea. Se guardan al
 * elegir; si otro visitante los cambia, llega por el websocket (evento "settings").
 */

let field: HTMLElement | null = null;
let select: HTMLSelectElement | null = null;
let description: HTMLElement | null = null;
let saving = false;
/** Último valor conocido del servidor (al que se vuelve si guardar falla). */
let remote: CommsMode | null = null;

function render(comms: CommsMode): void {
  if (!select || !description) return;
  if (select.value !== comms) select.value = comms;
  setText(description, COMMS_LABELS[comms].description);
}

/** Ajustes que llegan del servidor (carga inicial o websocket). */
export function applyRemoteSettings(settings: MatchSettings): void {
  remote = settings.comms;
  if (field) field.hidden = false;
  // Mientras se guarda, la respuesta propia es la que manda.
  if (!saving) render(settings.comms);
}

export async function loadSettings(): Promise<void> {
  try {
    applyRemoteSettings(await fetchSettings());
  } catch (err) {
    // Un orquestador anterior a los ajustes no tiene la ruta: el selector queda oculto.
    if (err instanceof ApiError && err.status === 404 && field) field.hidden = true;
  }
}

export function initSettings(): void {
  field = byId("comms-field");
  select = byId<HTMLSelectElement>("comms");
  description = byId("comms-description");
  const input = select;

  input.addEventListener("change", () => {
    const parsed = CommsModeSchema.safeParse(input.value);
    if (!parsed.success) return;
    const comms = parsed.data;
    render(comms);
    saving = true;
    input.disabled = true;
    saveSettings({ comms })
      .then((saved) => {
        remote = saved.comms;
        render(saved.comms);
      })
      .catch((err) => {
        showToast(`No se pudo guardar el modo de comunicación: ${describeError(err)}`);
        if (remote) render(remote);
      })
      .finally(() => {
        saving = false;
        input.disabled = false;
      });
  });
}
