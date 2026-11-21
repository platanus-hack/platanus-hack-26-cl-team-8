import { describe, expect, it } from "vitest";
import type { MatchAttempt, MatchSpec } from "@phack/protocol";
import { REF_KEY, fakeConfig } from "./fixtures";
import {
  PROVISIONAL_MIN_GAMES,
  attemptGame,
  buildReport,
  calibrationBaseSpecs,
  leagueSpecs,
  pairAttempts,
  summarize,
} from "./report";
import { createSimRunner } from "./sim";
import { emptyState } from "./store";
import type { RunnerState } from "./types";

const config = fakeConfig(3);
const models = Object.fromEntries([config.reference, ...config.candidates].map((m) => [m.key, m]));
const sim = createSimRunner();

async function play(specs: MatchSpec[], opts: { infraFirst?: boolean } = {}): Promise<MatchAttempt[]> {
  const out: MatchAttempt[] = [];
  const signal = new AbortController().signal;
  for (const spec of specs) {
    if (opts.infraFirst) {
      const bad = await createSimRunner({ infraRate: 1 }).run(spec, models, signal, { attempt: 1, tournamentId: config.id });
      out.push(bad);
    }
    out.push(await sim.run(spec, models, signal, { attempt: opts.infraFirst ? 2 : 1, tournamentId: config.id }));
  }
  return out;
}

describe("attemptGame", () => {
  it("puntaje desde el punto de vista de a; empate = 0.5", async () => {
    const [attempt] = await play(calibrationBaseSpecs(config).slice(0, 1));
    const g = attemptGame({ ...attempt!, outcome: { winner: attempt!.spec.b, reason: "kill" } });
    expect(g.scoreA).toBe(0);
    expect(attemptGame({ ...attempt!, outcome: { winner: null, reason: "draw" } }).scoreA).toBe(0.5);
    expect(g.cluster).toBe("platanus:s1");
  });
});

describe("buildReport", () => {
  it("sin liga: standings y matriz vacíos, calibración con todos los candidatos", async () => {
    const attempts = await play(calibrationBaseSpecs(config));
    const report = buildReport(config, attempts, null);
    expect(report.standings).toEqual([]);
    expect(report.matrix).toEqual([]);
    expect(report.provisional).toBe(true);
    expect(report.provisionalWhy[0]).toMatch(/liga todavía no empieza/);
    expect(report.calibration.map((c) => c.model).sort()).toEqual(config.candidates.map((c) => c.key).sort());
    expect(report.progress.stage).toBe("calibration");
    expect(report.progress.calibration).toEqual({ planned: 10, valid: 10, infra: 0 });
  });

  it("standings solo con liga; matriz en el orden de standings; provisional con pocos datos", async () => {
    const cal = await play(calibrationBaseSpecs(config));
    const state: RunnerState = {
      ...emptyState(),
      leagueModels: [REF_KEY, config.candidates[0]!.key, config.candidates[1]!.key].sort(),
      leagueSeeds: [1000],
    };
    const league = await play(leagueSpecs(config, state), { infraFirst: true });
    const report = buildReport(config, [...cal, ...league], state);

    expect(report.standings).toHaveLength(3);
    // 3 modelos × 1 semilla: cada uno juega 4 partidas de liga (las de calibración no cuentan).
    for (const s of report.standings) expect(s.games).toBe(4);
    expect(report.standings.map((s) => s.rank)).toEqual([1, 2, 3]);
    expect(report.standings.find((s) => s.isReference)?.rating).toBe(1000);
    expect(report.standings.every((s) => s.ciMethod === "laplace")).toBe(true);

    const order = report.standings.map((s) => s.model);
    expect(report.matrix.map((c) => [c.row, c.col])).toEqual(
      order.flatMap((row) => order.filter((col) => col !== row).map((col) => [row, col])),
    );
    for (const cell of report.matrix) expect(cell.games).toBe(2);

    expect(report.provisional).toBe(true);
    expect(report.provisionalWhy.some((w) => w.includes(`mínimo ${PROVISIONAL_MIN_GAMES}`))).toBe(true);
    expect(report.provisionalWhy.some((w) => w.includes("semilla"))).toBe(true);
    // Con 1 semilla de calibración los intervalos son anchos: quien entró está "pending".
    const pendingIn = report.calibration.filter((r) => r.league && r.verdict === "pending");
    expect(pendingIn.length).toBeGreaterThan(0);
    expect(report.provisionalWhy).toContain(`entraron a la liga con la calibración pendiente: ${pendingIn.map((r) => r.name).join(", ")}`);
    expect(report.progress.league).toMatchObject({ planned: 6, valid: 6, infra: 6, seedsPlanned: 1, seedsDone: 1 });
    expect(report.progress.stage).toBe("league");
    // Los intentos infra cuestan y suman reloj, pero no juegos.
    expect(report.progress.costUsd).toBeGreaterThan(0);
  });

  it("pairAttempts acepta la pareja en cualquier orden e incluye infra y ambas etapas", async () => {
    const a = REF_KEY;
    const b = config.candidates[0]!.key;
    const state: RunnerState = { ...emptyState(), leagueModels: [a, b].sort(), leagueSeeds: [1000] };
    const attempts = [...(await play(calibrationBaseSpecs(config))), ...(await play(leagueSpecs(config, state), { infraFirst: true }))];
    const x = pairAttempts(attempts, a, b);
    const y = pairAttempts(attempts, b, a);
    expect(x).toEqual(y);
    expect(new Set(x.map((t) => t.spec.stage))).toEqual(new Set(["calibration", "league"]));
    expect(x.some((t) => t.status === "infra")).toBe(true);
    expect(pairAttempts(attempts, "x/no", b)).toEqual([]);
  });

  it("summarize", async () => {
    const attempts = await play(calibrationBaseSpecs(config));
    expect(summarize(config, attempts, null)).toMatchObject({ id: config.id, models: 4, validMatches: 10, stage: "calibration" });
    expect(summarize(config, [], { ...emptyState(), paused: true }).stage).toBe("paused");
  });
});
