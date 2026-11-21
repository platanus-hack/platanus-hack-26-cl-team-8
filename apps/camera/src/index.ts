import type { Bot } from "mineflayer";
import { AGENT_USERNAMES, ARENA, SIDES } from "@phack/protocol";
import { connectBot, isMisplaced, placeCamera } from "./bot";
import { loadConfig, type CameraConfig } from "./config";
import { orbitPosition, pickAimTarget, smoothToward, type Vec } from "./director";
import { FfmpegStreamer } from "./ffmpeg";
import { errorText, FatalError, log } from "./log";
import { createStage, type Stage } from "./stage";

/** Constante de tiempo del suavizado de la mira, en segundos. */
const AIM_SMOOTHING_SECONDS = 0.6;
/** Altura sobre los pies a la que se apunta (más o menos el pecho). */
const AIM_HEIGHT = 1;
/** Fallos seguidos de conexión al servidor de Minecraft antes de rendirse. */
const MAX_CONNECT_FAILURES = 20;
/** Excepciones seguidas en el render antes de rendirse. */
const MAX_RENDER_ERRORS = 60;
const STATS_INTERVAL_MS = 15_000;
const PLACEMENT_CHECK_MS = 20_000;

let stopping = false;
let streamer: FfmpegStreamer | null = null;
let currentBot: Bot | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Error irrecuperable: salimos con código 1 y Docker reinicia el contenedor. */
function fatal(message: string): never {
  log("error", `Error irrecuperable: ${message}`);
  stopping = true;
  try {
    currentBot?.end("fatal");
  } catch {
    // nada que hacer
  }
  // No esperamos a ffmpeg: al cerrarse nuestro stdin termina solo.
  process.exit(1);
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("info", `Recibida ${signal}; cerrando la cámara.`);
  try {
    currentBot?.quit("cerrando");
  } catch {
    // ya estaba desconectado
  }
  await streamer?.stop();
  process.exit(0);
}

function fighterFeet(bot: Bot | null, username: string): Vec | null {
  const entity = bot?.players[username]?.entity;
  if (!entity) return null;
  return { x: entity.position.x, y: entity.position.y, z: entity.position.z };
}

/**
 * Loop de render: a CAMERA_FPS (o tan rápido como dé la CPU) mueve la cámara,
 * dibuja y entrega el frame a ffmpeg. Si ffmpeg todavía no consumió el frame
 * anterior, NO se dibuja (frame descartado): así nunca se acumula memoria.
 */
function startRenderLoop(config: CameraConfig, stage: Stage, ffmpeg: FfmpegStreamer): void {
  const frameMs = 1000 / config.fps;
  // Un único buffer reutilizado: solo se sobreescribe cuando ffmpeg ya terminó de leerlo.
  const pixels = new Uint8Array(config.width * config.height * 4);
  const frame = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);

  const center: Vec = { x: ARENA.center.x, y: ARENA.center.y, z: ARENA.center.z };
  const basePosition: Vec = { x: ARENA.camera.x, y: ARENA.camera.y, z: ARENA.camera.z };
  let aim: Vec = { x: center.x, y: center.y + AIM_HEIGHT, z: center.z };

  const startedAt = performance.now();
  let lastTick = startedAt;
  let renderErrors = 0;
  let sent = 0;
  let dropped = 0;
  let lastStats = startedAt;

  const tick = (): void => {
    if (stopping) return;
    const now = performance.now();
    const dt = Math.min(1, (now - lastTick) / 1000);
    lastTick = now;
    const elapsed = (now - startedAt) / 1000;

    try {
      const bot = currentBot;
      const fighters: Vec[] = [];
      for (const side of SIDES) {
        const feet = fighterFeet(bot, AGENT_USERNAMES[side]);
        stage.setMarker(side, feet, elapsed);
        if (feet) fighters.push({ x: feet.x, y: feet.y + AIM_HEIGHT, z: feet.z });
      }
      const target = pickAimTarget(fighters, { x: center.x, y: center.y + AIM_HEIGHT, z: center.z });
      aim = smoothToward(aim, target, dt, AIM_SMOOTHING_SECONDS);
      stage.setCamera(orbitPosition(basePosition, center, elapsed, config.orbitSeconds), aim);

      if (!stage.ready) {
        // Todavía no hay mundo (el bot nunca se ha conectado): nada que dibujar.
        dropped += 1;
      } else if (ffmpeg.canWrite) {
        stage.render(pixels);
        if (ffmpeg.write(frame)) sent += 1;
        else dropped += 1;
      } else {
        // ffmpeg ocupado o caído: mantenemos la escena al día pero no dibujamos.
        stage.update();
        dropped += 1;
      }
      renderErrors = 0;
    } catch (err) {
      renderErrors += 1;
      if (renderErrors === 1 || renderErrors % 20 === 0) {
        log("error", `Falló el render de un frame (${renderErrors} seguidos): ${errorText(err)}`);
      }
      if (renderErrors >= MAX_RENDER_ERRORS) {
        fatal(`el render falló ${renderErrors} veces seguidas: ${errorText(err)}`);
      }
    }

    const after = performance.now();
    if (after - lastStats >= STATS_INTERVAL_MS) {
      const seconds = (after - lastStats) / 1000;
      log(
        "info",
        `Video: ${(sent / seconds).toFixed(1)} fps enviados a ffmpeg (objetivo ${config.fps}), ` +
          `${dropped} ticks sin frame, bot ${currentBot ? "conectado" : "desconectado"}.`,
      );
      sent = 0;
      dropped = 0;
      lastStats = after;
    }

    // Siempre cedemos al menos 1 ms al event loop (red, workers de chunks, ffmpeg).
    setTimeout(tick, Math.max(1, frameMs - (after - now)));
  };

  tick();
}

/**
 * Mantiene a la cámara en modo espectador y en su sitio mientras dure la sesión.
 * Reintenta por RCON hasta lograrlo y vuelve a revisar cada cierto tiempo (por si
 * el orquestador u otro comando la mueve o le cambia el modo de juego).
 */
async function keepPlaced(config: CameraConfig, bot: Bot, isOver: () => boolean, onPlaced: () => void): Promise<void> {
  let announced = false;
  let failures = 0;
  while (!isOver() && !stopping) {
    if (!announced || isMisplaced(bot)) {
      try {
        await placeCamera(config);
        failures = 0;
        if (!announced) {
          announced = true;
          log("info", "Cámara en modo espectador y en posición (vía RCON).");
        }
        // Damos tiempo a que lleguen los chunks de la arena y los recargamos.
        await sleep(3_000);
        if (!isOver()) onPlaced();
      } catch (err) {
        failures += 1;
        if (failures === 1 || failures % 10 === 0) {
          log(
            "warn",
            `No se pudo ubicar la cámara por RCON (${config.rcon.host}:${config.rcon.port}, intento ${failures}): ` +
              `${errorText(err)}`,
          );
        }
        await sleep(3_000);
        continue;
      }
    }
    await sleep(PLACEMENT_CHECK_MS);
  }
}

/** Conecta el bot, lo mantiene, y reconecta cuando se cae. */
async function runBotLoop(config: CameraConfig, stage: Stage): Promise<void> {
  let failures = 0;
  while (!stopping) {
    try {
      log("info", `Conectando a Minecraft ${config.mc.host}:${config.mc.port} como ${config.username}...`);
      const session = await connectBot(config);
      failures = 0;
      log("info", `Bot conectado (versión ${session.bot.version}).`);

      let over = false;
      // attachWorld lanza FatalError si la versión no está soportada: sale del loop.
      const world = stage.attachWorld(session.bot);
      currentBot = session.bot;
      void keepPlaced(
        config,
        session.bot,
        () => over,
        () => world.refresh(),
      );

      const reason = await session.ended;
      over = true;
      currentBot = null;
      world.detach();
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

async function main(): Promise<void> {
  const config = loadConfig();
  log(
    "info",
    `Cámara ${config.width}x${config.height} a ${config.fps} fps -> ${config.rtmpUrl} ` +
      `(órbita: ${config.orbitSeconds > 0 ? `${config.orbitSeconds} s por vuelta` : "fija"}, ` +
      `distancia de visión: ${config.viewDistance} chunks).`,
  );

  const stage = createStage({ width: config.width, height: config.height, viewDistance: config.viewDistance });
  log("info", "Contexto WebGL headless creado.");

  const ffmpeg = new FfmpegStreamer({
    width: config.width,
    height: config.height,
    fps: config.fps,
    rtmpUrl: config.rtmpUrl,
    bitrateKbps: config.bitrateKbps,
    silentAudio: config.silentAudio,
    onFatal: (message) => fatal(message),
  });
  streamer = ffmpeg;
  ffmpeg.start();

  // El loop parte ya, pero solo empieza a enviar video cuando el bot entra por primera
  // vez al mundo; después sigue enviando (cielo vacío) aunque el bot se desconecte.
  startRenderLoop(config, stage, ffmpeg);
  await runBotLoop(config, stage);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  fatal(`excepción no capturada: ${err instanceof Error ? (err.stack ?? err.message) : errorText(err)}`);
});
process.on("unhandledRejection", (reason) => {
  fatal(`promesa rechazada sin manejar: ${reason instanceof Error ? (reason.stack ?? reason.message) : errorText(reason)}`);
});

main().catch((err: unknown) => {
  if (stopping) return;
  fatal(errorText(err));
});
