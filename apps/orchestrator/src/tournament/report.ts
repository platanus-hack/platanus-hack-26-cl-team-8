/**
 * Reporte del torneo (lo que dibuja la web y el CLI) y el calendario derivado de
 * config + estado congelado. Todo puro: recibe config, intentos y estado, y no toca disco.
 *
 * - Calibración: todas las partidas válidas de calibración (base + adaptativa).
 * - Standings y matriz: SOLO partidas válidas de la liga. Sin liga todavía ⇒ vacíos.
 * - Los intentos "infra" nunca entran al rating; sí cuentan para reloj y gasto.
 */
import { createHash } from "node:crypto";
import {
  REFERENCE_RATING,
  type CalibrationRow,
  type FrozenModel,
  type MatchAttempt,
  type MatchSpec,
  type StandingRow,
  type TournamentConfig,
  type TournamentProgress,
  type TournamentReport,
  type TournamentSummary,
} from "@phack/protocol";
import { calibrate, clusterBootstrap, fitBradleyTerry, headToHead } from "./rating";
import { calibrationBasePairs, calibrationSeed, leagueSchedule, legsFor, pairKey } from "./schedule";
import { emptyState, validAttempts } from "./store";
import type { Game, Pair, RunnerState } from "./types";

/** Umbrales para marcar el rating oficial como provisional. */
export const PROVISIONAL_MIN_GAMES = 20;
export const PROVISIONAL_MIN_SEEDS = 3;
export const PROVISIONAL_MIN_CLUSTERS = 5;
/** Muestras del bootstrap por clusters del reporte. */
export const BOOTSTRAP_SAMPLES = 200;
/** z del intervalo de Laplace cuando no hay bootstrap (95 %, igual que el bootstrap). */
const LAPLACE_Z = 1.96;

// ---------- Calendario derivado ----------

export function allModels(config: TournamentConfig): FrozenModel[] {
  return [config.reference, ...config.candidates];
}

export function modelMap(config: TournamentConfig): Record<string, FrozenModel> {
  return Object.fromEntries(allModels(config).map((m) => [m.key, m]));
}

function specsFor(config: TournamentConfig, pairs: Pair[], round: number): MatchSpec[] {
  const seed = calibrationSeed(config.seeds.calibrationBase, round);
  const specs: MatchSpec[] = [];
  for (const scenario of config.scenarios) {
    for (const pair of pairs) specs.push(...legsFor(pair, "calibration", scenario, seed, round));
  }
  return specs;
}

/** Ronda base de calibración (ronda 0): cada candidato vs referencia + cruces entre candidatos. */
export function calibrationBaseSpecs(config: TournamentConfig): MatchSpec[] {
  const pairs = calibrationBasePairs(
    config.reference.key,
    config.candidates.map((c) => c.key),
  );
  return specsFor(config, pairs, 0);
}

/** Partidas de una ronda adaptativa (round ≥ 1, semilla propia). */
export function adaptiveRoundSpecs(config: TournamentConfig, round: number, pairs: Pair[]): MatchSpec[] {
  return specsFor(config, pairs, round);
}

/** Toda la calibración programada: base + rondas adaptativas guardadas en el estado. */
export function calibrationSpecs(config: TournamentConfig, state: RunnerState): MatchSpec[] {
  const specs = calibrationBaseSpecs(config);
  for (const r of [...state.adaptiveRounds].sort((x, y) => x.round - y.round)) {
    specs.push(...adaptiveRoundSpecs(config, r.round, r.pairs));
  }
  return specs;
}

/** Calendario de la liga congelado en el estado (vacío si todavía no se congela). */
export function leagueSpecs(config: TournamentConfig, state: RunnerState): MatchSpec[] {
  if (!state.leagueModels || !state.leagueSeeds || state.leagueModels.length < 2) return [];
  return leagueSchedule(state.leagueModels, config.scenarios, state.leagueSeeds);
}

// ---------- Intentos → juegos ----------

/** Partida válida → juego del rating (cluster = escenario + semilla). */
export function attemptGame(a: MatchAttempt): Game {
  const winner = a.outcome?.winner ?? null;
  const scoreA: Game["scoreA"] = winner === a.spec.a ? 1 : winner === a.spec.b ? 0 : 0.5;
  return { cluster: `${a.spec.scenario}:s${a.spec.seed}`, a: a.spec.a, b: a.spec.b, scoreA };
}

export function gamesOf(valid: MatchAttempt[], stage: MatchSpec["stage"]): Game[] {
  return valid.filter((a) => a.spec.stage === stage).map(attemptGame);
}

/** USD de un intento (los dos lados; los infra también se pagan). */
export function attemptCost(a: MatchAttempt): number {
  return (a.sides.red.costUsd || 0) + (a.sides.blue.costUsd || 0);
}

/** Reloj consumido: suma de duraciones de todos los intentos repartida entre los servidores. */
export function elapsedMs(attempts: MatchAttempt[], concurrency: number): number {
  const total = attempts.reduce((s, a) => s + Math.max(0, a.endedAt - a.startedAt), 0);
  return total / Math.max(1, concurrency);
}

/** Etapa actual derivada del estado y los intentos. */
export function stageOf(state: RunnerState, attempts: MatchAttempt[]): TournamentProgress["stage"] {
  if (state.paused) return "paused";
  if (state.finished) return "done";
  if (state.leagueModels) return "league";
  return attempts.length > 0 ? "calibration" : "created";
}

/** Intentos (válidos e infra, ambas etapas) de una pareja, en orden cronológico. */
export function pairAttempts(attempts: MatchAttempt[], x: string, y: string): MatchAttempt[] {
  const { a, b } = pairKey(x, y);
  return attempts
    .filter((t) => t.spec.a === a && t.spec.b === b)
    .sort((p, q) => p.startedAt - q.startedAt || (p.matchId < q.matchId ? -1 : p.matchId > q.matchId ? 1 : p.attempt - q.attempt));
}

// ---------- Reporte ----------

function seedOf(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

function weightedMean(items: Array<{ value: number; weight: number }>): number {
  const w = items.reduce((s, i) => s + i.weight, 0);
  return w > 0 ? Math.round(items.reduce((s, i) => s + i.value * i.weight, 0) / w) : 0;
}

/** Latencia agregada de un modelo: percentiles por partida promediados con peso = decisiones. */
function latencyOf(model: string, valid: MatchAttempt[]): StandingRow["latencyMs"] {
  const p50: Array<{ value: number; weight: number }> = [];
  const p95: Array<{ value: number; weight: number }> = [];
  let count = 0;
  for (const a of valid) {
    for (const side of [a.sides.red, a.sides.blue]) {
      if (side.model !== model || side.latencyMs.count <= 0) continue;
      count += side.latencyMs.count;
      p50.push({ value: side.latencyMs.p50, weight: side.latencyMs.count });
      p95.push({ value: side.latencyMs.p95, weight: side.latencyMs.count });
    }
  }
  return { p50: weightedMean(p50), p95: weightedMean(p95), count };
}

function costOf(model: string, attempts: MatchAttempt[]): number {
  let usd = 0;
  for (const a of attempts) {
    if (a.sides.red.model === model) usd += a.sides.red.costUsd || 0;
    if (a.sides.blue.model === model) usd += a.sides.blue.costUsd || 0;
  }
  return usd;
}

function calibrationRows(config: TournamentConfig, valid: MatchAttempt[], state: RunnerState): CalibrationRow[] {
  const rows = calibrate(allModels(config), gamesOf(valid, "calibration"), config.rule);
  const cut = new Map((state.leagueCut ?? []).map((c) => [c.model, c.why]));
  return rows.map((row) => {
    if (!state.leagueModels) return row;
    const inLeague = state.leagueModels.includes(row.model);
    const why = cut.has(row.model) ? `${row.why}; ${cut.get(row.model)}` : row.why;
    return { ...row, league: inLeague, why };
  });
}

function standings(
  config: TournamentConfig,
  attempts: MatchAttempt[],
  valid: MatchAttempt[],
  league: MatchAttempt[],
  models: string[],
): StandingRow[] {
  const games = league.map(attemptGame);
  const ref = config.reference.key;
  const fitOpts = { reference: ref, priorSdElo: config.rule.priorSdElo, origin: REFERENCE_RATING };
  const fit = fitBradleyTerry(models, games, fitOpts);
  const boot = clusterBootstrap(models, games, { ...fitOpts, samples: BOOTSTRAP_SAMPLES, seed: seedOf(config.id) });
  const byKey = modelMap(config);

  const rows = models.map((key) => {
    const m = byKey[key]!;
    let wins = 0;
    let draws = 0;
    let losses = 0;
    for (const g of games) {
      if (g.a !== key && g.b !== key) continue;
      const s = g.a === key ? g.scoreA : 1 - g.scoreA;
      if (s === 1) wins++;
      else if (s === 0) losses++;
      else draws++;
    }
    const rating = fit.ratings[key] ?? REFERENCE_RATING;
    const se = fit.se[key] ?? 0;
    const ci = boot?.[key];
    return {
      rank: 0,
      model: key,
      name: m.name,
      version: m.version,
      gatewayId: m.gatewayId,
      inferenceProvider: m.inferenceProvider,
      reasoning: m.reasoning,
      isReference: m.isReference,
      rating,
      lo: ci ? ci.lo : rating - LAPLACE_Z * se,
      hi: ci ? ci.hi : rating + LAPLACE_Z * se,
      ciMethod: ci ? ("bootstrap" as const) : ("laplace" as const),
      games: wins + draws + losses,
      wins,
      draws,
      losses,
      costUsd: costOf(key, attempts),
      latencyMs: latencyOf(key, valid),
    } satisfies StandingRow;
  });
  rows.sort((x, y) => y.rating - x.rating || (x.model < y.model ? -1 : x.model > y.model ? 1 : 0));
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Orden canónico (matchId, intento): las sumas en coma flotante no dependen del archivo. */
export function canonicalOrder(attempts: MatchAttempt[]): MatchAttempt[] {
  return [...attempts].sort((x, y) =>
    x.matchId < y.matchId ? -1 : x.matchId > y.matchId ? 1 : x.attempt - y.attempt || x.startedAt - y.startedAt,
  );
}

/** Arma el reporte completo. Independiente del orden de `attempts`. */
export function buildReport(
  config: TournamentConfig,
  rawAttempts: MatchAttempt[],
  state: RunnerState | null,
): TournamentReport {
  const attempts = canonicalOrder(rawAttempts);
  const st = state ?? emptyState();
  const valid = validAttempts(attempts);
  const calPlanned = calibrationSpecs(config, st);
  const legPlanned = leagueSpecs(config, st);
  const league = valid.filter((a) => a.spec.stage === "league");

  const validIds = new Set(valid.map((a) => a.matchId));
  const seeds = st.leagueSeeds ?? [];
  const seedsDone = seeds.filter((seed) => {
    const specs = legPlanned.filter((s) => s.seed === seed);
    return specs.length > 0 && specs.every((s) => validIds.has(s.id));
  }).length;

  const infra = (stage: MatchSpec["stage"]): number =>
    attempts.filter((a) => a.status === "infra" && a.spec.stage === stage).length;
  const progress: TournamentProgress = {
    stage: stageOf(st, attempts),
    calibration: {
      planned: calPlanned.length,
      valid: valid.filter((a) => a.spec.stage === "calibration").length,
      infra: infra("calibration"),
    },
    league: {
      planned: legPlanned.length,
      valid: league.length,
      infra: infra("league"),
      seedsPlanned: seeds.length,
      seedsDone,
    },
    elapsedMinutes: Math.round((elapsedMs(attempts, config.limits.concurrency) / 60_000) * 10) / 10,
    costUsd: attempts.reduce((s, a) => s + attemptCost(a), 0),
    limits: config.limits,
    stopReason: st.stopReason,
  };

  const leagueModels = st.leagueModels ?? [];
  const rows = league.length > 0 && leagueModels.length >= 2 ? standings(config, attempts, valid, league, leagueModels) : [];
  const order = rows.map((r) => r.model);
  const matrix = rows.length > 0 ? headToHead(order, league.map(attemptGame)) : [];

  const provisionalWhy: string[] = [];
  if (rows.length === 0) {
    provisionalWhy.push(
      st.leagueModels ? "todavía no hay partidas válidas de la liga" : "la liga todavía no empieza: el ranking oficial sale solo de la liga",
    );
  } else {
    for (const r of rows) {
      if (r.games < PROVISIONAL_MIN_GAMES) {
        provisionalWhy.push(`${r.name}: ${r.games} partidas válidas de liga (mínimo ${PROVISIONAL_MIN_GAMES})`);
      }
    }
    if (seedsDone < PROVISIONAL_MIN_SEEDS) {
      provisionalWhy.push(`${seedsDone} semilla(s) de liga completas (mínimo ${PROVISIONAL_MIN_SEEDS})`);
    }
    const clusters = new Set(league.map((a) => attemptGame(a).cluster)).size;
    if (clusters < PROVISIONAL_MIN_CLUSTERS) {
      provisionalWhy.push(
        `${clusters} grupo(s) escenario+semilla en la liga (mínimo ${PROVISIONAL_MIN_CLUSTERS} para el bootstrap; se usa Laplace)`,
      );
    }
  }

  // Quien entró a la liga con la calibración "pending" (estimación dentro, intervalo cruzando el borde).
  const calibration = calibrationRows(config, valid, st);
  if (rows.length > 0) {
    const pending = calibration.filter((r) => r.league && r.verdict === "pending").map((r) => r.name);
    if (pending.length > 0) {
      provisionalWhy.push(`entraron a la liga con la calibración pendiente: ${pending.join(", ")}`);
    }
  }

  return {
    config,
    progress,
    provisional: provisionalWhy.length > 0,
    provisionalWhy,
    standings: rows,
    matrix,
    calibration,
  };
}

export function summarize(config: TournamentConfig, attempts: MatchAttempt[], state: RunnerState | null): TournamentSummary {
  return {
    id: config.id,
    name: config.name,
    createdAt: config.createdAt,
    mode: config.mode,
    stage: stageOf(state ?? emptyState(), attempts),
    models: 1 + config.candidates.length,
    validMatches: validAttempts(attempts).length,
  };
}
