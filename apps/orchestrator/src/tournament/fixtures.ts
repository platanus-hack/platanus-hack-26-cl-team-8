/**
 * Datos de prueba para los tests del torneo (no se usa en producción): modelos congelados
 * sintéticos y una configuración completa.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrozenModel, TournamentConfig } from "@phack/protocol";
import { benchmarkVersion } from "./benchmark";
import { DEFAULT_SEEDS } from "./schedule";

export function fakeModel(key: string, extra: Partial<FrozenModel> = {}): FrozenModel {
  return {
    key,
    name: key.split("/")[1] ?? key,
    line: key,
    gatewayId: key,
    version: "1",
    released: 1_700_000_000,
    inferenceProvider: null,
    clientProvider: "mock",
    reasoning: "none",
    pricing: { input: 1e-7, output: 4e-7, cacheRead: null },
    isReference: false,
    priority: null,
    ...extra,
  };
}

export const REF_KEY = "deepseek/ref";

/** Config con la referencia y `n` candidatos "lab/m00".."lab/mNN". */
export function fakeConfig(n: number, over: Partial<TournamentConfig> = {}): TournamentConfig {
  const candidates = Array.from({ length: n }, (_, i) => fakeModel(`lab/m${String(i).padStart(2, "0")}`, { priority: i }));
  return {
    id: "t-test",
    name: "Torneo de prueba",
    createdAt: 1_700_000_000_000,
    catalog: { fetchedAt: 1_700_000_000_000, sha256: "x", source: "test" },
    benchmark: benchmarkVersion("platanus", 60, 1500),
    reference: fakeModel(REF_KEY, { isReference: true, inferenceProvider: "baseten" }),
    candidates,
    omitted: [],
    limits: {
      maxMinutes: 100_000,
      maxMatches: 300,
      maxUsd: 100_000,
      concurrency: 1,
      maxCandidates: n,
      calibrationShare: 0.5,
      maxAttempts: 3,
    },
    rule: { bandElo: 150, z: 1.645, priorSdElo: 400 },
    scenarios: ["platanus"],
    seeds: { ...DEFAULT_SEEDS },
    mode: "simulated",
    ...over,
  };
}

export function tempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "phack-torneo-"));
}
