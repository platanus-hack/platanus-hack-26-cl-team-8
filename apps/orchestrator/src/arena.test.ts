import { describe, expect, it } from "vitest";
import { ARENA, KITS, KIT_LIST } from "@phack/protocol";
import {
  arenaBuildCommands,
  clearPlacedBlocksCommand,
  fighterKitCommands,
  prepareFighter,
  runCountdown,
} from "./arena";
import type { RconLike } from "./rcon";

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

describe("arena", () => {
  const wall = ARENA.radius + 1;
  const min = { x: ARENA.center.x - wall, z: ARENA.center.z - wall };
  const max = { x: ARENA.center.x + wall, z: ARENA.center.z + wall };
  const wallTop = ARENA.center.y + ARENA.wallHeight;

  it("pone una tapa invisible justo sobre los muros, después de vaciar el volumen", () => {
    const commands = arenaBuildCommands();
    const clear = commands.findIndex((c) => c.endsWith("minecraft:air"));
    const lid = commands.findIndex((c) => c.endsWith("minecraft:barrier"));
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(lid).toBeGreaterThan(clear);
    expect(commands[lid]).toBe(
      `fill ${min.x} ${wallTop + 1} ${min.z} ${max.x} ${wallTop + 1} ${max.z} minecraft:barrier`,
    );
  });

  it("al terminar borra solo los tablones, y solo dentro de la arena", () => {
    expect(clearPlacedBlocksCommand()).toBe(
      `fill ${min.x + 1} ${ARENA.center.y + 1} ${min.z + 1} ${max.x - 1} ${wallTop} ${max.z - 1} ` +
        "minecraft:air replace minecraft:oak_planks",
    );
  });
});
