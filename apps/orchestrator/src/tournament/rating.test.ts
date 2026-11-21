import type { FrozenModel } from "@phack/protocol";
import { describe, expect, it } from "vitest";
import { calibrate, clusterBootstrap, fitBradleyTerry, headToHead } from "./rating";
import type { Game } from "./types";

const OPTS = { reference: "ref", priorSdElo: 400 };

/** PRNG con semilla para simular partidas. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Partidas simuladas con ratings ocultos (sin empates), `perPair` por pareja, clusters por semilla. */
function simulate(hidden: Record<string, number>, perPair: number, seed: number): Game[] {
  const random = rng(seed);
  const keys = Object.keys(hidden).sort();
  const games: Game[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = keys[i]!;
      const b = keys[j]!;
      const p = 1 / (1 + 10 ** ((hidden[b]! - hidden[a]!) / 400));
      for (let k = 0; k < perPair; k += 1) {
        games.push({ cluster: `platanus:s${k % 10}`, a, b, scoreA: random() < p ? 1 : 0 });
      }
    }
  }
  return games;
}

function shuffle<T>(list: T[], seed: number): T[] {
  const random = rng(seed);
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function model(key: string, isReference = false): FrozenModel {
  return {
    key,
    name: key.toUpperCase(),
    line: key,
    gatewayId: key,
    version: "1",
    released: null,
    inferenceProvider: null,
    clientProvider: "mock",
    reasoning: "none",
    pricing: null,
    isReference,
    priority: null,
  };
}

const MIXED: Game[] = [
  { cluster: "c1", a: "ref", b: "x", scoreA: 1 },
  { cluster: "c1", a: "x", b: "ref", scoreA: 0.5 },
  { cluster: "c2", a: "x", b: "y", scoreA: 1 },
  { cluster: "c2", a: "y", b: "ref", scoreA: 0 },
  { cluster: "c3", a: "y", b: "x", scoreA: 0.5 },
  { cluster: "c3", a: "ref", b: "z", scoreA: 0 },
  { cluster: "c4", a: "z", b: "y", scoreA: 1 },
];

describe("fitBradleyTerry", () => {
  it("solo empates ⇒ todos exactamente en 1000", () => {
    const games: Game[] = [];
    for (const [a, b] of [["ref", "x"], ["x", "y"], ["y", "ref"], ["z", "x"]] as const) {
      for (let k = 0; k < 7; k += 1) games.push({ cluster: `s${k}`, a, b, scoreA: 0.5 });
    }
    const fit = fitBradleyTerry(["ref", "x", "y", "z"], games, OPTS);
    for (const r of Object.values(fit.ratings)) expect(r).toBe(1000);
    expect(fit.converged).toBe(true);
  });

  it("permutar las partidas y los modelos no cambia nada", () => {
    const base = fitBradleyTerry(["ref", "x", "y", "z"], MIXED, OPTS);
    for (let seed = 1; seed <= 5; seed += 1) {
      const other = fitBradleyTerry(shuffle(["ref", "x", "y", "z"], seed), shuffle(MIXED, seed * 7), OPTS);
      expect(other.ratings).toEqual(base.ratings);
      expect(other.se).toEqual(base.se);
    }
  });

  it("es simétrico al intercambiar a/b con 1 − score", () => {
    const flipped = MIXED.map((g): Game => ({ cluster: g.cluster, a: g.b, b: g.a, scoreA: (1 - g.scoreA) as Game["scoreA"] }));
    const base = fitBradleyTerry(["ref", "x", "y", "z"], MIXED, OPTS);
    const other = fitBradleyTerry(["ref", "x", "y", "z"], flipped, OPTS);
    for (const k of ["ref", "x", "y", "z"]) {
      expect(Math.abs(other.ratings[k]! - base.ratings[k]!)).toBeLessThan(1e-9);
      expect(Math.abs(other.se[k]! - base.se[k]!)).toBeLessThan(1e-9);
    }
  });

  it("la referencia queda fija en 1000 con SE 0", () => {
    const fit = fitBradleyTerry(["ref", "x", "y", "z"], MIXED, OPTS);
    expect(fit.ratings.ref).toBe(1000);
    expect(fit.se.ref).toBe(0);
  });

  it("un modelo que gana todo queda arriba con rating finito", () => {
    const games: Game[] = [];
    for (const rival of ["ref", "x", "y"]) {
      for (let k = 0; k < 10; k += 1) games.push({ cluster: `s${k}`, a: "top", b: rival, scoreA: 1 });
    }
    games.push({ cluster: "s0", a: "x", b: "y", scoreA: 0.5 }, { cluster: "s0", a: "ref", b: "x", scoreA: 0.5 });
    const fit = fitBradleyTerry(["ref", "x", "y", "top"], games, OPTS);
    expect(Number.isFinite(fit.ratings.top)).toBe(true);
    expect(Number.isFinite(fit.se.top)).toBe(true);
    expect(fit.converged).toBe(true);
    for (const k of ["ref", "x", "y"]) expect(fit.ratings.top).toBeGreaterThan(fit.ratings[k]! + 200);
  });

  it("modelos sin partidas quedan en 1000 con SE = priorSdElo", () => {
    const fit = fitBradleyTerry(["ref", "x", "nadie"], [{ cluster: "c", a: "ref", b: "x", scoreA: 1 }], OPTS);
    expect(fit.ratings.nadie).toBe(1000);
    expect(fit.se.nadie).toBe(400);
  });

  it("recupera aproximadamente ratings ocultos con muchas partidas", () => {
    const hidden = { ref: 1000, a: 1200, b: 900, c: 1050, d: 750 };
    const fit = fitBradleyTerry(Object.keys(hidden), simulate(hidden, 600, 42), OPTS);
    for (const [k, r] of Object.entries(hidden)) {
      expect(Math.abs(fit.ratings[k]! - r)).toBeLessThan(35);
      if (k !== "ref") expect(fit.se[k]!).toBeLessThan(20);
    }
  });

  it("menos partidas ⇒ más incertidumbre", () => {
    const hidden = { ref: 1000, a: 1100 };
    const few = fitBradleyTerry(["ref", "a"], simulate(hidden, 10, 1), OPTS);
    const many = fitBradleyTerry(["ref", "a"], simulate(hidden, 200, 1), OPTS);
    expect(few.se.a!).toBeGreaterThan(many.se.a!);
  });
});

describe("headToHead", () => {
  it("cubre todas las combinaciones fila ≠ columna y distingue sin partidas de 50 %", () => {
    const games: Game[] = [
      { cluster: "c", a: "x", b: "y", scoreA: 1 },
      { cluster: "c", a: "y", b: "x", scoreA: 1 },
      { cluster: "c", a: "ref", b: "x", scoreA: 0.5 },
    ];
    const cells = headToHead(["ref", "x", "y"], games);
    expect(cells).toHaveLength(6);
    const cell = (row: string, col: string) => cells.find((c) => c.row === row && c.col === col)!;
    expect(cell("x", "y")).toEqual({ row: "x", col: "y", games: 2, wins: 1, draws: 0, losses: 1, score: 0.5 });
    expect(cell("x", "ref")).toMatchObject({ games: 1, draws: 1, score: 0.5 });
    expect(cell("ref", "y")).toMatchObject({ games: 0, score: null });
    expect(cell("y", "ref").score).toBeNull();
    expect(cells.map((c) => `${c.row}-${c.col}`)).toEqual(["ref-x", "ref-y", "x-ref", "x-y", "y-ref", "y-x"]);
  });
});

describe("clusterBootstrap", () => {
  const boot = { ...OPTS, samples: 200, seed: 7 };

  it("devuelve null con menos de 5 clusters aunque haya muchas partidas", () => {
    const games = simulate({ ref: 1000, a: 1100 }, 400, 3).map((g, i): Game => ({ ...g, cluster: `s${i % 4}` }));
    expect(clusterBootstrap(["ref", "a"], games, boot)).toBeNull();
    const five = games.map((g, i): Game => ({ ...g, cluster: `s${i % 5}` }));
    expect(clusterBootstrap(["ref", "a"], five, boot)).not.toBeNull();
  });

  it("remuestrea clusters completos: clusters idénticos ⇒ intervalo de ancho cero", () => {
    const one: Game[] = [
      { cluster: "", a: "ref", b: "a", scoreA: 1 },
      { cluster: "", a: "a", b: "ref", scoreA: 0.5 },
      { cluster: "", a: "a", b: "ref", scoreA: 1 },
      { cluster: "", a: "ref", b: "a", scoreA: 0 },
    ];
    const games = [0, 1, 2, 3, 4, 5].flatMap((s) => one.map((g): Game => ({ ...g, cluster: `s${s}` })));
    const out = clusterBootstrap(["ref", "a"], games, boot)!;
    const fit = fitBradleyTerry(["ref", "a"], games, OPTS);
    expect(Math.abs(out.a!.hi - out.a!.lo)).toBeLessThan(1e-9);
    expect(Math.abs(out.a!.lo - fit.ratings.a!)).toBeLessThan(1e-9);
    expect(out.ref).toEqual({ lo: 1000, hi: 1000 });
  });

  it("es determinista e independiente del orden; el intervalo contiene la estimación", () => {
    const games = simulate({ ref: 1000, a: 1150, b: 900 }, 40, 11);
    const first = clusterBootstrap(["ref", "a", "b"], games, boot)!;
    const again = clusterBootstrap(["b", "ref", "a"], shuffle(games, 5), boot)!;
    expect(again).toEqual(first);
    const fit = fitBradleyTerry(["ref", "a", "b"], games, OPTS);
    for (const k of ["a", "b"]) {
      expect(first[k]!.lo).toBeLessThan(fit.ratings[k]!);
      expect(first[k]!.hi).toBeGreaterThan(fit.ratings[k]!);
    }
  });
});

describe("calibrate", () => {
  const rule = { bandElo: 150, z: 1.645, priorSdElo: 400 };
  const models = [model("ref", true), model("igual"), model("fuerte"), model("duda"), model("nuevo")];

  /** n partidas de `key` contra la referencia con fracción `p` de puntos (en victorias/derrotas exactas). */
  function versusRef(key: string, wins: number, losses: number, draws = 0): Game[] {
    const out: Game[] = [];
    let i = 0;
    const push = (s: Game["scoreA"], n: number) => {
      for (let k = 0; k < n; k += 1, i += 1) out.push({ cluster: `s${i}`, a: key, b: "ref", scoreA: s });
    };
    push(1, wins);
    push(0, losses);
    push(0.5, draws);
    return out;
  }

  const games = [
    ...versusRef("igual", 100, 100, 200),
    ...versusRef("fuerte", 190, 10),
    ...versusRef("duda", 3, 1),
  ];
  const rows = calibrate(models, games, rule);
  const row = (k: string) => rows.find((r) => r.model === k)!;

  it("no incluye a la referencia y conserva el orden", () => {
    expect(rows.map((r) => r.model)).toEqual(["igual", "fuerte", "duda", "nuevo"]);
  });

  it("clasifica inside, outside y pending", () => {
    expect(row("igual")).toMatchObject({ verdict: "inside", league: true, games: 400, opponents: 1 });
    expect(row("igual").why).toContain("dentro de la banda ±150");
    expect(row("fuerte")).toMatchObject({ verdict: "outside", league: false });
    expect(row("fuerte").why).toContain("sobre el borde +150");
    expect(row("duda").verdict).toBe("pending");
    expect(row("duda").why).toMatch(/cruza .*: faltan partidas/);
    expect(row("nuevo")).toMatchObject({ verdict: "pending", league: false, games: 0, opponents: 0 });
  });

  it("lo/hi son diff ∓ z·se y pending entra a la liga solo con estimación dentro de la banda", () => {
    const d = row("duda");
    expect(d.lo).toBeCloseTo(d.diff - 1.645 * d.se, 9);
    expect(d.hi).toBeCloseTo(d.diff + 1.645 * d.se, 9);
    expect(d.league).toBe(Math.abs(d.diff) <= 150);
    expect(d.why).toContain(d.league ? "entra a la liga como provisional" : "no entra a la liga");
  });

  it("pending con estimación fuera de la banda no entra a la liga", () => {
    const wide = calibrate(models, versusRef("duda", 6, 0), { ...rule, priorSdElo: 2000 });
    const d = wide.find((r) => r.model === "duda")!;
    expect(d.verdict).toBe("pending");
    expect(Math.abs(d.diff)).toBeGreaterThan(150);
    expect(d.league).toBe(false);
  });

  it("outside por debajo", () => {
    const low = calibrate(models, versusRef("igual", 5, 300), rule).find((r) => r.model === "igual")!;
    expect(low.verdict).toBe("outside");
    expect(low.why).toContain("bajo el borde -150");
  });
});
