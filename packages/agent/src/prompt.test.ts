import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt";

const base = { side: "red" as const, username: "AgenteRojo", opponentUsername: "AgenteAzul", strategy: "", tickMs: 1500 };

describe("buildSystemPrompt", () => {
  it("describe la arena Platanus: muros de vidrio, sin vacío", () => {
    const text = buildSystemPrompt({ ...base, arena: "platanus" });
    expect(text).toContain("muros de vidrio");
    expect(text).not.toContain("pizza");
  });

  it("describe la pizza: sin muros y con vacío", () => {
    const text = buildSystemPrompt({ ...base, arena: "pizza-spleef-2" });
    expect(text).toContain("Pizza Spleef 2");
    expect(text).toContain("caer al vacío");
  });

  it("sin escenario usa ARENA_SCENARIO", () => {
    const previous = process.env.ARENA_SCENARIO;
    try {
      process.env.ARENA_SCENARIO = "pizza-spleef-2";
      expect(buildSystemPrompt(base)).toContain("Pizza Spleef 2");
      delete process.env.ARENA_SCENARIO;
      expect(buildSystemPrompt(base)).toContain("arena Platanus");
    } finally {
      if (previous === undefined) delete process.env.ARENA_SCENARIO;
      else process.env.ARENA_SCENARIO = previous;
    }
  });
});
