/**
 * Golpe crítico con salto (Minecraft Java 1.20.4): un golpe hace 1.5 veces el daño si el
 * atacante está cayendo (pasó el punto más alto del salto y no tocó el piso), no está en
 * el agua, no viene corriendo y el arma está recargada.
 *
 * Un salto sube ~6 ticks (0.3 s) y baja otros ~6: se salta un poco antes de que el arma
 * recargue para que la recarga termine cerca del punto más alto y el golpe salga en la
 * caída. Puro (sin mineflayer): el cuerpo le pasa su estado en cada tick y hace lo que diga.
 */

/** Cuánto antes de que termine la recarga se salta (ticks hasta el punto más alto). */
export const CRIT_JUMP_LEAD_MS = 300;
/** Si con el arma lista pasa este tiempo sin lograr la caída, se pega normal: no se pierde el ritmo. */
export const CRIT_MAX_WAIT_MS = 600;
/** Entre un salto y el siguiente: un salto completo dura ~0.6 s. */
export const CRIT_REJUMP_MS = 450;
/** Se salta con el rival hasta a este margen más allá del alcance: el salto también acerca. */
export const CRIT_JUMP_SLACK = 1;
/** Bajo esta distancia no se corre: un golpe a la carrera da retroceso en vez de crítico. */
export const CRIT_NO_SPRINT_RANGE = 4.5;

export type CritInput = {
  now: number;
  /** Momento en que el arma termina de recargar. */
  readyAt: number;
  /** Distancia al rival. */
  dist: number;
  /** Alcance cuerpo a cuerpo. */
  reach: number;
  onGround: boolean;
  /** Velocidad vertical (negativa = cayendo). */
  vy: number;
  inWater: boolean;
  /** Último salto (0 = nunca). */
  lastJumpAt: number;
};

export type CritStep = { action: "jump" } | { action: "hit"; crit: boolean } | { action: "wait" };

export function critStep(input: CritInput): CritStep {
  const { now, readyAt, dist, reach, onGround, vy, inWater, lastJumpAt } = input;
  const ready = now >= readyAt;
  const inReach = dist <= reach;
  // En el agua no hay críticos: se pega normal.
  if (inWater) return ready && inReach ? { action: "hit", crit: false } : { action: "wait" };
  if (!onGround) {
    // En el aire: solo se pega cayendo; subiendo se espera.
    return ready && inReach && vy < 0 ? { action: "hit", crit: true } : { action: "wait" };
  }
  if (ready && inReach && now - readyAt >= CRIT_MAX_WAIT_MS) return { action: "hit", crit: false };
  const soon = readyAt - now <= CRIT_JUMP_LEAD_MS;
  if (soon && dist <= reach + CRIT_JUMP_SLACK && now - lastJumpAt >= CRIT_REJUMP_MS) return { action: "jump" };
  return { action: "wait" };
}
