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
// cámara: lo que se ve es lo que "ve" el bot.

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

export type CameraPose = { eye: Vec; yaw: number; pitch: number };

/**
 * Pose de una cámara parada en `position` que mira hacia `aim`, lista para un bot.
 *
 * El servidor reenvía la rotación de una entidad con 1 byte por eje (pasos de 1,4°), así
 * que el giro exacto no se puede transmitir. Se usa el ángulo transmisible más cercano y
 * se corre el ojo lo justo (unos centímetros) para que `aim` quede igual en el centro de
 * la imagen: la cámara sigue a su objetivo sin los saltitos del redondeo.
 */
export function cameraPose(position: Vec, aim: Vec): CameraPose {
  const angles = lookAngles(position, aim);
  const yaw = quantizeAngle(angles.yaw);
  const pitch = quantizeAngle(angles.pitch);
  const direction = lookDirection(yaw, pitch);
  const distance = Math.hypot(aim.x - position.x, aim.y - position.y, aim.z - position.z);
  return {
    eye: {
      x: aim.x - direction.x * distance,
      y: aim.y - direction.y * distance,
      z: aim.z - direction.z * distance,
    },
    yaw,
    pitch,
  };
}

export type Shot = "follow" | "wide";

/**
 * Qué cámara está al aire. Sin pelea, la general ("wide", estática desde arriba). Con
 * pelea se alternan: `followSeconds` de la que sigue a los peleadores y `wideSeconds` de
 * la general, partiendo por la que sigue. Con `wideSeconds` <= 0 nunca se corta a la
 * general durante la pelea; con `followSeconds` <= 0 siempre se muestra la general.
 */
export function pickShot(fighting: boolean, fightSeconds: number, followSeconds: number, wideSeconds: number): Shot {
  if (!fighting || followSeconds <= 0) return "wide";
  if (wideSeconds <= 0) return "follow";
  return fightSeconds % (followSeconds + wideSeconds) < followSeconds ? "follow" : "wide";
}
