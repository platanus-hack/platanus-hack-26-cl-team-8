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
