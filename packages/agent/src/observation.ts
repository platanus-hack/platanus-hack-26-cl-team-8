import { distance3, distanceToWall, round1, type Vec3Like } from "./geometry";

export type ObservationInput = {
  /** Epoch ms actual. */
  now: number;
  /** Epoch ms en que partió el bucle de decisiones. */
  startedAt: number;
  self: {
    position: Vec3Like;
    health: number;
    food: number;
    heldItem: string | null;
    inventory: { name: string; count: number }[];
  };
  /** null si el rival no está a la vista. */
  opponent: { position: Vec3Like; health: number | null } | null;
  arena: { center: Vec3Like; radius: number };
  currentAction: string;
  lastActionResult: string;
};

/**
 * Lo que ve el LLM en cada decisión. Se serializa con JSON.stringify como último
 * mensaje "user". Los campos distance / health / opponentHealth son contrato
 * (el LLM de prueba "mock" depende de ellos).
 */
export type Observation = {
  secondsElapsed: number;
  health: number;
  food: number;
  position: Vec3Like;
  opponentVisible: boolean;
  distance: number | null;
  opponentHealth: number | null;
  /** Posición del rival relativa a la propia (rival - yo). */
  opponentRelative: Vec3Like | null;
  distanceToWall: number;
  heldItem: string | null;
  inventory: Record<string, number>;
  currentAction: string;
  lastActionResult: string;
};

function roundVec(v: Vec3Like): Vec3Like {
  return { x: round1(v.x), y: round1(v.y), z: round1(v.z) };
}

export function summarizeInventory(items: { name: string; count: number }[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const item of items) {
    summary[item.name] = (summary[item.name] ?? 0) + item.count;
  }
  return summary;
}

export function buildObservation(input: ObservationInput): Observation {
  const { self, opponent, arena } = input;
  return {
    secondsElapsed: Math.max(0, Math.round((input.now - input.startedAt) / 1000)),
    health: round1(self.health),
    food: round1(self.food),
    position: roundVec(self.position),
    opponentVisible: opponent !== null,
    distance: opponent ? round1(distance3(self.position, opponent.position)) : null,
    opponentHealth: opponent && opponent.health !== null ? round1(opponent.health) : null,
    opponentRelative: opponent
      ? roundVec({
          x: opponent.position.x - self.position.x,
          y: opponent.position.y - self.position.y,
          z: opponent.position.z - self.position.z,
        })
      : null,
    distanceToWall: round1(distanceToWall(self.position, arena.center, arena.radius)),
    heldItem: self.heldItem,
    inventory: summarizeInventory(self.inventory),
    currentAction: input.currentAction,
    lastActionResult: input.lastActionResult,
  };
}
