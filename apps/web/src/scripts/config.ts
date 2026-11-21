import { API_ROUTES } from "@phack/protocol";

/** Origen de la API sin barra final. "" = mismo origen que la página. */
export const API_BASE: string = (import.meta.env.PUBLIC_API_BASE ?? "").trim().replace(/\/+$/, "");

/** Playlist HLS de la transmisión de la arena. */
export const HLS_URL: string = (import.meta.env.PUBLIC_HLS_URL ?? "").trim() || "/live/arena/index.m3u8";

export function apiUrl(path: string): string {
  return API_BASE + path;
}

/** URL del websocket: mismo host que la API, con http->ws / https->wss. */
export function wsUrl(): string {
  const httpUrl = new URL(API_BASE + API_ROUTES.ws, window.location.href);
  return httpUrl.href.replace(/^http/, "ws");
}
