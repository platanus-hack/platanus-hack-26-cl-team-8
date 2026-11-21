import type { MatchResult, Side } from "@phack/protocol";

/** Lógica pura para decidir el resultado de una pelea. */

/** `absorption`: corazones amarillos (de la manzana dorada); cuentan como vida al desempatar. */
export type Vitals = { health: number; alive: boolean; absorption?: number };

/** Vida que cuenta al acabarse el tiempo: la normal más los corazones amarillos. */
function timeoutHealth(v: Vitals): number {
  if (!v.alive) return 0;
  const absorption = v.absorption !== undefined && Number.isFinite(v.absorption) ? Math.max(0, v.absorption) : 0;
  return Math.max(0, v.health) + absorption;
}

export const SIDE_LABEL: Record<Side, string> = { red: "Rojo", blue: "Azul" };

export function otherSide(side: Side): Side {
  return side === "red" ? "blue" : "red";
}

/** Si un lado muere, gana el otro. */
export function resultForDeath(dead: Side): MatchResult {
  return { winner: otherSide(dead), reason: "kill" };
}

/**
 * Al acabarse el tiempo gana quien tenga más vida (contando los corazones amarillos);
 * si están iguales, empate.
 */
export function decideTimeoutResult(red: Vitals, blue: Vitals): MatchResult {
  const redHealth = timeoutHealth(red);
  const blueHealth = timeoutHealth(blue);
  if (Math.abs(redHealth - blueHealth) < 0.01) return { winner: null, reason: "draw" };
  return { winner: redHealth > blueHealth ? "red" : "blue", reason: "timeout_health" };
}

export function describeResult(result: MatchResult): string {
  switch (result.reason) {
    case "kill":
      return result.winner ? `Ganó ${SIDE_LABEL[result.winner]} por KO` : "Pelea terminada por KO";
    case "timeout_health":
      return result.winner
        ? `Se acabó el tiempo: ganó ${SIDE_LABEL[result.winner]} por tener más vida`
        : "Se acabó el tiempo";
    case "draw":
      return "Se acabó el tiempo: empate";
    case "stopped":
      return "Pelea detenida manualmente";
    case "error":
      return "La pelea terminó por un error";
  }
}
