/**
 * Textos y números del leaderboard del torneo. Funciones puras: sin DOM.
 */
import {
  REFERENCE_RATING,
  type CalibrationVerdict,
  type MatchAttempt,
  type TournamentProgress,
  type TournamentReport,
  type TournamentStage,
} from "@phack/protocol";

export const STAGE_LABEL: Record<TournamentProgress["stage"], string> = {
  created: "Creado, sin partidas",
  calibration: "Calibrando",
  league: "Liga en curso",
  done: "Terminado",
  paused: "En pausa",
};

export const MATCH_STAGE_LABEL: Record<TournamentStage, string> = {
  calibration: "Calibración",
  league: "Liga",
};

export const VERDICT_LABEL: Record<CalibrationVerdict, string> = {
  inside: "Dentro de la banda",
  outside: "Fuera de la banda",
  pending: "Pendiente",
};

type Reason = NonNullable<MatchAttempt["outcome"]>["reason"];

export const REASON_LABEL: Record<Reason, string> = {
  kill: "K.O.",
  timeout_health: "Tiempo: más vida",
  draw: "Tiempo: misma vida",
};

/** 0.62 -> "62 %". */
export function formatPct(score: number): string {
  return `${Math.round(score * 100)} %`;
}

/** Rating Elo entero. */
export function formatRating(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n)) : "–";
}

/** Diferencia con signo: "+42", "−17", "0". */
export function formatSigned(n: number): string {
  const r = Math.round(n);
  if (r > 0) return `+${r}`;
  if (r < 0) return `−${Math.abs(r)}`;
  return "0";
}

/** Dólares con los decimales justos: "$12.40", "$0.42", "$0.0031". */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n === 0) return "$0";
  const abs = Math.abs(n);
  const digits = abs >= 10 ? 2 : abs >= 0.1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `$${n.toFixed(digits)}`;
}

/** Milisegundos legibles: "840 ms", "1.2 s". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}

/** Minutos con un decimal si hace falta: "37", "4.5". */
export function formatMinutes(min: number): string {
  if (!Number.isFinite(min)) return "–";
  return String(Math.round(min * 10) / 10);
}

export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString("es-CL", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Fracción para una barra de progreso, recortada a [0, 1]. */
export function fraction(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(1, Math.max(0, done / total));
}

/**
 * Color divergente para un puntaje (V + 0,5·E)/válidas, centrado en 50 %: hacia el
 * verde azulado cuando la fila le gana a la columna, hacia el naranjo cuando pierde.
 * No usa rojo ni azul: esos colores son de los lados del juego.
 */
const MID = [42, 44, 49] as const;
const WIN = [38, 150, 116] as const;
const LOSS = [196, 98, 52] as const;

export function scoreColor(score: number): string {
  const t = Math.min(1, Math.abs(score - 0.5) * 2);
  const end = score >= 0.5 ? WIN : LOSS;
  const mix = (i: 0 | 1 | 2) => Math.round(MID[i] + (end[i] - MID[i]) * t);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/** Duración de una partida en segundos: "61 s". */
export function formatDuration(startedAt: number, endedAt: number): string {
  const s = Math.round((endedAt - startedAt) / 1000);
  return s > 0 ? `${s} s` : "–";
}

/** "A", "A y B", "A, B y C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

/**
 * La tabla dicha en dos frases: quién va primero y quiénes ya se distinguen de la
 * referencia. Un modelo se distingue cuando todo su intervalo queda a un lado de 1000; si
 * lo cruza, con estas partidas no se puede decir si juega mejor o peor.
 */
export function takeaway(report: TournamentReport): string {
  const rows = report.standings;
  const reference = report.config.reference.name;
  if (rows.length === 0) {
    const total = report.calibration.length;
    if (total === 0) return "";
    const inLeague = report.calibration.filter((row) => row.league).length;
    return `La liga todavía no tiene partidas válidas. Por la calibración, ${inLeague} de ${total} candidatos entran a jugarla.`;
  }

  const leader = rows[0]!;
  const lead = Math.round(leader.rating - REFERENCE_RATING);
  let first: string;
  if (leader.isReference) first = `${leader.name}, la referencia, va primero: ningún candidato la supera por ahora.`;
  else if (lead > 0) first = `${leader.name} va primero con ${formatRating(leader.rating)}, ${lead} sobre ${reference}.`;
  else first = `${leader.name} va primero con ${formatRating(leader.rating)}.`;

  const candidates = rows.filter((row) => !row.isReference);
  const above = candidates.filter((row) => row.lo > REFERENCE_RATING).map((row) => row.name);
  const below = candidates.filter((row) => row.hi < REFERENCE_RATING).map((row) => row.name);
  if (candidates.length === 0) return first;
  if (above.length + below.length === 0) {
    return `${first} Todos los intervalos cruzan el ${REFERENCE_RATING}: con estas partidas, ninguno se distingue todavía de la referencia.`;
  }
  const sides = [
    above.length > 0 ? `${joinNames(above)} por arriba` : "",
    below.length > 0 ? `${joinNames(below)} por abajo` : "",
  ].filter((part) => part !== "");
  const rest = above.length + below.length < candidates.length ? " El resto todavía se traslapa con ella." : "";
  return `${first} Ya se distinguen de la referencia: ${sides.join(" y ")}.${rest}`;
}
