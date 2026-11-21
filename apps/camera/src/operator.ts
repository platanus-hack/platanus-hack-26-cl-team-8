import type { Bot } from "mineflayer";
import { AGENT_USERNAMES, ARENA, SIDES } from "@phack/protocol";
import { connectBot, runRcon } from "./bot";
import type { CameraConfig } from "./config";
import { cameraPose, orbitPosition, pickAimTarget, pickShot, smoothToward, type Shot, type Vec } from "./director";
import { errorText, FatalError, log } from "./log";

/**
 * Modo "cliente real": este proceso NO dibuja ni publica video. Solo vuela al bot cámara.
 *
 * El video lo produce el cliente real de Minecraft (infra/stream/stream.sh), que entra al
 * servidor como espectador. Desde aquí lo montamos en el bot cámara con /spectate, así que
 * ve exactamente lo que "ve" el bot. Mover la cámara = mover al bot.
 *
 * Hay dos cámaras y el bot salta de una a otra:
 *  - la que sigue ("follow"): parada en ARENA.camera, gira para mirar a los peleadores;
 *  - la general ("wide"): estática, alta, muestra toda la arena como en un partido.
 * Sin pelea se muestra la general; con pelea se alternan (CAMERA_FOLLOW_SECONDS /
 * CAMERA_WIDE_SECONDS).
 */

/** Cada cuánto se recalcula la posición del bot. mineflayer la envía al servidor a 20 Hz. */
const FLIGHT_TICK_MS = 25;
/** Constante de tiempo del suavizado del punto de mira, en segundos. */
const AIM_SMOOTHING_SECONDS = 0.6;
/** Altura sobre los pies a la que se apunta (más o menos el pecho). */
const AIM_HEIGHT = 1;
/** Altura de los ojos de un jugador sobre sus pies: ahí queda la cámara del cliente. */
const EYE_HEIGHT = 1.62;
/** Dónde se para la cámara general, relativo al centro de la arena: alta y un poco hacia atrás. */
const WIDE_OFFSET: Vec = { x: 0, y: 22, z: 13 };
/**
 * Lo máximo que el bot avanza por iteración. Al cambiar de cámara cruza en un par de
 * décimas de segundo; más rápido y el servidor rechazaría el movimiento.
 */
const MAX_FLIGHT_STEP = 3;
/** Si el bot está más lejos que esto de donde debería (recién conectado), se pide un /tp. */
const TELEPORT_DISTANCE = 30;
/** Cada cuánto se vuelve a montar al cliente por si se soltó, aunque nada lo indique. */
const REMOUNT_INTERVAL_MS = 30_000;
const MAINTAIN_INTERVAL_MS = 1_000;
/** Fallos seguidos de conexión al servidor de Minecraft antes de rendirse. */
const MAX_CONNECT_FAILURES = 20;

let stopping = false;
let currentBot: Bot | null = null;
/** Dónde deberían estar los pies del bot y hacia dónde mira; lo calcula el loop de vuelo. */
let desired: { feet: Vec; yaw: number; pitch: number } | null = null;
/** true = el bot está lejos de `desired` y hay que llevarlo con /tp. */
let needsTeleport = true;
/** true = hay que (volver a) montar al cliente real en el bot. */
let mountDirty = true;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fatal(message: string): never {
  log("error", `Error irrecuperable: ${message}`);
  stopping = true;
  try {
    currentBot?.end("fatal");
  } catch {
    // nada que hacer
  }
  process.exit(1);
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log("info", `Recibida ${signal}; cerrando la cámara.`);
  try {
    currentBot?.quit("cerrando");
  } catch {
    // ya estaba desconectado
  }
  process.exit(0);
}

function fighterFeet(bot: Bot, username: string): Vec | null {
  const entity = bot.players[username]?.entity;
  if (!entity) return null;
  return { x: entity.position.x, y: entity.position.y, z: entity.position.z };
}

const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/** Loop de vuelo: decide qué cámara está al aire y deja al bot en esa pose. */
function startFlightLoop(config: CameraConfig): void {
  const center: Vec = { x: ARENA.center.x, y: ARENA.center.y + AIM_HEIGHT, z: ARENA.center.z };
  const followBase: Vec = { x: ARENA.camera.x, y: ARENA.camera.y, z: ARENA.camera.z };
  // La general nunca cambia: se calcula una sola vez.
  const widePose = cameraPose(
    { x: center.x + WIDE_OFFSET.x, y: center.y + WIDE_OFFSET.y, z: center.z + WIDE_OFFSET.z },
    center,
  );

  let aim: Vec = { ...center };
  let fightStartedAt: number | null = null;
  let shot: Shot = "wide";
  const startedAt = performance.now();
  let lastTick = startedAt;

  setInterval(() => {
    if (stopping) return;
    const now = performance.now();
    const dt = Math.min(1, (now - lastTick) / 1000);
    lastTick = now;
    const bot = currentBot;
    if (!bot?.entity) return;

    const fighters: Vec[] = [];
    for (const side of SIDES) {
      const feet = fighterFeet(bot, AGENT_USERNAMES[side]);
      if (feet) fighters.push({ x: feet.x, y: feet.y + AIM_HEIGHT, z: feet.z });
    }
    const fighting = fighters.length > 0;
    if (!fighting) fightStartedAt = null;
    else if (fightStartedAt === null) fightStartedAt = now;
    const fightSeconds = fightStartedAt === null ? 0 : (now - fightStartedAt) / 1000;

    // La mira se sigue actualizando aunque esté al aire la general: al volver a la cámara
    // que sigue, ya está apuntando a la pelea.
    aim = smoothToward(aim, pickAimTarget(fighters, center), dt, AIM_SMOOTHING_SECONDS);

    const nextShot = pickShot(fighting, fightSeconds, config.followSeconds, config.wideSeconds);
    if (nextShot !== shot) {
      shot = nextShot;
      log("info", `Al aire: cámara ${shot === "follow" ? "que sigue a los peleadores" : "general"}.`);
    }
    const pose =
      shot === "follow"
        ? cameraPose(orbitPosition(followBase, center, (now - startedAt) / 1000, config.orbitSeconds), aim)
        : widePose;
    const feet: Vec = { x: pose.eye.x, y: pose.eye.y - EYE_HEIGHT, z: pose.eye.z };
    desired = { feet, yaw: pose.yaw, pitch: pose.pitch };

    // Solo un espectador puede volar; antes de serlo, el servidor expulsaría al bot.
    if (bot.game?.gameMode !== "spectator") {
      needsTeleport = true;
      return;
    }
    const position = bot.entity.position;
    const dx = feet.x - position.x;
    const dy = feet.y - position.y;
    const dz = feet.z - position.z;
    const off = Math.hypot(dx, dy, dz);
    if (off > TELEPORT_DISTANCE) {
      needsTeleport = true;
      return;
    }
    if (off > MAX_FLIGHT_STEP) {
      const scale = MAX_FLIGHT_STEP / off;
      position.set(position.x + dx * scale, position.y + dy * scale, position.z + dz * scale);
    } else {
      position.set(feet.x, feet.y, feet.z);
    }
    bot.entity.yaw = pose.yaw;
    bot.entity.pitch = pose.pitch;
  }, FLIGHT_TICK_MS);
}

/** Comandos para dejar al bot en modo espectador, en su sitio y mirando en la dirección fija. */
function placementCommands(config: CameraConfig): string[] {
  const commands = [`gamemode spectator ${config.username}`];
  if (desired) {
    const { feet, yaw, pitch } = desired;
    // /tp usa los ángulos de Minecraft: yaw 180 = norte (-z), pitch positivo = hacia abajo.
    const mcYaw = 180 - toDegrees(yaw);
    const mcPitch = -toDegrees(pitch);
    commands.push(
      `tp ${config.username} ${feet.x.toFixed(3)} ${feet.y.toFixed(3)} ${feet.z.toFixed(3)} ` +
        `${mcYaw.toFixed(3)} ${mcPitch.toFixed(3)}`,
    );
  }
  return commands;
}

/**
 * Mientras dure la sesión del bot: lo mantiene en modo espectador y en su sitio, y mantiene
 * al cliente real montado en él. Todo por RCON, y solo cuando hace falta.
 */
async function maintain(config: CameraConfig, bot: Bot, isOver: () => boolean): Promise<void> {
  let failures = 0;
  let placedOnce = false;
  let lastMountReply = "";
  let nextRemountAt = 0;

  while (!isOver() && !stopping) {
    try {
      if (needsTeleport && desired) {
        await runRcon(config, placementCommands(config));
        needsTeleport = false;
        if (!placedOnce) {
          placedOnce = true;
          log("info", "Bot cámara en modo espectador y en posición (vía RCON).");
        }
        // Tras un /tp el cliente montado puede quedar suelto: se vuelve a montar.
        mountDirty = true;
      }

      const clientOnline = bot.players[config.clientUsername] !== undefined;
      if (clientOnline && placedOnce && (mountDirty || Date.now() >= nextRemountAt)) {
        const replies = await runRcon(config, [
          `gamemode spectator ${config.clientUsername}`,
          `spectate ${config.username} ${config.clientUsername}`,
        ]);
        mountDirty = false;
        nextRemountAt = Date.now() + REMOUNT_INTERVAL_MS;
        const reply = (replies[1] ?? "").trim();
        if (reply !== lastMountReply) {
          lastMountReply = reply;
          log("info", `Cliente real ${config.clientUsername} montado en la cámara: "${reply}"`);
        }
      } else if (!clientOnline && lastMountReply !== "") {
        lastMountReply = "";
        log("warn", `El cliente real ${config.clientUsername} no está en el servidor; no hay video hasta que vuelva.`);
      }
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures === 1 || failures % 30 === 0) {
        log(
          "warn",
          `Falló RCON (${config.rcon.host}:${config.rcon.port}, intento ${failures}): ${errorText(err)}`,
        );
      }
    }
    await sleep(MAINTAIN_INTERVAL_MS);
  }
}

/** Conecta el bot, lo mantiene, y reconecta cuando se cae. */
async function runBotLoop(config: CameraConfig): Promise<void> {
  let failures = 0;
  while (!stopping) {
    try {
      log("info", `Conectando a Minecraft ${config.mc.host}:${config.mc.port} como ${config.username}...`);
      const session = await connectBot(config);
      failures = 0;
      log("info", `Bot conectado (versión ${session.bot.version}).`);

      let over = false;
      needsTeleport = true;
      mountDirty = true;
      session.bot.on("playerJoined", (player) => {
        if (player.username === config.clientUsername) mountDirty = true;
      });
      currentBot = session.bot;
      void maintain(config, session.bot, () => over);

      const reason = await session.ended;
      over = true;
      currentBot = null;
      if (stopping) return;
      log("warn", `El bot se desconectó: ${reason}`);
    } catch (err) {
      currentBot = null;
      if (err instanceof FatalError) throw err;
      if (stopping) return;
      failures += 1;
      log("warn", `No se pudo conectar el bot (intento ${failures}/${MAX_CONNECT_FAILURES}): ${errorText(err)}`);
      if (failures >= MAX_CONNECT_FAILURES) {
        throw new FatalError(`no se pudo conectar a Minecraft tras ${failures} intentos seguidos`);
      }
    }
    // Espera creciente: 2 s, 4 s, ... hasta 15 s.
    await sleep(Math.min(15_000, 2_000 * Math.max(1, failures)));
  }
}

export async function runOperator(config: CameraConfig): Promise<void> {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    fatal(`excepción no capturada: ${err instanceof Error ? (err.stack ?? err.message) : errorText(err)}`);
  });
  process.on("unhandledRejection", (reason) => {
    fatal(`promesa rechazada sin manejar: ${reason instanceof Error ? (reason.stack ?? reason.message) : errorText(reason)}`);
  });

  log(
    "info",
    `Cámara en modo cliente real: el video lo dibuja ${config.clientUsername} (infra/stream), ` +
      `montado en ${config.username}. Con pelea: ${config.followSeconds} s siguiéndola y ` +
      `${config.wideSeconds} s de cámara general.`,
  );
  startFlightLoop(config);
  try {
    await runBotLoop(config);
  } catch (err) {
    if (stopping) return;
    fatal(errorText(err));
  }
}
