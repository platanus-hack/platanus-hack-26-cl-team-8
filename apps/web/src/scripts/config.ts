import { API_ROUTES } from "@phack/protocol";

/** Origen de la API sin barra final. "" = mismo origen que la página. */
export const API_BASE: string = (import.meta.env.PUBLIC_API_BASE ?? "").trim().replace(/\/+$/, "");

/** Playlist HLS de la transmisión de la arena. */
export const HLS_URL: string = (import.meta.env.PUBLIC_HLS_URL ?? "").trim() || "/live/arena/index.m3u8";

/**
 * Modo maqueta (datos estáticos, sin backend): ver mock.ts. Se activa con `?mock` en
 * la URL. Solo existe en desarrollo (`astro dev`) o si el sitio se compiló con
 * PUBLIC_MOCK=1; en el sitio real el parámetro se ignora.
 */
export const MOCK: boolean =
  (import.meta.env.DEV || import.meta.env.PUBLIC_MOCK === "1") &&
  new URLSearchParams(window.location.search).has("mock");

export function apiUrl(path: string): string {
  return API_BASE + path;
}

/** URL del websocket: mismo host que la API, con http->ws / https->wss. */
export function wsUrl(): string {
  const httpUrl = new URL(API_BASE + API_ROUTES.ws, window.location.href);
  return httpUrl.href.replace(/^http/, "ws");
}
