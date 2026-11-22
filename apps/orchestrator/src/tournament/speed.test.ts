import { describe, expect, it } from "vitest";
import type { MatchAttempt, SideStats } from "@phack/protocol";
import { REF_KEY, fakeConfig } from "./fixtures";
import { buildSpeedReport, ranks, spearman } from "./speed";

function side(model: string, over: Partial<SideStats> = {}): SideStats {
  return {
    model,
    health: 10,
    damageDealt: 10,
    decisions: 10,
    invalidActions: 0,
    tokensIn: 10_000,
    tokensOut: 500,
    costUsd: 0.01,
    costSource: "reported",
    latencyMs: { count: 10, mean: 1000, p50: 900, p95: 1500 },
    llmErrors: 0,
    ...over,
  };
}

function attempt(id: string, red: SideStats, blue: SideStats, winner: string | null, over: Partial<MatchAttempt> = {}): MatchAttempt {
  return {
    matchId: id,
    attempt: 1,
    status: "valid",
    spec: { id, stage: "league", scenario: "platanus", seed: 1000, a: red.model, b: blue.model, leg: "ida", red: red.model, blue: blue.model, round: 0 },
    startedAt: 0,
    endedAt: 30_000,
    outcome: { winner, reason: winner ? "kill" : "draw" },
    error: null,
    sides: { red, blue },
    ...over,
  } as MatchAttempt;
}

describe("ranks y spearman", () => {
  it("promedia empates y da ±1 en órdenes perfectos", () => {
    expect(ranks([10, 20, 20, 5])).toEqual([2, 3.5, 3.5, 1]);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 2], [1, 2])).toBeNull();
    expect(spearman([1, 2, 3], [5, 5, 5])).toBeNull();
  });
});

describe("buildSpeedReport", () => {
  it("decisiones por minuto de pelea real cuando el intento trae fightMs", () => {
    const config = fakeConfig(1);
    const a = config.candidates[0]!.key;
    const attempts = [
      attempt("n1", side(a, { decisions: 20 }), side(REF_KEY, { decisions: 10 }), a, { fightMs: 20_000 }),
      // Sin fightMs: no entra a la cuenta exacta.
      attempt("n2", side(a, { decisions: 99 }), side(REF_KEY), a),
    ];
    const r = buildSpeedReport(config, attempts, null, "league");
    expect(r.rows.find((x) => x.model === a)!.decisionsPerFightMin).toBeCloseTo(60);
    expect(r.rows.find((x) => x.model === REF_KEY)!.decisionsPerFightMin).toBeCloseTo(30);
  });

  const config = fakeConfig(2);
  const [a, b] = config.candidates.map((m) => m.key) as [string, string];

  it("parte de las decisiones, latencia ponderada, por decisión y V-E-D por modelo", () => {
    const attempts = [
      // a decide 15 veces contra 5 de la referencia y gana.
      attempt("m1", side(a, { decisions: 15, latencyMs: { count: 15, mean: 400, p50: 350, p95: 800 }, damageDealt: 30 }), side(REF_KEY, { decisions: 5 }), a),
      // Empate entre a y b, mismas decisiones.
      attempt("m2", side(a, { decisions: 10, latencyMs: { count: 10, mean: 600, p50: 550, p95: 900 } }), side(b), null),
      // Un intento de infraestructura no cuenta.
      attempt("m3", side(a, { decisions: 99 }), side(b), null, { status: "infra" }),
      // La calibración no cuenta con stage "league".
      attempt("c1", side(b, { decisions: 1 }), side(REF_KEY, { decisions: 1 }), b, {
        spec: { id: "c1", stage: "calibration", scenario: "platanus", seed: 1, a: b, b: REF_KEY, leg: "ida", red: b, blue: REF_KEY, round: 0 },
      }),
    ];
    const standings = [
      { model: a, rank: 1, rating: 1100 },
      { model: REF_KEY, rank: 2, rating: 1000 },
      { model: b, rank: 3, rating: 900 },
    ] as never;
    const r = buildSpeedReport(config, attempts, { standings }, "league");
    expect(r.validMatches).toBe(2);
    expect(r.rows.map((x) => x.model)).toEqual([a, REF_KEY, b]);
    const ra = r.rows[0]!;
    expect(ra).toMatchObject({ matches: 2, wins: 1, draws: 1, losses: 0, decisions: 25, rating: 1100 });
    expect(ra.decisionShare).toBeCloseTo((0.75 + 0.5) / 2);
    expect(ra.decisionsPerMatch).toBeCloseTo(12.5);
    // Media exacta: (400·15 + 600·10) / 25.
    expect(ra.latencyMeanMs).toBeCloseTo(480);
    expect(ra.latencyP50Ms).toBeCloseTo(450);
    expect(ra.damagePerDecision).toBeCloseTo(40 / 25);
    // 25 decisiones en 1 minuto de reloj (2 intentos de 30 s).
    expect(ra.decisionsPerWallMin).toBeCloseTo(25);
    // Intentos de antes, sin la duración de la pelea: no hay decisiones por minuto exactas.
    expect(ra.decisionsPerFightMin).toBeNull();
    expect(r.rows[1]).toMatchObject({ matches: 1, losses: 1, decisionShare: 0.25 });

    const share = r.correlations.find((c) => c.metric === "decisionShare")!;
    expect(share.n).toBe(3);
    expect(share.rho).toBeCloseTo(0.5);

    const all = buildSpeedReport(config, attempts, null, "all");
    expect(all.validMatches).toBe(3);
    expect(all.rows.every((x) => x.rating === null)).toBe(true);
  });
});
