// hls.js publica ESM con export default (dist/hls.mjs): import por defecto.
import Hls from "hls.js";
import { HLS_URL } from "./config";
import { byId, setText } from "./dom";

const RETRY_MS = 3000;
/** Sin avance de reproducción durante este tiempo = señal caída. */
const STALL_MS = 12_000;
const WATCHDOG_MS = 2000;

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
