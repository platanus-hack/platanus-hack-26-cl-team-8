import type { MatchPhase, MatchResult, Side } from "@phack/protocol";

export const SIDE_LABEL: Record<Side, string> = { red: "Rojo", blue: "Azul" };

export const PHASE_LABEL: Record<MatchPhase, string> = {
  idle: "En espera",
  preparing: "Preparando la arena",
  running: "En combate",
  finished: "Pelea finalizada",
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Cuenta regresiva mm:ss (redondea hacia arriba para no mostrar 00:00 antes de tiempo). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

export function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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
  }
}
