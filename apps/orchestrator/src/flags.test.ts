import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MAX_FLAG_TAGS, type AgentStatus, type MatchRecord, type Side } from "@phack/protocol";
import { FlagStore, parseFlags, sourceOfRecord, withFlagOutcomes, type FlagSource } from "./flags";

const MATCH = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

function status(side: Side): AgentStatus {
  return {
    side,
    username: side === "red" ? "AgenteRojo" : "AgenteAzul",
    connected: true,
    alive: side === "red",
    health: side === "red" ? 12 : 0,
    food: 20,
    damageDealt: 0,
    decisions: 3,
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
      red: { side: "red", prompt: "ataca", provider: "vercel", model: "deepseek/x", kit: "archer" },
      blue: { side: "blue", prompt: "defiende", provider: "mock", kit: "tank" },
    },
    final: { red: status("red"), blue: status("blue") },
    settings: { ...DEFAULT_SETTINGS, comms: "chat", timer: false, timerSeconds: null, mode: "single", voice: false },
    series: null,
    result: { winner: "red", reason: "kill" },
  };
}

/** La pelea en curso: sin resultado y con los prompts como se veían al empezar. */
function live(id: string): FlagSource {
  return {
    matchId: id,
    configs: { red: { side: "red", prompt: "ataca" }, blue: { side: "blue", prompt: "defiende" } },
    settings: { ...DEFAULT_SETTINGS, comms: "chat", timer: false, timerSeconds: null, mode: "single", voice: false },
    outcome: null,
  };
}

const quiet = () => {};
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "phack-flags-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FlagStore", () => {
  it("guarda y vuelve a leer las marcas, las más recientes primero", async () => {
    const dir = await tempDir();
    const store = new FlagStore(dir, quiet);
    await store.load();
    expect(store.list()).toEqual([]);
    await store.put(sourceOfRecord(record(MATCH)), "red", { tags: ["Agresivo"], note: " buena " }, 10);
    await store.put(sourceOfRecord(record(OTHER)), "blue", { tags: [], note: "" }, 20);

    const reloaded = new FlagStore(dir, quiet);
    await reloaded.load();
    const flags = reloaded.list();
    expect(flags.map((f) => [f.matchId, f.side])).toEqual([
      [OTHER, "blue"],
      [MATCH, "red"],
    ]);
    expect(flags[1]).toEqual({
      matchId: MATCH,
      side: "red",
      flaggedAt: 10,
      updatedAt: 10,
      tags: ["agresivo"],
      note: "buena",
      config: record(MATCH).configs.red,
      rival: record(MATCH).configs.blue,
      settings: { ...DEFAULT_SETTINGS, comms: "chat", timer: false, timerSeconds: null, mode: "single", voice: false },
      outcome: {
        startedAt: 1000,
        endedAt: 5000,
        durationMs: 4000,
        result: { winner: "red", reason: "kill" },
        final: record(MATCH).final,
      },
    });
    expect(JSON.parse(await readFile(join(dir, "flags.json"), "utf8"))).toHaveLength(2);
  });

  it("al editar solo cambian las etiquetas, la nota y la fecha de edición", async () => {
    const store = new FlagStore(await tempDir(), quiet);
    const created = await store.put(sourceOfRecord(record(MATCH)), "blue", { tags: ["a"], note: "uno" }, 10);
    expect(created.config).toEqual(record(MATCH).configs.blue);
    expect(created.rival).toEqual(record(MATCH).configs.red);

    const changed = record(MATCH);
    changed.configs.blue.prompt = "otro texto";
    changed.result = { winner: "blue", reason: "timeout_health" };
    const edited = await store.put(sourceOfRecord(changed), "blue", { tags: ["b"], note: "dos" }, 30);
    expect(edited).toEqual({ ...created, tags: ["b"], note: "dos", updatedAt: 30 });
    expect(store.list()).toEqual([edited]);
  });

  it("al editar una marca hecha a mitad de pelea completa el resultado si ya terminó", async () => {
    const store = new FlagStore(await tempDir(), quiet);
    await store.put(live(MATCH), "red", { tags: [], note: "" }, 10);
    const edited = await store.put(sourceOfRecord(record(MATCH)), "red", { tags: ["x"], note: "" }, 20);
    expect(edited.outcome?.result).toEqual({ winner: "red", reason: "kill" });
    expect(edited.flaggedAt).toBe(10);
  });

  it("edit cambia una marca existente sin necesitar la pelea, y devuelve null si no hay marca", async () => {
    const store = new FlagStore(await tempDir(), quiet);
    await store.put(sourceOfRecord(record(MATCH)), "red", { tags: ["a"], note: "" }, 10);
    const edited = await store.edit(MATCH, "red", { tags: ["  Nueva   Etiqueta "], note: "nota" }, 40);
    expect(edited).toMatchObject({ tags: ["nueva etiqueta"], note: "nota", updatedAt: 40, flaggedAt: 10 });
    expect(await store.edit(MATCH, "blue", { tags: [], note: "" }, 40)).toBeNull();
  });

  it("normaliza las etiquetas y se queda con las primeras ocho", async () => {
    const store = new FlagStore(await tempDir(), quiet);
    const tags = ["  Rush ", "rush", "", "   ", "A  B", ...Array.from({ length: 12 }, (_, i) => `t${i}`)];
    const flag = await store.put(live(MATCH), "red", { tags, note: "" }, 10);
    expect(flag.tags).toHaveLength(MAX_FLAG_TAGS);
    expect(flag.tags.slice(0, 3)).toEqual(["rush", "a b", "t0"]);
  });

  it("attachOutcome completa una marca hecha a mitad de pelea y recoge la explicación que llega después", async () => {
    const store = new FlagStore(await tempDir(), quiet);
    await store.put(live(MATCH), "red", { tags: ["vivo"], note: "" }, 10);
    await store.put(live(OTHER), "blue", { tags: [], note: "" }, 11);
    expect(store.list().every((f) => f.outcome === null)).toBe(true);

    await store.attachOutcome(record(MATCH));
    let flag = store.list().find((f) => f.matchId === MATCH);
    expect(flag?.outcome?.result).toEqual({ winner: "red", reason: "kill" });
    // Los prompts del registro vienen ya resueltos (proveedor, modelo y kit).
    expect(flag?.config).toEqual(record(MATCH).configs.red);
    expect(flag?.rival).toEqual(record(MATCH).configs.blue);
    expect(flag?.tags).toEqual(["vivo"]);

    const explained = record(MATCH);
    explained.result = { ...explained.result, explanation: "Rojo lo acorraló contra la pared." };
    await store.attachOutcome(explained);
    flag = store.list().find((f) => f.matchId === MATCH);
    expect(flag?.outcome?.result.explanation).toBe("Rojo lo acorraló contra la pared.");
    // La otra pelea no se toca.
    expect(store.list().find((f) => f.matchId === OTHER)?.outcome).toBeNull();
  });

  it("attachOutcome no escribe nada si la pelea no tiene marcas", async () => {
    const dir = await tempDir();
    const store = new FlagStore(dir, quiet);
    await store.attachOutcome(record(MATCH));
    await expect(readFile(join(dir, "flags.json"), "utf8")).rejects.toThrow();
  });

  it("remove quita solo ese lado de esa pelea", async () => {
    const dir = await tempDir();
    const store = new FlagStore(dir, quiet);
    await store.put(live(MATCH), "red", { tags: [], note: "" }, 10);
    await store.put(live(MATCH), "blue", { tags: [], note: "" }, 11);
    expect(await store.remove(MATCH, "red")).toBe(true);
    expect(await store.remove(MATCH, "red")).toBe(false);
    expect(store.list().map((f) => f.side)).toEqual(["blue"]);
    const reloaded = new FlagStore(dir, quiet);
    await reloaded.load();
    expect(reloaded.list().map((f) => f.side)).toEqual(["blue"]);
  });

  it("un archivo corrupto se lee como ninguna marca y no rompe", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "flags.json"), "{esto no es json", "utf8");
    const store = new FlagStore(dir, quiet);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it("un fallo de disco se registra y no se lanza", async () => {
    const dir = await tempDir();
    // Un archivo en medio de la ruta de la carpeta de datos hace fallar la escritura.
    await writeFile(join(dir, "archivo"), "", "utf8");
    const blocked = join(dir, "archivo", "datos");
    const logs: string[] = [];
    const store = new FlagStore(blocked, (_level, text) => logs.push(text));
    const flag = await store.put(live(MATCH), "red", { tags: [], note: "" }, 10);
    expect(flag.matchId).toBe(MATCH);
    expect(logs[0]).toMatch(/No se pudieron guardar los prompts marcados/);
  });
});

describe("parseFlags", () => {
  const good = (matchId: string, side: Side, flaggedAt: number) => ({
    matchId,
    side,
    flaggedAt,
    updatedAt: flaggedAt,
    tags: [],
    note: "",
    config: { side, prompt: "p" },
    rival: { side: side === "red" ? "blue" : "red", prompt: "r" },
    outcome: null,
  });

  it("si el JSON está corrupto o no es un arreglo, ninguna marca", () => {
    expect(parseFlags("{roto")).toEqual([]);
    expect(parseFlags("null")).toEqual([]);
    expect(parseFlags(JSON.stringify({ a: 1 }))).toEqual([]);
  });

  it("salta las marcas inválidas y conserva las demás, las más recientes primero", () => {
    const raw = JSON.stringify([
      good(MATCH, "red", 10),
      { matchId: MATCH, side: "verde" },
      42,
      good(OTHER, "blue", 30),
      good(MATCH, "red", 50),
    ]);
    const flags = parseFlags(raw);
    expect(flags.map((f) => [f.matchId, f.side, f.flaggedAt])).toEqual([
      [OTHER, "blue", 30],
      [MATCH, "red", 10],
    ]);
    // Sin ajustes guardados valen los de por defecto.
    expect(flags[0]?.settings).toBeDefined();
  });

  it("adapta un proveedor que ya no existe conservando el modelo", () => {
    const flag = { ...good(MATCH, "red", 10), config: { side: "red", prompt: "p", provider: "openrouter", model: "x/y" } };
    expect(parseFlags(JSON.stringify([flag]))[0]?.config).toEqual({ side: "red", prompt: "p", provider: "vercel", model: "x/y" });
  });
});

describe("withFlagOutcomes", () => {
  function fakeHistory() {
    const records = new Map<string, MatchRecord>();
    return {
      records,
      append: async (r: MatchRecord) => {
        records.set(r.id, r);
      },
      update: async (id: string, change: (r: MatchRecord) => MatchRecord) => {
        const current = records.get(id);
        if (!current) return false;
        records.set(id, change(current));
        return true;
      },
    };
  }

  it("las marcas reciben el registro al guardar la pelea y al corregirla", async () => {
    const history = fakeHistory();
    const flags = new FlagStore(await tempDir(), quiet);
    await flags.put(live(MATCH), "blue", { tags: [], note: "" }, 10);
    const wrapped = withFlagOutcomes(history, flags, quiet);

    await wrapped.append(record(MATCH));
    expect(history.records.has(MATCH)).toBe(true);
    expect(flags.list()[0]?.outcome?.result.winner).toBe("red");

    const ok = await wrapped.update(MATCH, (r) => ({ ...r, result: { ...r.result, explanation: "Por la vida." } }));
    expect(ok).toBe(true);
    expect(flags.list()[0]?.outcome?.result.explanation).toBe("Por la vida.");
    expect(await wrapped.update(OTHER, (r) => r)).toBe(false);
  });

  it("un fallo de las marcas no impide guardar la pelea", async () => {
    const history = fakeHistory();
    const logs: string[] = [];
    const broken = {
      attachOutcome: async () => {
        throw new Error("disco lleno");
      },
    };
    const wrapped = withFlagOutcomes(history, broken, (_level, text) => logs.push(text));
    await expect(wrapped.append(record(MATCH))).resolves.toBeUndefined();
    await expect(wrapped.update(MATCH, (r) => r)).resolves.toBe(true);
    expect(history.records.has(MATCH)).toBe(true);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/disco lleno/);
  });
});
