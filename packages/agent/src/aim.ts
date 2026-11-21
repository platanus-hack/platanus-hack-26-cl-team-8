import type { Vec3Like } from "./geometry";

/**
 * Velocidad media aproximada de una flecha a carga completa, en bloques/segundo.
 * (3 bloques/tick = 60 b/s al salir; el roce la baja un poco en distancias de arena.)
 */
export const ARROW_SPEED = 57;
/** Gravedad de una flecha: 0.05 bloques/tick^2 = 20 bloques/s^2. */
export const ARROW_GRAVITY = 20;

export type AimInput = {
  /** Posición de los ojos del tirador. */
  from: Vec3Like;
  /** Punto del rival al que se quiere acertar (centro del cuerpo). */
  target: Vec3Like;
  /** Velocidad estimada del rival en bloques/segundo. */
  targetVelocity: Vec3Like;
  arrowSpeed?: number;
  gravity?: number;
};

/**
 * Punto al que hay que mirar para acertar: adelanta el movimiento horizontal del
 * rival y sube la mira para compensar la caída de la flecha. Aproximación simple,
 * suficiente para distancias cortas (< 30 bloques).
 */
export function computeAim(input: AimInput): Vec3Like {
  const speed = input.arrowSpeed ?? ARROW_SPEED;
  const gravity = input.gravity ?? ARROW_GRAVITY;
  const { from, target, targetVelocity } = input;

  let predicted: Vec3Like = { x: target.x, y: target.y, z: target.z };
  let time = 0;
  for (let i = 0; i < 2; i++) {
    const dist = Math.hypot(predicted.x - from.x, predicted.y - from.y, predicted.z - from.z);
    time = dist / speed;
    predicted = {
      x: target.x + targetVelocity.x * time,
      y: target.y,
      z: target.z + targetVelocity.z * time,
    };
  }
  const finalDist = Math.hypot(predicted.x - from.x, predicted.y - from.y, predicted.z - from.z);
  time = finalDist / speed;
  const drop = 0.5 * gravity * time * time;
  return { x: predicted.x, y: predicted.y + drop, z: predicted.z };
}

export type VelocitySample = { x: number; y: number; z: number; at: number };

/**
 * Estima la velocidad (bloques/s) a partir de dos muestras de posición y la
 * suaviza con la estimación anterior. Si las muestras están muy separadas en el
 * tiempo (o son simultáneas) devuelve cero.
 */
export function estimateVelocity(prev: VelocitySample | null, next: VelocitySample, previous: Vec3Like): Vec3Like {
  if (!prev) return { x: 0, y: 0, z: 0 };
  const dt = (next.at - prev.at) / 1000;
  if (dt <= 0 || dt > 1) return { x: 0, y: 0, z: 0 };
  const raw = { x: (next.x - prev.x) / dt, y: (next.y - prev.y) / dt, z: (next.z - prev.z) / dt };
  return {
    x: previous.x * 0.5 + raw.x * 0.5,
    y: previous.y * 0.5 + raw.y * 0.5,
    z: previous.z * 0.5 + raw.z * 0.5,
  };
}
