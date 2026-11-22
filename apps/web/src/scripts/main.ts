import { parseArenaEvent, type ArenaEvent, type MatchPhase, type MatchState } from "@phack/protocol";
import { actionLine, describeAction } from "./actions";
import { fetchDefaults, fetchMatches, fetchState } from "./api";
import { initArenaPicker, setMatchArena } from "./arenapicker";
import { initAccess } from "./access";
import { initControls, setPhase } from "./controls";
import { initSettingControls } from "./controls-enhance";
import { initCountdown, updateCountdown } from "./countdown";
import { initStageCards, updateStageCards } from "./stagecards";
import { byId, setText } from "./dom";
import { addFeed, initFeed } from "./feed";
import { addToHistory, initHistory, syncHistory } from "./history";
import { SIDE_LABEL, formatNumber, resultDetail, resultTitle, roundDetail, roundTitle } from "./format";
import { setDefaults } from "./models";
import { PIPELINE_MS, initPlayer, noteServerTime, serverNow, streamClock, videoServerNow } from "./player";
import { applyRemotePrompts, initPrompts, loadPrompts } from "./prompts";
import { applyRemoteSettings, initSettings, loadSettings } from "./settings";
import { shownSettings, applyDamage, applyDeath, initScoreboard, renderState, showExplanation, showResult, showRound } from "./scoreboard";
import { connectSocket, type SocketStatus } from "./socket";
import { initSound, playEnd, playHit, playKnockout, playMessage, playStart } from "./sound";
import { initThoughts, markFallen, pushAction, pushInjected, pushMessage, pushThought, syncThoughts } from "./thoughts";
import { initTranscriptLink, setTranscriptMatch } from "./transcriptlink";
import { initVoice, playSpeech, preloadSpeech, stopSpeech } from "./voice";
import { initWelcome } from "./welcome";

const STATE_POLL_MS = 5000;

let socketStatus: SocketStatus = "connecting";
let lastPhase: MatchPhase | null = null;
/** El sonido de inicio ya sonó para la pelea que está partiendo. */
let startAnnounced = false;

/**
 * Suena el inicio de la pelea, una sola vez por pelea: en el cero de la cuenta regresiva
 * o, si no hubo cuenta (servidor antiguo, pestaña en segundo plano), al pasar a "running".
 */
function announceStart(): void {
  if (startAnnounced) return;
  startAnnounced = true;
  playStart();
}

/**
 * El "por qué ganó" lo escribe el servidor unos segundos después del final y lo guarda
 * con la pelea. Se consulta unas pocas veces hasta que aparece; si no llega, no pasa nada.
 */
async function awaitExplanation(matchId: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 2500));
    // Ya partió otra pelea: ese resultado no está en pantalla.
    if (lastPhase === "preparing" || lastPhase === "running") return;
    try {
      const record = (await fetchMatches()).find((item) => item.id === matchId);
      const text = record?.result.explanation;
      if (text) {
        showExplanation(text);
        return;
      }
    } catch {
      // Se reintenta en la próxima vuelta.
    }
  }
}

function applyState(state: MatchState): void {
  renderState(state);
  syncThoughts(state);
  setPhase(state.phase);
  setMatchArena(state);
  setTranscriptMatch(state.id);
  syncHistory(state);
  updateCountdown(state);
  updateStageCards(state);

  if (lastPhase !== null && lastPhase !== state.phase) {
    if (state.phase === "preparing") {
      startAnnounced = false;
      // Lo que quedaba por decir de la pelea anterior ya no suena.
      stopSpeech();
      addFeed({ at: Date.now(), kind: "system", text: "Preparando la arena para una nueva pelea…" });
    } else if (state.phase === "running") {
      announceStart();
      const text = state.series ? `¡Comienza la ronda ${state.series.round}!` : "¡Comienza la pelea!";
      addFeed({ at: Date.now(), kind: "system", text });
    } else if (state.phase === "intermission") {
      // La campana de inicio vuelve a sonar con la ronda que viene.
      startAnnounced = false;
    }
  }
  lastPhase = state.phase;
}

function handleEvent(event: ArenaEvent): void {
  switch (event.type) {
    case "state":
      applyState(event.state);
      break;
    case "prompts":
      applyRemotePrompts(event.prompts);
      break;
    case "settings":
      applyRemoteSettings(event.settings);
      break;
    case "injected":
      pushInjected(event.side, event.kind, event.text, event.at);
      addFeed({
        at: event.at,
        kind: "warn",
        side: event.side,
        text: `${event.kind === "injection" ? "recibe una orden falsa" : "recibe un aviso falso"}: «${event.text}»`,
      });
      break;
    case "message": {
      playMessage(event.side);
      const bubble = pushMessage(event.side, event.text, event.at);
      // Su voz suena junto con el globo (el audio se pidió cuando llegó el evento).
      if (event.speechId) playSpeech(event.side, event.speechId, bubble);
      addFeed({ at: event.at, kind: "message", side: event.side, text: event.text });
      break;
    }
    case "thought":
      pushThought(event.side, event.text, event.at);
      addFeed({ at: event.at, kind: "thought", side: event.side, text: event.text });
      break;
    case "action": {
      const view = describeAction(event.tool, event.args, event.result);
      pushAction(event.side, view, event.at);
      addFeed({ at: event.at, kind: "action", side: event.side, text: actionLine(view), title: view.raw });
      break;
    }
    case "damage":
      playHit();
      applyDamage(event.side, event.health, event.amount);
      addFeed({
        at: event.at,
        kind: "damage",
        side: event.side,
        text: `recibe ${formatNumber(event.amount)} de daño (vida: ${formatNumber(event.health)})`,
      });
      break;
    case "death":
      playKnockout();
      applyDeath(event.side);
      markFallen(event.side);
      addFeed({ at: event.at, kind: "death", side: event.side, text: `${SIDE_LABEL[event.side]} ha caído en combate.` });
      break;
    case "round_end":
      // En un K.O. ya sonó la caída; en los demás finales de ronda suena la campana.
      if (event.result.reason !== "kill") playEnd();
      showRound(event.result, event.series);
      addFeed({ at: event.at, kind: "system", text: `${roundTitle(event.result)}. ${roundDetail(event.result, event.series, shownSettings())}` });
      break;
    case "match_end":
      stopSpeech();
      // En un K.O. ya sonó la caída; en los demás finales suena la campana.
      if (event.record.result.reason !== "kill") playEnd();
      showResult(event.record.result);
      addToHistory(event.record);
      if (!event.record.result.explanation) void awaitExplanation(event.record.id);
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
// Los eventos llegan por websocket al instante, pero la imagen (HLS) va más de un segundo
// atrás. Cada evento trae la hora en que ocurrió (`at`): espera en una cola, en orden de
// llegada, y se aplica cuando la imagen llega a ese instante (videoServerNow, en
// player.ts). Así el marcador nunca adelanta lo que se ve.

type Pending = { event: ArenaEvent; arrivedAt: number };

const DRAIN_MS = 40;
/** Un evento nunca espera más que esto desde que llegó, aunque el video esté detenido o recargando. */
const MAX_WAIT_MS = 6000;

const pending: Pending[] = [];
/** Cuándo llegó el último evento de la pelea por el websocket (reloj del navegador). */
let lastLiveEventAt = 0;

function enqueue(event: ArenaEvent): void {
  pending.push({ event, arrivedAt: Date.now() });
  drainPending();
}

function receiveEvent(event: ArenaEvent): void {
  noteServerTime(event.at);

  // Los prompts y ajustes pendientes no son parte de la imagen: se aplican al tiro.
  if (event.type === "prompts" || event.type === "settings") {
    handleEvent(event);
    return;
  }

  // El audio de un mensaje se pide al llegar: cuando la imagen alcance el mensaje, ya está.
  if (event.type === "message" && event.speechId) preloadSpeech(event.speechId);

  lastLiveEventAt = Date.now();
  enqueue(event);
}

/** Aplica, en orden de llegada, los eventos que la imagen ya alcanzó; con `force`, todos. */
function drainPending(force = false): void {
  if (pending.length === 0) return;
  const now = Date.now();
  const videoNow = videoServerNow();
  while (pending.length > 0) {
    const next = pending[0]!;
    // El primero de la fila manda: si le falta, los que llegaron después también esperan.
    if (!force && next.event.at > videoNow && now - next.arrivedAt < MAX_WAIT_MS) break;
    pending.shift();
    handleEvent(next.event);
  }
}

/**
 * Para medir la sincronía desde la consola: `__arenaSync()` dice qué hora cree la página
 * que es en el servidor, qué instante se ve en pantalla, de dónde lo sacó y cuántos
 * eventos esperan. Solo lee; no cambia nada.
 */
function exposeSyncProbe(): void {
  Object.assign(window, {
    __arenaSync: () => {
      const clock = streamClock();
      return {
        serverNow: clock.serverNow,
        videoNow: clock.videoNow,
        delayMs: clock.serverNow - clock.videoNow,
        source: clock.source,
        queued: pending.length,
        pipelineMs: PIPELINE_MS,
      };
    },
  });
}

function renderConnection(status: SocketStatus): void {
  const indicator = byId("conn");
  indicator.dataset.state = status;
  setText(
    byId("conn-text"),
    status === "open" ? "Conectado" : status === "connecting" ? "Conectando…" : "Sin conexión, reintentando…",
  );
  // Con todo bien solo se ve el punto verde: la ayuda dice qué significa.
  indicator.dataset.tip =
    status === "open"
      ? "Conectado a la arena: los datos llegan en vivo."
      : "Sin conexión con la arena. La página sigue intentando.";
  document.body.dataset.conn = status;
}

/**
 * Estado por HTTP: entra a la misma cola que los eventos del websocket, con la hora del
 * servidor en que llegó. Así no se adelanta a la imagen ni pisa datos más nuevos.
 */
function pollState(): void {
  const sentAt = Date.now();
  fetchState()
    .then((state) => {
      // Mientras se esperaba la respuesta llegó algo por el websocket: esto ya es más viejo.
      if (lastLiveEventAt >= sentAt) return;
      const event: ArenaEvent = { type: "state", at: serverNow(), state };
      // Sin ningún evento del websocket todavía no se conoce la hora del servidor: la de
      // este estado sería la del navegador, y con un reloj adelantado dejaría la cola
      // entera esperando. Se aplica de una vez; es lo primero que ve la página.
      if (lastLiveEventAt === 0) handleEvent(event);
      else enqueue(event);
    })
    .catch(() => {
      // Silencioso: el indicador de conexión ya informa el problema.
    });
}

function init(): void {
  initScoreboard();
  initThoughts();
  initCountdown(announceStart);
  initStageCards();
  initFeed();
  initTranscriptLink();
  initPrompts();
  initHistory();
  initSettingControls();
  initSettings();
  initAccess();
  // Después del acceso: la bienvenida cambia una línea según si este navegador puede jugar.
  initWelcome();
  initArenaPicker();
  // Al iniciar o detener, la respuesta del botón se muestra al instante: se vacía la cola
  // para que un estado viejo en espera no la pise después.
  initControls((state) => {
    drainPending(true);
    // Una consulta por HTTP que iba en camino trae un estado anterior al del botón.
    lastLiveEventAt = Date.now();
    applyState(state);
  });
  window.setInterval(drainPending, DRAIN_MS);
  exposeSyncProbe();
  initPlayer();
  initSound();
  initVoice();

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
        if (everOpened) {
          void loadPrompts();
          void loadSettings();
        }
        everOpened = true;
      }
    },
  });

  // Carga inicial por HTTP: funciona aunque el websocket tarde o esté bloqueado.
  pollState();
  void loadPrompts();
  void loadSettings();
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
