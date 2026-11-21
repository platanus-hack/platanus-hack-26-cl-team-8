import {
  ARENAS,
  SelectableArenaScenarioIdSchema,
  type ArenaOption,
  type ArenaScenarioId,
  type MatchPhase,
  type MatchSettings,
  type MatchState,
} from "@phack/protocol";
import { describeError, saveSettings } from "./api";
import { byId, setText } from "./dom";
import { getDefaults, onDefaultsChange } from "./models";
import { showToast } from "./toast";

/**
 * Selector "Mapa", junto al botón de la pelea. Es un ajuste más de la próxima pelea
 * (MatchSettings.arena): se guarda al elegir, vale desde la próxima pelea y, si otro
 * visitante lo cambia, llega por el websocket con los demás ajustes. Con una pelea en
 * curso queda bloqueado y muestra el mapa en juego; el HUD muestra ese mapa al lado de la fase.
 */

let select: HTMLSelectElement | null = null;
let liveName: HTMLElement | null = null;
let phase: MatchPhase | null = null;
/** Mapa de la pelea en curso (o de la última), según el estado del servidor. */
let live: ArenaScenarioId | null = null;
/** Mapa guardado en los ajustes; null = el por defecto del servidor. */
let pending: ArenaScenarioId | null = null;
let saving = false;

const fighting = (p: MatchPhase | null): boolean => p === "preparing" || p === "running" || p === "intermission";

/** Mapas que ofrece el servidor (los de GET /api/defaults), con el por defecto primero. */
function options(): ArenaOption[] {
  return getDefaults()?.arenas ?? [];
}

function render(): void {
  if (!select) return;
  const list = options();
  if (select.options.length !== list.length || list.some((o, i) => select?.options[i]?.value !== o.id)) {
    select.replaceChildren(
      ...list.map((option) => {
        const el = document.createElement("option");
        el.value = option.id;
        el.textContent = option.name;
        return el;
      }),
    );
  }
  const active = fighting(phase);
  // Con pelea se ve (bloqueado) el mapa en juego; sin pelea, el elegido para la próxima.
  const shown = active && live ? live : (pending ?? getDefaults()?.arena ?? null);
  if (shown && list.some((o) => o.id === shown)) select.value = shown;
  select.disabled = saving || active || phase === null || list.length < 2;
  select.title = active ? "No se puede cambiar el mapa con una pelea en curso." : "Mapa de la próxima pelea.";
  if (liveName) {
    const name = live && (active || phase === "finished") ? ARENAS[live].name : "";
    setText(liveName, name);
    liveName.hidden = name === "";
  }
}

/** Ajustes del servidor (carga inicial o websocket): el mapa elegido para la próxima pelea. */
export function applyRemoteArena(settings: MatchSettings): void {
  if (saving) return;
  pending = settings.arena;
  render();
}

/** Estado de la pelea: fase y mapa en juego. */
export function setMatchArena(state: Pick<MatchState, "phase" | "arena">): void {
  phase = state.phase;
  live = state.arena;
  render();
}

export function initArenaPicker(): void {
  select = byId<HTMLSelectElement>("map-select");
  liveName = byId("map-name");
  onDefaultsChange(render);
  select.addEventListener("change", () => {
    if (!select || fighting(phase)) return;
    const parsed = SelectableArenaScenarioIdSchema.safeParse(select.value);
    if (!parsed.success) return;
    const before = pending;
    pending = parsed.data;
    saving = true;
    render();
    saveSettings({ arena: parsed.data })
      .then((saved) => {
        pending = saved.arena;
      })
      .catch((err) => {
        pending = before;
        showToast(`No se pudo guardar el mapa: ${describeError(err)}`);
      })
      .finally(() => {
        saving = false;
        render();
      });
  });
  render();
}
