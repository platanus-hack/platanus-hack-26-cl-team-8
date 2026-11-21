// hls.js publica ESM con export default (dist/hls.mjs): import por defecto.
import Hls from "hls.js";
import { HLS_URL, MOCK } from "./config";
import { byId, setText } from "./dom";

const RETRY_MS = 3000;
/** Sin avance de reproducción durante este tiempo = señal caída. */
const STALL_MS = 12_000;
const WATCHDOG_MS = 2000;

// ---------- Reloj de la transmisión ----------
//
// Cada evento del servidor trae la hora en que ocurrió (`at`, reloj del servidor), y la
// imagen de ese instante llega a la pantalla más de un segundo después. Aquí se calcula
// qué instante del juego se está viendo ahora; main.ts aplica cada evento cuando la
// imagen llega a él, así un golpe se ve y se descuenta al mismo tiempo.

const DEFAULT_PIPELINE_MS = 400;
const MAX_PIPELINE_MS = 5000;

function pipelineSetting(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= MAX_PIPELINE_MS ? value : null;
}

/**
 * Tiempo entre que algo pasa en el juego y la hora que MediaMTX le pone al cuadro que lo
 * muestra: lo que tarda el cliente de Minecraft en dibujarlo, la captura de pantalla y el
 * codificador. Se fija al compilar con PUBLIC_STREAM_PIPELINE_MS y, para calibrar sin
 * recompilar, con `?sync=<ms>` en la URL (de 0 a 5000; fuera de eso se ignora).
 */
export const PIPELINE_MS: number =
  pipelineSetting(new URLSearchParams(window.location.search).get("sync")) ??
  pipelineSetting(import.meta.env.PUBLIC_STREAM_PIPELINE_MS) ??
  DEFAULT_PIPELINE_MS;

/**
 * Sin fechas en el playlist solo se conoce la distancia al borde en vivo, que además no
 * ve lo que tarda MediaMTX en empaquetar cada parte: se suma al atraso de arriba.
 */
const FALLBACK_PIPELINE_MS = PIPELINE_MS + 400;
/** La imagen nunca se considera más atrasada que esto respecto del servidor. */
const MAX_VIDEO_DELAY_MS = 15_000;
/** Ventana de eventos con la que se estima la diferencia entre los dos relojes. */
const OFFSET_WINDOW_MS = 30_000;

/**
 * De dónde sale el instante que se ve en pantalla: "dates" = fechas del playlist (hls.js),
 * "latency" = distancia al borde en vivo, "native" = fecha de inicio del HLS nativo
 * (Safari), "none" = no hay imagen en pantalla y no se aplica atraso.
 */
export type SyncSource = "dates" | "latency" | "native" | "none";

export type StreamClock = {
  /** Hora actual del servidor (epoch ms), estimada. */
  serverNow: number;
  /** Hora del servidor del instante del juego que se ve en pantalla ahora. */
  videoNow: number;
  source: SyncSource;
};

/** Instante del juego en pantalla según el reproductor; null = no hay imagen. Recibe la hora del servidor. */
type VideoProbe = (now: number) => { at: number; source: SyncSource } | null;

let videoProbe: VideoProbe | null = null;

/**
 * Muestras de (reloj del servidor − reloj del navegador), una por evento recibido. Cada
 * evento tarda algo en llegar, así que todas se quedan cortas; la mayor es la del evento
 * que viajó más rápido y por eso la mejor. Se guardan solo las que pueden llegar a ser la
 * mayor de la ventana: de más vieja a más nueva y de mayor a menor.
 */
const offsetSamples: { seenAt: number; offset: number }[] = [];

/** Registra la hora (`at`) de un evento recién llegado del servidor, para estimar su reloj. */
export function noteServerTime(at: number): void {
  if (!Number.isFinite(at)) return;
  const seenAt = Date.now();
  const offset = at - seenAt;
  while (offsetSamples.length > 0 && offsetSamples[offsetSamples.length - 1]!.offset <= offset) offsetSamples.pop();
  offsetSamples.push({ seenAt, offset });
  while (offsetSamples.length > 1 && offsetSamples[0]!.seenAt < seenAt - OFFSET_WINDOW_MS) offsetSamples.shift();
}

function clockOffset(now: number): number {
  for (const sample of offsetSamples) {
    if (sample.seenAt >= now - OFFSET_WINDOW_MS) return sample.offset;
  }
  // Hace rato que no llega nada (o nunca llegó): vale la última muestra, o cero.
  return offsetSamples[offsetSamples.length - 1]?.offset ?? 0;
}

/** Hora actual del servidor (epoch ms), estimada con los eventos de los últimos segundos. */
export function serverNow(): number {
  const now = Date.now();
  return now + clockOffset(now);
}

/** El reloj completo, de una sola lectura. No cambia nada: se puede llamar en cada cuadro. */
export function streamClock(): StreamClock {
  const now = serverNow();
  const probed = videoProbe ? videoProbe(now) : null;
  if (!probed || !Number.isFinite(probed.at)) return { serverNow: now, videoNow: now, source: "none" };
  return {
    serverNow: now,
    videoNow: Math.min(now, Math.max(now - MAX_VIDEO_DELAY_MS, probed.at)),
    source: probed.source,
  };
}

/**
 * Hora del servidor del instante del juego que está en pantalla ahora. Todo lo que el
 * espectador ve y depende del tiempo (cola de eventos, reloj de la pelea, cuenta
 * regresiva) se mide con este reloj, no con Date.now(). Sin imagen en pantalla (sin
 * señal, en pausa) es la hora del servidor, sin atraso.
 */
export function videoServerNow(): number {
  return streamClock().videoNow;
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
      // El atraso simulado (?delay=) pasa por el mismo reloj que el del video real.
      videoProbe = (now) => ({ at: now - mock.MOCK_VIDEO_DELAY_MS, source: "latency" });
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
    videoProbe = null;
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
      videoProbe = (now) => {
        if (container.dataset.signal !== "on" || video.paused) return null;
        // Lo más exacto: la hora que trae el cuadro en pantalla (EXT-X-PROGRAM-DATE-TIME),
        // menos lo que tardó el juego en llegar a ese cuadro.
        const playing = instance.playingDate;
        if (playing) {
          const at = playing.getTime() - PIPELINE_MS;
          const delay = now - at;
          // Una fecha fuera de rango (relojes distintos, playlist raro) no sirve: se usa lo de abajo.
          if (delay > 0 && delay < MAX_VIDEO_DELAY_MS) return { at, source: "dates" };
        }
        // Si el playlist no trae fechas: distancia al borde en vivo + lo que hls.js no ve.
        const latency = instance.latency;
        if (!Number.isFinite(latency) || latency <= 0) return null;
        return { at: now - (latency * 1000 + FALLBACK_PIPELINE_MS), source: "latency" };
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
      videoProbe = (now) => {
        if (container.dataset.signal !== "on" || video.paused) return null;
        // Safari entrega la fecha del inicio del playlist (EXT-X-PROGRAM-DATE-TIME) con
        // getStartDate(), que no está en los tipos del DOM; sin fechas devuelve una inválida.
        const startDate = (video as HTMLVideoElement & { getStartDate?: () => Date }).getStartDate?.();
        const startMs = startDate ? startDate.getTime() : Number.NaN;
        if (Number.isFinite(startMs)) {
          const at = startMs + video.currentTime * 1000 - PIPELINE_MS;
          const delay = now - at;
          if (delay > 0 && delay < MAX_VIDEO_DELAY_MS) return { at, source: "native" };
        }
        // Sin fecha válida: distancia al borde en vivo, como hls.js sin fechas.
        if (video.seekable.length === 0) return null;
        const liveEdge = video.seekable.end(video.seekable.length - 1);
        return {
          at: now - (Math.max(0, liveEdge - video.currentTime) * 1000 + FALLBACK_PIPELINE_MS),
          source: "latency",
        };
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
