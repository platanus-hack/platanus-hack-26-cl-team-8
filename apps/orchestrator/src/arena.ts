import { AGENT_USERNAMES, MAX_HEALTH, arenaFor, type ArenaScenario, type Side } from "@phack/protocol";
import { floorBounds, platanusBuildCommands } from "./platanus";
import type { RconLike } from "./rcon";
import type { SleepFn } from "./util";
import type { Kit, KitItem } from "@phack/protocol";

/**
 * Preparación de la arena y de los peleadores por RCON.
 * Sintaxis de comandos de Minecraft Java 1.20.4.
 *
 * El escenario sale de ARENA_SCENARIO (ver ARENAS en @phack/protocol). Todas las
 * funciones aceptan el escenario como último argumento; si falta, usan el activo.
 */

/** Escenario configurado en ARENA_SCENARIO (vacío = el por defecto, "platanus"). */
export function activeArena(): ArenaScenario {
  return arenaFor(process.env.ARENA_SCENARIO);
}

/** Caja que ocupa la arena en planta (piso, plantilla y su destino). */
function arenaBounds(arena: ArenaScenario): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (arena.kind === "built") return floorBounds(arena);
  const { center: c, radius, template } = arena;
  return {
    minX: Math.min(c.x - radius, template.from.x),
    maxX: Math.max(c.x + radius, template.to.x),
    minZ: Math.min(c.z - radius, template.from.z),
    maxZ: Math.max(c.z + radius, template.to.z),
  };
}

/** Reglas del mundo: sin mobs, siempre de día, PvP con daño visible. */
export function worldRuleCommands(arena: ArenaScenario = activeArena()): string[] {
  const { red } = arena.spawns;
  return [
    // En "normal" el daño entre jugadores y el hambre funcionan; los mobs se apagan con la regla.
    "difficulty normal",
    "gamerule doMobSpawning false",
    "gamerule doPatrolSpawning false",
    "gamerule doTraderSpawning false",
    "gamerule doInsomnia false",
    "gamerule doDaylightCycle false",
    "gamerule doWeatherCycle false",
    "gamerule doFireTick false",
    "gamerule keepInventory true",
    // Con regeneración natural, comer sirve de algo (los prompts pueden decidir cuándo comer).
    "gamerule naturalRegeneration true",
    // La lava de los cubos no debe incendiar la lana ni los tablones: el fuego no se propaga.
    "gamerule doFireTick false",
    "gamerule doImmediateRespawn true",
    "gamerule announceAdvancements false",
    // Nada de avisos dentro del juego (muertes, logros): eso lo muestra el sitio web.
    "gamerule showDeathMessages false",
    "gamerule spawnRadius 0",
    "time set 6000",
    "weather clear",
    // En la pizza el centro tiene un ingrediente con telarañas: el spawn rojo tiene espacio libre.
    `setworldspawn ${red.x} ${red.y} ${red.z}`,
  ];
}

/** Área que debe quedar cargada aunque no haya jugadores (arena + cámaras). */
export function forceloadCommand(arena: ArenaScenario = activeArena()): string {
  const pad = 8;
  const b = arenaBounds(arena);
  const minX = Math.min(b.minX, arena.camera.x, arena.cameraWide.x) - pad;
  const maxX = Math.max(b.maxX, arena.camera.x, arena.cameraWide.x) + pad;
  const minZ = Math.min(b.minZ, arena.camera.z, arena.cameraWide.z) - pad;
  const maxZ = Math.max(b.maxZ, arena.camera.z, arena.cameraWide.z) + pad;
  return `forceload add ${minX} ${minZ} ${maxX} ${maxZ}`;
}

/**
 * Comandos que dejan la arena como nueva entre peleas.
 *  - Pizza Spleef 2 (mapa del ZIP): se restaura su plantilla original y se limpian restos
 *    del combate. Las entidades decorativas y la lógica original del mapa se conservan.
 *  - Platanus (mundo vacío): se reconstruye entera (ver platanus.ts).
 * El primer comando es el que toca chunks: es el que se reintenta si aún no cargaron.
 */
export function arenaBuildCommands(arena: ArenaScenario = activeArena()): string[] {
  if (arena.kind === "built") return platanusBuildCommands(arena);
  const { center: c, template } = arena;
  const { from, to, destination } = template;
  const cleanup = ["item", "arrow", "spectral_arrow", "experience_orb"].map(
    (type) => `kill @e[type=minecraft:${type},x=${c.x},y=${c.y},z=${c.z},distance=..${arena.radius + 8}]`,
  );
  return [
    `clone ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} ${destination.x} ${destination.y} ${destination.z} replace`,
    ...cleanup,
  ];
}

/** Encantamientos y tipo de poción en el formato NBT de 1.20.4: `{Enchantments:[{id:"minecraft:punch",lvl:1s}]}`, `{Potion:"minecraft:healing"}`. */
function itemNbt(item: KitItem): string {
  const tags: string[] = [];
  if (item.enchantments?.length) {
    const list = item.enchantments.map((e) => `{id:"minecraft:${e.id}",lvl:${e.level}s}`).join(",");
    tags.push(`Enchantments:[${list}]`);
  }
  // Pociones (1.20.4): el tipo va en la etiqueta Potion.
  if (item.potion) tags.push(`Potion:"minecraft:${item.potion}"`);
  return tags.length > 0 ? `{${tags.join(",")}}` : "";
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
    ...kitEffectCommands(username, kit),
  ];
}

/** Los efectos permanentes del kit (por ejemplo, la velocidad del Berserker). */
export function kitEffectCommands(username: string, kit: Kit): string[] {
  return kit.effects.map((e) => `effect give ${username} minecraft:${e.id} infinite ${e.amplifier} true`);
}

/**
 * Borra lo que los peleadores dejaron dentro de la arena: bloques (tablones y lana), el
 * agua y la lava de los cubos y el fuego. Un comando por cosa: `fill ... replace` acepta
 * un solo filtro (que puede ser un tag de bloques).
 */
export function clearPlacedBlocksCommands(arena: ArenaScenario = activeArena()): string[] {
  // Un mapa de plantilla (Pizza Spleef 2) tiene lana y otros bloques propios sobre el piso:
  // no se toca aquí, se restaura entero con su plantilla antes de la pelea siguiente.
  if (arena.kind !== "built") return [];
  const { minX, maxX, minZ, maxZ } = floorBounds(arena);
  const floorY = arena.center.y;
  const box = `fill ${minX + 1} ${floorY + 1} ${minZ + 1} ${maxX - 1} ${floorY + arena.wallHeight} ${maxZ - 1} minecraft:air replace`;
  return [
    "#minecraft:planks",
    "#minecraft:wool",
    "minecraft:cobblestone",
    "minecraft:dirt",
    "minecraft:obsidian",
    "minecraft:water",
    "minecraft:lava",
    "minecraft:fire",
  ].map(
    (filter) => `${box} ${filter}`,
  );
}

export function teleportCommand(side: Side, arena: ArenaScenario = activeArena()): string {
  const spawn = arena.spawns[side];
  // +0.5 para caer al centro del bloque; pitch 0 = mirando al frente.
  return `tp ${AGENT_USERNAMES[side]} ${spawn.x + 0.5} ${spawn.y} ${spawn.z + 0.5} ${spawn.yaw} 0`;
}

async function sendAll(rcon: RconLike, commands: string[]): Promise<void> {
  for (const command of commands) await rcon.send(command);
}

/**
 * Reintenta mientras el chunk no haya cargado tras el forceload. Una prueba `execute if`
 * fallida significa que el servidor tiene otro mundo cargado.
 */
async function sendWhenLoaded(rcon: RconLike, command: string, sleep: SleepFn, arena: ArenaScenario): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await rcon.send(command);
    if (!/not loaded/i.test(response)) {
      if (/test failed|testfail/i.test(response)) {
        throw new Error(`No está cargado el mapa ${arena.name}. Revisa el mundo ${arena.level} del servidor.`);
      }
      return;
    }
    await sleep(1_000);
  }
  throw new Error("La zona de la arena no terminó de cargar en el servidor de Minecraft");
}

export async function applyWorldRules(rcon: RconLike, arena: ArenaScenario = activeArena()): Promise<void> {
  await sendAll(rcon, worldRuleCommands(arena));
}

export async function buildArena(rcon: RconLike, sleep: SleepFn, arena: ArenaScenario = activeArena()): Promise<void> {
  await rcon.send(forceloadCommand(arena));
  if (arena.kind === "template") {
    const { at, block } = arena.check;
    await sendWhenLoaded(rcon, `execute if block ${at.x} ${at.y} ${at.z} ${block}`, sleep, arena);
  }
  const [first, ...rest] = arenaBuildCommands(arena);
  if (first !== undefined) await sendWhenLoaded(rcon, first, sleep, arena);
  await sendAll(rcon, rest);
}

/** Al terminar una pelea: que los muros de tablones no sigan en la transmisión hasta la próxima. */
export async function clearPlacedBlocks(rcon: RconLike, arena: ArenaScenario = activeArena()): Promise<void> {
  await sendAll(rcon, clearPlacedBlocksCommands(arena));
}

/**
 * Lo que responde el servidor cuando un comando de kit funcionó:
 * "Replaced a slot on AgenteRojo with [Iron Sword]" o "Applied effect Speed to AgenteRojo".
 */
const KIT_COMMAND_OK = /Replaced a slot|Applied effect/i;

/**
 * Deja a un peleador listo: supervivencia, limpio, curado, en su spawn y con su kit.
 *
 * Un slot o un NBT mal escrito no hace fallar el comando por RCON: el servidor solo responde
 * con un texto de error y el peleador queda sin ese objeto. Por eso se revisa la respuesta de
 * cada comando del kit y se avisa por `warn`; la pelea sigue igual.
 */
export async function prepareFighter(
  rcon: RconLike,
  side: Side,
  kit: Kit,
  warn: (text: string) => void = () => {},
  arena: ArenaScenario = activeArena(),
): Promise<void> {
  const username = AGENT_USERNAMES[side];
  await sendAll(rcon, [`gamemode survival ${username}`, `clear ${username}`, `effect clear ${username}`]);

  const tpResponse = await rcon.send(teleportCommand(side, arena));
  if (/no (player|entity) was found/i.test(tpResponse)) {
    throw new Error(`${username} no está conectado al servidor de Minecraft`);
  }

  // El color del equipo tiñe el nametag. Si el equipo ya existe de una pelea anterior,
  // `team add` no lo cambia; se reaplican el color y la pertenencia en cada preparación.
  const team = `phack_${side}`;
  await sendAll(rcon, [
    `team add ${team}`,
    `team modify ${team} color ${side}`,
    `team join ${team} ${username}`,
  ]);

  await sendAll(rcon, [
    // Primero la vida máxima y después la cura: al revés quedaría con la vida de antes.
    `attribute ${username} minecraft:generic.max_health base set ${MAX_HEALTH}`,
    `effect give ${username} minecraft:instant_health 1 10 true`,
    `effect give ${username} minecraft:saturation 1 10 true`,
  ]);

  for (const command of fighterKitCommands(username, kit)) {
    const reply = (await rcon.send(command)).trim();
    if (!KIT_COMMAND_OK.test(reply)) {
      warn(
        `El servidor no confirmó un comando del kit de ${username}: "${command}" respondió "${reply || "(sin respuesta)"}"`,
      );
    }
  }
}

/**
 * Modo por rondas: deja a un peleador listo para la ronda siguiente. Vuelve a su spawn
 * con la vida completa, saciado y con los efectos permanentes de su kit. No toca el
 * inventario ni le da los ítems del kit: lo que gastó sigue gastado.
 *
 * La vida máxima se fija de nuevo porque al reaparecer después de morir vuelve a la de
 * Minecraft (y debe ir antes de la cura, como en prepareFighter).
 */
export async function resetFighterForRound(
  rcon: RconLike,
  side: Side,
  kit: Kit,
  arena: ArenaScenario = activeArena(),
): Promise<void> {
  const username = AGENT_USERNAMES[side];
  const tpResponse = await rcon.send(teleportCommand(side, arena));
  if (/no (player|entity) was found/i.test(tpResponse)) {
    throw new Error(`${username} no está conectado al servidor de Minecraft`);
  }
  await sendAll(rcon, [
    `attribute ${username} minecraft:generic.max_health base set ${MAX_HEALTH}`,
    `effect give ${username} minecraft:instant_health 1 10 true`,
    `effect give ${username} minecraft:saturation 1 10 true`,
    // Morir borra los efectos: los del kit son parte del agente, no algo que se gaste.
    ...kitEffectCommands(username, kit),
  ]);
}

/** Cada cuánto se revisa, durante la cuenta regresiva, si la pelea se canceló. */
const COUNTDOWN_STEP_MS = 250;

/**
 * Espera hasta el instante `endsAt` (epoch ms), el final de la cuenta regresiva; se corta si
 * la pelea se canceló. No muestra nada dentro del juego: la cuenta regresiva la dibuja el
 * sitio web a partir de `countdownEndsAt` del estado. La pausa cubre además la
 * invulnerabilidad inicial al entrar al mundo.
 */
export async function runCountdown(
  sleep: SleepFn,
  endsAt: number,
  isCancelled: () => boolean,
  now: () => number = Date.now,
): Promise<void> {
  // Tope de lo que se pide dormir en total: así también termina con un `sleep` que no hace
  // avanzar el reloj (los tests).
  let budget = endsAt - now();
  while (budget > 0) {
    if (isCancelled()) return;
    // Se mira el reloj en cada paso: los temporizadores se atrasan un poco y ese atraso no se acumula.
    const left = endsAt - now();
    if (left <= 0) return;
    const step = Math.min(left, budget, COUNTDOWN_STEP_MS);
    await sleep(step);
    budget -= step;
  }
}
