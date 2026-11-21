import { describe, expect, it } from "vitest";
import { ARENA, KITS, KIT_LIST } from "@phack/protocol";
import { arenaBuildCommands, clearPlacedBlocksCommand, fighterKitCommands, prepareFighter } from "./arena";
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

  it("arquero: el arco lleva su encantamiento y la Velocidad I es permanente", () => {
    const commands = fighterKitCommands("AgenteAzul", KITS.archer);
    expect(commands).toContain(
      'item replace entity AgenteAzul hotbar.1 with minecraft:bow{Enchantments:[{id:"minecraft:punch",lvl:1s}]}',
    );
    expect(commands).toContain("item replace entity AgenteAzul hotbar.8 with minecraft:arrow 32");
    expect(commands.at(-1)).toBe("effect give AgenteAzul minecraft:speed infinite 0 true");
  });

  it("enderman: botas con Caída de pluma IV y 4 perlas", () => {
    const commands = fighterKitCommands("AgenteRojo", KITS.ender);
    expect(commands).toContain(
      'item replace entity AgenteRojo armor.feet with minecraft:chainmail_boots{Enchantments:[{id:"minecraft:feather_falling",lvl:4s}]}',
    );
    expect(commands).toContain("item replace entity AgenteRojo hotbar.1 with minecraft:ender_pearl 4");
  });

  it("constructor: manzanas doradas y tablones en sus slots", () => {
    const commands = fighterKitCommands("AgenteRojo", KITS.builder);
    expect(commands).toContain("item replace entity AgenteRojo hotbar.2 with minecraft:golden_apple 3");
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
