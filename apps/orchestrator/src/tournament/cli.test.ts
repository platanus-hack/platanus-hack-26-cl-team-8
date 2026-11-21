import { describe, expect, it } from "vitest";
import { UsageError, scenarioFrom } from "./cli";

describe("--scenario del torneo", () => {
  it("por defecto ARENA_SCENARIO; vale cualquier mapa del mundo arena", () => {
    expect(scenarioFrom({}, { ARENA_SCENARIO: "platanus" })).toBe("platanus");
    expect(scenarioFrom({ scenario: "chunk-battle" }, { ARENA_SCENARIO: "platanus" })).toBe("chunk-battle");
    expect(scenarioFrom({ scenario: "platanus" }, { ARENA_SCENARIO: "chunk-battle" })).toBe("platanus");
    // --map es un alias de --scenario.
    expect(scenarioFrom({ map: "chunk-battle" }, { ARENA_SCENARIO: "platanus" })).toBe("chunk-battle");
    expect(scenarioFrom({ map: "chunk-battle", scenario: "chunk-battle" }, { ARENA_SCENARIO: "platanus" })).toBe("chunk-battle");
    expect(() => scenarioFrom({ map: "chunk-battle", scenario: "platanus" }, { ARENA_SCENARIO: "platanus" })).toThrow(UsageError);
  });

  it("rechaza la pizza en el mundo arena, y los mapas construidos con la pizza cargada", () => {
    expect(() => scenarioFrom({ scenario: "pizza-spleef-2" }, { ARENA_SCENARIO: "platanus" })).toThrow(UsageError);
    expect(() => scenarioFrom({ scenario: "lava" }, { ARENA_SCENARIO: "platanus" })).toThrow(/platanus, chunk-battle/);
    expect(() => scenarioFrom({ scenario: "chunk-battle" }, { ARENA_SCENARIO: "pizza-spleef-2" })).toThrow(UsageError);
    expect(scenarioFrom({}, { ARENA_SCENARIO: "pizza-spleef-2" })).toBe("pizza-spleef-2");
  });
});
