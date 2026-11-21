import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { ARENA } from "@phack/protocol";
import type { CameraConfig } from "./config";
import { errorText, log } from "./log";

// mineflayer y rcon-client (v4) son CommonJS. Se cargan con createRequire para no
// depender de cómo el loader ESM detecta sus exports con nombre; los tipos salen
// de `typeof import(...)`.
const nodeRequire = createRequire(import.meta.url);
const mineflayer = nodeRequire("mineflayer") as typeof import("mineflayer");
const { Rcon } = nodeRequire("rcon-client") as typeof import("rcon-client");

const CONNECT_TIMEOUT_MS = 45_000;

export type BotSession = {
  bot: Bot;
  /** Se resuelve (nunca rechaza) con el motivo cuando la conexión termina. */
  ended: Promise<string>;
};

function reasonText(reason: unknown): string {
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/**
 * Conecta el bot espectador. Resuelve cuando ya apareció en el mundo; rechaza si
 * la conexión falla, lo expulsan antes de aparecer o pasa el timeout.
 */
export function connectBot(config: CameraConfig): Promise<BotSession> {
  return new Promise<BotSession>((resolve, reject) => {
    const bot = mineflayer.createBot({
      host: config.mc.host,
      port: config.mc.port,
      username: config.username,
      version: config.mc.version,
      auth: "offline",
      // Sin física: el bot no "cae" ni se mueve solo; se queda donde lo deje el /tp.
      physicsEnabled: false,
    });
    bot.physicsEnabled = false;

    let spawned = false;
    let endReason = "";
    let resolveEnded: (reason: string) => void = () => {};
    const ended = new Promise<string>((res) => {
      resolveEnded = res;
    });

    const timer = setTimeout(() => {
      if (spawned) return;
      endReason = `no apareció en el mundo en ${CONNECT_TIMEOUT_MS / 1000} s`;
      bot.end("timeout");
    }, CONNECT_TIMEOUT_MS);

    // Sin listener de "error", mineflayer lanzaría una excepción no capturada.
    bot.on("error", (err) => {
      log("warn", `Error de conexión del bot: ${errorText(err)}`);
      if (endReason === "") endReason = errorText(err);
    });
    bot.on("kicked", (reason) => {
      endReason = `expulsado por el servidor: ${reasonText(reason)}`;
    });
    bot.once("end", (reason) => {
      clearTimeout(timer);
      const text = endReason !== "" ? endReason : reasonText(reason) || "conexión cerrada";
      if (!spawned) reject(new Error(text));
      resolveEnded(text);
    });
    bot.once("spawn", () => {
      spawned = true;
      clearTimeout(timer);
      resolve({ bot, ended });
    });
  });
}

/** Abre una conexión RCON, manda los comandos en orden y la cierra. Devuelve las respuestas. */
export async function runRcon(config: CameraConfig, commands: readonly string[]): Promise<string[]> {
  const rcon = new Rcon({
    host: config.rcon.host,
    port: config.rcon.port,
    password: config.rcon.password,
    timeout: 5_000,
  });
  // Evita un "unhandled error event" si el socket se cae a mitad de camino.
  rcon.on("error", () => {});
  await rcon.connect();
  try {
    const replies: string[] = [];
    for (const command of commands) replies.push(await rcon.send(command));
    return replies;
  } finally {
    await rcon.end().catch(() => {});
  }
}

/** Deja a la cámara en modo espectador y en ARENA.camera usando RCON. */
export async function placeCamera(config: CameraConfig): Promise<void> {
  const { x, y, z } = ARENA.camera;
  await runRcon(config, [`gamemode spectator ${config.username}`, `tp ${config.username} ${x} ${y} ${z}`]);
}

/** true si alguien sacó a la cámara de su sitio o de modo espectador. */
export function isMisplaced(bot: Bot): boolean {
  const entity = bot.entity;
  if (!entity) return true;
  if (bot.game?.gameMode !== "spectator") return true;
  const dx = entity.position.x - ARENA.camera.x;
  const dy = entity.position.y - ARENA.camera.y;
  const dz = entity.position.z - ARENA.camera.z;
  return dx * dx + dy * dy + dz * dz > 3 * 3;
}
