import { seriesLeader, type MatchResult, type RoundResult, type Series, type Side } from "@phack/protocol";

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

/** Modo por rondas: gana la serie quien ganó más rondas; con las mismas, empate. */
export function seriesResult(series: Pick<Series, "wins">): MatchResult {
  const leader = seriesLeader(series);
  return leader ? { winner: leader, reason: "rounds" } : { winner: null, reason: "draw" };
}

/**
 * Cómo terminó una ronda, contado a uno de los agentes ("la ganaste", "la perdiste").
 * Le llega al reanudar, como resultado de su última acción.
 */
export function roundNote(result: RoundResult, side: Side): string {
  const head = `terminó la ronda ${result.round}`;
  if (result.winner === null) return `${head}: empate, se acabó el tiempo con la misma vida`;
  const won = result.winner === side;
  switch (result.reason) {
    case "kill":
      return `${head}: la ${won ? "ganaste" : "perdiste"} por K.O.`;
    case "surrender":
      return won ? `${head}: la ganaste porque el otro agente se rindió` : `${head}: la perdiste porque te rendiste`;
    default:
      return `${head}: la ${won ? "ganaste" : "perdiste"} por tener ${won ? "más" : "menos"} vida al acabarse el tiempo`;
  }
}

/** Línea del registro al terminar una ronda, con cómo va la serie. */
export function describeRound(result: RoundResult, series: Pick<Series, "wins">): string {
  const score = `Serie: Rojo ${series.wins.red}, Azul ${series.wins.blue}`;
  if (result.winner === null) return `Ronda ${result.round}: empate, se acabó el tiempo con la misma vida. ${score}`;
  const how =
    result.reason === "kill"
      ? "por KO"
      : result.reason === "surrender"
        ? `porque ${SIDE_LABEL[otherSide(result.winner)]} se rindió`
        : "por tener más vida al acabarse el tiempo";
  return `Ronda ${result.round}: ganó ${SIDE_LABEL[result.winner]} ${how}. ${score}`;
}

/** `series`: en el modo por rondas, para contar el marcador final. */
export function describeResult(result: MatchResult, series: Pick<Series, "wins"> | null = null): string {
  switch (result.reason) {
    case "kill":
      return result.winner ? `Ganó ${SIDE_LABEL[result.winner]} por KO` : "Pelea terminada por KO";
    case "timeout_health":
      return result.winner
        ? `Se acabó el tiempo: ganó ${SIDE_LABEL[result.winner]} por tener más vida`
        : "Se acabó el tiempo";
    case "draw":
      return series ? `La serie terminó empatada: ${series.wins.red} a ${series.wins.blue} en rondas` : "Se acabó el tiempo: empate";
    case "rounds": {
      if (!result.winner) return "Terminó la serie";
      const score = series ? ` ${series.wins[result.winner]} a ${series.wins[otherSide(result.winner)]}` : "";
      return `Ganó ${SIDE_LABEL[result.winner]} la serie${score}`;
    }
    case "stopped":
      return "Pelea detenida manualmente";
    case "error":
      return "La pelea terminó por un error";
  }
}
