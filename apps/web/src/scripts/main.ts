import { parseArenaEvent, type ArenaEvent, type MatchPhase, type MatchState } from "@phack/protocol";
import { fetchDefaults, fetchState } from "./api";
import { initControls, setPhase } from "./controls";
import { byId, setText } from "./dom";
import { addFeed, initFeed } from "./feed";
import { SIDE_LABEL, formatNumber, resultDetail, resultTitle, truncate } from "./format";
import { setDefaults } from "./models";
import { initPlayer, setServerClockOffset, videoDelayMs } from "./player";
import { applyRemotePrompts, initPrompts, loadPrompts } from "./prompts";
import {
  applyAction,
  applyDamage,
  applyDeath,
  applyThought,
  initScoreboard,
  renderState,
  showResult,
  syncClock,
} from "./scoreboard";
import { connectSocket, type SocketStatus } from "./socket";

const STATE_POLL_MS = 5000;
const MAX_ARGS_LENGTH = 160;

let socketStatus: SocketStatus = "connecting";
let lastPhase: MatchPhase | null = null;

function describeAction(tool: string, args: Record<string, unknown>, result: string): string {
  let argsText = "";
  try {
    const json = JSON.stringify(args);
    if (json !== undefined && json !== "{}") argsText = truncate(json, MAX_ARGS_LENGTH);
  } catch {
    argsText = "…";
  }
  const call = `${tool}(${argsText})`;
  return result.trim() === "" ? call : `${call} → ${result}`;
}

function applyState(state: MatchState): void {
  renderState(state);
  setPhase(state.phase);

  if (lastPhase !== null && lastPhase !== state.phase) {
    if (state.phase === "preparing") {
      addFeed({ at: Date.now(), kind: "system", text: "Preparando la arena para una nueva pelea…" });
    } else if (state.phase === "running") {
      addFeed({ at: Date.now(), kind: "system", text: "¡Comienza la pelea!" });
    }
  }
  lastPhase = state.phase;
}

function handleEvent(event: ArenaEvent): void {
  syncClock(event.at);

  switch (event.type) {
    case "state":
      applyState(event.state);
      break;
    case "prompts":
      applyRemotePrompts(event.prompts);
      break;
    case "thought":
      applyThought(event.side, event.text);
      addFeed({ at: event.at, kind: "thought", side: event.side, text: event.text });
      break;
    case "action": {
      const text = describeAction(event.tool, event.args, event.result);
      applyAction(event.side, text);
      addFeed({ at: event.at, kind: "action", side: event.side, text });
      break;
    }
    case "damage":
      applyDamage(event.side, event.health, event.amount);
      addFeed({
        at: event.at,
        kind: "damage",
        side: event.side,
        text: `recibe ${formatNumber(event.amount)} de daño (vida: ${formatNumber(event.health)})`,
      });
      break;
    case "death":
      applyDeath(event.side);
      addFeed({ at: event.at, kind: "death", side: event.side, text: `${SIDE_LABEL[event.side]} ha caído en combate.` });
      break;
    case "match_end":
      showResult(event.record.result);
      addFeed({
        at: event.at,
        kind: "system",
        text: `${resultTitle(event.record.result)} ${resultDetail(event.record.result)}`,
      });
      break;
    case "log":
      addFeed({
        at: event.at,
        kind: event.level === "info" ? "system" : event.level,
        text: event.text,
      });
      break;
  }
}

// ---------- Telemetría sincronizada con el video ----------
//
// Los eventos llegan por websocket al instante, pero la imagen (HLS) va varios segundos
// atrás. Para que el marcador no "adelante" lo que se ve, cada evento espera en una cola
// el mismo tiempo que lleva de atraso el video, y recién entonces se aplica.

type Pending = { dueAt: number; event: ArenaEvent };

const DRAIN_MS = 50;
/** Saltos de atraso menores que esto se suavizan; mayores (cambió la señal) se toman de una vez. */
const DELAY_SNAP_MS = 1500;

const pending: Pending[] = [];
let lastDueAt = 0;
let delay = 0;

function receiveEvent(event: ArenaEvent): void {
  const now = Date.now();
  setServerClockOffset(event.at - now);

  // Los prompts pendientes no son parte de la imagen: se aplican al tiro.
  if (event.type === "prompts") {
    handleEvent(event);
    return;
  }

  const target = videoDelayMs();
  delay = Math.abs(target - delay) > DELAY_SNAP_MS ? target : delay + (target - delay) * 0.2;
  // Nunca antes que el evento anterior: el orden de llegada se respeta siempre.
  const dueAt = Math.max(lastDueAt, now + delay);
  lastDueAt = dueAt;
  pending.push({ dueAt, event });
  drainPending();
}

function drainPending(force = false): void {
  const now = Date.now();
  while (pending.length > 0) {
    const next = pending[0]!;
    if (!force && next.dueAt > now) break;
    pending.shift();
    handleEvent(next.event);
  }
}

function renderConnection(status: SocketStatus): void {
  const indicator = byId("conn");
  indicator.dataset.state = status;
  setText(
    byId("conn-text"),
    status === "open" ? "Conectado" : status === "connecting" ? "Conectando…" : "Sin conexión, reintentando…",
  );
  document.body.dataset.conn = status;
}

function pollState(): void {
  fetchState()
    .then(applyState)
    .catch(() => {
      // Silencioso: el indicador de conexión ya informa el problema.
    });
}

function init(): void {
  initScoreboard();
  initFeed();
  initPrompts();
  // Al iniciar o detener, la respuesta del botón se muestra al instante: se vacía la cola
  // para que un estado viejo en espera no la pise después.
  initControls((state) => {
    drainPending(true);
    applyState(state);
  });
  window.setInterval(drainPending, DRAIN_MS);
  initPlayer();

  renderConnection("connecting");
  let everOpened = false;

  connectSocket({
    onMessage(raw) {
      const event = parseArenaEvent(raw);
      if (event) receiveEvent(event);
    },
    onStatus(status) {
      const previous = socketStatus;
      socketStatus = status;
      renderConnection(status);
      if (status === "open" && previous !== "open") {
        // Tras (re)conectar pudo haber cambiado todo mientras no escuchábamos.
        if (everOpened) void loadPrompts();
        everOpened = true;
      }
    },
  });

  // Carga inicial por HTTP: funciona aunque el websocket tarde o esté bloqueado.
  pollState();
  void loadPrompts();
  // Con esto se sabe qué modelo usa un agente que dejó "por defecto del servidor".
  fetchDefaults()
    .then(setDefaults)
    .catch(() => {
      // Sin este dato la página funciona igual: solo no muestra el modelo por defecto.
    });

  // Respaldo: mientras el websocket esté caído, el estado se consulta por HTTP.
  window.setInterval(() => {
    if (socketStatus !== "open") pollState();
  }, STATE_POLL_MS);
}

init();
