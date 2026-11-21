import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MatchAttempt, TournamentConfig } from "@phack/protocol";
import { benchmarkVersion } from "./benchmark";
import { REF_KEY, fakeConfig, tempDataDir } from "./fixtures";
import { buildReport, calibrationSpecs, leagueSpecs } from "./report";
import { BenchmarkMismatchError, runTournament } from "./runner";
import { createSimRunner } from "./sim";
import { FileTournamentStore, validAttempts } from "./store";
import type { MatchRunner } from "./types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(config: TournamentConfig): Promise<FileTournamentStore> {
  const dir = await tempDataDir();
  dirs.push(dir);
  const store = new FileTournamentStore(dir);
  await store.create(config, "{}");
  return store;
}

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of items) m.set(key(t), (m.get(key(t)) ?? 0) + 1);
  return m;
}

describe("runTournament con agentes simulados", () => {
  it("corre calibración → liga y termina con el calendario completo", async () => {
    const config = fakeConfig(4);
    const store = await setup(config);
    const summary = await runTournament(store, config.id, createSimRunner());
    expect(summary.stage).toBe("done");
    expect(summary.paused).toBe(false);

    const attempts = await store.attempts(config.id);
    const state = (await store.loadState(config.id))!;
    expect(state.leagueModels).not.toBeNull();
    expect(state.leagueModels).toContain(REF_KEY);
    const planned = [...calibrationSpecs(config, state), ...leagueSpecs(config, state)];
    const valid = validAttempts(attempts);
    expect(valid.map((a) => a.matchId).sort()).toEqual(planned.map((s) => s.id).sort());

    const report = buildReport(config, attempts, state);
    expect(report.progress.stage).toBe("done");
    expect(report.standings.length).toBe(state.leagueModels!.length);
    expect(report.standings.find((s) => s.isReference)?.rating).toBe(1000);
  });

  it("10 modelos en la liga: 45 parejas, 90 partidas por semilla y 450 con 5 semillas", async () => {
    const config = fakeConfig(9, { limits: { ...fakeConfig(9).limits, maxMatches: 1000 } });
    const store = await setup(config);
    const models = [config.reference, ...config.candidates].map((m) => m.key).sort();
    await store.saveState(config.id, {
      leagueModels: models,
      leagueSeeds: [1000, 1001, 1002, 1003, 1004],
      adaptiveRounds: [],
      stopReason: null,
      paused: false,
    });
    await runTournament(store, config.id, createSimRunner());
    const valid = validAttempts(await store.attempts(config.id)).filter((a) => a.spec.stage === "league");
    expect(valid).toHaveLength(450);
    expect(new Set(valid.map((a) => a.matchId)).size).toBe(450);
    expect(new Set(valid.map((a) => `${a.spec.a}~${a.spec.b}`)).size).toBe(45);
    for (const n of countBy(valid, (a) => String(a.spec.seed)).values()) expect(n).toBe(90);
    // Cada pareja juega ida y vuelta en cada semilla: 2·5 = 10 partidas.
    for (const n of countBy(valid, (a) => `${a.spec.a}~${a.spec.b}`).values()) expect(n).toBe(10);
  });

  it("todo empates ⇒ todos en exactamente 1000", async () => {
    const config = fakeConfig(5);
    const store = await setup(config);
    await runTournament(store, config.id, createSimRunner({ drawRate: 1 }));
    const report = buildReport(config, await store.attempts(config.id), await store.loadState(config.id));
    expect(report.standings.length).toBeGreaterThan(1);
    for (const s of report.standings) expect(s.rating).toBe(1000);
    for (const c of report.calibration) {
      expect(c.diff).toBe(0);
      expect(c.verdict).not.toBe("outside");
    }
    for (const cell of report.matrix) expect(cell.score).toBe(0.5);
  });

  it("reordenar attempts.jsonl da exactamente el mismo reporte", async () => {
    const config = fakeConfig(5);
    const store = await setup(config);
    await runTournament(store, config.id, createSimRunner({ infraRate: 0.1 }));
    const state = await store.loadState(config.id);
    const file = join(store.dir(config.id), "attempts.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const before = buildReport(config, await store.attempts(config.id), state);

    // Barajado determinista (los intentos de un mismo matchId conservan su orden relativo:
    // "el primer valid" se define por orden de archivo, y solo hay uno valid por id).
    const shuffled = [...lines].reverse();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    await writeFile(file, `${shuffled.join("\n")}\n`, "utf8");
    const after = buildReport(config, await store.attempts(config.id), state);
    expect(after.standings).toEqual(before.standings);
    expect(after.matrix).toEqual(before.matrix);
    expect(after.calibration).toEqual(before.calibration);
    expect(after.standings.map((s) => s.model)).toEqual(before.standings.map((s) => s.model));
  });

  it("abort a mitad + reanudar: cada matchId con exactamente un valid y el total del calendario", async () => {
    const config = fakeConfig(5);
    const store = await setup(config);
    const abort = new AbortController();
    let seen = 0;
    const first = await runTournament(store, config.id, createSimRunner({ delayMs: 15 }), {
      signal: abort.signal,
      onAttempt: () => {
        seen++;
        // Aborta mientras la partida siguiente está "jugándose" (dentro de delayMs).
        if (seen === 9) setTimeout(() => abort.abort(), 3);
      },
    });
    expect(first.paused).toBe(true);
    expect(first.stage).toBe("paused");
    const mid = await store.attempts(config.id);
    expect(mid.length).toBe(9);

    const second = await runTournament(store, config.id, createSimRunner());
    expect(second.stage).toBe("done");
    const attempts = await store.attempts(config.id);
    const state = (await store.loadState(config.id))!;
    const planned = [...calibrationSpecs(config, state), ...leagueSpecs(config, state)];
    const validCount = countBy(
      attempts.filter((a) => a.status === "valid"),
      (a) => a.matchId,
    );
    for (const spec of planned) expect(validCount.get(spec.id)).toBe(1);
    expect([...validCount.values()].reduce((s, n) => s + n, 0)).toBe(planned.length);

    // Reanudar de nuevo no agrega nada.
    const third = await runTournament(store, config.id, createSimRunner());
    expect(third.played).toBe(0);
    expect((await store.attempts(config.id)).length).toBe(attempts.length);
  });

  it("la pausa por archivo deja el torneo pausado y el resume lo completa", async () => {
    const config = fakeConfig(3);
    const store = await setup(config);
    let n = 0;
    const first = await runTournament(store, config.id, createSimRunner(), {
      pauseRequested: () => store.pauseRequested(config.id),
      onAttempt: () => {
        if (++n === 4) void store.requestPause(config.id);
      },
    });
    expect(first.paused).toBe(true);
    expect(first.played).toBeGreaterThanOrEqual(4);
    expect((await store.loadState(config.id))?.paused).toBe(true);
    await store.clearPause(config.id);
    const second = await runTournament(store, config.id, createSimRunner());
    expect(second.stage).toBe("done");
  });

  it("los fallos de infra se reintentan y quedan fuera del rating", async () => {
    const config = fakeConfig(4);
    const store = await setup(config);
    const failFirst = (id: string): boolean => id.length % 3 === 0;
    await runTournament(
      store,
      config.id,
      createSimRunner({ infra: (spec, attempt) => (attempt === 1 && failFirst(spec.id) ? "simulado: 429" : null) }),
    );
    const attempts = await store.attempts(config.id);
    const infra = attempts.filter((a) => a.status === "infra");
    expect(infra.length).toBeGreaterThan(0);
    for (const a of infra) {
      expect(a.attempt).toBe(1);
      const retry = attempts.find((b) => b.matchId === a.matchId && b.attempt === 2);
      expect(retry?.status).toBe("valid");
    }
    const state = await store.loadState(config.id);
    const withInfra = buildReport(config, attempts, state);
    const withoutInfra = buildReport(
      config,
      attempts.filter((a) => a.status === "valid"),
      state,
    );
    expect(withInfra.standings.map((s) => [s.model, s.rating, s.games])).toEqual(
      withoutInfra.standings.map((s) => [s.model, s.rating, s.games]),
    );
    expect(withInfra.progress.calibration.infra + withInfra.progress.league.infra).toBe(infra.length);
  });

  it("una partida que siempre falla agota maxAttempts y no se vuelve a intentar", async () => {
    const config = fakeConfig(2);
    const store = await setup(config);
    const doomed = (await import("./report")).calibrationBaseSpecs(config)[0]!.id;
    const runner = createSimRunner({ infra: (spec) => (spec.id === doomed ? "simulado: caída" : null) });
    await runTournament(store, config.id, runner);
    await runTournament(store, config.id, runner);
    const tries = (await store.attempts(config.id)).filter((a) => a.matchId === doomed);
    expect(tries).toHaveLength(config.limits.maxAttempts);
    expect(tries.every((a) => a.status === "infra")).toBe(true);
  });

  it("un runner que lanza se registra como infra", async () => {
    const config = fakeConfig(2);
    const store = await setup(config);
    const sim = createSimRunner();
    let calls = 0;
    const flaky: MatchRunner = {
      run: (spec, models, signal, info) => {
        if (calls++ === 0) return Promise.reject(new Error("RCON caído"));
        return sim.run(spec, models, signal, info);
      },
    };
    await runTournament(store, config.id, flaky);
    const [first] = await store.attempts(config.id);
    expect(first?.status).toBe("infra");
    expect(first?.error).toContain("RCON caído");
  });

  it("respeta maxMatches y el reloj proyectado", async () => {
    const config = fakeConfig(4, {
      limits: { ...fakeConfig(4).limits, maxMatches: 7 },
    });
    const store = await setup(config);
    const summary = await runTournament(store, config.id, createSimRunner());
    expect(summary.stopReason).toContain("límite de partidas");
    expect(summary.stage).toBe("done");
    expect(validAttempts(await store.attempts(config.id))).toHaveLength(7);

    const clock = fakeConfig(8, { id: "t-reloj", limits: { ...fakeConfig(8).limits, maxMinutes: 60 } });
    const store2 = await setup(clock);
    const s2 = await runTournament(store2, clock.id, createSimRunner());
    const r = buildReport(clock, await store2.attempts(clock.id), await store2.loadState(clock.id));
    expect(r.progress.elapsedMinutes).toBeLessThanOrEqual(60);
    expect(s2.stage).toBe("done");
  });

  it("se niega a reanudar si el benchmark cambió", async () => {
    const config = fakeConfig(2);
    const store = await setup(config);
    const other = benchmarkVersion("platanus", 60, 1500, [{ name: "otra tool" }]);
    await expect(runTournament(store, config.id, createSimRunner(), { benchmark: other })).rejects.toBeInstanceOf(
      BenchmarkMismatchError,
    );
    await expect(runTournament(store, config.id, createSimRunner(), { benchmark: other })).rejects.toThrow(/tools del agente/);
    expect(await store.attempts(config.id)).toEqual([] as MatchAttempt[]);
  });

  it("recorta la liga a los más cercanos si no cabe y lo deja registrado", async () => {
    const config = fakeConfig(6, { limits: { ...fakeConfig(6).limits, maxMatches: 6 * 2 * 2 + 12 } });
    const store = await setup(config);
    await runTournament(store, config.id, createSimRunner({ drawRate: 1 }));
    const state = (await store.loadState(config.id))!;
    // Base = 6 parejas con la ref + 3 cruces = 9 parejas = 18 partidas; quedan 18 ⇒ n(n-1) ≤ 18 ⇒ n = 4.
    expect(state.leagueModels).toHaveLength(4);
    expect(state.leagueCut?.length).toBe(3);
    const report = buildReport(config, await store.attempts(config.id), state);
    const cut = report.calibration.filter((c) => state.leagueCut!.some((x) => x.model === c.model));
    for (const c of cut) {
      expect(c.league).toBe(false);
      expect(c.why).toContain("fuera por presupuesto");
    }
  });
});
