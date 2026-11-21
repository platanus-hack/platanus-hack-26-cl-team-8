/**
 * De punta a punta con agentes simulados: catálogo real congelado (fixture) → torneo con
 * el plan por defecto de 1 hora → reporte.
 */
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FrozenModel, TournamentConfig } from "@phack/protocol";
import { BENCHMARK_MATCH_SECONDS, benchmarkVersion, sha256 } from "./benchmark";
import {
  DEFAULT_PRIORITY_LINES,
  DEFAULT_REFERENCE_ID,
  DEFAULT_REFERENCE_PROVIDER,
  freezeModel,
  lineKey,
  resolveCatalog,
} from "./catalog";
import { tempDataDir } from "./fixtures";
import { buildReport, calibrationSpecs, leagueSpecs } from "./report";
import { runTournament } from "./runner";
import { DEFAULT_SEEDS } from "./schedule";
import { createSimRunner } from "./sim";
import { FileTournamentStore, validAttempts } from "./store";
import type { CatalogModel } from "./types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function frozenFromFixture(maxCandidates: number): Promise<{ raw: string; reference: FrozenModel; candidates: FrozenModel[] }> {
  const raw = await readFile(fileURLToPath(new URL("./catalog.fixture.json", import.meta.url)), "utf8");
  const models = (JSON.parse(raw) as { data: CatalogModel[] }).data;
  const res = resolveCatalog(models, { priorityLines: DEFAULT_PRIORITY_LINES, referenceId: DEFAULT_REFERENCE_ID, maxCandidates });
  const ref = freezeModel(res.reference, null, { isReference: true, priority: null, pinProvider: DEFAULT_REFERENCE_PROVIDER });
  if ("omittedReason" in ref) throw new Error(ref.omittedReason);
  const candidates = res.candidates.map((l) => {
    const f = freezeModel(l.chosen!, null, { isReference: false, priority: l.priority });
    if ("omittedReason" in f) throw new Error(f.omittedReason);
    return { ...f, clientProvider: "mock" as const };
  });
  return { raw, reference: { ...ref, clientProvider: "mock" }, candidates };
}

describe("torneo simulado de punta a punta", () => {
  it("una sola versión por línea y ninguna de la línea de la referencia", async () => {
    const { reference, candidates } = await frozenFromFixture(30);
    const lines = candidates.map((c) => lineKey(c.gatewayId).line);
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines).not.toContain(lineKey(reference.gatewayId).line);
    expect(candidates.some((c) => c.gatewayId.endsWith("-batch"))).toBe(false);
    expect(reference.gatewayId).toBe("deepseek/deepseek-v4.1-flash-1017-fast");
    expect(reference.inferenceProvider).toBe("baseten");
  });

  it("plan de 1 hora: calibración, liga, reloj ≤ 60 min y reporte consistente", async () => {
    const { raw, reference, candidates } = await frozenFromFixture(8);
    const config: TournamentConfig = {
      id: "e2e-1h",
      name: "E2E 1 hora",
      createdAt: Date.now(),
      catalog: { fetchedAt: Date.now(), sha256: sha256(raw), source: "fixture" },
      benchmark: benchmarkVersion("platanus", BENCHMARK_MATCH_SECONDS, 1500),
      reference,
      candidates,
      omitted: [],
      limits: { maxMinutes: 60, maxMatches: 1000, maxUsd: 10, concurrency: 1, maxCandidates: 8, calibrationShare: 0.5, maxAttempts: 3 },
      rule: { bandElo: 150, z: 1.645, priorSdElo: 400 },
      scenarios: ["platanus"],
      seeds: { ...DEFAULT_SEEDS },
      mode: "simulated",
    };
    const dir = await tempDataDir();
    dirs.push(dir);
    const store = new FileTournamentStore(dir);
    await store.create(config, raw);

    const summary = await runTournament(store, config.id, createSimRunner({ infraRate: 0.05 }), {
      benchmark: benchmarkVersion("platanus", BENCHMARK_MATCH_SECONDS, 1500),
    });
    expect(summary.paused).toBe(false);
    expect(summary.stage).toBe("done");

    const attempts = await store.attempts(config.id);
    const state = (await store.loadState(config.id))!;
    const report = buildReport(config, attempts, state);
    expect(report.progress.elapsedMinutes).toBeLessThanOrEqual(60);
    // La ronda base (8 candidatos: 8 vs ref + 4 cruces = 24 partidas) se juega entera.
    expect(report.progress.calibration.planned).toBeGreaterThanOrEqual(24);
    const valid = validAttempts(attempts);
    const calIds = new Set(calibrationSpecs(config, state).map((s) => s.id));
    expect(valid.filter((a) => calIds.has(a.matchId)).length).toBe(report.progress.calibration.valid);

    if (state.leagueModels && state.leagueModels.length >= 2) {
      expect(leagueSpecs(config, state).length).toBe(report.progress.league.planned);
      expect(report.standings.length).toBe(state.leagueModels.length);
      expect(report.provisional).toBe(true);
    }
    // Cada candidato tiene fila de calibración con veredicto y motivo.
    expect(report.calibration).toHaveLength(8);
    for (const row of report.calibration) expect(row.why.length).toBeGreaterThan(0);
  });
});
