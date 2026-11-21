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

/** Velocidad con la que sale una perla de ender, en bloques/tick. */
export const PEARL_SPEED = 1.5;
/** Gravedad de una perla: 0.03 bloques/tick^2. */
export const PEARL_GRAVITY = 0.03;
/** Roce del aire: la velocidad se multiplica por esto en cada tick. */
export const PEARL_DRAG = 0.99;
/** Altura desde la que sale la perla, medida desde los pies (0.1 bajo los ojos). */
export const PEARL_LAUNCH_HEIGHT = 1.52;
/** Ángulo más bajo con el que se lanza (radianes; positivo = hacia arriba). */
export const PEARL_MIN_PITCH = (-70 * Math.PI) / 180;
/**
 * Ángulo más alto con el que se lanza. Con +6° la perla sube unos 2 bloques sobre los
 * pies: no puede pasar por encima del muro de la arena.
 */
export const PEARL_MAX_PITCH = (6 * Math.PI) / 180;

const PEARL_MAX_TICKS = 200;

/**
 * Distancia horizontal a la que cae una perla lanzada con ángulo `pitch` (radianes,
 * positivo = hacia arriba) desde `drop` bloques por encima del punto de caída. Simula
 * tick a tick como el servidor: avanza, aplica el roce y después la gravedad.
 *
 * Es el punto donde la trayectoria toca el suelo. El jugador aparece donde estaba la
 * perla al empezar ese último tick, o sea hasta ~1.4 bloques ANTES de este punto y nunca
 * después: quedarse corto es lo que conviene (se cae junto al rival y dentro de la arena).
 */
export function pearlRange(pitch: number, drop: number): number {
  const height = Math.max(0.1, drop);
  let vx = PEARL_SPEED * Math.cos(pitch);
  let vy = PEARL_SPEED * Math.sin(pitch);
  let x = 0;
  let y = 0;
  for (let tick = 0; tick < PEARL_MAX_TICKS; tick++) {
    const nextY = y + vy;
    if (nextY <= -height) {
      // Toca el suelo dentro de este tick: se interpola el punto exacto.
      const fraction = (-height - y) / (nextY - y);
      return x + vx * fraction;
    }
    x += vx;
    y = nextY;
    vx *= PEARL_DRAG;
    vy = vy * PEARL_DRAG - PEARL_GRAVITY;
  }
  return x;
}

/**
 * Ángulo (radianes, positivo = hacia arriba) con el que hay que lanzar la perla para que
 * caiga a `distance` bloques en horizontal, saliendo `drop` bloques por encima del punto
 * de caída. Apuntar directo a los pies del rival se queda corto, por eso se busca el
 * ángulo por bisección sobre la simulación. El resultado nunca sale de
 * [PEARL_MIN_PITCH, PEARL_MAX_PITCH]: si el punto queda más lejos de lo que alcanza el
 * ángulo máximo, se lanza con el máximo.
 */
export function pearlPitch(distance: number, drop: number): number {
  if (!(distance > pearlRange(PEARL_MIN_PITCH, drop))) return PEARL_MIN_PITCH;
  if (distance >= pearlRange(PEARL_MAX_PITCH, drop)) return PEARL_MAX_PITCH;
  let low = PEARL_MIN_PITCH;
  let high = PEARL_MAX_PITCH;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (pearlRange(mid, drop) < distance) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export type VelocitySample = { x: number; y: number; z: number; at: number };

/**
 * Sobre esta velocidad (bloques/s) el salto entre dos muestras no es movimiento sino un
 * teletransporte (una perla de ender): nadie corre a más de unos 8 b/s.
 */
const MAX_TRACKED_SPEED = 20;

/**
 * Estima la velocidad (bloques/s) a partir de dos muestras de posición y la
 * suaviza con la estimación anterior. Si las muestras están muy separadas en el
 * tiempo (o son simultáneas), o el rival se teletransportó entre ellas, devuelve cero.
 */
export function estimateVelocity(prev: VelocitySample | null, next: VelocitySample, previous: Vec3Like): Vec3Like {
  if (!prev) return { x: 0, y: 0, z: 0 };
  const dt = (next.at - prev.at) / 1000;
  if (dt <= 0 || dt > 1) return { x: 0, y: 0, z: 0 };
  const raw = { x: (next.x - prev.x) / dt, y: (next.y - prev.y) / dt, z: (next.z - prev.z) / dt };
  if (Math.hypot(raw.x, raw.y, raw.z) > MAX_TRACKED_SPEED) return { x: 0, y: 0, z: 0 };
  return {
    x: previous.x * 0.5 + raw.x * 0.5,
    y: previous.y * 0.5 + raw.y * 0.5,
    z: previous.z * 0.5 + raw.z * 0.5,
  };
}
