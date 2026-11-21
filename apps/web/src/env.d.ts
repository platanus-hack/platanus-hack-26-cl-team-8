/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Origen de la API del orquestador. Vacío = mismo origen. */
  readonly PUBLIC_API_BASE?: string;
  /** URL del playlist HLS. Por defecto /live/arena/index.m3u8. */
  readonly PUBLIC_HLS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
