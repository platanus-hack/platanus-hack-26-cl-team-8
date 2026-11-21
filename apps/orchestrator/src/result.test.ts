import { describe, expect, it } from "vitest";
import { decideTimeoutResult, describeResult, otherSide, resultForDeath } from "./result";

describe("otherSide", () => {
  it("devuelve el lado contrario", () => {
    expect(otherSide("red")).toBe("blue");
    expect(otherSide("blue")).toBe("red");
  });
});

describe("resultForDeath", () => {
  it("si muere rojo gana azul por kill", () => {
    expect(resultForDeath("red")).toEqual({ winner: "blue", reason: "kill" });
  });

  it("si muere azul gana rojo por kill", () => {
    expect(resultForDeath("blue")).toEqual({ winner: "red", reason: "kill" });
  });
});

describe("decideTimeoutResult", () => {
  it("gana quien tiene más vida", () => {
    expect(decideTimeoutResult({ health: 14, alive: true }, { health: 9.5, alive: true })).toEqual({
      winner: "red",
      reason: "timeout_health",
    });
    expect(decideTimeoutResult({ health: 3, alive: true }, { health: 20, alive: true })).toEqual({
      winner: "blue",
      reason: "timeout_health",
    });
  });

  it("empate si tienen la misma vida", () => {
    expect(decideTimeoutResult({ health: 20, alive: true }, { health: 20, alive: true })).toEqual({
      winner: null,
      reason: "draw",
    });
  });

  it("un lado muerto cuenta como vida 0", () => {
    expect(decideTimeoutResult({ health: 20, alive: false }, { health: 1, alive: true })).toEqual({
      winner: "blue",
      reason: "timeout_health",
    });
  });

  it("empate si ambos están muertos", () => {
    expect(decideTimeoutResult({ health: 5, alive: false }, { health: 8, alive: false })).toEqual({
      winner: null,
      reason: "draw",
    });
  });
});

describe("describeResult", () => {
  it("describe en español cada motivo", () => {
    expect(describeResult({ winner: "red", reason: "kill" })).toContain("Rojo");
    expect(describeResult({ winner: "blue", reason: "timeout_health" })).toContain("Azul");
    expect(describeResult({ winner: null, reason: "draw" })).toContain("empate");
    expect(describeResult({ winner: null, reason: "stopped" })).toContain("detenida");
    expect(describeResult({ winner: null, reason: "error" })).toContain("error");
  });
});
