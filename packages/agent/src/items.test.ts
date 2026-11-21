import { describe, expect, it } from "vitest";
import { attackCooldownMs, isArrow, isAxe, isBuildBlock, isFoodName, isPearl, isSword } from "./items";

describe("clasificación de ítems", () => {
  it("distingue espadas, hachas y picotas", () => {
    expect(isSword("diamond_sword")).toBe(true);
    expect(isSword("diamond_axe")).toBe(false);
    expect(isAxe("diamond_axe")).toBe(true);
    expect(isAxe("diamond_pickaxe")).toBe(false);
  });

  it("reconoce flechas, perlas, bloques y comida", () => {
    expect(isArrow("arrow")).toBe(true);
    expect(isArrow("spectral_arrow")).toBe(true);
    expect(isArrow("bow")).toBe(false);
    expect(isPearl("ender_pearl")).toBe(true);
    expect(isBuildBlock("oak_planks")).toBe(true);
    expect(isBuildBlock("cobblestone")).toBe(false);
    expect(isFoodName("cooked_beef")).toBe(true);
    expect(isFoodName("golden_apple")).toBe(true);
    expect(isFoodName("ender_pearl")).toBe(false);
  });
});

describe("attackCooldownMs", () => {
  it("las espadas recargan en 650 ms sea cual sea el material", () => {
    expect(attackCooldownMs("iron_sword")).toBe(650);
    expect(attackCooldownMs("stone_sword")).toBe(650);
    expect(attackCooldownMs("diamond_sword")).toBe(650);
  });

  it("las hachas son más lentas, según el material", () => {
    expect(attackCooldownMs("diamond_axe")).toBe(1050);
    expect(attackCooldownMs("golden_axe")).toBe(1050);
    expect(attackCooldownMs("netherite_axe")).toBe(1050);
    expect(attackCooldownMs("iron_axe")).toBe(1150);
    expect(attackCooldownMs("stone_axe")).toBe(1300);
    expect(attackCooldownMs("wooden_axe")).toBe(1300);
  });

  it("la mano vacía o un ítem que no es arma recargan en 300 ms", () => {
    expect(attackCooldownMs("")).toBe(300);
    expect(attackCooldownMs("bow")).toBe(300);
    expect(attackCooldownMs("cooked_beef")).toBe(300);
  });

  it("deja un margen de hasta un tick de servidor sobre la recarga exacta del juego", () => {
    // Recarga exacta = 1000 / velocidad de ataque del arma en 1.20.4.
    const exact: Record<string, number> = {
      iron_sword: 1000 / 1.6,
      diamond_axe: 1000 / 1,
      iron_axe: 1000 / 0.9,
      stone_axe: 1000 / 0.8,
      "": 1000 / 4,
    };
    for (const [item, ms] of Object.entries(exact)) {
      expect(attackCooldownMs(item) - ms).toBeGreaterThanOrEqual(25);
      expect(attackCooldownMs(item) - ms).toBeLessThanOrEqual(50);
    }
  });
});
