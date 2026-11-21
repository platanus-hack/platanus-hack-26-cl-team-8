// hls.js publica ESM con export default (dist/hls.mjs): import por defecto.
import Hls from "hls.js";
import { HLS_URL, MOCK } from "./config";
import { byId, setText } from "./dom";

const RETRY_MS = 3000;
/** Sin avance de reproducción durante este tiempo = señal caída. */
const STALL_MS = 12_000;
const WATCHDOG_MS = 2000;

/** Lo que tarda la cámara en codificar y MediaMTX en empaquetar, que hls.js no ve. */
const ENCODE_DELAY_MS = 1200;
const MAX_VIDEO_DELAY_MS = 15_000;

let delayProbe: (() => number) | null = null;
let serverClockOffset = 0;

/** Diferencia entre el reloj del servidor y el del navegador (ms), medida al recibir cada evento. */
export function setServerClockOffset(ms: number): void {
  serverClockOffset = ms;
}

/**
 * Cuánto va atrasada la imagen respecto de la telemetría, en ms. El video (HLS) llega
 * varios segundos después que los eventos del websocket; main.ts usa este valor para
 * retrasar el marcador y que un golpe se vea y se descuente al mismo tiempo.
 * Sin video en pantalla devuelve 0.
 */
export function videoDelayMs(): number {
  if (!delayProbe) return 0;
  const value = delayProbe();
  return Number.isFinite(value) ? Math.min(MAX_VIDEO_DELAY_MS, Math.max(0, value)) : 0;
}

/**
 * Reproductor en vivo. Estrategia simple y robusta: ante cualquier error fatal
 * o congelamiento se destruye todo y se vuelve a empezar cada RETRY_MS, hasta
 * que la transmisión exista. Mientras tanto se muestra "Sin señal".
 */
export function initPlayer(): void {
  const container = byId("player");
  const video = byId<HTMLVideoElement>("arena-video");
  const detail = byId("no-signal-detail");

  let hls: Hls | null = null;
  let retryTimer: number | undefined;
  let mediaRecoveryTried = false;
  let lastTime = 0;
  let lastProgressAt = Date.now();
  let attempts = 0;

  if (MOCK) {
    // Modo maqueta: video de relleno dibujado en un canvas, sin HLS.
    container.dataset.signal = "off";
    void import("./mock").then((mock) => {
      if (!mock.startMockVideo(video)) return;
      delayProbe = () => mock.MOCK_VIDEO_DELAY_MS;
      video.addEventListener("timeupdate", () => {
        container.dataset.signal = "on";
      });
    });
    return;
  }

  const useHlsJs = Hls.isSupported();
  const useNative = !useHlsJs && video.canPlayType("application/vnd.apple.mpegurl") !== "";

  const setSignal = (live: boolean): void => {
    const value = live ? "on" : "off";
    if (container.dataset.signal !== value) container.dataset.signal = value;
    if (live) attempts = 0;
  };

  const tryPlay = (): void => {
    // Silenciado + playsinline: el autoplay está permitido en todos los navegadores.
    video.muted = true;
    video.play().catch(() => {
      // Si aun así se bloquea, un toque sobre el reproductor lo inicia.
    });
  };

  const teardown = (): void => {
    delayProbe = null;
    if (hls) {
      hls.destroy();
      hls = null;
    } else if (video.hasAttribute("src")) {
      video.removeAttribute("src");
      video.load();
    }
  };

  const scheduleRetry = (): void => {
    setSignal(false);
    if (retryTimer !== undefined) return;
    setText(
      detail,
      attempts > 1
        ? `Esperando la transmisión de la arena. Reintentando… (intento ${attempts})`
        : "Esperando la transmisión de la arena. Reintentando…",
    );
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      start();
    }, RETRY_MS);
  };

  const start = (): void => {
    teardown();
    attempts += 1;
    mediaRecoveryTried = false;
    lastTime = 0;
    lastProgressAt = Date.now();

    if (useHlsJs) {
      const instance = new Hls({
        lowLatencyMode: true,
        enableWorker: true,
        backBufferLength: 10,
        // Permite acelerar un poco para volver al borde en vivo si se atrasa.
        maxLiveSyncPlaybackRate: 1.5,
      });
      hls = instance;
      delayProbe = () => {
        if (container.dataset.signal !== "on") return 0;
        // Lo más exacto: la hora de captura del cuadro en pantalla (EXT-X-PROGRAM-DATE-TIME).
        const playing = instance.playingDate;
        if (playing) {
          const byDate = Date.now() + serverClockOffset - playing.getTime();
          if (byDate > 0 && byDate < MAX_VIDEO_DELAY_MS) return byDate;
        }
        // Si el playlist no trae fechas: distancia al borde en vivo + lo que tarda en codificarse.
        const latency = instance.latency;
        return Number.isFinite(latency) && latency > 0 ? latency * 1000 + ENCODE_DELAY_MS : 0;
      };
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        tryPlay();
      });
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoveryTried) {
          mediaRecoveryTried = true;
          instance.recoverMediaError();
          return;
        }
        // Playlist inexistente (aún no hay stream), red caída, etc.
        scheduleRetry();
      });
      instance.loadSource(HLS_URL);
      instance.attachMedia(video);
    } else if (useNative) {
      // Safari / iOS sin MSE: HLS nativo.
      video.src = HLS_URL;
      video.load();
      tryPlay();
      delayProbe = () => {
        if (container.dataset.signal !== "on" || video.seekable.length === 0) return 0;
        const liveEdge = video.seekable.end(video.seekable.length - 1);
        return Math.max(0, liveEdge - video.currentTime) * 1000 + ENCODE_DELAY_MS;
      };
    }
  };

  if (!useHlsJs && !useNative) {
    setSignal(false);
    setText(detail, "Este navegador no puede reproducir la transmisión (HLS no soportado).");
    return;
  }

  video.addEventListener("timeupdate", () => {
    if (video.currentTime > lastTime) {
      lastTime = video.currentTime;
      lastProgressAt = Date.now();
      setSignal(true);
    }
  });

  video.addEventListener("error", () => {
    // Con hls.js los errores llegan por Hls.Events.ERROR; esto cubre el modo nativo.
    if (!hls) scheduleRetry();
  });

  container.addEventListener("click", () => {
    if (video.paused) tryPlay();
  });

  document.addEventListener("visibilitychange", () => {
    // Al volver a la pestaña se da un margen nuevo antes de declarar la señal caída.
    if (!document.hidden) lastProgressAt = Date.now();
  });

  window.setInterval(() => {
    if (document.hidden || retryTimer !== undefined) return;
    if (Date.now() - lastProgressAt > STALL_MS) scheduleRetry();
  }, WATCHDOG_MS);

  start();
}
