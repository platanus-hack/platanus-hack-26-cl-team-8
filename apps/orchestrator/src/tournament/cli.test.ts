import { describe, expect, it } from "vitest";
import { UsageError, scenarioFrom } from "./cli";

describe("--scenario del torneo", () => {
  it("por defecto ARENA_SCENARIO; con Platanus solo vale Platanus", () => {
    expect(scenarioFrom({}, { ARENA_SCENARIO: "platanus" })).toBe("platanus");
    expect(scenarioFrom({ scenario: "platanus" }, { ARENA_SCENARIO: "platanus" })).toBe("platanus");
    // --map es un alias de --scenario.
    expect(scenarioFrom({ map: "platanus" }, { ARENA_SCENARIO: "platanus" })).toBe("platanus");
    expect(scenarioFrom({ map: "platanus", scenario: "platanus" }, { ARENA_SCENARIO: "platanus" })).toBe("platanus");
    expect(() => scenarioFrom({ map: "chunk-battle", scenario: "platanus" }, { ARENA_SCENARIO: "platanus" })).toThrow(UsageError);
  });

  it("rechaza Chunk Battle y la pizza con Platanus; un servidor en otro mapa solo corre ese mapa", () => {
    expect(() => scenarioFrom({ scenario: "chunk-battle" }, { ARENA_SCENARIO: "platanus" })).toThrow(UsageError);
    expect(() => scenarioFrom({ map: "chunk-battle" }, { ARENA_SCENARIO: "platanus" })).toThrow(UsageError);
    expect(() => scenarioFrom({ scenario: "pizza-spleef-2" }, { ARENA_SCENARIO: "platanus" })).toThrow(UsageError);
    expect(() => scenarioFrom({ scenario: "lava" }, { ARENA_SCENARIO: "platanus" })).toThrow(/válidos con ARENA_SCENARIO=platanus: platanus\)/);
    // Chunk Battle sigue alcanzable si el servidor arranca con él, pero entonces no hay otro.
    expect(scenarioFrom({}, { ARENA_SCENARIO: "chunk-battle" })).toBe("chunk-battle");
    expect(() => scenarioFrom({ scenario: "platanus" }, { ARENA_SCENARIO: "chunk-battle" })).toThrow(UsageError);
    expect(() => scenarioFrom({ scenario: "chunk-battle" }, { ARENA_SCENARIO: "pizza-spleef-2" })).toThrow(UsageError);
    expect(scenarioFrom({}, { ARENA_SCENARIO: "pizza-spleef-2" })).toBe("pizza-spleef-2");
  });
});
