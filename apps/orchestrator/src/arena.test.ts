import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "@phack/env";
import {
  ARENA,
  ARENA_SCENARIOS,
  ARENAS,
  DEFAULT_ARENA_SCENARIO,
  KITS,
  KIT_LIST,
  arenaFor,
  type BuiltArena,
  type TemplateArena,
} from "@phack/protocol";
import {
  activeArena,
  buildArena,
  clearPlacedBlocksCommands,
  fighterKitCommands,
  forceloadCommand,
  prepareFighter,
  resetFighterForRound,
  runCountdown,
  teleportCommand,
} from "./arena";
import type { RconLike } from "./rcon";

const PIZZA = ARENAS["pizza-spleef-2"] as TemplateArena;

describe("Pizza Spleef 2", () => {
  it("restaura la plantilla original sin generar otra arena ni eliminar decoraciones", async () => {
    const send = vi.fn(async (_command: string) => "Test passed, count: 1");
    const sleep = vi.fn(async () => {});
    await buildArena({ send }, sleep, PIZZA);
    await buildArena({ send }, sleep, PIZZA);

    const commands = send.mock.calls.map(([command]) => command);
    expect(commands.filter((command) => /^setblock /.test(command))).toEqual([]);
    // Las versiones con kits de construcción pueden retirar bloques y fluidos antes
    // de restaurar la plantilla. Nunca deben generar un piso ni muros nuevos.
    for (const command of commands.filter((command) => command.startsWith("fill "))) {
      expect(command).toMatch(/ minecraft:air replace (#minecraft:(planks|wool)|minecraft:(water|lava|fire))$/);
    }
    expect(commands.filter((command) => command.startsWith("clone "))).toEqual([
      "clone -25 6 -135 37 8 -73 -23 3 -23 replace",
      "clone -25 6 -135 37 8 -73 -23 3 -23 replace",
    ]);
    const cleanup = commands.filter((command) => command.startsWith("kill "));
    expect(cleanup).toHaveLength(8);
    for (const command of cleanup) {
      expect(command).toMatch(/^kill @e\[type=minecraft:(item|arrow|spectral_arrow|experience_orb),/);
      expect(command).toContain("distance=..");
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it("espera a los chunks antes de comprobar el mapa", async () => {
    const send = vi.fn(async (_command: string) => "Test passed, count: 1");
    send.mockResolvedValueOnce("").mockResolvedValueOnce("That position is not loaded");
    const sleep = vi.fn(async () => {});
    await buildArena({ send }, sleep, PIZZA);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(send.mock.calls[1]?.[0]).toBe(send.mock.calls[2]?.[0]);
  });

  it("rechaza el mundo anterior antes de preparar una pelea", async () => {
    const send = vi.fn(async (_command: string) => "Test failed");
    await expect(buildArena({ send }, async () => {}, PIZZA)).rejects.toThrow("No está cargado el mapa Pizza Spleef 2");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("carga el disco y ambas cámaras y coloca a los agentes sobre la pizza", () => {
    const bounds = forceloadCommand(PIZZA).split(" ").slice(2).map(Number);
    const [minX, minZ, maxX, maxZ] = bounds;
    for (const position of [PIZZA.camera, PIZZA.cameraWide, PIZZA.template.from, PIZZA.template.to, ...Object.values(PIZZA.spawns)]) {
      expect(position.x).toBeGreaterThanOrEqual(minX!);
      expect(position.x).toBeLessThanOrEqual(maxX!);
      expect(position.z).toBeGreaterThanOrEqual(minZ!);
      expect(position.z).toBeLessThanOrEqual(maxZ!);
    }
    expect(teleportCommand("red", PIZZA)).toBe("tp AgenteRojo -7.5 4 8.5 -90 0");
    expect(teleportCommand("blue", PIZZA)).toBe("tp AgenteAzul 24.5 4 8.5 90 0");
  });
});

describe("escenario activo", () => {
  it("usa Platanus por defecto y respeta ARENA_SCENARIO", () => {
    const previous = process.env.ARENA_SCENARIO;
    try {
      delete process.env.ARENA_SCENARIO;
      expect(activeArena().id).toBe("platanus");
      process.env.ARENA_SCENARIO = "pizza-spleef-2";
      expect(activeArena().id).toBe("pizza-spleef-2");
      process.env.ARENA_SCENARIO = "lava";
      expect(() => activeArena()).toThrow("Escenario de arena desconocido");
      expect(arenaFor("")).toBe(ARENA);
    } finally {
      if (previous === undefined) delete process.env.ARENA_SCENARIO;
      else process.env.ARENA_SCENARIO = previous;
    }
  });

  it("libs/env acepta exactamente los escenarios del contrato", () => {
    expect(loadEnv({}).ARENA_SCENARIO).toBe(DEFAULT_ARENA_SCENARIO);
    for (const id of ARENA_SCENARIOS) {
      expect(loadEnv({ ARENA_SCENARIO: id }).ARENA_SCENARIO).toBe(id);
      expect(ARENAS[id].id).toBe(id);
      expect(ARENAS[id].level).toBe(id);
    }
    expect(() => loadEnv({ ARENA_SCENARIO: "lava" })).toThrow();
  });
});


/** RCON falso que anota lo que se le envía. */
function recorder(reply: (command: string) => string = () => ""): { rcon: RconLike; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    rcon: {
      send: async (command) => {
        sent.push(command);
        return reply(command);
      },
    },
  };
}

/** Lo que responde un servidor 1.20.4 de verdad cuando un comando de kit funciona. */
function serverReply(command: string): string {
  const player = command.split(" ")[3] ?? "";
  if (command.startsWith("item replace entity ")) return `Replaced a slot on ${player} with [Objeto]`;
  if (command.startsWith("effect give ")) return `Applied effect Efecto to ${command.split(" ")[2] ?? ""}`;
  return "";
}

describe("fighterKitCommands", () => {
  it("clásico: armadura de hierro y la hotbar de siempre, sin efectos", () => {
    expect(fighterKitCommands("AgenteRojo", KITS.classic)).toEqual([
      "item replace entity AgenteRojo armor.head with minecraft:iron_helmet",
      "item replace entity AgenteRojo armor.chest with minecraft:iron_chestplate",
      "item replace entity AgenteRojo armor.legs with minecraft:iron_leggings",
      "item replace entity AgenteRojo armor.feet with minecraft:iron_boots",
      "item replace entity AgenteRojo hotbar.0 with minecraft:iron_sword",
      "item replace entity AgenteRojo hotbar.1 with minecraft:bow",
      "item replace entity AgenteRojo hotbar.2 with minecraft:cooked_beef 4",
      "item replace entity AgenteRojo hotbar.8 with minecraft:arrow 16",
    ]);
  });

  it("arquero: el arco lleva su encantamiento y no hay ningún efecto", () => {
    const commands = fighterKitCommands("AgenteAzul", KITS.archer);
    expect(commands).toContain(
      'item replace entity AgenteAzul hotbar.1 with minecraft:bow{Enchantments:[{id:"minecraft:punch",lvl:1s}]}',
    );
    expect(commands).toContain("item replace entity AgenteAzul hotbar.8 with minecraft:arrow 32");
    expect(commands.some((c) => c.startsWith("effect give "))).toBe(false);
  });

  it("berserker: hacha de diamante y Velocidad I permanente, al final", () => {
    const commands = fighterKitCommands("AgenteAzul", KITS.berserker);
    expect(commands).toContain("item replace entity AgenteAzul hotbar.0 with minecraft:diamond_axe");
    expect(commands.at(-1)).toBe("effect give AgenteAzul minecraft:speed infinite 0 true");
    expect(commands.filter((c) => c.startsWith("effect give "))).toHaveLength(1);
  });

  it("enderman: peto y grebas de hierro, casco y botas de malla con Caída de pluma IV, y 4 perlas", () => {
    const commands = fighterKitCommands("AgenteRojo", KITS.ender);
    expect(commands.slice(0, 4)).toEqual([
      "item replace entity AgenteRojo armor.head with minecraft:chainmail_helmet",
      "item replace entity AgenteRojo armor.chest with minecraft:iron_chestplate",
      "item replace entity AgenteRojo armor.legs with minecraft:iron_leggings",
      'item replace entity AgenteRojo armor.feet with minecraft:chainmail_boots{Enchantments:[{id:"minecraft:feather_falling",lvl:4s}]}',
    ]);
    expect(commands).toContain("item replace entity AgenteRojo hotbar.1 with minecraft:ender_pearl 4");
  });

  it("constructor: 2 manzanas doradas y los tablones en sus slots", () => {
    const commands = fighterKitCommands("AgenteRojo", KITS.builder);
    expect(commands).toContain("item replace entity AgenteRojo hotbar.2 with minecraft:golden_apple 2");
    expect(commands).toContain("item replace entity AgenteRojo hotbar.3 with minecraft:oak_planks 16");
  });

  it("todos los kits: un comando por ítem y por efecto, cada ítem en un slot distinto", () => {
    for (const kit of KIT_LIST) {
      const commands = fighterKitCommands("P", kit);
      expect(commands).toHaveLength(kit.items.length + kit.effects.length);
      const items = commands.filter((c) => c.startsWith("item replace entity P "));
      const effects = commands.filter((c) => c.startsWith("effect give P minecraft:"));
      expect(items).toHaveLength(kit.items.length);
      expect(effects).toHaveLength(kit.effects.length);
      // Los efectos van al final: tienen que enviarse después de los ítems y de `effect clear`.
      expect(commands.slice(kit.items.length)).toEqual(effects);
      const slots = items.map((c) => c.split(" ")[4]);
      expect(new Set(slots).size).toBe(slots.length);
      for (const command of items) expect(command).toMatch(/ with minecraft:[a-z_]+(\{.*\})?( \d+)?$/);
    }
  });
});

describe("prepareFighter", () => {
  it("limpia inventario y efectos, teletransporta, cura y recién entonces entrega el kit", async () => {
    const { rcon, sent } = recorder();
    await prepareFighter(rcon, "red", KITS.berserker);

    expect(sent.slice(0, 3)).toEqual(["gamemode survival AgenteRojo", "clear AgenteRojo", "effect clear AgenteRojo"]);
    expect(sent[3]).toMatch(/^tp AgenteRojo /);
    const kit = fighterKitCommands("AgenteRojo", KITS.berserker);
    expect(sent.slice(-kit.length)).toEqual(kit);
    expect(sent).toContain("item replace entity AgenteRojo hotbar.0 with minecraft:diamond_axe");
    expect(sent.at(-1)).toBe("effect give AgenteRojo minecraft:speed infinite 0 true");
    // Nada de `give`: todo va a un slot exacto.
    expect(sent.some((c) => c.startsWith("give "))).toBe(false);
  });

  it("falla con un mensaje claro si el peleador no está en el servidor", async () => {
    const { rcon } = recorder((command) => (command.startsWith("tp ") ? "No entity was found" : ""));
    await expect(prepareFighter(rcon, "blue", KITS.classic)).rejects.toThrow("AgenteAzul no está conectado");
  });

  it("no avisa nada cuando el servidor confirma todos los comandos del kit", async () => {
    const { rcon } = recorder(serverReply);
    const warnings: string[] = [];
    await prepareFighter(rcon, "red", KITS.berserker, (text) => warnings.push(text));
    expect(warnings).toEqual([]);
  });

  it("avisa, sin fallar, de cada comando del kit que el servidor no confirma", async () => {
    const badSlot = "item replace entity AgenteAzul hotbar.1 with minecraft:ender_pearl 4";
    const { rcon, sent } = recorder((command) => {
      if (command === badSlot) return "Unknown item 'minecraft:ender_pearl'\n";
      // Un efecto sin respuesta tampoco cuenta como entregado.
      if (command.startsWith("effect give AgenteAzul minecraft:speed")) return "";
      return serverReply(command);
    });
    const warnings: string[] = [];
    // Un kit de prueba con un efecto, para cubrir los dos tipos de comando.
    const kit = { ...KITS.ender, effects: KITS.berserker.effects };
    await prepareFighter(rcon, "blue", kit, (text) => warnings.push(text));

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("AgenteAzul");
    expect(warnings[0]).toContain(`"${badSlot}"`);
    expect(warnings[0]).toContain("Unknown item 'minecraft:ender_pearl'");
    expect(warnings[1]).toContain("minecraft:speed");
    expect(warnings[1]).toContain("(sin respuesta)");
    // El resto del kit se entrega igual: se envían todos los comandos.
    expect(sent.slice(-fighterKitCommands("AgenteAzul", kit).length)).toEqual(fighterKitCommands("AgenteAzul", kit));
  });

  it("la curación inicial no se confunde con un comando del kit", async () => {
    // Sin respuesta en nada: solo avisan los comandos del kit, no `gamemode`, `clear`, `tp` ni la curación.
    const { rcon } = recorder();
    const warnings: string[] = [];
    await prepareFighter(rcon, "red", KITS.classic, (text) => warnings.push(text));
    expect(warnings).toHaveLength(KITS.classic.items.length + KITS.classic.effects.length);
    for (const warning of warnings) expect(warning).toContain('"item replace entity AgenteRojo ');
  });
});

describe("resetFighterForRound", () => {
  it("lo lleva a su lugar con la vida completa, sin tocar el inventario ni darle el kit", async () => {
    const { rcon, sent } = recorder();
    await resetFighterForRound(rcon, "red", KITS.classic);
    const spawn = ARENA.spawns.red;
    expect(sent).toEqual([
      `tp AgenteRojo ${spawn.x + 0.5} ${spawn.y} ${spawn.z + 0.5} ${spawn.yaw} 0`,
      "attribute AgenteRojo minecraft:generic.max_health base set 30",
      "effect give AgenteRojo minecraft:instant_health 1 10 true",
      "effect give AgenteRojo minecraft:saturation 1 10 true",
    ]);
  });

  it("devuelve los efectos permanentes del kit (morir los borra), pero no sus ítems", async () => {
    const { rcon, sent } = recorder();
    await resetFighterForRound(rcon, "red", KITS.berserker);
    expect(KITS.berserker.effects.length).toBeGreaterThan(0);
    for (const effect of KITS.berserker.effects) {
      expect(sent).toContain(`effect give AgenteRojo minecraft:${effect.id} infinite ${effect.amplifier} true`);
    }
    expect(sent.some((command) => command.startsWith("item replace") || command.startsWith("clear"))).toBe(false);
  });

  it("falla con un mensaje claro si el peleador no está en el servidor", async () => {
    const { rcon } = recorder((command) => (command.startsWith("tp ") ? "No entity was found" : ""));
    await expect(resetFighterForRound(rcon, "blue", KITS.classic)).rejects.toThrow("AgenteAzul no está conectado");
  });
});

describe("runCountdown", () => {
  /** Reloj falso que avanza solo cuando se duerme; `late` = atraso de cada temporizador. */
  function fakeTime(start: number, late = 0) {
    let at = start;
    const slept: number[] = [];
    return {
      slept,
      now: () => at,
      sleep: async (ms: number) => {
        slept.push(ms);
        at += ms + late;
      },
    };
  }

  it("espera hasta el instante pedido, en pasos cortos", async () => {
    const time = fakeTime(10_000);
    await runCountdown(time.sleep, 13_000, () => false, time.now);
    expect(time.now()).toBe(13_000);
    expect(time.slept.length).toBeGreaterThan(3);
    expect(Math.max(...time.slept)).toBeLessThanOrEqual(1_000);
  });

  it("si el instante ya pasó no espera", async () => {
    const time = fakeTime(10_000);
    await runCountdown(time.sleep, 9_000, () => false, time.now);
    expect(time.slept).toEqual([]);
  });

  it("se corta apenas la pelea se cancela", async () => {
    const time = fakeTime(10_000);
    await runCountdown(time.sleep, 13_000, () => time.slept.length >= 2, time.now);
    expect(time.slept).toHaveLength(2);
    expect(time.now()).toBeLessThan(13_000);
  });

  it("el atraso de los temporizadores no se acumula", async () => {
    const time = fakeTime(10_000, 10);
    await runCountdown(time.sleep, 13_000, () => false, time.now);
    // Termina pasado el instante por, a lo más, el atraso de un solo temporizador.
    expect(time.now()).toBeGreaterThanOrEqual(13_000);
    expect(time.now()).toBeLessThanOrEqual(13_010);
  });

  it("con un sueño que no hace avanzar el reloj igual termina, tras pedir dormir el total", async () => {
    const slept: number[] = [];
    await runCountdown(
      async (ms) => {
        slept.push(ms);
      },
      13_000,
      () => false,
      () => 10_000,
    );
    expect(slept.reduce((total, ms) => total + ms, 0)).toBe(3_000);
  });
});

describe("clearPlacedBlocksCommands", () => {
  it("Platanus: borra bloques, agua, lava y fuego, solo dentro de los muros", () => {
    const platanus = ARENAS.platanus as BuiltArena;
    const { center, floor, wallHeight } = platanus;
    const box = `fill ${center.x - floor.halfX + 1} ${center.y + 1} ${center.z - floor.halfZ + 1} ${center.x + floor.halfX - 1} ${center.y + wallHeight} ${center.z + floor.halfZ - 1} minecraft:air replace`;
    expect(clearPlacedBlocksCommands(platanus)).toEqual([
      `${box} #minecraft:planks`,
      `${box} #minecraft:wool`,
      `${box} minecraft:cobblestone`,
      `${box} minecraft:dirt`,
      `${box} minecraft:obsidian`,
      `${box} minecraft:water`,
      `${box} minecraft:lava`,
      `${box} minecraft:fire`,
    ]);
  });

  it("Pizza Spleef 2: no toca el mapa (se restaura con su plantilla antes de la pelea siguiente)", () => {
    expect(clearPlacedBlocksCommands(ARENAS["pizza-spleef-2"])).toEqual([]);
  });
});
