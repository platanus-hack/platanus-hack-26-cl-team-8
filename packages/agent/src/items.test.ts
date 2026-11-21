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
  it("las espadas recargan en 625 ms sea cual sea el material", () => {
    expect(attackCooldownMs("iron_sword")).toBe(625);
    expect(attackCooldownMs("stone_sword")).toBe(625);
    expect(attackCooldownMs("diamond_sword")).toBe(625);
  });

  it("las hachas son más lentas, según el material", () => {
    expect(attackCooldownMs("diamond_axe")).toBe(1000);
    expect(attackCooldownMs("golden_axe")).toBe(1000);
    expect(attackCooldownMs("netherite_axe")).toBe(1000);
    expect(attackCooldownMs("iron_axe")).toBe(1111);
    expect(attackCooldownMs("stone_axe")).toBe(1250);
    expect(attackCooldownMs("wooden_axe")).toBe(1250);
  });

  it("la mano vacía o un ítem que no es arma recargan en 250 ms", () => {
    expect(attackCooldownMs("")).toBe(250);
    expect(attackCooldownMs("bow")).toBe(250);
    expect(attackCooldownMs("cooked_beef")).toBe(250);
  });
});
