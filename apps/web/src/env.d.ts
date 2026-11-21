/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Origen de la API del orquestador. Vacío = mismo origen. */
  readonly PUBLIC_API_BASE?: string;
  /** URL del playlist HLS. Por defecto /live/arena/index.m3u8. */
  readonly PUBLIC_HLS_URL?: string;
  /** "1" = permite el modo maqueta (`?mock`) también en el sitio compilado. */
  readonly PUBLIC_MOCK?: string;
  /**
   * Ms entre que algo pasa en el juego y la hora del cuadro que lo muestra (cliente de
   * Minecraft + captura + codificador). Por defecto 400; ver PIPELINE_MS en scripts/player.ts.
   */
  readonly PUBLIC_STREAM_PIPELINE_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
