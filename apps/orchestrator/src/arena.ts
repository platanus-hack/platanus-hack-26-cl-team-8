import {
  AGENT_USERNAMES,
  MAX_HEALTH,
  arenaFor,
  type ArenaScenario,
  type ArenaScenarioId,
  type ArenaSpawn,
  type Side,
} from "@phack/protocol";
import {
  chunkBattleBuildCommands,
  chunkBattleLayout,
  placeTemplateFailed,
  randomChunkBattleSeed,
  type ChunkBattleLayout,
} from "./chunkbattle";
import { floorBounds, platanusBuildCommands } from "./platanus";
import type { RconLike } from "./rcon";
import type { SleepFn } from "./util";
import type { Kit, KitItem } from "@phack/protocol";

/**
 * Preparación de la arena y de los peleadores por RCON.
 * Sintaxis de comandos de Minecraft Java 1.20.4.
 *
 * El escenario es por pelea: `planArena(escenario, semilla)` arma el plan (`ArenaSetup`)
 * y las funciones de abajo lo reciben. También aceptan un `ArenaScenario` suelto (se usa
 * el último plan construido de ese escenario o uno sin semilla) y, si falta, usan el de
 * ARENA_SCENARIO (compatibilidad).
 */

/** Escenario configurado en ARENA_SCENARIO (vacío = el por defecto, "platanus"). */
export function activeArena(): ArenaScenario {
  return arenaFor(process.env.ARENA_SCENARIO);
}

/**
 * Plan concreto de una pelea: escenario, semilla y spawns reales. En Chunk Battle la
 * semilla decide las islas (sin semilla se sortea una); en los demás escenarios no cambia
 * nada y queda registrada tal cual (o null).
 */
export type ArenaSetup = {
  arena: ArenaScenario;
  seed: number | null;
  spawns: Record<Side, ArenaSpawn>;
  /** Solo Chunk Battle: islas que salieron por semilla. */
  chunkBattle: ChunkBattleLayout | null;
};

export type ArenaTarget = ArenaScenario | ArenaSetup;

/** Arma el plan de una pelea para un escenario EXPLÍCITO (objeto o id) y una semilla opcional. */
export function planArena(
  scenario: ArenaScenario | ArenaScenarioId | string,
  seed?: number | null,
  random: () => number = Math.random,
): ArenaSetup {
  const arena = typeof scenario === "string" ? arenaFor(scenario) : scenario;
  if (arena.kind === "islands") {
    const chunkBattle = chunkBattleLayout(arena, seed ?? randomChunkBattleSeed(random));
    return {
      arena,
      seed: chunkBattle.seed,
      spawns: { red: chunkBattle.red.spawn, blue: chunkBattle.blue.spawn },
      chunkBattle,
    };
  }
  return { arena, seed: seed ?? null, spawns: { ...arena.spawns }, chunkBattle: null };
}

function isSetup(target: ArenaTarget): target is ArenaSetup {
  return "spawns" in target && "chunkBattle" in target;
}

/** Último plan construido por escenario: lo usan las llamadas que pasan un escenario suelto. */
const lastBuilt = new Map<ArenaScenarioId, ArenaSetup>();

/**
 * Plan de un objetivo. Con un escenario suelto se usa el último plan construido de ese
 * escenario (así el teletransporte calza con las islas que armó `buildArena`); si nunca
 * se construyó, se planifica sin semilla. Lo correcto es pasar el plan de la pelea.
 */
export function toSetup(target: ArenaTarget = activeArena()): ArenaSetup {
  if (isSetup(target)) return target;
  return lastBuilt.get(target.id) ?? planArena(target);
}

function arenaOf(target: ArenaTarget): ArenaScenario {
  return isSetup(target) ? target.arena : target;
}

/** Caja que ocupa la arena en planta (piso, plantilla y su destino, o islas). */
function arenaBounds(arena: ArenaScenario): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (arena.kind === "built") return floorBounds(arena);
  if (arena.kind === "islands") {
    const { from, to } = arena.clearBox;
    return { minX: from.x, maxX: to.x, minZ: from.z, maxZ: to.z };
  }
  const { center: c, radius, template } = arena;
  return {
    minX: Math.min(c.x - radius, template.from.x),
    maxX: Math.max(c.x + radius, template.to.x),
    minZ: Math.min(c.z - radius, template.from.z),
    maxZ: Math.max(c.z + radius, template.to.z),
  };
}

/** Reglas del mundo: sin mobs, siempre de día, PvP con daño visible. */
export function worldRuleCommands(target: ArenaTarget = activeArena()): string[] {
  const { red } = toSetup(target).spawns;
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
    // La lava de los cubos no debe incendiar los tablones: el fuego no se propaga.
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
export function forceloadCommand(target: ArenaTarget = activeArena()): string {
  const arena = arenaOf(target);
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
 *  - Chunk Battle (mundo vacío): islas de la semilla del plan (ver chunkbattle.ts).
 * El primer comando es el que toca chunks; buildArena reintenta cualquiera que caiga en
 * un chunk que aún no cargó.
 */
export function arenaBuildCommands(target: ArenaTarget = activeArena()): string[] {
  const setup = toSetup(target);
  const { arena } = setup;
  if (arena.kind === "built") return platanusBuildCommands(arena);
  if (arena.kind === "islands") return chunkBattleBuildCommands(arena, setup.chunkBattle!);
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
 * Borra lo que los peleadores dejaron dentro de la arena: bloques (tablones, roca y la
 * obsidiana que deja el agua sobre la lava), el agua y la lava de los cubos y el fuego. Un
 * comando por cosa: `fill ... replace` acepta un solo filtro (que puede ser un tag de bloques).
 * Los filtros de lana y tierra quedan de cuando el catálogo las tenía: hoy no borran nada.
 */
export function clearPlacedBlocksCommands(target: ArenaTarget = activeArena()): string[] {
  const arena = arenaOf(target);
  // Un mapa de plantilla (Pizza Spleef 2) tiene lana y otros bloques propios sobre el piso,
  // y las islas de Chunk Battle tienen su propio terreno (roca, tierra, madera): no se
  // tocan aquí, se reconstruyen enteros antes de la pelea siguiente.
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

export function teleportCommand(side: Side, target: ArenaTarget = activeArena()): string {
  const spawn = toSetup(target).spawns[side];
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

export async function applyWorldRules(rcon: RconLike, target: ArenaTarget = activeArena()): Promise<void> {
  await sendAll(rcon, worldRuleCommands(target));
}

/**
 * Construye o restaura la arena del plan. Devuelve el plan usado (útil cuando se pasa un
 * escenario suelto: trae la semilla sorteada y los spawns reales).
 */
export async function buildArena(rcon: RconLike, sleep: SleepFn, target: ArenaTarget = activeArena()): Promise<ArenaSetup> {
  // Un escenario suelto se reconstruye con un plan nuevo (en Chunk Battle, otra semilla).
  const setup = isSetup(target) ? target : planArena(target);
  lastBuilt.set(setup.arena.id, setup);
  const { arena } = setup;
  await rcon.send(forceloadCommand(arena));
  if (arena.kind === "template") {
    const { at, block } = arena.check;
    await sendWhenLoaded(rcon, `execute if block ${at.x} ${at.y} ${at.z} ${block}`, sleep, arena);
  }
  const [first, ...rest] = arenaBuildCommands(setup);
  if (first !== undefined) await sendWhenLoaded(rcon, first, sleep, arena);
  for (const command of rest) {
    // El forceload carga los chunks de a poco: cualquier comando (no solo el primero) puede
    // caer en uno que aún no cargó. Sin reintento quedarían restos de la pelea anterior.
    let response = await rcon.send(command);
    for (let attempt = 1; attempt < 15 && /not loaded/i.test(response); attempt += 1) {
      await sleep(1_000);
      response = await rcon.send(command);
    }
    if (/not loaded/i.test(response)) {
      throw new Error("La zona de la arena no terminó de cargar en el servidor de Minecraft");
    }
    if (command.startsWith("place template ") && placeTemplateFailed(response)) {
      throw new Error(
        `No se pudo colocar una estructura de ${arena.name} (${command.split(" ")[2]}): "${response.trim()}". ` +
          `Revisa que el datapack phack-chunkbattle esté instalado en el mundo ${arena.level} del servidor.`,
      );
    }
  }
  return setup;
}

/** Al terminar una pelea: que los muros de tablones no sigan en la transmisión hasta la próxima. */
export async function clearPlacedBlocks(rcon: RconLike, target: ArenaTarget = activeArena()): Promise<void> {
  await sendAll(rcon, clearPlacedBlocksCommands(target));
}

/**
 * Modo por rondas, entre una ronda y la siguiente: deja la arena como al empezar la serie.
 * Platanus y la pizza solo borran lo colocado (ver clearPlacedBlocksCommands). Chunk
 * Battle se reconstruye entera con el MISMO plan (mismas islas, misma semilla): el puente
 * y lo cavado no deben seguir en la ronda siguiente. Como la reconstrucción vacía primero
 * todo el volumen, los peleadores esperan arriba, flotando con caída lenta, y la caída
 * lenta se les quita al terminar, ya de vuelta en su spawn (no debe durar en la ronda:
 * cambiaría la pelea). Después hay que curarlos y darles el kit (resetFighterForRound o
 * prepareFighter).
 */
export async function resetArenaForRound(rcon: RconLike, sleep: SleepFn, setup: ArenaSetup): Promise<void> {
  const { arena } = setup;
  if (arena.kind !== "islands") {
    await clearPlacedBlocks(rcon, setup);
    return;
  }
  const above = arena.clearBox.to.y + 2;
  const users = [AGENT_USERNAMES.red, AGENT_USERNAMES.blue];
  await sendAll(
    rcon,
    (["red", "blue"] as const).flatMap((side) => {
      const spawn = setup.spawns[side];
      const username = AGENT_USERNAMES[side];
      return [
        `effect give ${username} minecraft:slow_falling 30 0 true`,
        `tp ${username} ${spawn.x + 0.5} ${above} ${spawn.z + 0.5}`,
      ];
    }),
  );
  await buildArena(rcon, sleep, setup);
  // Primero de vuelta al spawn y recién ahí sin caída lenta: quitarla arriba los dejaría
  // cayendo ~30 bloques mientras se prepara el otro lado (con un servidor lento, a la muerte).
  await sendAll(rcon, [
    ...(["red", "blue"] as const).map((side) => teleportCommand(side, setup)),
    ...users.map((username) => `effect clear ${username} minecraft:slow_falling`),
  ]);
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
  target: ArenaTarget = activeArena(),
): Promise<void> {
  const username = AGENT_USERNAMES[side];
  await sendAll(rcon, [`gamemode survival ${username}`, `clear ${username}`, `effect clear ${username}`]);

  const tpResponse = await rcon.send(teleportCommand(side, target));
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
  target: ArenaTarget = activeArena(),
): Promise<void> {
  const username = AGENT_USERNAMES[side];
  const tpResponse = await rcon.send(teleportCommand(side, target));
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
