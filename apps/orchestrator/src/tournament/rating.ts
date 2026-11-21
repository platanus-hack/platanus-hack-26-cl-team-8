/**
 * Rating del torneo: Bradley–Terry regularizado en escala Elo, error estándar de Laplace,
 * bootstrap por clusters (escenario+semilla), matriz fila-vs-columna y calibración contra
 * la referencia.
 *
 * Todo es puro y determinista: el ajuste trabaja sobre estadísticos agregados por pareja
 * (ordenados por key), así que el resultado no depende del orden de las partidas ni del
 * orden de la lista de modelos.
 */
import { REFERENCE_RATING, type CalibrationRow, type CalibrationRule, type FrozenModel, type MatrixCell } from "@phack/protocol";
import type { Game, RatingFit } from "./types";

export type FitOptions = {
  /** Key del modelo fijo en `origin` (no lleva prior). */
  reference: string;
  /** Desviación estándar del prior N(origin, priorSdElo²), en Elo. */
  priorSdElo: number;
  /** Origen de la escala (por defecto REFERENCE_RATING = 1000). */
  origin?: number;
};

export type BootstrapOptions = FitOptions & {
  samples: number;
  seed: number;
};

/** Mínimo de clusters distintos para que el bootstrap tenga sentido. */
export const MIN_BOOTSTRAP_CLUSTERS = 5;

/** Elo por unidad natural: 400 / ln 10. */
const ELO_PER_NAT = 400 / Math.LN10;
const MAX_ITERATIONS = 100;
/** Convergencia: el paso de Newton más grande, en Elo. */
const STEP_TOLERANCE_ELO = 1e-9;

/** Estadísticos de una pareja (a < b por key): partidas y puntos totales de a. */
type PairStats = { a: number; b: number; n: number; scoreA: number };

/** Lista de modelos sin repetidos, ordenada por key (independiente del orden de entrada). */
function sortedModels(models: string[]): string[] {
  return [...new Set(models)].sort();
}

/**
 * Agrega las partidas por pareja ordenada. Ignora partidas con modelos desconocidos o
 * contra sí mismo. Las sumas son de múltiplos de 0.5, así que son exactas en cualquier orden.
 */
function aggregate(models: string[], games: Game[]): PairStats[] {
  const index = new Map(models.map((m, i) => [m, i]));
  const byPair = new Map<string, PairStats>();
  for (const g of games) {
    const ia = index.get(g.a);
    const ib = index.get(g.b);
    if (ia === undefined || ib === undefined || ia === ib) continue;
    const [a, b, s] = ia < ib ? [ia, ib, g.scoreA] : [ib, ia, 1 - g.scoreA];
    const key = `${a}:${b}`;
    let stats = byPair.get(key);
    if (!stats) {
      stats = { a, b, n: 0, scoreA: 0 };
      byPair.set(key, stats);
    }
    stats.n += 1;
    stats.scoreA += s;
  }
  return [...byPair.values()].sort((x, y) => x.a - y.a || x.b - y.b);
}

/** σ(x) = 1 / (1 + e^-x), estable. */
function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** log σ(x), estable. */
function logSigmoid(x: number): number {
  return x >= 0 ? -Math.log1p(Math.exp(-x)) : x - Math.log1p(Math.exp(x));
}

/** Factorización de Cholesky de una matriz simétrica definida positiva (triangular inferior). */
function cholesky(m: number[][]): number[][] {
  const n = m.length;
  const l = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = m[i]![j]!;
      for (let k = 0; k < j; k += 1) sum -= l[i]![k]! * l[j]![k]!;
      l[i]![j] = i === j ? Math.sqrt(Math.max(sum, 1e-300)) : sum / l[j]![j]!;
    }
  }
  return l;
}

/** Resuelve L·Lᵀ·x = rhs. */
function choleskySolve(l: number[][], rhs: number[]): number[] {
  const n = l.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let sum = rhs[i]!;
    for (let k = 0; k < i; k += 1) sum -= l[i]![k]! * y[k]!;
    y[i] = sum / l[i]![i]!;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k += 1) sum -= l[k]![i]! * x[k]!;
    x[i] = sum / l[i]![i]!;
  }
  return x;
}

/**
 * Ajusta Bradley–Terry con puntajes 1 / 0.5 / 0 en escala Elo:
 * p(a gana) = 1 / (1 + 10^((Rb − Ra)/400)). La referencia queda fija en `origin`; el resto
 * lleva un prior N(origin, priorSdElo²). Newton con hessiano completo y búsqueda lineal
 * (el objetivo es cóncavo). SE de Laplace = sqrt(diag(H⁻¹)) de rating − referencia.
 * Los modelos sin partidas quedan en `origin` con SE = priorSdElo (la referencia, SE 0).
 */
export function fitBradleyTerry(models: string[], games: Game[], opts: FitOptions): RatingFit {
  const origin = opts.origin ?? REFERENCE_RATING;
  const keys = sortedModels(models);
  const pairs = aggregate(keys, games);
  const tau = opts.priorSdElo / ELO_PER_NAT;
  const priorPrecision = 1 / (tau * tau);

  const played = new Set<number>();
  for (const p of pairs) {
    played.add(p.a);
    played.add(p.b);
  }
  const refIndex = keys.indexOf(opts.reference);
  // Parámetros libres: modelos con partidas que no son la referencia.
  const free = keys.map((_, i) => i).filter((i) => i !== refIndex && played.has(i));
  const slot = new Map(free.map((i, s) => [i, s]));
  const n = free.length;

  // θ en unidades naturales (log-odds); θ = 0 ⇔ rating = origin.
  const theta = new Array<number>(keys.length).fill(0);

  const objective = (t: number[]): number => {
    let f = 0;
    for (const p of pairs) {
      const d = t[p.a]! - t[p.b]!;
      f += p.scoreA * logSigmoid(d) + (p.n - p.scoreA) * logSigmoid(-d);
    }
    for (const i of free) f -= (t[i]! * t[i]!) * priorPrecision / 2;
    return f;
  };

  /** Gradiente de la log-posterior y hessiano negativo (definido positivo) en los libres. */
  const derivatives = (t: number[]): { grad: number[]; hess: number[][] } => {
    const grad = new Array<number>(n).fill(0);
    const hess = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let s = 0; s < n; s += 1) {
      grad[s] = -t[free[s]!]! * priorPrecision;
      hess[s]![s] = priorPrecision;
    }
    for (const p of pairs) {
      const q = sigmoid(t[p.a]! - t[p.b]!);
      const g = p.scoreA - p.n * q;
      const w = p.n * q * (1 - q);
      const sa = slot.get(p.a);
      const sb = slot.get(p.b);
      if (sa !== undefined) {
        grad[sa]! += g;
        hess[sa]![sa]! += w;
      }
      if (sb !== undefined) {
        grad[sb]! -= g;
        hess[sb]![sb]! += w;
      }
      if (sa !== undefined && sb !== undefined) {
        hess[sa]![sb]! -= w;
        hess[sb]![sa]! -= w;
      }
    }
    return { grad, hess };
  };

  let iterations = 0;
  let converged = n === 0;
  while (!converged && iterations < MAX_ITERATIONS) {
    iterations += 1;
    const { grad, hess } = derivatives(theta);
    const step = choleskySolve(cholesky(hess), grad);
    const maxStep = Math.max(...step.map(Math.abs)) * ELO_PER_NAT;
    if (maxStep === 0) {
      converged = true;
      break;
    }
    // Búsqueda lineal: se acorta el paso mientras empeore el objetivo.
    const f0 = objective(theta);
    let t = 1;
    let next = theta.slice();
    for (;;) {
      next = theta.slice();
      for (let s = 0; s < n; s += 1) next[free[s]!] = theta[free[s]!]! + t * step[s]!;
      if (objective(next) >= f0 || t < 1e-8) break;
      t /= 2;
    }
    for (let s = 0; s < n; s += 1) theta[free[s]!] = next[free[s]!]!;
    if (maxStep * t < STEP_TOLERANCE_ELO) converged = true;
  }

  // Laplace: varianzas = diagonal de H⁻¹ en el óptimo.
  const variance = new Array<number>(n).fill(0);
  if (n > 0) {
    const { hess } = derivatives(theta);
    const l = cholesky(hess);
    for (let s = 0; s < n; s += 1) {
      const e = new Array<number>(n).fill(0);
      e[s] = 1;
      variance[s] = choleskySolve(l, e)[s]!;
    }
  }

  const ratings: Record<string, number> = {};
  const se: Record<string, number> = {};
  keys.forEach((key, i) => {
    const s = slot.get(i);
    if (s !== undefined) {
      ratings[key] = origin + theta[i]! * ELO_PER_NAT;
      se[key] = Math.sqrt(variance[s]!) * ELO_PER_NAT;
    } else {
      ratings[key] = origin;
      se[key] = i === refIndex ? 0 : opts.priorSdElo;
    }
  });
  return { ratings, se, iterations, converged };
}

/** PRNG determinista (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentil con interpolación lineal sobre una lista ordenada. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Intervalo 95 % (percentiles 2.5 / 97.5) por bootstrap de clusters: cada muestra toma, con
 * reemplazo, tantos clusters completos (escenario+semilla) como hay, y reajusta el BT.
 * Determinista dado `seed`. null si hay menos de MIN_BOOTSTRAP_CLUSTERS clusters.
 */
export function clusterBootstrap(
  models: string[],
  games: Game[],
  opts: BootstrapOptions,
): Record<string, { lo: number; hi: number }> | null {
  const byCluster = new Map<string, Game[]>();
  for (const g of games) {
    const list = byCluster.get(g.cluster);
    if (list) list.push(g);
    else byCluster.set(g.cluster, [g]);
  }
  const clusters = [...byCluster.keys()].sort().map((c) => byCluster.get(c)!);
  if (clusters.length < MIN_BOOTSTRAP_CLUSTERS || opts.samples < 1) return null;

  const keys = sortedModels(models);
  const draws: Record<string, number[]> = Object.fromEntries(keys.map((k) => [k, []]));
  const random = mulberry32(opts.seed);
  const fitOpts: FitOptions = { reference: opts.reference, priorSdElo: opts.priorSdElo, origin: opts.origin };
  for (let s = 0; s < opts.samples; s += 1) {
    const sample: Game[] = [];
    for (let k = 0; k < clusters.length; k += 1) {
      sample.push(...clusters[Math.floor(random() * clusters.length)]!);
    }
    const fit = fitBradleyTerry(keys, sample, fitOpts);
    for (const key of keys) draws[key]!.push(fit.ratings[key]!);
  }

  const out: Record<string, { lo: number; hi: number }> = {};
  for (const key of keys) {
    const sorted = draws[key]!.sort((x, y) => x - y);
    out[key] = { lo: percentile(sorted, 0.025), hi: percentile(sorted, 0.975) };
  }
  return out;
}

/**
 * Matriz fila-vs-columna: una celda por cada combinación fila ≠ columna, en el orden de
 * `models` (filas, y dentro de cada fila, columnas). V/E/D desde el punto de vista de la
 * fila; score = (V + 0.5·E) / partidas, o null si no hay partidas (≠ 0.5).
 */
export function headToHead(models: string[], games: Game[]): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const row of models) {
    for (const col of models) {
      if (row === col) continue;
      let wins = 0;
      let draws = 0;
      let losses = 0;
      for (const g of games) {
        let s: number;
        if (g.a === row && g.b === col) s = g.scoreA;
        else if (g.a === col && g.b === row) s = 1 - g.scoreA;
        else continue;
        if (s === 1) wins += 1;
        else if (s === 0) losses += 1;
        else draws += 1;
      }
      const total = wins + draws + losses;
      cells.push({ row, col, games: total, wins, draws, losses, score: total === 0 ? null : (wins + 0.5 * draws) / total });
    }
  }
  return cells;
}

/** Entero con signo para los textos: "+40", "-210", "0". */
function signed(x: number): string {
  const r = Math.round(x);
  return r > 0 ? `+${r}` : r < 0 ? `-${-r}` : "0";
}

/**
 * Calibración contra la referencia (el modelo con isReference, que no aparece en las filas).
 * diff = rating − referencia; lo/hi = diff ∓ z·se (en escala de diferencia, no de rating).
 *   inside:  [lo, hi] ⊂ [−band, band]
 *   outside: [lo, hi] no toca la banda
 *   pending: el intervalo cruza un borde (o el modelo no tiene partidas)
 * league = inside, o pending con |diff| ≤ band y al menos una partida (entra provisional).
 */
export function calibrate(models: FrozenModel[], games: Game[], rule: CalibrationRule): CalibrationRow[] {
  const reference = models.find((m) => m.isReference);
  const keys = models.map((m) => m.key);
  const origin = REFERENCE_RATING;
  const fit = fitBradleyTerry(keys, games, {
    reference: reference?.key ?? "",
    priorSdElo: rule.priorSdElo,
    origin,
  });
  const band = rule.bandElo;
  const known = new Set(keys);

  return models
    .filter((m) => !m.isReference)
    .map((m): CalibrationRow => {
      const rating = fit.ratings[m.key]!;
      const se = fit.se[m.key]!;
      const diff = rating - origin;
      const lo = diff - rule.z * se;
      const hi = diff + rule.z * se;

      let count = 0;
      const rivals = new Set<string>();
      for (const g of games) {
        if (g.a === g.b || !known.has(g.a) || !known.has(g.b)) continue;
        if (g.a === m.key) rivals.add(g.b);
        else if (g.b === m.key) rivals.add(g.a);
        else continue;
        count += 1;
      }

      const interval = `intervalo [${signed(lo)}, ${signed(hi)}]`;
      let verdict: CalibrationRow["verdict"];
      let why: string;
      if (count === 0) {
        verdict = "pending";
        why = "sin partidas válidas todavía: faltan partidas";
      } else if (lo >= -band && hi <= band) {
        verdict = "inside";
        why = `${interval} dentro de la banda ±${band}: mismo nivel que la referencia`;
      } else if (hi < -band) {
        verdict = "outside";
        why = `${interval} entero bajo el borde -${band}: juega peor que la referencia`;
      } else if (lo > band) {
        verdict = "outside";
        why = `${interval} entero sobre el borde +${band}: juega mejor que la referencia`;
      } else {
        verdict = "pending";
        const crosses =
          lo < -band && hi > band
            ? `cruza los dos bordes ±${band}`
            : lo < -band
              ? `cruza el borde -${band}`
              : `cruza el borde +${band}`;
        why = `${interval} ${crosses}: faltan partidas`;
      }

      const league = verdict === "inside" || (verdict === "pending" && count > 0 && Math.abs(diff) <= band);
      if (verdict === "pending" && count > 0) {
        why += league
          ? `; estimación ${signed(diff)} dentro de la banda, entra a la liga como provisional`
          : `; estimación ${signed(diff)} fuera de la banda, no entra a la liga`;
      }

      return {
        model: m.key,
        name: m.name,
        rating,
        diff,
        se,
        lo,
        hi,
        games: count,
        opponents: rivals.size,
        verdict,
        league,
        why,
      };
    });
}
