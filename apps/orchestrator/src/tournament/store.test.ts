import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MatchAttempt } from "@phack/protocol";
import { fakeConfig, tempDataDir } from "./fixtures";
import {
  FileTournamentStore,
  TournamentLockedError,
  TournamentNotFoundError,
  acquireLock,
  isValidTournamentId,
  lockFile,
  parseAttemptLines,
  readLiveLock,
  tournamentsDir,
  validAttempts,
} from "./store";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function dataDir(): Promise<string> {
  const d = await tempDataDir();
  dirs.push(d);
  return d;
}

function attempt(matchId: string, n: number, status: MatchAttempt["status"], winner: string | null = null): MatchAttempt {
  const side = (model: string) => ({
    model,
    health: 10,
    damageDealt: 5,
    decisions: 10,
    invalidActions: 0,
    tokensIn: 100,
    tokensOut: 10,
    costUsd: 0.01,
    costSource: "estimated" as const,
    latencyMs: { count: 10, mean: 500, p50: 480, p95: 900 },
    llmErrors: 0,
  });
  return {
    matchId,
    attempt: n,
    status,
    spec: { id: matchId, stage: "calibration", scenario: "platanus", seed: 1, a: "a", b: "b", leg: "ida", red: "a", blue: "b", round: 0 },
    startedAt: 1000 * n,
    endedAt: 1000 * n + 80_000,
    outcome: status === "valid" ? { winner, reason: winner ? "kill" : "draw" } : null,
    error: status === "infra" ? "429" : null,
    sides: { red: side("a"), blue: side("b") },
  };
}

describe("validAttempts", () => {
  it("cuenta el primer valid por matchId y nunca los infra", () => {
    const list = [
      attempt("m2", 1, "infra"),
      attempt("m1", 1, "valid", "a"),
      attempt("m2", 2, "valid", "b"),
      attempt("m1", 2, "valid", "b"), // duplicado: no cuenta
      attempt("m3", 1, "infra"),
    ];
    const valid = validAttempts(list);
    expect(valid.map((a) => [a.matchId, a.attempt])).toEqual([
      ["m1", 1],
      ["m2", 2],
    ]);
  });
});

describe("parseAttemptLines", () => {
  it("ignora líneas vacías, corruptas o cortadas", () => {
    const good = JSON.stringify(attempt("m1", 1, "valid", "a"));
    const raw = `${good}\n\n{"matchId":"x"}\nno-json\n${good.slice(0, 20)}`;
    expect(parseAttemptLines(raw)).toHaveLength(1);
  });
});

describe("FileTournamentStore", () => {
  it("crea, carga, lista y guarda intentos y estado", async () => {
    const store = new FileTournamentStore(await dataDir());
    const config = fakeConfig(2);
    await store.create(config, '{"data":[]}');
    await expect(store.create(config, "{}")).rejects.toThrow(/Ya existe/);

    expect(await store.load(config.id)).toEqual(config);
    expect(await store.catalogRaw(config.id)).toBe('{"data":[]}');
    expect((await store.list()).map((c) => c.id)).toEqual([config.id]);
    expect(await store.attempts(config.id)).toEqual([]);

    await store.appendAttempt(config.id, attempt("m1", 1, "infra"));
    await store.appendAttempt(config.id, attempt("m1", 2, "valid", "a"));
    expect((await store.attempts(config.id)).map((a) => a.attempt)).toEqual([1, 2]);

    const state = { leagueModels: ["a", "b"], leagueSeeds: [1000], adaptiveRounds: [], stopReason: "x", paused: true };
    await store.saveState(config.id, state);
    expect(await store.loadState(config.id)).toEqual(state);
    // Sin restos de archivos temporales (escritura atómica).
    expect((await readdir(store.dir(config.id))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("appendAttempt concurrente no intercala líneas", async () => {
    const store = new FileTournamentStore(await dataDir());
    const config = fakeConfig(2);
    await store.create(config, "{}");
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.appendAttempt(config.id, attempt(`m${i}`, 1, "valid", "a"))));
    expect(await store.attempts(config.id)).toHaveLength(50);
  });

  it("no existe ⇒ TournamentNotFoundError; ids inválidos no tocan el disco", async () => {
    const store = new FileTournamentStore(await dataDir());
    await expect(store.load("nada")).rejects.toBeInstanceOf(TournamentNotFoundError);
    await expect(store.load("../etc")).rejects.toBeInstanceOf(TournamentNotFoundError);
    expect(isValidTournamentId("../etc")).toBe(false);
    expect(isValidTournamentId("torneo-20261121-1530")).toBe(true);
    expect(await store.exists("..")).toBe(false);
  });

  it("list ignora carpetas sin tournament.json", async () => {
    const dir = await dataDir();
    const store = new FileTournamentStore(dir);
    await store.create(fakeConfig(2), "{}");
    await store.create(fakeConfig(2, { id: "t-otro", createdAt: 1_800_000_000_000 }), "{}");
    await writeFile(join(store.root, "t-roto.txt"), "x");
    expect((await store.list()).map((c) => c.id)).toEqual(["t-otro", "t-test"]);
  });

  it("pausa por archivo", async () => {
    const store = new FileTournamentStore(await dataDir());
    const config = fakeConfig(2);
    await store.create(config, "{}");
    expect(await store.pauseRequested(config.id)).toBe(false);
    await store.requestPause(config.id);
    expect(await store.pauseRequested(config.id)).toBe(true);
    await store.clearPause(config.id);
    expect(await store.pauseRequested(config.id)).toBe(false);
  });
});

describe("lock de proceso", () => {
  it("es exclusivo mientras el pid vive y se reemplaza si quedó huérfano", async () => {
    const dir = await dataDir();
    const release = await acquireLock(dir, "t-test");
    expect((await readLiveLock(dir))?.id).toBe("t-test");
    await expect(acquireLock(dir, "t-otro")).rejects.toBeInstanceOf(TournamentLockedError);
    await release();
    expect(await readLiveLock(dir)).toBeNull();

    // Lock de un proceso muerto: se ignora y se reemplaza.
    await writeFile(lockFile(dir), JSON.stringify({ pid: 999_999_999, id: "viejo", startedAt: 0 }));
    expect(await readLiveLock(dir)).toBeNull();
    const release2 = await acquireLock(dir, "t-nuevo");
    expect(JSON.parse(await readFile(lockFile(dir), "utf8")).id).toBe("t-nuevo");
    await release2();
  });

  it("un lock de otra máquina (host CLI vs orquestador en Docker) cuenta como vivo", async () => {
    // En otro espacio de pids `kill(pid, 0)` no dice nada: el pid del host no existe en el
    // contenedor y el lock parecería huérfano, así que "Iniciar pelea" no daría 409.
    const dir = await dataDir();
    await mkdir(tournamentsDir(dir), { recursive: true });
    await writeFile(lockFile(dir), JSON.stringify({ pid: 999_999_999, id: "t-host", startedAt: 0, host: "otra-maquina" }));
    expect((await readLiveLock(dir))?.id).toBe("t-host");
    await expect(acquireLock(dir, "t-otro")).rejects.toBeInstanceOf(TournamentLockedError);
    // El lock propio guarda el host.
    await rm(lockFile(dir));
    const release = await acquireLock(dir, "t-propio");
    expect(JSON.parse(await readFile(lockFile(dir), "utf8")).host).toBe(hostname());
    await release();
  });
});
