import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "@phack/agent";
import { BENCHMARK_GENERATION, benchmarkMismatch, benchmarkVersion } from "./benchmark";

describe("benchmarkVersion", () => {
  it("el id lleva el escenario y la generación v2 (mapa por partida)", () => {
    expect(BENCHMARK_GENERATION).toBe("v2");
    expect(benchmarkVersion("platanus", 60, 1500).id).toMatch(/^pvp-platanus-v2\+[0-9a-f]{12}$/);
    expect(benchmarkVersion("chunk-battle", 60, 1500).id).toMatch(/^pvp-chunk-battle-v2\+[0-9a-f]{12}$/);
    // Las tools que se congelan incluyen construir y romper bloques (cruzar entre islas).
    expect(TOOL_NAMES).toEqual(expect.arrayContaining(["build", "dig"]));
  });

  it("cambia con el escenario y con las tools; es estable con lo mismo", () => {
    const platanus = benchmarkVersion("platanus", 60, 1500);
    const chunk = benchmarkVersion("chunk-battle", 60, 1500);
    expect(benchmarkVersion("platanus", 60, 1500)).toEqual(platanus);
    expect(chunk.promptHash).not.toBe(platanus.promptHash);
    expect(chunk.toolsHash).toBe(platanus.toolsHash);
    expect(benchmarkMismatch(platanus, chunk)).toContain("escenario");

    const oldTools = benchmarkVersion("platanus", 60, 1500, [{ name: "approach" }]);
    expect(oldTools.toolsHash).not.toBe(platanus.toolsHash);
    expect(benchmarkMismatch(oldTools, platanus)).toContain("tools del agente");
  });
});
