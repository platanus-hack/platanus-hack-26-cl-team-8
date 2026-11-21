/**
 * Matemática pura de la cámara (sin three ni mineflayer) para poder testearla.
 */

export type Vec = { x: number; y: number; z: number };

/**
 * Punto al que debe mirar la cámara:
 *  - dos peleadores presentes: el punto medio entre ambos;
 *  - uno solo: el punto medio entre ese peleador y el centro (no lo perdemos de vista
 *    pero tampoco dejamos el resto de la arena fuera de cuadro);
 *  - ninguno: el centro de la arena.
 */
export function pickAimTarget(fighters: readonly Vec[], center: Vec): Vec {
  const first = fighters[0];
  const second = fighters[1];
  if (first && second) return midpoint(first, second);
  if (first) return midpoint(first, center);
  return { x: center.x, y: center.y, z: center.z };
}

export function midpoint(a: Vec, b: Vec): Vec {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

/**
 * Suavizado exponencial independiente del framerate: con `tauSeconds` = 0.5 la
 * cámara recorre ~63% de la distancia al objetivo cada medio segundo.
 */
export function smoothToward(current: Vec, target: Vec, dtSeconds: number, tauSeconds: number): Vec {
  if (tauSeconds <= 0 || dtSeconds <= 0) {
    return tauSeconds <= 0 ? { x: target.x, y: target.y, z: target.z } : { x: current.x, y: current.y, z: current.z };
  }
  const alpha = 1 - Math.exp(-dtSeconds / tauSeconds);
  return {
    x: current.x + (target.x - current.x) * alpha,
    y: current.y + (target.y - current.y) * alpha,
    z: current.z + (target.z - current.z) * alpha,
  };
}

/**
 * Posición de la cámara. Con `periodSeconds` <= 0 queda fija en `base`; si no,
 * gira alrededor de `center` a la misma altura y distancia horizontal que `base`,
 * partiendo desde `base` en t = 0.
 */
export function orbitPosition(base: Vec, center: Vec, elapsedSeconds: number, periodSeconds: number): Vec {
  if (periodSeconds <= 0) return { x: base.x, y: base.y, z: base.z };
  const dx = base.x - center.x;
  const dz = base.z - center.z;
  const radius = Math.hypot(dx, dz);
  if (radius === 0) return { x: base.x, y: base.y, z: base.z };
  const angle = Math.atan2(dz, dx) + (2 * Math.PI * elapsedSeconds) / periodSeconds;
  return {
    x: center.x + radius * Math.cos(angle),
    y: base.y,
    z: center.z + radius * Math.sin(angle),
  };
}

export type FramingOptions = {
  /** Relación de aspecto del video (ancho / alto). */
  aspect: number;
  /** Zoom máximo: FOV vertical mínimo, en grados. */
  minFov: number;
  /** Zoom mínimo: FOV vertical máximo, en grados. */
  maxFov: number;
  /** FOV cuando no hay nadie a quien encuadrar. */
  idleFov: number;
  /** Aire alrededor de los sujetos (1 = justo al borde de la imagen). */
  margin: number;
};

const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/**
 * FOV vertical (grados) para que todos los `subjects` quepan en la imagen de una cámara
 * ubicada en `camera` que mira hacia `aim`. Mientras más juntos están los peleadores,
 * menor el FOV: la cámara hace zoom sobre el intercambio de golpes.
 *
 * Proyecta cada punto sobre los ejes derecha/arriba de la cámara y pide el mayor de los
 * ángulos necesarios, convirtiendo el horizontal a vertical con la relación de aspecto.
 */
export function framingFov(camera: Vec, aim: Vec, subjects: readonly Vec[], options: FramingOptions): number {
  if (subjects.length === 0) return options.idleFov;

  // Base de la cámara: forward hacia el objetivo, right horizontal, up perpendicular.
  let fx = aim.x - camera.x;
  let fy = aim.y - camera.y;
  let fz = aim.z - camera.z;
  const fLen = Math.hypot(fx, fy, fz);
  if (fLen === 0) return options.idleFov;
  fx /= fLen;
  fy /= fLen;
  fz /= fLen;
  // right = forward × (0,1,0)
  let rx = -fz;
  let rz = fx;
  const rLen = Math.hypot(rx, rz);
  if (rLen === 0) return options.idleFov; // cámara mirando recto hacia abajo
  rx /= rLen;
  rz /= rLen;
  // up = right × forward
  const ux = -rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;

  let needTan = 0;
  for (const s of subjects) {
    const dx = s.x - camera.x;
    const dy = s.y - camera.y;
    const dz = s.z - camera.z;
    const depth = dx * fx + dy * fy + dz * fz;
    if (depth <= 0.1) return options.maxFov; // detrás o encima de la cámara
    const horizontal = Math.abs(dx * rx + dz * rz) / depth;
    const vertical = Math.abs(dx * ux + dy * uy + dz * uz) / depth;
    needTan = Math.max(needTan, vertical, horizontal / options.aspect);
  }
  const fov = 2 * toDegrees(Math.atan(needTan * options.margin));
  return Math.min(options.maxFov, Math.max(options.minFov, fov));
}

/** Igual que `smoothToward`, para un solo número (se usa con el FOV). */
export function smoothScalar(current: number, target: number, dtSeconds: number, tauSeconds: number): number {
  if (tauSeconds <= 0) return target;
  if (dtSeconds <= 0) return current;
  return current + (target - current) * (1 - Math.exp(-dtSeconds / tauSeconds));
}

// ---------- Modo "cliente real": la cámara es un bot que vuela ----------
//
// En ese modo quien dibuja es el cliente real de Minecraft, montado (/spectate) en el bot
// cámara. El servidor reenvía la ROTACIÓN de una entidad con 1 byte por eje (pasos de
// 1,4°), pero su POSICIÓN con mucha precisión. Por eso la cámara mantiene una dirección
// fija y encuadra TRASLADÁNDOSE: se desliza para seguir la pelea y se acerca o aleja para
// hacer zoom. Girar se vería a saltos.

/** Pasos por vuelta con los que el protocolo de Minecraft transmite un ángulo de entidad. */
export const ANGLE_STEPS = 256;

/** Redondea un ángulo (radianes) al valor más cercano que el protocolo puede transmitir. */
export function quantizeAngle(radians: number): number {
  const step = (2 * Math.PI) / ANGLE_STEPS;
  return Math.round(radians / step) * step;
}

/**
 * Ángulos con la convención de mineflayer para mirar desde `from` hacia `to`:
 * yaw 0 = hacia -z (norte), crece hacia -x; pitch positivo = hacia arriba.
 */
export function lookAngles(from: Vec, to: Vec): { yaw: number; pitch: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** Vector unitario hacia donde mira una cámara con esos ángulos (inversa de `lookAngles`). */
export function lookDirection(yaw: number, pitch: number): Vec {
  const flat = Math.cos(pitch);
  return { x: -Math.sin(yaw) * flat, y: Math.sin(pitch), z: -Math.cos(yaw) * flat };
}

export type DollyOptions = {
  /** Relación de aspecto del video (ancho / alto). */
  aspect: number;
  /** FOV vertical FIJO del cliente de Minecraft, en grados. */
  lensFov: number;
  /** Aire alrededor de los sujetos (1 = justo al borde de la imagen). */
  margin: number;
  /** Lo más cerca que la cámara se pone del punto al que mira (zoom máximo). */
  minDistance: number;
  /** Lo más lejos (zoom mínimo). */
  maxDistance: number;
  /** Distancia cuando no hay nadie a quien encuadrar: se ve toda la arena. */
  idleDistance: number;
};

/**
 * Distancia a la que debe ponerse una cámara de lente fijo, que mira hacia `aim` en la
 * dirección `direction` (unitaria), para que todos los `subjects` quepan en la imagen.
 * Es el equivalente a `framingFov` cuando no se puede cambiar el FOV: en vez de cerrar
 * el lente, la cámara se acerca.
 */
export function framingDistance(aim: Vec, direction: Vec, subjects: readonly Vec[], options: DollyOptions): number {
  if (subjects.length === 0) return options.idleDistance;
  // right = direction × (0,1,0)
  let rx = -direction.z;
  let rz = direction.x;
  const rLen = Math.hypot(rx, rz);
  if (rLen === 0) return options.idleDistance; // cámara mirando recto hacia abajo
  rx /= rLen;
  rz /= rLen;
  // up = right × direction
  const ux = -rz * direction.y;
  const uy = rz * direction.x - rx * direction.z;
  const uz = rx * direction.y;

  const tanV = Math.tan((options.lensFov * Math.PI) / 360) / options.margin;
  const tanH = tanV * options.aspect;
  let need = options.minDistance;
  for (const s of subjects) {
    const ox = s.x - aim.x;
    const oy = s.y - aim.y;
    const oz = s.z - aim.z;
    // Profundidad del sujeto respecto al punto de mira: si está más cerca de la cámara
    // que `aim` (ahead < 0), la cámara tiene que alejarse más para que quepa.
    const ahead = ox * direction.x + oy * direction.y + oz * direction.z;
    const horizontal = Math.abs(ox * rx + oz * rz);
    const vertical = Math.abs(ox * ux + oy * uy + oz * uz);
    need = Math.max(need, horizontal / tanH - ahead, vertical / tanV - ahead);
  }
  return Math.min(options.maxDistance, Math.max(options.minDistance, need));
}

/** Posición del ojo de una cámara que mira hacia `aim` en `direction`, a `distance` bloques. */
export function eyePosition(aim: Vec, direction: Vec, distance: number): Vec {
  return {
    x: aim.x - direction.x * distance,
    y: aim.y - direction.y * distance,
    z: aim.z - direction.z * distance,
  };
}
