/**
 * MatchRunner simulado: agentes con un rating oculto por modelo y un RNG con semilla.
 * No usa Minecraft ni créditos; sirve para los tests y para `--simulate`.
 *
 * Determinista: cada intento usa un RNG sembrado con (id del torneo, matchId, intento),
 * así que repetir o reanudar da exactamente los mismos resultados. Las duraciones son
 * simuladas (≈ 60 s de pelea + preparación) para que los límites de reloj se comporten
 * como en una corrida real aunque la simulación tarde milisegundos.
 */
import { createHash } from "node:crypto";
import type { FrozenModel, MatchAttempt, MatchSpec, SideStats } from "@phack/protocol";
import type { MatchRunner } from "./types";

/** RNG mulberry32: uniforme en [0, 1). */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

/** Rating oculto derivado de la key: 1000 ± 300 (estable entre corridas). */
export function hiddenRating(key: string): number {
  return 700 + (hashSeed(`rating:${key}`) % 601);
}

export type SimOptions = {
  /** Ratings ocultos explícitos; los que falten salen de hiddenRating(key). */
  ratings?: Record<string, number>;
  /** Probabilidad de empate por partida (1 = todo empates). */
  drawRate?: number;
  /** Probabilidad de fallo de infraestructura por intento. */
  infraRate?: number;
  /** Fallo de infra forzado: devuelve un motivo para que el intento falle. */
  infra?: (spec: MatchSpec, attempt: number) => string | null;
  /** Segundos simulados de pelea y de preparación. */
  matchSeconds?: number;
  overheadSeconds?: number;
  tickMs?: number;
  /** Espera real por intento (ms), para probar abort/pausa. Respeta la señal. */
  delayMs?: number;
  now?: () => number;
};

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function sideStats(
  model: FrozenModel,
  rng: () => number,
  decisionsMax: number,
  health: number,
  damageDealt: number,
  fraction: number,
): SideStats {
  const decisions = Math.max(1, Math.round(decisionsMax * fraction * (0.75 + 0.25 * rng())));
  const invalidActions = Math.floor(decisions * 0.05 * rng());
  const tokensIn = decisions * (2000 + Math.floor(rng() * 1000));
  const tokensOut = decisions * (100 + Math.floor(rng() * 100));
  const costUsd = model.pricing ? tokensIn * model.pricing.input + tokensOut * model.pricing.output : 0;
  // Latencia base del modelo (estable) con ruido por partida.
  const base = 300 + (hashSeed(`latency:${model.key}`) % 1700);
  const mean = Math.round(base * (0.9 + 0.2 * rng()));
  const count = decisions - invalidActions;
  return {
    model: model.key,
    health,
    damageDealt,
    decisions,
    invalidActions,
    tokensIn,
    tokensOut,
    costUsd,
    costSource: model.pricing ? "estimated" : "none",
    latencyMs: { count, mean, p50: Math.round(mean * 0.92), p95: Math.round(mean * 1.8) },
    llmErrors: 0,
  };
}

/** p(a gana) en Bradley–Terry con escala Elo. */
export function winProbability(ra: number, rb: number): number {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

export function createSimRunner(opts: SimOptions = {}): MatchRunner {
  const drawRate = opts.drawRate ?? 0.1;
  const infraRate = opts.infraRate ?? 0;
  const matchSeconds = opts.matchSeconds ?? 60;
  const overheadSeconds = opts.overheadSeconds ?? 20;
  const tickMs = opts.tickMs ?? 1500;
  const now = opts.now ?? Date.now;
  const decisionsMax = Math.ceil((matchSeconds * 1000) / tickMs);
  const rating = (key: string): number => opts.ratings?.[key] ?? hiddenRating(key);

  return {
    async run(spec, models, signal, info): Promise<MatchAttempt> {
      const attempt = info?.attempt ?? 1;
      const rng = mulberry32(hashSeed(`${info?.tournamentId ?? ""}|${spec.id}|${attempt}`));
      await sleepAbortable(opts.delayMs ?? 0, signal);
      const startedAt = now();
      const red = models[spec.red];
      const blue = models[spec.blue];
      if (!red || !blue) throw new Error(`Modelo desconocido en ${spec.id}`);

      const forced = opts.infra?.(spec, attempt) ?? null;
      const infraRoll = rng();
      if (signal.aborted || forced || infraRoll < infraRate) {
        const error = signal.aborted ? "pelea detenida" : forced ?? "simulado: 429 del proveedor en racha";
        const seconds = 5 + Math.floor(rng() * 15);
        return {
          matchId: spec.id,
          attempt,
          status: "infra",
          spec,
          startedAt,
          endedAt: startedAt + seconds * 1000,
          outcome: null,
          error,
          sides: {
            red: { ...sideStats(red, rng, decisionsMax, 20, 0, 0.1), llmErrors: 3 },
            blue: sideStats(blue, rng, decisionsMax, 20, 0, 0.1),
          },
        };
      }

      const pRed = winProbability(rating(spec.red), rating(spec.blue));
      const draw = rng() < drawRate;
      const redWins = rng() < pRed;
      const kill = !draw && rng() < 0.6;
      const fightSeconds = kill ? 15 + Math.floor(rng() * (matchSeconds - 15)) : matchSeconds;
      const fraction = fightSeconds / matchSeconds;
      const loserHealth = kill ? 0 : 1 + Math.floor(rng() * 12);
      const winnerHealth = Math.min(20, loserHealth + 1 + Math.floor(rng() * 8));
      const drawHealth = 1 + Math.floor(rng() * 19);
      const redHealth = draw ? drawHealth : redWins ? winnerHealth : loserHealth;
      const blueHealth = draw ? drawHealth : redWins ? loserHealth : winnerHealth;
      const winner = draw ? null : redWins ? spec.red : spec.blue;
      return {
        matchId: spec.id,
        attempt,
        status: "valid",
        spec,
        startedAt,
        endedAt: startedAt + (fightSeconds + overheadSeconds) * 1000,
        outcome: { winner, reason: draw ? "draw" : kill ? "kill" : "timeout_health" },
        error: null,
        sides: {
          red: sideStats(red, rng, decisionsMax, redHealth, 20 - blueHealth, fraction),
          blue: sideStats(blue, rng, decisionsMax, blueHealth, 20 - redHealth, fraction),
        },
      };
    },
  };
}
