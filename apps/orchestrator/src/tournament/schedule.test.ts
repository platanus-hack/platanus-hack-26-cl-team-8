import type { CalibrationRow, FrozenModel, TournamentLimits } from "@phack/protocol";
import { describe, expect, it } from "vitest";
import {
  adaptiveBudget,
  adaptivePairs,
  calibrationBasePairs,
  calibrationSeed,
  capacity,
  DEFAULT_SEEDS,
  estimateMatch,
  leagueSchedule,
  leagueSeeds,
  leagueSize,
  legsFor,
  matchId,
  pairKey,
  planPreview,
  roundRobinRounds,
} from "./schedule";
import type { Pair } from "./types";

const models = (n: number): string[] => Array.from({ length: n }, (_, i) => `m${String(i).padStart(2, "0")}`);

const LIMITS: TournamentLimits = {
  maxMinutes: 60,
  maxMatches: 1000,
  maxUsd: 100,
  concurrency: 1,
  maxCandidates: 8,
  calibrationShare: 0.5,
  maxAttempts: 3,
};

function frozen(key: string, isReference = false): FrozenModel {
  return {
    key,
    name: key,
    line: key,
    gatewayId: key,
    version: "1",
    released: null,
    inferenceProvider: isReference ? "baseten" : null,
    clientProvider: "mock",
    reasoning: "none",
    pricing: { input: 1e-6, output: 4e-6, cacheRead: null },
    isReference,
    priority: null,
  };
}

function row(model: string, rating: number, verdict: CalibrationRow["verdict"], se = 100): CalibrationRow {
  return {
    model,
    name: model,
    rating,
    diff: rating - 1000,
    se,
    lo: rating - 1000 - 1.645 * se,
    hi: rating - 1000 + 1.645 * se,
    games: 2,
    opponents: 1,
    verdict,
    league: verdict !== "outside",
    why: "",
  };
}

const ps = (p: Pair): string => `${p.a}~${p.b}`;

describe("pairKey y matchId", () => {
  it("ordena la pareja por key", () => {
    expect(pairKey("z", "a")).toEqual({ a: "a", b: "z" });
    expect(pairKey("a", "z")).toEqual({ a: "a", b: "z" });
  });

  it("arma el id estable sin importar el orden de la pareja", () => {
    expect(matchId("league", "platanus", 1000, { a: "x/b", b: "x/a" }, "vuelta")).toBe(
      "league:platanus:s1000:x/a~x/b:vuelta",
    );
  });
});

describe("legsFor", () => {
  it("la ida pone a en rojo y la vuelta intercambia los lados", () => {
    const [ida, vuelta] = legsFor({ a: "b", b: "a" }, "calibration", "platanus", 1, 0);
    expect(ida).toMatchObject({ a: "a", b: "b", leg: "ida", red: "a", blue: "b" });
    expect(vuelta).toMatchObject({ a: "a", b: "b", leg: "vuelta", red: "b", blue: "a" });
    expect(ida!.id).not.toBe(vuelta!.id);
  });
});

describe("roundRobinRounds", () => {
  it("con n par: n-1 rondas, cada modelo una vez por ronda, todas las parejas una vez", () => {
    const rounds = roundRobinRounds(models(10));
    expect(rounds).toHaveLength(9);
    const all = new Set<string>();
    for (const r of rounds) {
      const seen = r.flatMap((p) => [p.a, p.b]);
      expect(new Set(seen).size).toBe(seen.length);
      expect(r).toHaveLength(5);
      for (const p of r) all.add(ps(p));
    }
    expect(all.size).toBe(45);
  });

  it("con n impar usa descanso y cubre todas las parejas", () => {
    const rounds = roundRobinRounds(models(5));
    expect(rounds).toHaveLength(5);
    expect(new Set(rounds.flat().map(ps)).size).toBe(10);
  });

  it("no depende del orden de entrada", () => {
    const m = models(7);
    expect(roundRobinRounds([...m].reverse())).toEqual(roundRobinRounds(m));
  });
});

describe("calibrationBasePairs", () => {
  const degree = (pairs: Pair[], m: string, ref: string) =>
    pairs.filter((p) => (p.a === m || p.b === m) && p.a !== ref && p.b !== ref).length;

  it("con candidatos pares: todos vs referencia y un rival candidato cada uno", () => {
    const c = models(8);
    const pairs = calibrationBasePairs("ref", c);
    expect(pairs).toHaveLength(8 + 4);
    for (const m of c) {
      expect(pairs.some((p) => ps(p) === ps(pairKey("ref", m)))).toBe(true);
      expect(degree(pairs, m, "ref")).toBe(1);
    }
    expect(new Set(pairs.map(ps)).size).toBe(pairs.length);
  });

  it("con candidatos impares: solo uno juega dos cruces", () => {
    const c = models(7);
    const pairs = calibrationBasePairs("ref", c);
    const degrees = c.map((m) => degree(pairs, m, "ref")).sort();
    expect(degrees).toEqual([1, 1, 1, 1, 1, 1, 2]);
  });

  it("con un candidato solo hay cruce con la referencia", () => {
    expect(calibrationBasePairs("ref", ["m"])).toEqual([pairKey("ref", "m")]);
  });

  it("es determinista y no depende del orden", () => {
    const c = models(9);
    expect(calibrationBasePairs("ref", [...c].reverse())).toEqual(calibrationBasePairs("ref", c));
  });
});

describe("adaptivePairs", () => {
  const rows = [
    row("a", 1010, "pending"),
    row("b", 1300, "outside"),
    row("c", 1080, "pending"),
    row("d", 990, "inside"),
  ];

  it("solo programa a los pending, prefiere rivales nuevos y cercanos", () => {
    const played = [pairKey("ref", "a"), pairKey("ref", "c"), pairKey("a", "d"), pairKey("b", "c")];
    const pairs = adaptivePairs(rows, played, "ref", 1);
    // a (se empata con c; a va primero por key) no jugó con b ni c: c (1080) está más cerca que b (1300).
    expect(pairs).toEqual([pairKey("a", "c")]);
  });

  it("reparte parejo y respeta maxPairs", () => {
    const pairs = adaptivePairs(rows, [], "ref", 10);
    for (const p of pairs) expect(["a", "c"].includes(p.a) || ["a", "c"].includes(p.b)).toBe(true);
    expect(new Set(pairs.map(ps)).size).toBe(pairs.length);
    const count = (m: string) => pairs.filter((p) => p.a === m || p.b === m).length;
    expect(Math.abs(count("a") - count("c"))).toBeLessThanOrEqual(1);
    expect(adaptivePairs(rows, [], "ref", 3)).toHaveLength(3);
    expect(adaptivePairs(rows, [], "ref", 0)).toEqual([]);
  });

  it("sin pending no programa nada", () => {
    expect(adaptivePairs([row("x", 1000, "inside")], [], "ref", 5)).toEqual([]);
  });

  it("es determinista", () => {
    expect(adaptivePairs([...rows].reverse(), [], "ref", 4)).toEqual(adaptivePairs(rows, [], "ref", 4));
  });
});

describe("leagueSchedule", () => {
  it("10 modelos, 1 escenario: 45 parejas, 90 por semilla, 450 con 5 semillas", () => {
    const seeds = leagueSeeds(DEFAULT_SEEDS.leagueBase, 5);
    const specs = leagueSchedule(models(10), ["platanus"], seeds);
    expect(specs).toHaveLength(450);
    expect(new Set(specs.map((s) => s.id)).size).toBe(450);
    for (const seed of seeds) {
      const of = specs.filter((s) => s.seed === seed);
      expect(of).toHaveLength(90);
      expect(new Set(of.map((s) => `${s.a}~${s.b}`)).size).toBe(45);
    }
  });

  it("completa una semilla antes de pasar a la siguiente; ida y vuelta seguidas", () => {
    const specs = leagueSchedule(models(4), ["platanus"], [1000, 1001]);
    const seedOrder = specs.map((s) => s.seed);
    expect(seedOrder).toEqual([...seedOrder].sort((x, y) => x - y));
    for (let i = 0; i < specs.length; i += 2) {
      const ida = specs[i]!;
      const vuelta = specs[i + 1]!;
      expect(ida.leg).toBe("ida");
      expect(vuelta.leg).toBe("vuelta");
      expect([ida.a, ida.b]).toEqual([vuelta.a, vuelta.b]);
      expect(ida.red).toBe(vuelta.blue);
      expect(ida.blue).toBe(vuelta.red);
      expect(ida.stage).toBe("league");
    }
    const rounds = specs.map((s) => s.round);
    expect(rounds).toEqual([...rounds].sort((x, y) => x - y));
  });

  it("es determinista y no depende del orden de los modelos", () => {
    const m = models(6);
    expect(leagueSchedule([...m].reverse(), ["platanus"], [1000])).toEqual(leagueSchedule(m, ["platanus"], [1000]));
  });
});

describe("semillas", () => {
  it("la liga nunca comparte semilla con la calibración", () => {
    const cal = Array.from({ length: 50 }, (_, r) => calibrationSeed(DEFAULT_SEEDS.calibrationBase, r));
    const league = leagueSeeds(DEFAULT_SEEDS.leagueBase, 20);
    expect(cal.some((s) => league.includes(s))).toBe(false);
  });
});

describe("capacity y leagueSize", () => {
  it("toma el mínimo de partidas, reloj y gasto", () => {
    expect(capacity(LIMITS, { minutesPerMatch: 80 / 60, usdPerMatch: 0.1 })).toBe(45);
    expect(capacity({ ...LIMITS, concurrency: 2 }, { minutesPerMatch: 80 / 60, usdPerMatch: 0.1 })).toBe(90);
    expect(capacity({ ...LIMITS, maxUsd: 1 }, { minutesPerMatch: 1, usdPerMatch: 0.3 })).toBe(3);
    expect(capacity({ ...LIMITS, maxMatches: 7 }, { minutesPerMatch: 1, usdPerMatch: 0 })).toBe(7);
  });

  it("mayor n con n(n-1)·escenarios <= capacidad, mínimo 2", () => {
    expect(leagueSize(90, 1)).toBe(10);
    expect(leagueSize(89, 1)).toBe(9);
    expect(leagueSize(21, 1)).toBe(5);
    expect(leagueSize(0, 1)).toBe(2);
    expect(leagueSize(90, 2)).toBe(7);
  });

  it("la adaptativa no pasa de su fracción de la capacidad", () => {
    expect(adaptiveBudget(100, 24, 0.5)).toBe(26);
    expect(adaptiveBudget(45, 24, 0.5)).toBe(0);
  });
});

describe("estimateMatch", () => {
  it("estima decisiones, minutos y USD con los supuestos explícitos", () => {
    const est = estimateMatch([frozen("a"), frozen("b")], 60, 1500, 20);
    expect(est.decisionsPerSide).toBe(40);
    expect(est.minutesPerMatch).toBeCloseTo(80 / 60);
    const perSide = 40 * (est.tokensInPerDecision * 1e-6 + est.tokensOutPerDecision * 4e-6);
    expect(est.usdPerMatch).toBeCloseTo(2 * perSide);
    expect(est.assumptions.length).toBeGreaterThan(0);
  });

  it("con un tick menor que la latencia, la cota sale de la latencia mínima, no del tick", () => {
    expect(estimateMatch([frozen("a")], 60, 300, 20).decisionsPerSide).toBe(60);
    expect(estimateMatch([frozen("a")], 60, 2000, 20).decisionsPerSide).toBe(30);
  });

  it("los modelos sin precio cuentan como 0 y se informan", () => {
    const est = estimateMatch([{ ...frozen("a"), pricing: null }], 60, 1500, 20);
    expect(est.usdPerMatch).toBe(0);
    expect(est.unpriced).toEqual(["a"]);
  });
});

describe("planPreview", () => {
  const reference = frozen("ref", true);
  const candidates = models(8).map((k) => frozen(k));

  it("plan por defecto de una hora: base, sin adaptativa, liga recortada a 5", () => {
    const plan = planPreview({
      reference,
      candidates,
      limits: LIMITS,
      scenarios: ["platanus"],
      est: { minutesPerMatch: 80 / 60, usdPerMatch: 0.05 },
    });
    expect(plan.candidates).toHaveLength(8);
    expect(plan.calibration.pairs).toHaveLength(12);
    expect(plan.calibration.matches).toBe(24);
    expect(plan.calibration.minutes).toBe(32);
    expect(plan.adaptiveMax).toBe(0);
    expect(plan.league).toMatchObject({ expectedModels: 5, pairs: 10, matchesPerSeed: 20, seeds: 1, matches: 20 });
    expect(plan.total).toMatchObject({ capacity: 45, matches: 44 });
    expect(plan.fits).toBe(true);
    expect(plan.notes.length).toBeGreaterThan(0);
  });

  it("con capacidad holgada entran todos y hay varias semillas", () => {
    const plan = planPreview({
      reference,
      candidates,
      limits: { ...LIMITS, maxMinutes: 600 },
      scenarios: ["platanus"],
      est: { minutesPerMatch: 1, usdPerMatch: 0.05 },
    });
    expect(plan.league.expectedModels).toBe(9);
    expect(plan.league.matchesPerSeed).toBe(72);
    expect(plan.league.seeds).toBeGreaterThanOrEqual(2);
    expect(plan.total.matches).toBeLessThanOrEqual(plan.total.capacity);
  });

  it("no cabe si no alcanza la ronda base", () => {
    const plan = planPreview({
      reference,
      candidates,
      limits: { ...LIMITS, maxMatches: 10 },
      scenarios: ["platanus"],
      est: { minutesPerMatch: 1, usdPerMatch: 0 },
    });
    expect(plan.fits).toBe(false);
  });

  it("es determinista y no depende del orden de los candidatos", () => {
    const input = { reference, limits: LIMITS, scenarios: ["platanus"], est: { minutesPerMatch: 1, usdPerMatch: 0.1 } };
    expect(planPreview({ ...input, candidates: [...candidates].reverse() })).toEqual(
      planPreview({ ...input, candidates }),
    );
  });
});
