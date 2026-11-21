import { describe, expect, it } from "vitest";
import { describeResources } from "./resources";

const context = { health: 20, food: 20, absorption: 0, pearlCooldown: 0, tools: ["attack", "dig", "build", "shoot", "eat", "pearl", "water", "lava", "shield", "drink", "throw"] };

describe("contexto vivo de recursos", () => {
  it("recalcula opciones al gastar flechas o cambiar hambre y recargas", () => {
    const items = [{ name: "bow", count: 1 }, { name: "cooked_beef", count: 2 }, { name: "ender_pearl", count: 1 }];
    const uses = describeResources(items, { ...context, pearlCooldown: 3 });
    expect(uses[0]?.uses[0]).toMatchObject({ tool: "shoot", available: false, constraint: "faltan flechas" });
    expect(uses[1]?.uses[0]).toMatchObject({ tool: "eat", available: false, constraint: "barra de comida llena" });
    expect(uses[2]?.uses[0]).toMatchObject({ tool: "pearl", available: false, constraint: "recarga: 3 s" });
    const updated = describeResources([...items, { name: "arrow", count: 4 }], { ...context, food: 17 });
    expect(updated[0]?.uses[0]?.available).toBe(true);
    expect(updated[1]?.uses[0]?.available).toBe(true);
    expect(updated[2]?.uses[0]?.available).toBe(true);
  });

  it("presenta los usos múltiples de un hacha y los recursos para combinar acciones", () => {
    const items = [{ name: "diamond_axe", count: 1, enchantments: [{ name: "sharpness", level: 3 }], durabilityUsed: 10 }, { name: "red_wool", count: 32 }, { name: "water_bucket", count: 1 }];
    const resources = describeResources(items, context);
    expect(resources[0]).toMatchObject(items[0]!);
    expect(resources[0]?.uses.map((use) => use.tool)).toEqual(["attack", "dig"]);
    expect(resources[1]?.uses[0]?.description).toContain("cualquier plano");
    expect(resources[2]?.uses[0]?.description).toContain("amortigua caídas");
  });

  it("conserva tipos de poción y distingue efectos beneficiosos de dañinos", () => {
    const resources = describeResources([{ name: "splash_potion:healing", count: 2 }, { name: "splash_potion:harming", count: 1 }, { name: "potion:strength", count: 1 }], context);
    expect(resources[0]?.uses[0]).toMatchObject({ tool: "throw", args: { potion: "healing", at: "self" } });
    expect(resources[1]?.uses[0]).toMatchObject({ tool: "throw", args: { potion: "harming", at: "rival" } });
    expect(resources[2]?.uses[0]).toMatchObject({ tool: "drink", args: { potion: "strength" } });
  });

  it("no promete capacidades inexistentes ni absorción acumulable", () => {
    const resources = describeResources([{ name: "golden_apple", count: 2 }, { name: "ender_pearl", count: 1 }, { name: "diamond", count: 3 }], { ...context, health: 3, absorption: 4, tools: ["eat"] });
    expect(resources[0]?.note).toContain("otra manzana no la suma");
    expect(resources[1]?.uses[0]?.available).toBe(false);
    expect(resources[2]?.uses).toEqual([]);
    expect(resources[2]?.note).toContain("no puedes fabricar");
  });
});
