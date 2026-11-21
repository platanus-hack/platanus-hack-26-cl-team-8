import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPTS, type AgentStatus, type MatchRecord, type Side } from "@phack/protocol";
import { MatchStore, defaultPrompts, normalizeConfig, parseMatchLines, parsePrompts } from "./store";

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
    heldItem: "",
    tokensIn: 0,
    tokensOut: 0,
    avgDecisionMs: 0,
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

describe("parseMatchLines con registros corregidos", () => {
  it("una línea posterior con el mismo id reemplaza el contenido sin mover la pelea", () => {
    const fixed: MatchRecord = { ...record("a"), result: { winner: "red", reason: "kill", explanation: "Rojo atacó sin parar." } };
    const raw = [record("a"), record("b"), fixed].map((r) => JSON.stringify(r)).join("\n");
    const parsed = parseMatchLines(raw);
    expect(parsed.map((r) => r.id)).toEqual(["b", "a"]);
    expect(parsed[1]?.result.explanation).toBe("Rojo atacó sin parar.");
  });

  it("los registros viejos sin los campos nuevos se leen con sus valores por defecto", () => {
    const old = record("viejo") as unknown as { final: Record<Side, Record<string, unknown>> };
    for (const side of ["red", "blue"] as const) {
      delete old.final[side].heldItem;
      delete old.final[side].tokensIn;
      delete old.final[side].tokensOut;
      delete old.final[side].avgDecisionMs;
    }
    const [parsed] = parseMatchLines(JSON.stringify(old));
    expect(parsed?.final.red).toMatchObject({ heldItem: "", tokensIn: 0, tokensOut: 0, avgDecisionMs: 0 });
  });
});

describe("MatchStore.update", () => {
  it("corrige la pelea en memoria y en disco (y sobrevive a una recarga)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phack-store-"));
    try {
      const store = new MatchStore(dir, () => {});
      await store.append(record("a"));
      await store.append(record("b"));
      const ok = await store.update("a", (r) => ({ ...r, result: { ...r.result, explanation: "porque sí" } }));
      expect(ok).toBe(true);
      expect(store.latest().map((r) => [r.id, r.result.explanation])).toEqual([
        ["b", undefined],
        ["a", "porque sí"],
      ]);

      const lines = (await readFile(join(dir, "matches.jsonl"), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(3);

      const reloaded = new MatchStore(dir, () => {});
      await reloaded.load();
      expect(reloaded.latest().map((r) => [r.id, r.result.explanation])).toEqual([
        ["b", undefined],
        ["a", "porque sí"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("devuelve false si la pelea no está", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phack-store-"));
    try {
      const store = new MatchStore(dir, () => {});
      expect(await store.update("nada", (r) => r)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
