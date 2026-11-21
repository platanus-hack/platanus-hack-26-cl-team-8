import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPTS, type AgentStatus, type MatchRecord, type Side } from "@phack/protocol";
import { defaultPrompts, normalizeConfig, parseMatchLines, parsePrompts } from "./store";

function status(side: Side): AgentStatus {
  return {
    side,
    username: side === "red" ? "AgenteRojo" : "AgenteAzul",
    connected: true,
    alive: true,
    health: 20,
    food: 20,
    damageDealt: 0,
    decisions: 0,
    lastThought: "",
    lastAction: "",
  };
}

function record(id: string): MatchRecord {
  return {
    id,
    startedAt: 1000,
    endedAt: 5000,
    durationMs: 4000,
    configs: {
      red: { side: "red", prompt: "ataca" },
      blue: { side: "blue", prompt: "defiende" },
    },
    final: { red: status("red"), blue: status("blue") },
    result: { winner: "red", reason: "kill" },
  };
}

describe("parsePrompts", () => {
  it("usa los valores por defecto si el JSON está corrupto", () => {
    expect(parsePrompts("{esto no es json")).toEqual(defaultPrompts());
    expect(parsePrompts("null")).toEqual(defaultPrompts());
    expect(parsePrompts("42")).toEqual(defaultPrompts());
  });

  it("lee los prompts guardados", () => {
    const raw = JSON.stringify({
      red: { side: "red", prompt: "rojo custom", provider: "openai", model: "gpt-x" },
      blue: { side: "blue", prompt: "azul custom" },
    });
    expect(parsePrompts(raw)).toEqual({
      red: { side: "red", prompt: "rojo custom", provider: "openai", model: "gpt-x" },
      blue: { side: "blue", prompt: "azul custom" },
    });
  });

  it("si un lado es inválido solo ese vuelve al valor por defecto", () => {
    const raw = JSON.stringify({
      red: { side: "red", prompt: 123 },
      blue: { side: "blue", prompt: "azul custom" },
    });
    const prompts = parsePrompts(raw);
    expect(prompts.red).toEqual({ side: "red", prompt: DEFAULT_PROMPTS.red });
    expect(prompts.blue).toEqual({ side: "blue", prompt: "azul custom" });
  });

  it("fuerza el lado según la clave del archivo", () => {
    const raw = JSON.stringify({ red: { side: "blue", prompt: "cruzado" } });
    expect(parsePrompts(raw).red).toEqual({ side: "red", prompt: "cruzado" });
  });
});

describe("normalizeConfig", () => {
  it("omite modelo vacío y proveedor ausente", () => {
    expect(normalizeConfig("red", { prompt: "hola", model: "   " })).toEqual({ side: "red", prompt: "hola" });
  });

  it("conserva proveedor y modelo recortado", () => {
    expect(normalizeConfig("blue", { prompt: "hola", provider: "anthropic", model: " m1 " })).toEqual({
      side: "blue",
      prompt: "hola",
      provider: "anthropic",
      model: "m1",
    });
  });
});

describe("parseMatchLines", () => {
  it("devuelve vacío para un archivo vacío", () => {
    expect(parseMatchLines("")).toEqual([]);
    expect(parseMatchLines("\n\n")).toEqual([]);
  });

  it("devuelve las peleas más recientes primero", () => {
    const raw = [record("a"), record("b"), record("c")].map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(parseMatchLines(raw).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("ignora líneas corruptas o con forma inválida", () => {
    const raw = [
      JSON.stringify(record("a")),
      "{linea cortada",
      JSON.stringify({ id: "sin-campos" }),
      "",
      JSON.stringify(record("b")),
    ].join("\n");
    expect(parseMatchLines(raw).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("respeta el límite quedándose con las últimas", () => {
    const raw = ["a", "b", "c", "d"].map((id) => JSON.stringify(record(id))).join("\n");
    expect(parseMatchLines(raw, 2).map((r) => r.id)).toEqual(["d", "c"]);
  });
});
