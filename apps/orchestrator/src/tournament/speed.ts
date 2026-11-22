/**
 * Velocidad y eficiencia por modelo, sacadas de los intentos que la liga ya guardó
 * (attempts.jsonl). Solo lee: no cambia el torneo ni su rating, y se puede correr con la
 * liga en curso o con los archivos descargados del servidor.
 *
 * Qué responde: ¿el que decide más rápido gana más? Junta cada modelo con su Elo oficial
 * y calcula la correlación de rangos (Spearman) entre el Elo y cada métrica.
 *
 * Ojo con la duración: un intento guarda startedAt/endedAt de la corrida completa
 * (preparar la arena, conectar bots, kits y cuenta regresiva incluidos), no de la pelea.
 * Por eso la métrica principal de velocidad es `decisionShare`: qué parte de las
 * decisiones de la partida tomó el modelo frente a su rival, que pelearon el mismo tiempo.
 * `decisionsPerWallMin` es solo aproximada (incluye la preparación). Los intentos que traen
 * `fightMs` (desde la liga sin tope de 1,5 s) dan además `decisionsPerFightMin`, exacta.
 */
import type { MatchAttempt, Side, TournamentConfig, TournamentReport } from "@phack/protocol";
import { allModels } from "./report";
import { validAttempts } from "./store";

export type SpeedStage = "league" | "calibration" | "all";

export type SpeedRow = {
  model: string;
  name: string;
  isReference: boolean;
  reasoning: string;
  /** Elo oficial (solo liga) y su posición; null si no está en el leaderboard. */
  rating: number | null;
  rank: number | null;
  /** Partidas válidas usadas para estas métricas. */
  matches: number;
  wins: number;
  draws: number;
  losses: number;
  /** Respuestas del LLM (una por llamada exitosa). */
  decisions: number;
  decisionsPerMatch: number | null;
  /** Media de (mis decisiones / decisiones de los dos) por partida. 0.5 = igual de rápido que el rival. */
  decisionShare: number | null;
  /** Decisiones por minuto de reloj del intento (incluye la preparación: subestima). */
  decisionsPerWallMin: number | null;
  /**
   * Decisiones por minuto de pelea real (intentos con `fightMs`, desde la liga sin tope de
   * 1,5 s); null si ningún intento la trae.
   */
  decisionsPerFightMin: number | null;
  /** Latencia estado -> acción: media exacta (ponderada por decisiones) y mediana de los p50/p95 de cada partida. */
  latencyMeanMs: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Decisiones sin acción válida / decisiones. */
  invalidRate: number | null;
  tokensInPerDecision: number | null;
  tokensOutPerDecision: number | null;
  costUsd: number;
  costPerDecisionUsd: number | null;
  damagePerMatch: number | null;
  damagePerDecision: number | null;
  /** Errores del LLM por partida (en partidas válidas: no llegaron al umbral de infraestructura). */
  llmErrorsPerMatch: number | null;
};

export type SpeedCorrelation = {
  metric: keyof SpeedRow;
  label: string;
  /** Spearman entre el Elo y la métrica (null si hay menos de 3 modelos con ambos). */
  rho: number | null;
  n: number;
};

export type SpeedReport = {
  tournamentId: string;
  stage: SpeedStage;
  validMatches: number;
  rows: SpeedRow[];
  correlations: SpeedCorrelation[];
};

/** Métricas que se correlacionan con el Elo (y cómo se llaman en la tabla). */
export const CORRELATED: ReadonlyArray<{ metric: keyof SpeedRow; label: string }> = [
  { metric: "decisionShare", label: "Parte de las decisiones" },
  { metric: "decisionsPerMatch", label: "Decisiones por partida" },
  { metric: "decisionsPerFightMin", label: "Decisiones por minuto de pelea" },
  { metric: "latencyMeanMs", label: "Latencia media" },
  { metric: "latencyP50Ms", label: "Latencia p50" },
  { metric: "invalidRate", label: "Tasa de inválidas" },
  { metric: "tokensInPerDecision", label: "Tokens de entrada por decisión" },
  { metric: "damagePerDecision", label: "Daño por decisión" },
  { metric: "costPerDecisionUsd", label: "Costo por decisión" },
];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Rangos con empates promediados (1 = el menor). */
export function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]![1]] = rank;
    i = j + 1;
  }
  return out;
}

/** Correlación de Spearman (Pearson sobre rangos); null con menos de 3 pares o sin varianza. */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

type Acc = {
  matches: number;
  wins: number;
  draws: number;
  losses: number;
  decisions: number;
  shares: number[];
  wallMs: number;
  /** Solo de los intentos que traen fightMs, con sus decisiones. */
  fightMs: number;
  fightDecisions: number;
  latencySum: number;
  latencyCount: number;
  p50s: number[];
  p95s: number[];
  invalid: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  damage: number;
  llmErrors: number;
};

const emptyAcc = (): Acc => ({
  matches: 0,
  wins: 0,
  draws: 0,
  losses: 0,
  decisions: 0,
  shares: [],
  wallMs: 0,
  fightMs: 0,
  fightDecisions: 0,
  latencySum: 0,
  latencyCount: 0,
  p50s: [],
  p95s: [],
  invalid: 0,
  tokensIn: 0,
  tokensOut: 0,
  cost: 0,
  damage: 0,
  llmErrors: 0,
});

export function buildSpeedReport(
  config: TournamentConfig,
  attempts: MatchAttempt[],
  report: Pick<TournamentReport, "standings"> | null,
  stage: SpeedStage = "league",
): SpeedReport {
  const models = allModels(config);
  const accs = new Map(models.map((m) => [m.key, emptyAcc()]));
  const used = validAttempts(attempts).filter((a) => stage === "all" || a.spec.stage === stage);

  for (const a of used) {
    const both = a.sides.red.decisions + a.sides.blue.decisions;
    for (const side of ["red", "blue"] as const satisfies readonly Side[]) {
      const s = a.sides[side];
      const acc = accs.get(s.model);
      if (!acc) continue;
      acc.matches += 1;
      const winner = a.outcome?.winner ?? null;
      if (winner === null) acc.draws += 1;
      else if (winner === s.model) acc.wins += 1;
      else acc.losses += 1;
      acc.decisions += s.decisions;
      if (both > 0) acc.shares.push(s.decisions / both);
      acc.wallMs += Math.max(0, a.endedAt - a.startedAt);
      if (typeof a.fightMs === "number" && a.fightMs > 0) {
        acc.fightMs += a.fightMs;
        acc.fightDecisions += s.decisions;
      }
      if (s.latencyMs.count > 0) {
        acc.latencySum += s.latencyMs.mean * s.latencyMs.count;
        acc.latencyCount += s.latencyMs.count;
        acc.p50s.push(s.latencyMs.p50);
        acc.p95s.push(s.latencyMs.p95);
      }
      acc.invalid += s.invalidActions;
      acc.tokensIn += s.tokensIn;
      acc.tokensOut += s.tokensOut;
      acc.cost += s.costUsd;
      acc.damage += s.damageDealt;
      acc.llmErrors += s.llmErrors;
    }
  }

  const standing = new Map((report?.standings ?? []).map((s) => [s.model, s]));
  const rows: SpeedRow[] = models.map((m) => {
    const acc = accs.get(m.key)!;
    const st = standing.get(m.key);
    const shares = acc.shares;
    return {
      model: m.key,
      name: m.name,
      isReference: m.isReference,
      reasoning: m.reasoning,
      rating: st?.rating ?? null,
      rank: st?.rank ?? null,
      matches: acc.matches,
      wins: acc.wins,
      draws: acc.draws,
      losses: acc.losses,
      decisions: acc.decisions,
      decisionsPerMatch: ratio(acc.decisions, acc.matches),
      decisionShare: shares.length > 0 ? shares.reduce((s, x) => s + x, 0) / shares.length : null,
      decisionsPerWallMin: ratio(acc.decisions, acc.wallMs / 60_000),
      decisionsPerFightMin: ratio(acc.fightDecisions, acc.fightMs / 60_000),
      latencyMeanMs: ratio(acc.latencySum, acc.latencyCount),
      latencyP50Ms: median(acc.p50s),
      latencyP95Ms: median(acc.p95s),
      invalidRate: ratio(acc.invalid, acc.decisions),
      tokensInPerDecision: ratio(acc.tokensIn, acc.decisions),
      tokensOutPerDecision: ratio(acc.tokensOut, acc.decisions),
      costUsd: acc.cost,
      costPerDecisionUsd: ratio(acc.cost, acc.decisions),
      damagePerMatch: ratio(acc.damage, acc.matches),
      damagePerDecision: ratio(acc.damage, acc.decisions),
      llmErrorsPerMatch: ratio(acc.llmErrors, acc.matches),
    };
  });
  // Mismo orden que el leaderboard; los que no están en él, al final.
  rows.sort((a, b) => (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY));

  const correlations = CORRELATED.map(({ metric, label }) => {
    const pairs = rows.filter((r) => r.rating !== null && typeof r[metric] === "number") as SpeedRow[];
    const rho = spearman(
      pairs.map((r) => r.rating!),
      pairs.map((r) => r[metric] as number),
    );
    return { metric, label, rho, n: pairs.length };
  });

  return { tournamentId: config.id, stage, validMatches: used.length, rows, correlations };
}
