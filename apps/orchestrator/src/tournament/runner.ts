/**
 * Bucle del torneo: calibración base → evaluación → rondas adaptativas (solo "pending",
 * hasta calibrationShare de la capacidad) → congelar la liga (modelos y semillas) en el
 * estado → liga semilla por semilla.
 *
 * - Antes de cada partida proyecta reloj, partidas y USD con la media observada (o la
 *   estimación del catálogo si aún no hay intentos) y para si el siguiente intento no cabe.
 * - Un intento "infra" se reintenta hasta limits.maxAttempts y nunca entra al rating.
 * - Pausa (archivo PAUSE o SIGINT en el CLI): deja de lanzar partidas, espera la que está
 *   en curso y sale guardando. Reanudar recalcula el calendario determinista desde config +
 *   estado y salta los matchId que ya tienen un intento válido: nunca duplica.
 */
import type { BenchmarkVersion, CalibrationRow, FrozenModel, MatchAttempt, MatchSpec, SideStats, TournamentConfig } from "@phack/protocol";
import { benchmarkMismatch } from "./benchmark";
import { calibrate } from "./rating";
import {
  adaptiveRoundSpecs,
  allModels,
  attemptCost,
  calibrationBaseSpecs,
  elapsedMs,
  gamesOf,
  leagueSpecs,
  modelMap,
  stageOf,
} from "./report";
import {
  adaptiveBudget,
  adaptivePairs,
  capacity,
  estimateMatch,
  leagueMatchesPerSeed,
  leagueSeeds,
  leagueSize,
} from "./schedule";
import { emptyState, validAttempts } from "./store";
import type { MatchRunner, Pair, RunnerState, RunOptions, TournamentStore } from "./types";

/** Segundos de preparación supuestos por partida antes de observar ninguna. */
export const DEFAULT_OVERHEAD_SECONDS = 20;
/** Tope de rondas adaptativas (además del presupuesto). */
export const MAX_ADAPTIVE_ROUNDS = 20;
/** Fallos de infra seguidos (entre partidas distintas) que pausan el torneo: algo está caído. */
export const MAX_INFRA_STREAK = 6;
/** Tope de semillas de liga congeladas (con presupuestos enormes, no programar miles). */
export const MAX_LEAGUE_SEEDS = 50;

export class BenchmarkMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkMismatchError";
  }
}

export type RunTournamentOptions = RunOptions & {
  /** Benchmark del código actual; si no coincide con el congelado, no se corre. */
  benchmark?: BenchmarkVersion;
  /** Pausa cooperativa (p. ej. archivo PAUSE). Se consulta antes de cada partida. */
  pauseRequested?: () => boolean | Promise<boolean>;
  /** Estimación previa por partida (si no, sale del catálogo congelado). */
  estimate?: { minutesPerMatch: number; usdPerMatch: number };
};

export type RunSummary = {
  stage: ReturnType<typeof stageOf>;
  stopReason: string | null;
  paused: boolean;
  /** Intentos registrados en esta corrida. */
  played: number;
};

type PhaseResult = "done" | "stopped";

/** Intento "infra" armado por el runner cuando el MatchRunner lanza. */
function crashedAttempt(spec: MatchSpec, attempt: number, startedAt: number, endedAt: number, error: string): MatchAttempt {
  const side = (model: string): SideStats => ({
    model,
    health: 20,
    damageDealt: 0,
    decisions: 0,
    invalidActions: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    costSource: "none",
    latencyMs: { count: 0, mean: 0, p50: 0, p95: 0 },
    llmErrors: 0,
  });
  return {
    matchId: spec.id,
    attempt,
    status: "infra",
    spec,
    startedAt,
    endedAt,
    outcome: null,
    error,
    sides: { red: side(spec.red), blue: side(spec.blue) },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Corre (o reanuda) el torneo `id` con `runner` hasta terminar, pausar o tocar un límite.
 * Lanza BenchmarkMismatchError si el benchmark actual no es el congelado.
 */
export async function runTournament(
  store: TournamentStore,
  id: string,
  runner: MatchRunner,
  opts: RunTournamentOptions = {},
): Promise<RunSummary> {
  const config = await store.load(id);
  if (opts.benchmark) {
    const mismatch = benchmarkMismatch(config.benchmark, opts.benchmark);
    if (mismatch) throw new BenchmarkMismatchError(mismatch);
  }
  const run = new TournamentRun(store, config, runner, opts);
  return run.start();
}

class TournamentRun {
  private state: RunnerState = emptyState();
  private attempts: MatchAttempt[] = [];
  private readonly validIds = new Set<string>();
  private readonly tries = new Map<string, number>();
  private inFlight = 0;
  private stopReason: string | null = null;
  /** true = la parada deja el torneo pausado (reanudable); false = terminado. */
  private stopPauses = false;
  private infraStreak = 0;
  private played = 0;
  private readonly models: Record<string, FrozenModel>;
  private readonly signal: AbortSignal;
  private readonly log: (text: string) => void;
  private readonly now: () => number;

  constructor(
    private readonly store: TournamentStore,
    private readonly config: TournamentConfig,
    private readonly runner: MatchRunner,
    private readonly opts: RunTournamentOptions,
  ) {
    this.models = modelMap(config);
    this.signal = opts.signal ?? new AbortController().signal;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  async start(): Promise<RunSummary> {
    const { config } = this;
    this.state = { ...emptyState(), ...((await this.store.loadState(config.id)) ?? {}) };
    this.state.paused = false;
    this.state.stopReason = null;
    this.state.finished = false;
    await this.save();

    this.attempts = await this.store.attempts(config.id);
    for (const a of this.attempts) this.tries.set(a.matchId, (this.tries.get(a.matchId) ?? 0) + 1);
    for (const a of validAttempts(this.attempts)) this.validIds.add(a.matchId);

    if (!this.state.leagueModels) {
      this.log("Calibración: ronda base");
      if ((await this.runSpecs(calibrationBaseSpecs(config))) === "stopped") return this.finish();
      if ((await this.adaptive()) === "stopped") return this.finish();
      await this.freezeLeague();
      if (this.stopReason) return this.finish();
    }

    const league = leagueSpecs(config, this.state);
    if (league.length > 0) {
      this.log(`Liga: ${this.state.leagueModels?.length ?? 0} modelos, ${this.state.leagueSeeds?.length ?? 0} semilla(s), ${league.length} partidas`);
      if ((await this.runSpecs(league)) === "stopped") return this.finish();
    }
    return this.finish();
  }

  // ---------- Etapas ----------

  private rows(): CalibrationRow[] {
    const valid = validAttempts(this.attempts);
    return calibrate(allModels(this.config), gamesOf(valid, "calibration"), this.config.rule);
  }

  private async adaptive(): Promise<PhaseResult> {
    const { config } = this;
    const scenarios = Math.max(1, config.scenarios.length);
    const baseMatches = calibrationBaseSpecs(config).length;
    for (let round = 1; round <= MAX_ADAPTIVE_ROUNDS; round++) {
      const saved = this.state.adaptiveRounds.find((r) => r.round === round);
      let pairs: Pair[];
      if (saved) {
        pairs = saved.pairs;
      } else {
        const rows = this.rows();
        if (!rows.some((r) => r.verdict === "pending")) break;
        const scheduled = this.state.adaptiveRounds.reduce((s, r) => s + r.pairs.length * 2 * scenarios, 0);
        const budget = adaptiveBudget(capacity(config.limits, this.estimate()), baseMatches, config.limits.calibrationShare) - scheduled;
        const maxPairs = Math.floor(budget / (2 * scenarios));
        if (maxPairs < 1) {
          this.log("Calibración adaptativa: sin presupuesto, los dudosos quedan \"pending\"");
          break;
        }
        const played: Pair[] = validAttempts(this.attempts)
          .filter((a) => a.spec.stage === "calibration")
          .map((a) => ({ a: a.spec.a, b: a.spec.b }));
        pairs = adaptivePairs(rows, played, config.reference.key, maxPairs);
        if (pairs.length === 0) break;
        this.state.adaptiveRounds.push({ round, pairs });
        await this.save();
      }
      this.log(`Calibración adaptativa: ronda ${round}, ${pairs.length} pareja(s)`);
      if ((await this.runSpecs(adaptiveRoundSpecs(config, round, pairs))) === "stopped") return "stopped";
    }
    return "done";
  }

  /** Elige a los clasificados, recorta por presupuesto y congela modelos + semillas. */
  private async freezeLeague(): Promise<void> {
    const { config } = this;
    const ref = config.reference.key;
    const scenarios = Math.max(1, config.scenarios.length);
    const qualified = this.rows()
      .filter((r) => r.league)
      .sort((x, y) => Math.abs(x.diff) - Math.abs(y.diff) || (x.model < y.model ? -1 : 1));
    if (qualified.length === 0) {
      this.state.leagueModels = [ref];
      this.state.leagueSeeds = [];
      this.state.leagueCut = [];
      this.stop("ningún candidato entró a la liga: no hay liga que jugar", false);
      await this.save();
      return;
    }
    const remaining = this.remainingCapacity();
    const n = Math.min(qualified.length + 1, leagueSize(remaining, scenarios));
    const entrants = qualified.slice(0, n - 1);
    const cut = qualified.slice(n - 1);
    const perSeed = leagueMatchesPerSeed(n, scenarios);
    const seeds = Math.min(MAX_LEAGUE_SEEDS, Math.max(1, Math.floor(remaining / Math.max(1, perSeed))));
    this.state.leagueModels = [ref, ...entrants.map((r) => r.model)].sort();
    this.state.leagueSeeds = leagueSeeds(config.seeds.leagueBase, seeds);
    this.state.leagueCut = cut.map((r) => ({
      model: r.model,
      why: `clasificado, fuera por presupuesto: la liga se recortó a ${n} modelos (los más cercanos a la referencia) para que quepa una semilla completa`,
    }));
    await this.save();
    this.log(
      `Liga congelada: ${n} modelos, ${seeds} semilla(s) de ${perSeed} partidas` +
        (cut.length > 0 ? `; ${cut.length} clasificado(s) fuera por presupuesto` : ""),
    );
  }

  // ---------- Presupuesto ----------

  /** Minutos y USD por partida: media observada si hay intentos; si no, la estimación. */
  private estimate(): { minutesPerMatch: number; usdPerMatch: number } {
    const n = this.attempts.length;
    if (n > 0) {
      const minutes = this.attempts.reduce((s, a) => s + Math.max(0, a.endedAt - a.startedAt), 0) / n / 60_000;
      const usd = this.attempts.reduce((s, a) => s + attemptCost(a), 0) / n;
      return { minutesPerMatch: minutes, usdPerMatch: usd };
    }
    if (this.opts.estimate) return this.opts.estimate;
    const { benchmark } = this.config;
    const est = estimateMatch(allModels(this.config), benchmark.matchSeconds, benchmark.tickMs, DEFAULT_OVERHEAD_SECONDS);
    return { minutesPerMatch: est.minutesPerMatch, usdPerMatch: est.usdPerMatch };
  }

  private usedMinutes(): number {
    return elapsedMs(this.attempts, this.config.limits.concurrency) / 60_000;
  }

  private usedUsd(): number {
    return this.attempts.reduce((s, a) => s + attemptCost(a), 0);
  }

  /** Partidas que todavía caben con los límites y la media observada. */
  private remainingCapacity(): number {
    const { limits } = this.config;
    const est = this.estimate();
    const byMatches = limits.maxMatches - this.validIds.size;
    const byClock =
      est.minutesPerMatch > 0
        ? Math.floor((limits.maxMinutes - this.usedMinutes()) / est.minutesPerMatch) * Math.max(1, limits.concurrency)
        : Number.POSITIVE_INFINITY;
    const byMoney = est.usdPerMatch > 0 ? Math.floor((limits.maxUsd - this.usedUsd()) / est.usdPerMatch) : Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(byMatches, byClock, byMoney));
  }

  /** null si cabe una partida más (contando las que están en curso); si no, el motivo. */
  private limitReached(): string | null {
    const { limits } = this.config;
    const est = this.estimate();
    const next = this.inFlight + 1;
    if (this.validIds.size + this.inFlight >= limits.maxMatches) {
      return `límite de partidas: ${this.validIds.size} válidas de ${limits.maxMatches}`;
    }
    const minutes = this.usedMinutes() + (next * est.minutesPerMatch) / Math.max(1, limits.concurrency);
    if (minutes > limits.maxMinutes) {
      return `límite de reloj: ${this.usedMinutes().toFixed(1)} de ${limits.maxMinutes} min usados y la próxima partida no cabe (≈ ${est.minutesPerMatch.toFixed(2)} min)`;
    }
    const usd = this.usedUsd() + next * est.usdPerMatch;
    if (usd > limits.maxUsd) {
      return `límite de gasto: ${this.usedUsd().toFixed(2)} de ${limits.maxUsd} USD usados y la próxima partida no cabe (≈ ${est.usdPerMatch.toFixed(3)} USD)`;
    }
    return null;
  }

  // ---------- Partidas ----------

  private stop(reason: string, pauses: boolean): void {
    if (this.stopReason) return;
    this.stopReason = reason;
    this.stopPauses = pauses;
    this.log(`Parada: ${reason}`);
  }

  /** Corre las partidas que faltan de `specs` con hasta `concurrency` en paralelo. */
  private async runSpecs(specs: MatchSpec[]): Promise<PhaseResult> {
    const { maxAttempts } = this.config.limits;
    const queue = specs.filter((s) => !this.validIds.has(s.id) && (this.tries.get(s.id) ?? 0) < maxAttempts);
    const worker = async (): Promise<void> => {
      while (!this.stopReason) {
        if (this.signal.aborted) {
          this.stop("detenido: se abortó la corrida", true);
          break;
        }
        if (this.opts.pauseRequested && (await this.opts.pauseRequested())) {
          this.stop("pausado a pedido (se terminó la partida en curso)", true);
          break;
        }
        const spec = queue.shift();
        if (!spec) break;
        const limit = this.limitReached();
        if (limit) {
          queue.unshift(spec);
          this.stop(limit, false);
          break;
        }
        await this.playOne(spec, queue);
      }
    };
    const workers = Array.from({ length: Math.max(1, this.config.limits.concurrency) }, () => worker());
    await Promise.all(workers);
    return this.stopReason ? "stopped" : "done";
  }

  private async playOne(spec: MatchSpec, queue: MatchSpec[]): Promise<void> {
    const { maxAttempts } = this.config.limits;
    const attemptNo = (this.tries.get(spec.id) ?? 0) + 1;
    this.tries.set(spec.id, attemptNo);
    this.inFlight++;
    const startedAt = this.now();
    let attempt: MatchAttempt;
    try {
      attempt = await this.runner.run(spec, this.models, this.signal, { attempt: attemptNo, tournamentId: this.config.id });
    } catch (err) {
      attempt = crashedAttempt(spec, attemptNo, startedAt, this.now(), `el runner falló: ${errorText(err)}`);
    } finally {
      this.inFlight--;
    }

    // Abortado a mitad: el intento no es un fallo real de infraestructura; no se registra.
    if (this.signal.aborted && attempt.status !== "valid") {
      this.tries.set(spec.id, attemptNo - 1);
      this.stop("detenido: se abortó la corrida", true);
      return;
    }

    attempt = { ...attempt, matchId: spec.id, attempt: attemptNo, spec };
    if (attempt.status === "valid" && !attempt.outcome) {
      attempt = { ...attempt, status: "infra", error: "intento válido sin resultado" };
    }
    await this.store.appendAttempt(this.config.id, attempt);
    this.attempts.push(attempt);
    this.played++;
    this.opts.onAttempt?.(attempt);

    if (attempt.status === "valid") {
      this.validIds.add(spec.id);
      this.infraStreak = 0;
      return;
    }
    this.infraStreak++;
    this.log(`Fallo de infraestructura en ${spec.id} (intento ${attemptNo}/${maxAttempts}): ${attempt.error ?? "sin detalle"}`);
    if (attemptNo < maxAttempts) queue.unshift(spec);
    else this.log(`${spec.id} agotó sus ${maxAttempts} intentos: queda sin jugar`);
    if (this.infraStreak >= MAX_INFRA_STREAK) {
      this.stop(`${this.infraStreak} fallos de infraestructura seguidos: torneo pausado (revisa Minecraft, la red o las claves)`, true);
    }
  }

  private async finish(): Promise<RunSummary> {
    this.state.stopReason = this.stopReason;
    this.state.paused = this.stopReason !== null && this.stopPauses;
    this.state.finished = !this.state.paused;
    await this.save();
    return {
      stage: stageOf(this.state, this.attempts),
      stopReason: this.state.stopReason,
      paused: this.state.paused,
      played: this.played,
    };
  }

  private save(): Promise<void> {
    return this.store.saveState(this.config.id, this.state);
  }
}
