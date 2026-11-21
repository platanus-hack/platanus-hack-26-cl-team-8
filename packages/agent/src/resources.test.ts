import { describe, expect, it } from "vitest";
import { describeResources, wornItem } from "./resources";

const context = { health: 20, food: 20, pearlCooldown: 0, tools: ["attack", "dig", "build", "shoot", "eat", "pearl", "water", "lava", "shield", "drink", "throw"] };

describe("contexto vivo de recursos", () => {
  it("recalcula opciones al gastar flechas o cambiar hambre y recargas", () => {
    const items = [{ name: "bow", count: 1 }, { name: "cooked_beef", count: 2 }, { name: "ender_pearl", count: 1 }];
    const uses = describeResources(items, { ...context, pearlCooldown: 3.2470000000000003 });
    expect(uses[0]?.uses[0]).toEqual({ tool: "shoot", blocked: "faltan flechas" });
    expect(uses[1]?.uses[0]).toEqual({ tool: "eat", args: { food: "cooked_beef" }, blocked: "barra de comida llena" });
    // La recarga va redondeada: el texto se lee cada turno.
    expect(uses[2]?.uses[0]).toEqual({ tool: "pearl", blocked: "recarga: 3.2 s" });
    const updated = describeResources([...items, { name: "arrow", count: 4 }], { ...context, food: 17 });
    for (const resource of updated) expect(resource.uses[0]).not.toHaveProperty("blocked");
  });

  it("presenta los usos múltiples de un hacha y del escudo", () => {
    const items = [{ name: "diamond_axe", count: 1, enchantments: [{ name: "sharpness", level: 3 }], maxDurability: 1561, durabilityUsed: 10 }, { name: "cobblestone", count: 32 }, { name: "shield", count: 1, maxDurability: 336, durabilityUsed: 0 }];
    const resources = describeResources(items, context);
    expect(resources[0]).toEqual({
      name: "diamond_axe",
      count: 1,
      durabilityLeft: 1551,
      enchantments: [{ name: "sharpness", level: 3 }],
      uses: [{ tool: "attack", args: { weapon: "diamond_axe" } }, { tool: "dig" }],
    });
    expect(resources[1]).toEqual({ name: "cobblestone", count: 32, uses: [{ tool: "build" }] });
    expect(resources[2]?.uses).toEqual([{ tool: "shield" }, { tool: "attack", args: { guard: true } }]);
  });

  it("conserva tipos de poción y distingue efectos beneficiosos de dañinos", () => {
    const resources = describeResources([{ name: "splash_potion:healing", count: 2 }, { name: "splash_potion:harming", count: 1 }, { name: "potion:strength", count: 1 }], context);
    expect(resources[0]?.uses[0]).toMatchObject({ tool: "throw", args: { potion: "healing", at: "self" } });
    expect(resources[1]?.uses[0]).toMatchObject({ tool: "throw", args: { potion: "harming", at: "rival" } });
    expect(resources[2]?.uses[0]).toMatchObject({ tool: "drink", args: { potion: "strength" } });
  });

  it("no promete capacidades inexistentes y bloquea la perla según el kit", () => {
    const items = [{ name: "golden_apple", count: 2 }, { name: "ender_pearl", count: 1 }, { name: "bucket", count: 1 }];
    const resources = describeResources(items, { ...context, health: 3, tools: ["eat"] });
    expect(resources[0]?.uses).toEqual([{ tool: "eat", args: { food: "golden_apple" } }]);
    expect(resources[1]?.uses[0]?.blocked).toBe("vida insuficiente (4 o menos)");
    // Un cubo ya vaciado no tiene uso: la lista queda vacía, sin texto de relleno.
    expect(resources[2]).toEqual({ name: "bucket", count: 1, uses: [] });
    // Sin Caída de pluma la perla quita 5: el cuerpo no la lanza con 5 o menos.
    const bare = describeResources(items, { ...context, health: 5, pearlMinHealth: 5 });
    expect(bare[1]?.uses[0]?.blocked).toBe("vida insuficiente (5 o menos)");
    expect(describeResources(items, { ...context, health: 5 })[1]?.uses[0]).toEqual({ tool: "pearl" });
  });

  it("solo lleva lo que cambia: sin casilla, sin textos fijos y sin campos vacíos", () => {
    const [sword] = describeResources([{ name: "iron_sword", count: 1, slot: 36, maxDurability: 250, durabilityUsed: 3, enchantments: [] }], context);
    expect(sword).toEqual({ name: "iron_sword", count: 1, durabilityLeft: 247, uses: [{ tool: "attack", args: { weapon: "iron_sword" } }] });
    expect(wornItem({ name: "iron_helmet", count: 1, slot: 5, maxDurability: 165, durabilityUsed: 0, enchantments: [] })).toEqual({ name: "iron_helmet", durabilityLeft: 165 });
  });
});
