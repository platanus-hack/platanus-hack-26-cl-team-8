import { loadEnv } from "@phack/env";

export type CameraConfig = {
  mc: { host: string; port: number; version: string };
  rcon: { host: string; port: number; password: string };
  username: string;
  /** Siempre par (lo exige yuv420p). */
  width: number;
  /** Siempre par (lo exige yuv420p). */
  height: number;
  fps: number;
  rtmpUrl: string;
  /** Segundos por vuelta de la órbita; 0 = cámara fija. */
  orbitSeconds: number;
  /** Radio de chunks que se dibujan alrededor del centro de la arena. */
  viewDistance: number;
  bitrateKbps: number;
  /** Agrega una pista de audio en silencio (por si algún reproductor HLS la exige). */
  silentAudio: boolean;
};

/**
 * Variables propias de la cámara que NO están en @phack/env (ese paquete no se
 * toca desde aquí); se leen directo de process.env y se documentan en el README.
 */
function readNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Variable de entorno inválida: ${name}="${raw}" no es un número`);
  }
  return Math.min(max, Math.max(min, value));
}

function readFlag(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "si" || raw === "sí";
}

function toEven(value: number, min: number): number {
  const clamped = Math.max(min, Math.floor(value));
  return clamped - (clamped % 2);
}

export function loadConfig(): CameraConfig {
  const env = loadEnv();
  return {
    mc: { host: env.MC_HOST, port: env.MC_PORT, version: env.MC_VERSION },
    rcon: { host: env.RCON_HOST, port: env.RCON_PORT, password: env.RCON_PASSWORD },
    username: env.CAMERA_USERNAME,
    width: toEven(env.CAMERA_WIDTH, 160),
    height: toEven(env.CAMERA_HEIGHT, 90),
    fps: Math.min(60, Math.max(1, env.CAMERA_FPS)),
    rtmpUrl: env.RTMP_URL,
    orbitSeconds: readNumber("CAMERA_ORBIT_SECONDS", 0, 0, 3600),
    viewDistance: Math.round(readNumber("CAMERA_VIEW_DISTANCE", 4, 2, 12)),
    bitrateKbps: Math.round(readNumber("CAMERA_BITRATE_KBPS", 2500, 200, 20000)),
    silentAudio: readFlag("CAMERA_SILENT_AUDIO"),
  };
}
