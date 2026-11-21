/**
 * Movimiento táctico: hacia qué punto caminar para esquivar de lado, rodear al rival,
 * mantener una distancia o ir a un lugar de la arena. Matemática pura (sin mineflayer):
 * el cuerpo llama a estas funciones cada vez que vuelve a planear el camino.
 */
import { clampToArena, distanceXZ, type Vec3Like } from "./geometry";

export type ArenaShape = { center: Vec3Like; radius: number };

/** Lugares a los que se puede ir con move "goto". */
export const MOVE_PLACES = ["center", "far_corner", "behind_rival"] as const;
export type MovePlace = (typeof MOVE_PLACES)[number];

/** Distancia que se deja libre respecto de los muros al elegir un punto. */
const WALL_MARGIN = 1.5;

function clamp(point: Vec3Like, arena: ArenaShape): Vec3Like {
  return clampToArena(point, arena.center, Math.max(1, arena.radius - WALL_MARGIN));
}

/** Vector horizontal unitario de `from` a `to`; (1, 0) si están en el mismo punto. */
function unit(from: Vec3Like, to: Vec3Like): { x: number; z: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  return len === 0 ? { x: 1, z: 0 } : { x: dx / len, z: dz / len };
}

/**
 * Esquivar de lado: un paso perpendicular a la línea hacia el rival (`side` 1 = a su
 * izquierda, -1 = a su derecha). Si ese lado choca con el muro, el otro.
 */
export function strafeTarget(self: Vec3Like, opponent: Vec3Like, side: 1 | -1, arena: ArenaShape, step = 3): Vec3Like {
  const toRival = unit(self, opponent);
  const pick = (s: number): Vec3Like => ({ x: self.x - toRival.z * step * s, y: self.y, z: self.z + toRival.x * step * s });
  const wanted = pick(side);
  const clamped = clamp(wanted, arena);
  // Contra el muro el paso queda corto: mejor esquivar hacia el otro lado.
  if (distanceXZ(clamped, self) < step * 0.5) return clamp(pick(-side), arena);
  return clamped;
}

/**
 * Rodear al rival: el siguiente punto de un círculo a su alrededor, a la distancia actual
 * (entre 3 y 8 bloques), avanzando `angleStep` radianes en el sentido `side`.
 */
export function orbitTarget(self: Vec3Like, opponent: Vec3Like, side: 1 | -1, arena: ArenaShape, angleStep = 0.7): Vec3Like {
  const radius = Math.min(8, Math.max(3, distanceXZ(self, opponent)));
  const angle = Math.atan2(self.z - opponent.z, self.x - opponent.x) + angleStep * side;
  return clamp({ x: opponent.x + Math.cos(angle) * radius, y: self.y, z: opponent.z + Math.sin(angle) * radius }, arena);
}

/**
 * Mantener la distancia: el punto sobre la recta rival→uno que queda a `distance` del
 * rival. null si ya se está a esa distancia (±1 bloque): ahí conviene esquivar de lado.
 */
export function keepDistanceTarget(self: Vec3Like, opponent: Vec3Like, distance: number, arena: ArenaShape): Vec3Like | null {
  const current = distanceXZ(self, opponent);
  if (Math.abs(current - distance) <= 1) return null;
  const away = unit(opponent, self);
  return clamp({ x: opponent.x + away.x * distance, y: self.y, z: opponent.z + away.z * distance }, arena);
}

/** Punto de un lugar de la arena: el centro, la esquina más lejos del rival o detrás de él. */
export function placeTarget(place: MovePlace, self: Vec3Like, opponent: Vec3Like | null, arena: ArenaShape): Vec3Like {
  const { center, radius } = arena;
  switch (place) {
    case "center":
      return { x: center.x, y: self.y, z: center.z };
    case "far_corner": {
      // Las esquinas (con margen) de la arena cuadrada; sin rival a la vista, la más lejana a uno.
      const reach = radius - WALL_MARGIN - 0.5;
      const corners: Vec3Like[] = [-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => ({ x: center.x + sx * reach, y: self.y, z: center.z + sz * reach })),
      );
      const from = opponent ?? self;
      return corners.reduce((best, corner) => (distanceXZ(corner, from) > distanceXZ(best, from) ? corner : best));
    }
    case "behind_rival": {
      if (!opponent) return { x: center.x, y: self.y, z: center.z };
      const through = unit(self, opponent);
      return clamp({ x: opponent.x + through.x * 3, y: self.y, z: opponent.z + through.z * 3 }, arena);
    }
  }
}
