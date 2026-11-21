import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@phack/protocol";
import { decideTimeoutResult, describeResult, otherSide, pointsResult, resultForDeath } from "./result";

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

  it("los corazones amarillos cuentan como vida", () => {
    expect(decideTimeoutResult({ health: 15, alive: true }, { health: 13, absorption: 4, alive: true })).toEqual({
      winner: "blue",
      reason: "timeout_health",
    });
    expect(decideTimeoutResult({ health: 16, absorption: 2, alive: true }, { health: 18, alive: true })).toEqual({
      winner: null,
      reason: "draw",
    });
    // Un muerto no tiene corazones amarillos que valgan.
    expect(decideTimeoutResult({ health: 0, absorption: 4, alive: false }, { health: 1, alive: true })).toMatchObject({
      winner: "blue",
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

describe("series por puntos", () => {
  const series = { wins: { red: 3, blue: 1 }, points: { red: 8, blue: 10 } };
  const byPoints = { ...DEFAULT_SETTINGS, scenario: "dilemma" as const };

  it("gana quien suma más puntos aunque haya ganado menos rondas", () => {
    expect(pointsResult(series)).toEqual({ winner: "blue", reason: "rounds" });
    expect(pointsResult({ points: { red: 4, blue: 4 } })).toEqual({ winner: null, reason: "draw" });
  });

  it("el texto cuenta el marcador con que se decidió", () => {
    expect(describeResult({ winner: "blue", reason: "rounds" }, series, byPoints)).toBe("Ganó Azul la serie 10 a 8 en puntos");
    expect(describeResult({ winner: "red", reason: "rounds" }, series)).toBe("Ganó Rojo la serie 3 a 1");
    expect(describeResult({ winner: null, reason: "draw" }, { wins: { red: 3, blue: 1 }, points: { red: 9, blue: 9 } }, byPoints)).toBe(
      "La serie terminó empatada: 9 a 9 en puntos",
    );
  });
});
