/**
 * Textos y números del leaderboard del torneo. Funciones puras: sin DOM.
 */
import type { CalibrationVerdict, MatchAttempt, TournamentProgress, TournamentStage } from "@phack/protocol";

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

/** Intervalo de un rating: semiancho redondeado ("±48") y extremos ("[952, 1048]"). */
export function formatInterval(lo: number, hi: number): { half: string; range: string } {
  const half = Math.round((hi - lo) / 2);
  return { half: `±${half}`, range: `[${Math.round(lo)}, ${Math.round(hi)}]` };
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
