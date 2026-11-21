import { describe, expect, it } from "vitest";
import { countedAbsorption, storeAttributes } from "./vitals";

describe("storeAttributes", () => {
  it("guarda un atributo con espacio de nombres también sin él (donde lo busca la física)", () => {
    const attributes: Record<string, unknown> = {};
    const modifiers = [{ uuid: "x", amount: 0.2, operation: 2 }];
    storeAttributes(attributes, [{ name: "minecraft:generic.movement_speed", value: 0.1, modifiers }]);
    const expected = { value: 0.1, modifiers };
    expect(attributes["minecraft:generic.movement_speed"]).toEqual(expected);
    expect(attributes["generic.movement_speed"]).toEqual(expected);
  });

  it("un nombre sin espacio de nombres queda una sola vez; desde 1.20.5 el nombre viene en key", () => {
    const attributes: Record<string, unknown> = {};
    storeAttributes(attributes, [
      { name: "generic.max_health", value: 20 },
      { key: "minecraft:generic.attack_speed", name: "ignorado", value: 4, modifiers: [] },
    ]);
    expect(Object.keys(attributes).sort()).toEqual([
      "generic.attack_speed",
      "generic.max_health",
      "minecraft:generic.attack_speed",
    ]);
    expect(attributes["generic.max_health"]).toEqual({ value: 20, modifiers: [] });
  });

  it("ignora propiedades sin nombre o sin valor numérico", () => {
    const attributes: Record<string, unknown> = {};
    storeAttributes(attributes, [null, 7, { value: 1 }, { name: "minecraft:generic.armor", value: "1" }]);
    expect(attributes).toEqual({});
  });
});

describe("countedAbsorption", () => {
  it("cuenta los corazones amarillos solo con el efecto de absorción activo", () => {
    expect(countedAbsorption(4, true)).toBe(4);
    // Se acabó el efecto: la baja a 0 que llega después no es daño.
    expect(countedAbsorption(4, false)).toBe(0);
  });

  it("valores raros cuentan como 0", () => {
    expect(countedAbsorption(0, true)).toBe(0);
    expect(countedAbsorption(-1, true)).toBe(0);
    expect(countedAbsorption(Number.NaN, true)).toBe(0);
  });
});
