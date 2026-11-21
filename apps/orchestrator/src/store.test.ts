import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_PROMPTS, type AgentStatus, type MatchRecord, type Side } from "@phack/protocol";
import {
  MatchStore,
  defaultPrompts,
  migrateStoredConfig,
  normalizeConfig,
  parseMatchLines,
  parsePrompts,
  parseSettings, MAX_HISTORY } from "./store";

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
    settings: { ...DEFAULT_SETTINGS, comms: "none", timer: true, timerSeconds: null, mode: "single", voice: false },
    series: null,
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
      red: { side: "red", prompt: "rojo custom", provider: "vercel", model: "deepseek/x", kit: "archer" },
      blue: { side: "blue", prompt: "azul custom" },
    });
    expect(parsePrompts(raw)).toEqual({
      red: { side: "red", prompt: "rojo custom", provider: "vercel", model: "deepseek/x", kit: "archer" },
      // Guardado antes de que existieran los kits: pelea con el kit por defecto.
      blue: { side: "blue", prompt: "azul custom", kit: "classic" },
    });
  });

  it("si un lado es inválido solo ese vuelve al valor por defecto", () => {
    const raw = JSON.stringify({
      red: { side: "red", prompt: 123 },
      blue: { side: "blue", prompt: "azul custom" },
    });
    const prompts = parsePrompts(raw);
    expect(prompts.red).toEqual({ side: "red", prompt: DEFAULT_PROMPTS.red, kit: "classic" });
    expect(prompts.blue).toEqual({ side: "blue", prompt: "azul custom", kit: "classic" });
  });

  it("fuerza el lado según la clave del archivo", () => {
    const raw = JSON.stringify({ red: { side: "blue", prompt: "cruzado" } });
    expect(parsePrompts(raw).red).toEqual({ side: "red", prompt: "cruzado", kit: "classic" });
  });

  it("un kit desconocido no invalida el lado: vuelve al kit por defecto", () => {
    const raw = JSON.stringify({ red: { side: "red", prompt: "rojo custom", kit: "ninja" } });
    expect(parsePrompts(raw).red).toEqual({ side: "red", prompt: "rojo custom", kit: "classic" });
  });
});

describe("parsePrompts con proveedores que ya no existen", () => {
  it('"gateway" era el mismo servicio que "vercel": se convierte y conserva el modelo', () => {
    const raw = JSON.stringify({
      red: { side: "red", prompt: "rojo custom", provider: "gateway", model: "anthropic/claude-haiku-5.5" },
    });
    expect(parsePrompts(raw).red).toEqual({
      side: "red",
      prompt: "rojo custom",
      provider: "vercel",
      model: "anthropic/claude-haiku-5.5",
      kit: "classic",
    });
  });

  it("openrouter pasa a vercel con su modelo, que ya tiene el formato del gateway", () => {
    const raw = JSON.stringify({ red: { side: "red", prompt: "rojo custom", provider: "openrouter", model: "openai/gpt-4o" } });
    expect(parsePrompts(raw).red).toEqual({
      side: "red",
      prompt: "rojo custom",
      provider: "vercel",
      model: "openai/gpt-4o",
      kit: "classic",
    });
  });

  it("con cualquier otro proveedor eliminado se conserva el prompt y el lado queda sin proveedor ni modelo", () => {
    const raw = JSON.stringify({
      red: { side: "red", prompt: "rojo custom", provider: "openai", model: "gpt-6-luna" },
      blue: { side: "blue", prompt: "azul custom", provider: "anthropic", model: "claude-haiku-5-5", kit: "tank" },
    });
    const prompts = parsePrompts(raw);
    expect(prompts.red).toEqual({ side: "red", prompt: "rojo custom", kit: "classic" });
    expect(prompts.blue).toEqual({ side: "blue", prompt: "azul custom", kit: "tank" });
  });
});

describe("migrateStoredConfig", () => {
  it("no toca las configuraciones vigentes ni lo que no es un objeto", () => {
    expect(migrateStoredConfig({ side: "red", prompt: "p", provider: "vercel", model: "a/b" })).toEqual({
      side: "red",
      prompt: "p",
      provider: "vercel",
      model: "a/b",
    });
    expect(migrateStoredConfig({ side: "red", prompt: "p", provider: "mock" })).toEqual({
      side: "red",
      prompt: "p",
      provider: "mock",
    });
    expect(migrateStoredConfig({ side: "red", prompt: "p" })).toEqual({ side: "red", prompt: "p" });
    expect(migrateStoredConfig(null)).toBeNull();
    expect(migrateStoredConfig("texto")).toBe("texto");
  });

  it("convierte gateway y openrouter en vercel conservando el modelo", () => {
    expect(migrateStoredConfig({ prompt: "p", provider: "gateway", model: "a/b" })).toEqual({
      prompt: "p",
      provider: "vercel",
      model: "a/b",
    });
    // Los modelos de OpenRouter ya tienen el formato del gateway.
    expect(migrateStoredConfig({ side: "red", prompt: "p", provider: "openrouter", model: "openai/gpt-4o-mini" })).toEqual({
      side: "red",
      prompt: "p",
      provider: "vercel",
      model: "openai/gpt-4o-mini",
    });
    expect(migrateStoredConfig({ prompt: "p", provider: "openrouter" })).toEqual({ prompt: "p", provider: "vercel" });
  });

  it("para el historial conserva el modelo aunque borre el proveedor", () => {
    expect(migrateStoredConfig({ prompt: "p", provider: "anthropic", model: "claude-haiku-5-5" }, true)).toEqual({
      prompt: "p",
      model: "claude-haiku-5-5",
    });
  });

  it("con los demás proveedores eliminados borra el proveedor y también el modelo", () => {
    for (const provider of ["openai", "anthropic", "basura", 7]) {
      expect(migrateStoredConfig({ prompt: "p", provider, model: "gpt-4o", kit: "tank" })).toEqual({ prompt: "p", kit: "tank" });
    }
  });

  it("no modifica el objeto que recibe y aplicarla dos veces da lo mismo", () => {
    const stored = { prompt: "p", provider: "gateway" };
    const once = migrateStoredConfig(stored);
    expect(stored).toEqual({ prompt: "p", provider: "gateway" });
    expect(migrateStoredConfig(once)).toEqual(once);
  });
});

describe("normalizeConfig", () => {
  it("omite modelo vacío y proveedor ausente, y pone el kit por defecto", () => {
    expect(normalizeConfig("red", { prompt: "hola", model: "   " })).toEqual({
      side: "red",
      prompt: "hola",
      kit: "classic",
    });
  });

  it("conserva proveedor, modelo recortado y kit", () => {
    expect(normalizeConfig("blue", { prompt: "hola", provider: "vercel", model: " m1 ", kit: "ender" })).toEqual({
      side: "blue",
      prompt: "hola",
      provider: "vercel",
      model: "m1",
      kit: "ender",
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

  it("las peleas guardadas con proveedores que ya no existen siguen en el historial", () => {
    const old = record("vieja") as unknown as { configs: Record<Side, Record<string, unknown>> };
    old.configs.red.provider = "anthropic";
    old.configs.red.model = "claude-haiku-5-5";
    old.configs.blue.provider = "gateway";
    old.configs.blue.model = "openai/gpt-6-luna";
    const parsed = parseMatchLines([JSON.stringify(old), JSON.stringify(record("nueva"))].join("\n"));
    expect(parsed.map((r) => r.id)).toEqual(["nueva", "vieja"]);
    // El modelo se conserva: es la verdad de lo que peleó.
    expect(parsed[1]?.configs.red).toEqual({ side: "red", prompt: "ataca", model: "claude-haiku-5-5" });
    expect(parsed[1]?.configs.blue).toEqual({
      side: "blue",
      prompt: "defiende",
      provider: "vercel",
      model: "openai/gpt-6-luna",
    });
  });

  it("conserva el kit de cada lado y tolera uno desconocido", () => {
    const withKits = record("kits") as unknown as { configs: Record<Side, Record<string, unknown>> };
    withKits.configs.red.kit = "builder";
    withKits.configs.blue.kit = "ninja";
    const [parsed] = parseMatchLines(JSON.stringify(withKits));
    expect(parsed?.configs.red.kit).toBe("builder");
    expect(parsed?.configs.blue.kit).toBeUndefined();
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

  it("corrige también una pelea que ya salió de la caché (la busca en el archivo)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phack-store-"));
    try {
      const store = new MatchStore(dir, () => {});
      await store.append(record("vieja"));
      for (let i = 0; i < MAX_HISTORY; i += 1) await store.append(record(`r${i}`));
      expect(store.latest().some((r) => r.id === "vieja")).toBe(false);
      expect(await store.update("vieja", (r) => ({ ...r, result: { ...r.result, explanation: "tarde" } }))).toBe(true);
      expect((await store.find("vieja"))?.result.explanation).toBe("tarde");
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

describe("parseSettings", () => {
  it("vuelve a los ajustes por defecto si el archivo está corrupto o trae basura", () => {
    expect(parseSettings("{no")).toEqual({ ...DEFAULT_SETTINGS, comms: "none", timer: true, timerSeconds: null, mode: "single", voice: false });
    expect(parseSettings("{}")).toEqual({ ...DEFAULT_SETTINGS, comms: "none", timer: true, timerSeconds: null, mode: "single", voice: false });
    expect(parseSettings('{"comms":"telepatía"}')).toEqual({ ...DEFAULT_SETTINGS, comms: "none", timer: true, timerSeconds: null, mode: "single", voice: false });
    expect(parseSettings('{"comms":"chat"}')).toEqual({ ...DEFAULT_SETTINGS, comms: "chat", timer: true, timerSeconds: null, mode: "single", voice: false });
  });

  it("guarda el límite de tiempo apagado; un archivo de antes lo trae encendido", () => {
    expect(parseSettings('{"comms":"chat","timer":false}')).toEqual({ ...DEFAULT_SETTINGS, comms: "chat", timer: false, timerSeconds: null, mode: "single", voice: false });
    expect(parseSettings('{"comms":"none","timer":"quizás"}')).toEqual({ ...DEFAULT_SETTINGS, comms: "none", timer: true, timerSeconds: null, mode: "single", voice: false });
  });

  it("guarda la duración elegida; una fuera de rango vuelve a la del servidor", () => {
    expect(parseSettings('{"timerSeconds":7200}').timerSeconds).toBe(7200);
    expect(parseSettings('{"timerSeconds":5}').timerSeconds).toBeNull();
    expect(parseSettings('{"timerSeconds":"mucho"}').timerSeconds).toBeNull();
  });

  it("un registro de historial sin ajustes vale como sin comunicación", () => {
    const { settings: _omit, ...old } = record("viejo");
    expect(parseMatchLines(JSON.stringify(old))[0]?.settings).toEqual({ ...DEFAULT_SETTINGS, comms: "none", timer: true, timerSeconds: null, mode: "single", voice: false });
  });
});
