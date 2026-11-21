import { loadEnvKeys } from "@phack/env";

/**
 * Quién dibuja el video:
 *  - "client": el cliente real de Minecraft (infra/stream), montado en este bot. Aquí solo
 *    se vuela la cámara; no se renderiza ni se publica nada.
 *  - "viewer": render propio con prismarine-viewer + ffmpeg (el método antiguo; sirve en
 *    máquinas sin GPU).
 */
export type CameraMode = "client" | "viewer";

export type CameraConfig = {
  mode: CameraMode;
  /** Usuario con el que entra el cliente real de Minecraft (modo "client"). */
  clientUsername: string;
  /** Modo "client": segundos seguidos de la cámara que sigue a los peleadores. 0 = solo la general. */
  followSeconds: number;
  /** Modo "client": segundos de la cámara general (estática, desde arriba) entre medio. 0 = nunca. */
  wideSeconds: number;
  mc: { host: string; port: number; version: string };
  rcon: { host: string; port: number; password: string };
  /**
   * URL base del orquestador (sin /api): de ahí sale el mapa de la pelea en curso para
   * reencuadrar. En Docker, http://orchestrator:8787.
   */
  orchestratorUrl: string;
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

function readMode(): CameraMode {
  const raw = (process.env.CAMERA_MODE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "viewer") return "viewer";
  if (raw === "client") return "client";
  throw new Error(`Variable de entorno inválida: CAMERA_MODE="${raw}" (valores: client, viewer)`);
}

function readName(name: string, fallback: string): string {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  if (!/^[A-Za-z0-9_]{3,16}$/.test(raw)) {
    throw new Error(`Variable de entorno inválida: ${name}="${raw}" no es un nombre de jugador de Minecraft`);
  }
  return raw;
}

function readUrl(name: string, fallback: string): string {
  const raw = (process.env[name] ?? "").trim();
  const value = raw === "" ? fallback : raw;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocolo");
  } catch {
    throw new Error(`Variable de entorno inválida: ${name}="${raw}" no es una URL http(s)`);
  }
  return value.replace(/\/+$/, "");
}

function toEven(value: number, min: number): number {
  const clamped = Math.max(min, Math.floor(value));
  return clamped - (clamped % 2);
}

export function loadConfig(): CameraConfig {
  // Solo lo que usa la cámara: una variable del LLM mal puesta no es asunto suyo.
  const env = loadEnvKeys([
    "MC_HOST",
    "MC_PORT",
    "MC_VERSION",
    "RCON_HOST",
    "RCON_PORT",
    "RCON_PASSWORD",
    "CAMERA_USERNAME",
    "CAMERA_WIDTH",
    "CAMERA_HEIGHT",
    "CAMERA_FPS",
    "RTMP_URL",
    "ORCHESTRATOR_PORT",
  ]);
  return {
    mode: readMode(),
    clientUsername: readName("STREAM_CLIENT_USERNAME", "Camarografo"),
    followSeconds: readNumber("CAMERA_FOLLOW_SECONDS", 20, 0, 3600),
    wideSeconds: readNumber("CAMERA_WIDE_SECONDS", 6, 0, 3600),
    mc: { host: env.MC_HOST, port: env.MC_PORT, version: env.MC_VERSION },
    rcon: { host: env.RCON_HOST, port: env.RCON_PORT, password: env.RCON_PASSWORD },
    orchestratorUrl: readUrl("CAMERA_ORCHESTRATOR_URL", `http://127.0.0.1:${env.ORCHESTRATOR_PORT}`),
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
