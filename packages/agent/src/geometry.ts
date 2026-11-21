/**
 * Matemática pura de la arena (sin mineflayer): distancias, límites y punto de retirada.
 */

export type Vec3Like = { x: number; y: number; z: number };

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Distancia horizontal (plano XZ). */
export function distanceXZ(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function distance3(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Devuelve el punto más cercano a `point` que queda dentro del círculo (plano XZ)
 * de radio `maxRadius` alrededor de `center`. Conserva la `y` del punto.
 */
export function clampToArena(point: Vec3Like, center: Vec3Like, maxRadius: number): Vec3Like {
  const dx = point.x - center.x;
  const dz = point.z - center.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= maxRadius || dist === 0) return { x: point.x, y: point.y, z: point.z };
  const scale = maxRadius / dist;
  return { x: center.x + dx * scale, y: point.y, z: center.z + dz * scale };
}

/** Bloques que faltan hasta el muro (0 si ya está en el borde o fuera). */
export function distanceToWall(point: Vec3Like, center: Vec3Like, radius: number): number {
  return Math.max(0, radius - distanceXZ(point, center));
}

export type RetreatInput = {
  self: Vec3Like;
  opponent: Vec3Like;
  center: Vec3Like;
  /** Radio interior de la arena. */
  radius: number;
  /** Distancia que se deja libre respecto del muro. */
  margin?: number;
  /** Cuántos bloques intentar alejarse en línea recta. */
  step?: number;
};

/**
 * Punto hacia el que hay que caminar para alejarse del rival sin salir de la arena.
 * Si estamos acorralados contra el muro, se desliza por el borde hacia el lado
 * que queda más lejos del rival.
 */
export function retreatTarget(input: RetreatInput): Vec3Like {
  const { self, opponent, center, radius } = input;
  const margin = input.margin ?? 1.5;
  const step = input.step ?? 8;
  const maxRadius = Math.max(1, radius - margin);

  let dx = self.x - opponent.x;
  let dz = self.z - opponent.z;
  let len = Math.hypot(dx, dz);
  if (len < 1e-6) {
    // Encima del rival: alejarse del centro.
    dx = self.x - center.x;
    dz = self.z - center.z;
    len = Math.hypot(dx, dz);
  }
  if (len < 1e-6) {
    dx = 1;
    dz = 0;
    len = 1;
  }
  dx /= len;
  dz /= len;

  const straight = clampToArena({ x: self.x + dx * step, y: self.y, z: self.z + dz * step }, center, maxRadius);
  if (distanceXZ(straight, self) >= 2) return straight;

  // Acorralado: probar dos puntos sobre el borde, a cada lado, y elegir el más lejano del rival.
  const selfAngle = Math.atan2(self.z - center.z, self.x - center.x);
  const sweep = (75 * Math.PI) / 180;
  const left: Vec3Like = {
    x: center.x + Math.cos(selfAngle + sweep) * maxRadius,
    y: self.y,
    z: center.z + Math.sin(selfAngle + sweep) * maxRadius,
  };
  const right: Vec3Like = {
    x: center.x + Math.cos(selfAngle - sweep) * maxRadius,
    y: self.y,
    z: center.z + Math.sin(selfAngle - sweep) * maxRadius,
  };
  return distanceXZ(left, opponent) >= distanceXZ(right, opponent) ? left : right;
}
