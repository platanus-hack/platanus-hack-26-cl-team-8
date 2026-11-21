import type { MatchPhase, MatchResult, MatchState, RoundReason, RoundResult, Series, Side, WinReason } from "@phack/protocol";

export const SIDE_LABEL: Record<Side, string> = { red: "Rojo", blue: "Azul" };

export const PHASE_LABEL: Record<MatchPhase, string> = {
  idle: "En espera",
  preparing: "Preparando la arena",
  running: "En combate",
  intermission: "Entre rondas",
  finished: "Pelea finalizada",
};

/** Texto de la fase; con la cuenta regresiva en marcha (al final de "preparing") se dice eso. */
export function phaseLabel(state: Pick<MatchState, "phase" | "countdownEndsAt" | "series">): string {
  if (state.phase === "preparing" && state.countdownEndsAt !== null) return "Cuenta regresiva";
  // En una serie, mientras se pelea se dice en qué ronda van.
  if (state.series && state.phase === "running") return `Ronda ${state.series.round} de ${state.series.maxRounds}`;
  return PHASE_LABEL[state.phase];
}

const ROUND_REASON: Record<RoundReason, string> = {
  kill: "por K.O.",
  surrender: "porque el otro se rindió",
  timeout_health: "por tener más vida al acabarse el tiempo",
  draw: "",
};

/** "Ronda 2: gana Rojo" o "Ronda 2: empate". */
export function roundTitle(result: RoundResult): string {
  return result.winner ? `Ronda ${result.round}: gana ${SIDE_LABEL[result.winner]}` : `Ronda ${result.round}: empate`;
}

/** Cómo terminó la ronda y cómo queda la serie, en una frase. */
export function roundDetail(result: RoundResult, series: Pick<Series, "wins">): string {
  const how = result.winner ? `Gana ${ROUND_REASON[result.reason]}.` : "Se acabó el tiempo con la misma vida.";
  return `${how} Serie: Rojo ${series.wins.red}, Azul ${series.wins.blue}.`;
}

export const REASON_LABEL: Record<WinReason, string> = {
  kill: "K.O.",
  timeout_health: "Más vida al acabar el tiempo",
  draw: "Empate",
  stopped: "Detenida",
  error: "Error",
  rounds: "Por rondas",
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Cuenta regresiva mm:ss (redondea hacia arriba para no mostrar 00:00 antes de tiempo). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} min ${pad2(seconds)} s` : `${seconds} s`;
}

export function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Número con a lo más un decimal (la vida de Minecraft viene en medios corazones). */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "–";
  return String(Math.round(n * 10) / 10);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function resultTitle(result: MatchResult): string {
  if (result.winner) return `¡Gana ${SIDE_LABEL[result.winner]}!`;
  if (result.reason === "stopped") return "Pelea detenida";
  if (result.reason === "error") return "Pelea interrumpida";
  return "Empate";
}

export function resultDetail(result: MatchResult): string {
  switch (result.reason) {
    case "kill":
      return "Victoria por K.O.";
    case "timeout_health":
      return "Se acabó el tiempo: gana quien conservó más vida.";
    case "draw":
      return "Se acabó el tiempo con la misma vida.";
    case "stopped":
      return "Alguien detuvo la pelea antes del final.";
    case "error":
      return "La pelea terminó por un error del servidor.";
    case "rounds":
      return "Ganó más rondas de la serie.";
  }
}
