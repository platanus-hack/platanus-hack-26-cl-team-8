import { AGENT_USERNAMES, ARENA, type Side } from "@phack/protocol";
import type { RconLike } from "./rcon";
import type { SleepFn } from "./util";
import type { Kit, KitItem } from "@phack/protocol";

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
    // Nada de avisos dentro del juego (muertes, logros): eso lo muestra el sitio web.
    "gamerule showDeathMessages false",
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
    // Tapa invisible justo sobre los muros: nadie sale de la arena con una perla o apilando bloques.
    `fill ${MIN_X} ${WALL_TOP_Y + 1} ${MIN_Z} ${MAX_X} ${WALL_TOP_Y + 1} ${MAX_Z} minecraft:barrier`,
  ];
}

/** Encantamientos en el formato NBT de 1.20.4: `{Enchantments:[{id:"minecraft:punch",lvl:1s}]}`. */
function itemNbt(item: KitItem): string {
  if (!item.enchantments?.length) return "";
  const list = item.enchantments.map((e) => `{id:"minecraft:${e.id}",lvl:${e.level}s}`).join(",");
  return `{Enchantments:[${list}]}`;
}

/**
 * Comandos que entregan un kit: cada ítem va a su slot exacto con `item replace` (así la
 * hotbar del juego coincide con la que dibuja la web) y los efectos son permanentes.
 * Los efectos deben enviarse después de `effect clear`.
 */
export function fighterKitCommands(username: string, kit: Kit): string[] {
  return [
    ...kit.items.map(
      (i) =>
        `item replace entity ${username} ${i.slot} with minecraft:${i.item}${itemNbt(i)}${i.count > 1 ? ` ${i.count}` : ""}`,
    ),
    ...kit.effects.map((e) => `effect give ${username} minecraft:${e.id} infinite ${e.amplifier} true`),
  ];
}

/** Borra los bloques que los peleadores colocaron dentro de la arena (el kit constructor usa tablones). */
export function clearPlacedBlocksCommand(): string {
  return `fill ${MIN_X + 1} ${FLOOR_Y + 1} ${MIN_Z + 1} ${MAX_X - 1} ${WALL_TOP_Y} ${MAX_Z - 1} minecraft:air replace minecraft:oak_planks`;
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

/** Al terminar una pelea: que los muros de tablones no sigan en la transmisión hasta la próxima. */
export async function clearPlacedBlocks(rcon: RconLike): Promise<void> {
  await rcon.send(clearPlacedBlocksCommand());
}

/** Deja a un peleador listo: supervivencia, limpio, curado, en su spawn y con su kit. */
export async function prepareFighter(rcon: RconLike, side: Side, kit: Kit): Promise<void> {
  const username = AGENT_USERNAMES[side];
  await sendAll(rcon, [`gamemode survival ${username}`, `clear ${username}`, `effect clear ${username}`]);

  const tpResponse = await rcon.send(teleportCommand(side));
  if (/no (player|entity) was found/i.test(tpResponse)) {
    throw new Error(`${username} no está conectado al servidor de Minecraft`);
  }

  await sendAll(rcon, [
    `effect give ${username} minecraft:instant_health 1 10 true`,
    `effect give ${username} minecraft:saturation 1 10 true`,
    ...fighterKitCommands(username, kit),
  ]);
}

/** Segundos de pausa antes de que empiece la pelea. */
const COUNTDOWN_SECONDS = 3;

/**
 * Pausa previa a la pelea; se corta si la pelea se canceló. No muestra nada dentro del
 * juego: la cuenta regresiva, el resultado y cualquier otro aviso los muestra el sitio web.
 * La pausa sigue existiendo porque cubre la invulnerabilidad inicial al entrar al mundo.
 */
export async function runCountdown(sleep: SleepFn, isCancelled: () => boolean): Promise<void> {
  for (let n = COUNTDOWN_SECONDS; n > 0; n -= 1) {
    if (isCancelled()) return;
    await sleep(1_000);
  }
}
