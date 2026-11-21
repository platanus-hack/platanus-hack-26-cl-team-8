import { AGENT_USERNAMES, ARENA, type Side } from "@phack/protocol";
import type { RconLike } from "./rcon";
import type { SleepFn } from "./util";

/**
 * Construcción de la arena y preparación de los peleadores por RCON.
 * Sintaxis de comandos de Minecraft Java 1.20.4.
 */

const c = ARENA.center;
/** Las paredes van un bloque afuera del radio interior. */
const WALL = ARENA.radius + 1;
const MIN_X = c.x - WALL;
const MAX_X = c.x + WALL;
const MIN_Z = c.z - WALL;
const MAX_Z = c.z + WALL;
const FLOOR_Y = c.y;
const WALL_TOP_Y = c.y + ARENA.wallHeight;
/** Se limpia un poco más arriba que las paredes. */
const CLEAR_TOP_Y = WALL_TOP_Y + 6;

/** RCON de Minecraft no siempre respeta UTF-8: los textos van con escapes \uXXXX. */
export function jsonText(component: Record<string, unknown>): string {
  return JSON.stringify(component).replace(
    /[\u0080-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function titleCommand(text: string, color: string): string {
  return `title @a title ${jsonText({ text, color, bold: true })}`;
}

export function subtitleCommand(text: string, color: string): string {
  return `title @a subtitle ${jsonText({ text, color })}`;
}

/** Reglas del mundo: sin mobs, siempre de día, PvP con daño visible. */
export function worldRuleCommands(): string[] {
  return [
    // En "normal" el daño entre jugadores y el hambre funcionan; los mobs se apagan con la regla.
    "difficulty normal",
    "gamerule doMobSpawning false",
    "gamerule doPatrolSpawning false",
    "gamerule doTraderSpawning false",
    "gamerule doInsomnia false",
    "gamerule doDaylightCycle false",
    "gamerule doWeatherCycle false",
    "gamerule keepInventory true",
    // Con regeneración natural, comer sirve de algo (los prompts pueden decidir cuándo comer).
    "gamerule naturalRegeneration true",
    "gamerule doImmediateRespawn true",
    "gamerule announceAdvancements false",
    "gamerule spawnRadius 0",
    "time set 6000",
    "weather clear",
    `setworldspawn ${c.x} ${FLOOR_Y + 1} ${c.z}`,
  ];
}

/** Área que debe quedar cargada aunque no haya jugadores (arena + cámara). */
export function forceloadCommand(): string {
  const pad = 8;
  const minX = Math.min(MIN_X, ARENA.camera.x) - pad;
  const maxX = Math.max(MAX_X, ARENA.camera.x) + pad;
  const minZ = Math.min(MIN_Z, ARENA.camera.z) - pad;
  const maxZ = Math.max(MAX_Z, ARENA.camera.z) + pad;
  return `forceload add ${minX} ${minZ} ${maxX} ${maxZ}`;
}

/** Piso, limpieza del interior, paredes de vidrio con base luminosa y marcas de spawn. */
export function arenaBuildCommands(): string[] {
  const { red, blue } = ARENA.spawns;
  return [
    // Fuera flechas, items tirados y cualquier entidad que no sea jugador.
    "kill @e[type=!minecraft:player]",
    // Limpiar todo el volumen (interior + paredes viejas).
    `fill ${MIN_X} ${FLOOR_Y + 1} ${MIN_Z} ${MAX_X} ${CLEAR_TOP_Y} ${MAX_Z} minecraft:air`,
    // Piso.
    `fill ${MIN_X} ${FLOOR_Y} ${MIN_Z} ${MAX_X} ${FLOOR_Y} ${MAX_Z} minecraft:smooth_stone`,
    // Cuatro paredes de vidrio (la cámara ve a través).
    `fill ${MIN_X} ${FLOOR_Y + 1} ${MIN_Z} ${MAX_X} ${WALL_TOP_Y} ${MIN_Z} minecraft:glass`,
    `fill ${MIN_X} ${FLOOR_Y + 1} ${MAX_Z} ${MAX_X} ${WALL_TOP_Y} ${MAX_Z} minecraft:glass`,
    `fill ${MIN_X} ${FLOOR_Y + 1} ${MIN_Z} ${MIN_X} ${WALL_TOP_Y} ${MAX_Z} minecraft:glass`,
    `fill ${MAX_X} ${FLOOR_Y + 1} ${MIN_Z} ${MAX_X} ${WALL_TOP_Y} ${MAX_Z} minecraft:glass`,
    // Luz: la primera fila de cada pared es de linternas de mar.
    `fill ${MIN_X} ${FLOOR_Y + 1} ${MIN_Z} ${MAX_X} ${FLOOR_Y + 1} ${MIN_Z} minecraft:sea_lantern`,
    `fill ${MIN_X} ${FLOOR_Y + 1} ${MAX_Z} ${MAX_X} ${FLOOR_Y + 1} ${MAX_Z} minecraft:sea_lantern`,
    `fill ${MIN_X} ${FLOOR_Y + 1} ${MIN_Z} ${MIN_X} ${FLOOR_Y + 1} ${MAX_Z} minecraft:sea_lantern`,
    `fill ${MAX_X} ${FLOOR_Y + 1} ${MIN_Z} ${MAX_X} ${FLOOR_Y + 1} ${MAX_Z} minecraft:sea_lantern`,
    // Marcas en el piso: centro y esquinas de cada lado.
    `setblock ${c.x} ${FLOOR_Y} ${c.z} minecraft:sea_lantern`,
    `setblock ${red.x} ${FLOOR_Y} ${red.z} minecraft:red_concrete`,
    `setblock ${blue.x} ${FLOOR_Y} ${blue.z} minecraft:blue_concrete`,
  ];
}

/** Kit idéntico para ambos lados. */
export function fighterKitCommands(username: string): string[] {
  return [
    `give ${username} minecraft:iron_sword 1`,
    `give ${username} minecraft:bow 1`,
    `give ${username} minecraft:arrow 16`,
    `give ${username} minecraft:cooked_beef 4`,
    `item replace entity ${username} armor.head with minecraft:iron_helmet`,
    `item replace entity ${username} armor.chest with minecraft:iron_chestplate`,
    `item replace entity ${username} armor.legs with minecraft:iron_leggings`,
    `item replace entity ${username} armor.feet with minecraft:iron_boots`,
  ];
}

export function teleportCommand(side: Side): string {
  const spawn = ARENA.spawns[side];
  // +0.5 para caer al centro del bloque; pitch 0 = mirando al frente.
  return `tp ${AGENT_USERNAMES[side]} ${spawn.x + 0.5} ${spawn.y} ${spawn.z + 0.5} ${spawn.yaw} 0`;
}

async function sendAll(rcon: RconLike, commands: string[]): Promise<void> {
  for (const command of commands) await rcon.send(command);
}

/** /fill falla si el chunk aún no cargó tras el forceload: se reintenta un rato. */
async function sendWhenLoaded(rcon: RconLike, command: string, sleep: SleepFn): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await rcon.send(command);
    if (!/not loaded/i.test(response)) return;
    await sleep(1_000);
  }
  throw new Error("La zona de la arena no terminó de cargar en el servidor de Minecraft");
}

export async function applyWorldRules(rcon: RconLike): Promise<void> {
  await sendAll(rcon, worldRuleCommands());
}

export async function buildArena(rcon: RconLike, sleep: SleepFn): Promise<void> {
  await rcon.send(forceloadCommand());
  for (const command of arenaBuildCommands()) {
    if (command.startsWith("fill ") || command.startsWith("setblock ")) {
      await sendWhenLoaded(rcon, command, sleep);
    } else {
      await rcon.send(command);
    }
  }
}

/** Deja a un peleador listo: supervivencia, limpio, curado, en su spawn y con el kit. */
export async function prepareFighter(rcon: RconLike, side: Side): Promise<void> {
  const username = AGENT_USERNAMES[side];
  await sendAll(rcon, [`gamemode survival ${username}`, `clear ${username}`, `effect clear ${username}`]);

  const tpResponse = await rcon.send(teleportCommand(side));
  if (/no (player|entity) was found/i.test(tpResponse)) {
    throw new Error(`${username} no está conectado al servidor de Minecraft`);
  }

  await sendAll(rcon, [
    `effect give ${username} minecraft:instant_health 1 10 true`,
    `effect give ${username} minecraft:saturation 1 10 true`,
    ...fighterKitCommands(username),
  ]);
}

/** Cuenta regresiva en pantalla; se corta si la pelea se canceló. */
export async function runCountdown(rcon: RconLike, sleep: SleepFn, isCancelled: () => boolean): Promise<void> {
  await rcon.send("title @a reset");
  await rcon.send("title @a times 0 25 5");
  for (const n of [3, 2, 1]) {
    if (isCancelled()) return;
    await rcon.send(titleCommand(String(n), "gold"));
    await sleep(1_000);
  }
  if (isCancelled()) return;
  await rcon.send(subtitleCommand("Rojo vs Azul", "white"));
  await rcon.send(titleCommand("¡A pelear!", "green"));
}

export async function announce(rcon: RconLike, title: string, color: string): Promise<void> {
  // "reset" borra el subtítulo de la cuenta regresiva.
  await rcon.send("title @a reset");
  await rcon.send("title @a times 5 60 20");
  await rcon.send(titleCommand(title, color));
}
