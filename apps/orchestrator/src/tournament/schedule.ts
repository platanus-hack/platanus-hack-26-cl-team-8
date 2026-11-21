/**
 * Calendario del torneo: parejas, ids estables, ida/vuelta, todos contra todos,
 * capacidad según límites y vista previa del plan (dry-run).
 *
 * Todo es determinista y puro: el mismo input da siempre el mismo calendario, sin
 * importar el orden en que lleguen los modelos. Así un resume recalcula el calendario
 * desde la configuración congelada y salta los ids que ya tienen un intento válido.
 */
import {
  REFERENCE_RATING,
  type CalibrationRow,
  type FrozenModel,
  type Leg,
  type MatchSpec,
  type TournamentLimits,
  type TournamentStage,
} from "@phack/protocol";
import type { Pair } from "./types";

// ---------- Parejas e ids ----------

/** Pareja ordenada por key (a < b). */
export function pairKey(x: string, y: string): Pair {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

/** Id estable de una partida: `${stage}:${scenario}:s${seed}:${a}~${b}:${leg}`. */
export function matchId(stage: TournamentStage, scenario: string, seed: number, pair: Pair, leg: Leg): string {
  const p = pairKey(pair.a, pair.b);
  return `${stage}:${scenario}:s${seed}:${p.a}~${p.b}:${leg}`;
}

/** Ida (a en el spawn rojo) y vuelta (a en el azul) de una pareja, en ese orden. */
export function legsFor(pair: Pair, stage: TournamentStage, scenario: string, seed: number, round: number): MatchSpec[] {
  const { a, b } = pairKey(pair.a, pair.b);
  const legs: Leg[] = ["ida", "vuelta"];
  return legs.map((leg) => ({
    id: matchId(stage, scenario, seed, { a, b }, leg),
    stage,
    scenario,
    seed,
    a,
    b,
    leg,
    red: leg === "ida" ? a : b,
    blue: leg === "ida" ? b : a,
    round,
  }));
}

function uniqueSorted(models: string[]): string[] {
  return [...new Set(models)].sort();
}

/**
 * Todos contra todos por el método del círculo: n-1 rondas (n par) o n rondas (n impar,
 * con descanso), cada modelo juega a lo más una vez por ronda. Determinista: ordena
 * los modelos por key antes de armar las rondas.
 */
export function roundRobinRounds(models: string[]): Pair[][] {
  const sorted = uniqueSorted(models);
  if (sorted.length < 2) return [];
  const slots: Array<string | null> = sorted.length % 2 === 0 ? [...sorted] : [...sorted, null];
  const n = slots.length;
  const rounds: Pair[][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: Pair[] = [];
    for (let i = 0; i < n / 2; i++) {
      const x = slots[i];
      const y = slots[n - 1 - i];
      if (x != null && y != null) pairs.push(pairKey(x, y));
    }
    rounds.push(pairs);
    // Rota todos menos el primero: el último pasa a la posición 1.
    const last = slots.pop() as string | null;
    slots.splice(1, 0, last);
  }
  return rounds;
}

// ---------- Calibración ----------

/**
 * Ronda base de calibración: cada candidato contra la referencia y además contra al
 * menos un candidato distinto. Los candidatos (ordenados por key) se emparejan de a
 * dos consecutivos; si son impares, el último juega también contra el primero (así
 * solo uno juega dos cruces y el resto uno). Con la referencia el grafo es conexo.
 * Con un solo candidato no hay cruce entre candidatos posible.
 */
export function calibrationBasePairs(reference: string, candidates: string[]): Pair[] {
  const sorted = uniqueSorted(candidates).filter((c) => c !== reference);
  const pairs: Pair[] = sorted.map((c) => pairKey(reference, c));
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    pairs.push(pairKey(sorted[i]!, sorted[i + 1]!));
  }
  if (sorted.length >= 3 && sorted.length % 2 === 1) {
    pairs.push(pairKey(sorted[sorted.length - 1]!, sorted[0]!));
  }
  return pairs;
}

const pairString = (p: Pair): string => {
  const k = pairKey(p.a, p.b);
  return `${k.a}~${k.b}`;
};

/**
 * Parejas de una ronda adaptativa, solo para candidatos "pending". Cada pending elige,
 * por turnos, su mejor rival: primero los que nunca enfrentó (o enfrentó menos veces),
 * luego el más cercano en rating, luego por key. En cada pasada cada pending recibe a
 * lo más una pareja (una pareja entre dos pending cuenta para ambos), así el reparto
 * queda parejo. No repite pareja dentro de la misma llamada y respeta maxPairs.
 * En cada pasada atiende primero a los más inciertos (se mayor) y luego por key.
 */
export function adaptivePairs(rows: CalibrationRow[], played: Pair[], reference: string, maxPairs: number): Pair[] {
  if (maxPairs <= 0) return [];
  const rating = new Map<string, number>([[reference, REFERENCE_RATING]]);
  for (const row of rows) rating.set(row.model, row.rating);
  const everyone = [...rating.keys()].sort();

  const pending = rows
    .filter((r) => r.verdict === "pending" && r.model !== reference)
    .sort((x, y) => y.se - x.se || (x.model < y.model ? -1 : x.model > y.model ? 1 : 0))
    .map((r) => r.model);
  const pendingSet = new Set(pending);

  const timesPlayed = new Map<string, number>();
  for (const p of played) timesPlayed.set(pairString(p), (timesPlayed.get(pairString(p)) ?? 0) + 1);

  const chosen: Pair[] = [];
  const chosenSet = new Set<string>();
  const given = new Map<string, number>(pending.map((m) => [m, 0]));

  for (;;) {
    let added = false;
    const served = new Set<string>();
    // Primero los que llevan menos parejas en esta llamada (reparto parejo).
    const order = [...pending].sort((x, y) => given.get(x)! - given.get(y)! || pending.indexOf(x) - pending.indexOf(y));
    for (const model of order) {
      if (chosen.length >= maxPairs) return chosen;
      if (served.has(model)) continue;
      const own = rating.get(model) ?? REFERENCE_RATING;
      const options = everyone
        .filter((r) => r !== model && !served.has(r) && !chosenSet.has(pairString({ a: model, b: r })))
        .map((r) => ({
          r,
          times: timesPlayed.get(pairString({ a: model, b: r })) ?? 0,
          gap: Math.abs((rating.get(r) ?? REFERENCE_RATING) - own),
        }))
        .sort((x, y) => x.times - y.times || x.gap - y.gap || (x.r < y.r ? -1 : x.r > y.r ? 1 : 0));
      const best = options[0];
      if (!best) continue;
      const pair = pairKey(model, best.r);
      chosen.push(pair);
      chosenSet.add(pairString(pair));
      served.add(model);
      given.set(model, given.get(model)! + 1);
      if (pendingSet.has(best.r)) {
        served.add(best.r);
        given.set(best.r, given.get(best.r)! + 1);
      }
      added = true;
    }
    if (!added) return chosen;
  }
}

// ---------- Semillas ----------

/**
 * Semilla de la ronda `round` de calibración (0 = base). Cada ronda adaptativa usa una
 * semilla propia para que una pareja repetida tenga un id nuevo.
 */
export function calibrationSeed(calibrationBase: number, round: number): number {
  return calibrationBase + round;
}

/** Semillas de la liga: `count` semillas consecutivas desde leagueBase. */
export function leagueSeeds(leagueBase: number, count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => leagueBase + i);
}

/**
 * Semillas reservadas por defecto: la calibración usa 1..999 (una por ronda) y la liga
 * desde 1000, así nunca comparten semilla.
 */
export const DEFAULT_SEEDS = { calibrationBase: 1, leagueBase: 1000 } as const;

// ---------- Liga ----------

/**
 * Calendario de la liga: semilla por semilla y, dentro de cada semilla y escenario, las
 * rondas del método del círculo; cada pareja juega ida y vuelta seguidas. Una semilla
 * queda completa (todas las parejas, ambos lados) antes de empezar la siguiente.
 * `round` es un contador global creciente (una ronda del círculo = una ronda).
 */
export function leagueSchedule(models: string[], scenarios: string[], seeds: number[]): MatchSpec[] {
  const rounds = roundRobinRounds(models);
  const specs: MatchSpec[] = [];
  let round = 0;
  for (const seed of seeds) {
    for (const scenario of scenarios) {
      for (const pairs of rounds) {
        for (const pair of pairs) specs.push(...legsFor(pair, "league", scenario, seed, round));
        round++;
      }
    }
  }
  return specs;
}

// ---------- Capacidad ----------

/**
 * Cuántas partidas caben: min(maxMatches, floor(maxMinutes/minutesPerMatch)·concurrency,
 * floor(maxUsd/usdPerMatch)). Una estimación de 0 (o menor) no limita.
 */
export function capacity(limits: TournamentLimits, est: { minutesPerMatch: number; usdPerMatch: number }): number {
  const byClock =
    est.minutesPerMatch > 0
      ? Math.floor(limits.maxMinutes / est.minutesPerMatch) * Math.max(1, limits.concurrency)
      : Number.POSITIVE_INFINITY;
  const byMoney = est.usdPerMatch > 0 ? Math.floor(limits.maxUsd / est.usdPerMatch) : Number.POSITIVE_INFINITY;
  const cap = Math.min(limits.maxMatches, byClock, byMoney);
  return Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
}

/** Mayor n con n(n-1)·scenarios <= capacityLeft (mínimo 2). */
export function leagueSize(capacityLeft: number, scenarios: number): number {
  const s = Math.max(1, scenarios);
  let n = 2;
  while ((n + 1) * n * s <= capacityLeft) n++;
  return n;
}

/** Partidas de una semilla completa de liga con n modelos: n(n-1)·scenarios. */
export function leagueMatchesPerSeed(models: number, scenarios: number): number {
  return models < 2 ? 0 : models * (models - 1) * Math.max(1, scenarios);
}

/**
 * Presupuesto (en partidas) de la calibración adaptativa: la calibración completa
 * (base + adaptativa) no pasa de calibrationShare·capacidad. La base corre siempre.
 */
export function adaptiveBudget(cap: number, baseMatches: number, calibrationShare: number): number {
  return Math.max(0, Math.floor(cap * calibrationShare) - baseMatches);
}

// ---------- Estimaciones ----------

/**
 * Supuestos de tokens por decisión, medidos sobre el agente (packages/agent):
 * prompt de sistema con BENCHMARK_PROMPT ≈ 1.9k caracteres, definiciones de tools ≈ 1.9k,
 * observación ≈ 0.4k, e historial de hasta 12 mensajes (≈ 4 turnos de observación +
 * tool call + resultado) ≈ 2.3k. En régimen ≈ 6.4k caracteres ≈ 1.8k tokens (a ~3.5
 * caracteres por token) más el formato de mensajes del proveedor: se usa 2500 de entrada.
 * La salida es una tool call con un "reason" corto: 150 tokens. No se descuenta caché.
 */
export const EST_TOKENS_IN_PER_DECISION = 2500;
export const EST_TOKENS_OUT_PER_DECISION = 150;

export type MatchEstimate = {
  /** Minutos de reloj por partida (pelea + preparación). */
  minutesPerMatch: number;
  /** USD por partida (dos lados), promedio sobre los modelos dados. */
  usdPerMatch: number;
  decisionsPerSide: number;
  tokensInPerDecision: number;
  tokensOutPerDecision: number;
  /** Modelos sin precio en el catálogo (cuentan como 0 USD). */
  unpriced: string[];
  assumptions: string[];
};

/**
 * Estima minutos y USD por partida. Con un par de modelos da el costo de esa pareja; con
 * todo el plantel, el costo medio de una partida (cada lado = un modelo promedio).
 * Decisiones por lado ≈ matchSeconds·1000/tickMs (cota superior: la latencia del LLM
 * puede espaciar más las decisiones).
 */
export function estimateMatch(
  models: FrozenModel[],
  matchSeconds: number,
  tickMs: number,
  overheadSeconds: number,
): MatchEstimate {
  const decisionsPerSide = tickMs > 0 ? Math.ceil((matchSeconds * 1000) / tickMs) : 0;
  const tokensIn = EST_TOKENS_IN_PER_DECISION;
  const tokensOut = EST_TOKENS_OUT_PER_DECISION;
  const unpriced = models.filter((m) => !m.pricing).map((m) => m.key);
  const perSide = models.map((m) =>
    m.pricing ? decisionsPerSide * (tokensIn * m.pricing.input + tokensOut * m.pricing.output) : 0,
  );
  const meanSide = perSide.length > 0 ? perSide.reduce((s, x) => s + x, 0) / perSide.length : 0;
  return {
    minutesPerMatch: (matchSeconds + overheadSeconds) / 60,
    usdPerMatch: 2 * meanSide,
    decisionsPerSide,
    tokensInPerDecision: tokensIn,
    tokensOutPerDecision: tokensOut,
    unpriced,
    assumptions: [
      `${decisionsPerSide} decisiones por lado (${matchSeconds} s de pelea cada ${tickMs} ms)`,
      `${tokensIn} tokens de entrada y ${tokensOut} de salida por decisión, sin caché`,
      `${matchSeconds + overheadSeconds} s de reloj por partida (${overheadSeconds} s de preparación)`,
      "precio por token del catálogo congelado",
    ],
  };
}

// ---------- Vista previa del plan ----------

export type PlanInput = {
  reference: FrozenModel;
  candidates: FrozenModel[];
  limits: TournamentLimits;
  scenarios: string[];
  est: { minutesPerMatch: number; usdPerMatch: number };
};

export type StageCost = { matches: number; minutes: number; usd: number };

export type PlanPreview = {
  candidates: Array<{ key: string; name: string; gatewayId: string; inferenceProvider: string | null }>;
  calibration: StageCost & { pairs: Pair[] };
  /** Máximo de partidas de la calibración adaptativa. */
  adaptiveMax: number;
  league: StageCost & {
    /** Modelos esperados en la liga (referencia incluida), recortados por capacidad. */
    expectedModels: number;
    pairs: number;
    matchesPerSeed: number;
    seeds: number;
  };
  /** Total peor caso: base + adaptativa máxima + liga. */
  total: StageCost & { capacity: number };
  /** true si cabe la ronda base y al menos una semilla completa de liga. */
  fits: boolean;
  notes: string[];
};

const round2 = (x: number): number => Math.round(x * 100) / 100;

function stageCost(matches: number, limits: TournamentLimits, est: PlanInput["est"]): StageCost {
  const waves = Math.ceil(matches / Math.max(1, limits.concurrency));
  return { matches, minutes: round2(waves * est.minutesPerMatch), usd: round2(matches * est.usdPerMatch) };
}

/**
 * Plan del dry-run: cuántas partidas, minutos y USD por etapa, sin jugar nada. Supone el
 * peor caso para la liga (la adaptativa gasta todo su presupuesto) y que todos los
 * candidatos clasifican; si no caben, la liga se recorta a los n más cercanos.
 */
export function planPreview(input: PlanInput): PlanPreview {
  const { reference, limits, est } = input;
  const scenarios = Math.max(1, input.scenarios.length);
  const candidates = [...input.candidates].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const notes: string[] = [];

  const cap = capacity(limits, est);
  const pairs = calibrationBasePairs(reference.key, candidates.map((c) => c.key));
  const baseMatches = pairs.length * 2 * scenarios;
  const calibration = { pairs, ...stageCost(baseMatches, limits, est) };
  const adaptiveMax = adaptiveBudget(cap, baseMatches, limits.calibrationShare);

  const left = Math.max(0, cap - baseMatches - adaptiveMax);
  const allModels = candidates.length + 1;
  const sizeByBudget = leagueSize(left, scenarios);
  const expectedModels = Math.min(allModels, sizeByBudget);
  const matchesPerSeed = leagueMatchesPerSeed(expectedModels, scenarios);
  const seeds = matchesPerSeed > 0 ? Math.floor(left / matchesPerSeed) : 0;
  const leagueMatches = seeds * matchesPerSeed;
  const league = {
    expectedModels,
    pairs: (expectedModels * (expectedModels - 1)) / 2,
    matchesPerSeed,
    seeds,
    ...stageCost(leagueMatches, limits, est),
  };

  const totalMatches = baseMatches + adaptiveMax + leagueMatches;
  const total = { capacity: cap, ...stageCost(totalMatches, limits, est) };
  const fits = baseMatches <= cap && seeds >= 1;

  notes.push(
    `Capacidad: ${cap} partidas (límites: ${limits.maxMatches} partidas, ${limits.maxMinutes} min × ${limits.concurrency} servidor(es), ${limits.maxUsd} USD; ${round2(est.minutesPerMatch)} min y ${round2(est.usdPerMatch)} USD por partida).`,
  );
  if (baseMatches > cap) notes.push(`La ronda base (${baseMatches} partidas) no cabe en la capacidad.`);
  if (candidates.length < 2) notes.push("Con menos de dos candidatos no hay cruces entre candidatos en la calibración.");
  if (adaptiveMax === 0) notes.push("Sin presupuesto para calibración adaptativa: los dudosos quedan \"pending\".");
  if (expectedModels < allModels) {
    notes.push(
      `La liga se recorta a ${expectedModels} de ${allModels} modelos (los más cercanos a la referencia) para que quepa una semilla completa.`,
    );
  }
  if (seeds === 0) notes.push("No cabe ni una semilla completa de la liga.");
  else if (seeds === 1) notes.push("La liga cabe con una sola semilla: el rating oficial quedará provisional.");
  notes.push("La liga supone que todos los candidatos clasifican y que la adaptativa gasta todo su presupuesto.");

  return {
    candidates: candidates.map((c) => ({
      key: c.key,
      name: c.name,
      gatewayId: c.gatewayId,
      inferenceProvider: c.inferenceProvider,
    })),
    calibration,
    adaptiveMax,
    league,
    total,
    fits,
    notes,
  };
}
