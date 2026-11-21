import type { ConversationLine } from "./comms";
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
    /** Vida extra en corazones amarillos (ausente o 0 = no tiene). */
    absorption?: number;
  };
  /** null si el rival no está a la vista. */
  opponent: { position: Vec3Like; health: number | null } | null;
  arena: { center: Vec3Like; radius: number };
  currentAction: string;
  lastActionResult: string;
  /** Herramientas que siguen en cola después de la acción actual, en orden. */
  queuedActions?: string[];
  /** Epoch ms desde el que se puede lanzar otra perla (ausente o pasado = ya se puede). */
  pearlReadyAt?: number;
  /** Epoch ms desde el que se puede construir otro muro (ausente o pasado = ya se puede). */
  buildReadyAt?: number;
  /** Lo que se ve de los bloques alrededor (ver Observation). */
  terrain?: { height: number; blocksBetween: number; enclosed: boolean };
  /** Lo que llegó del rival desde la decisión anterior (modos "thoughts" y "chat"). */
  rivalThoughts?: string[];
  rivalMessages?: string[];
  /** Modo "chat": últimos mensajes entre los dos, el más viejo primero. */
  conversation?: ConversationLine[];
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
  /**
   * Herramientas que esperan su turno después de la acción actual, en orden (las que
   * quedan de una respuesta que llamó varias). Solo aparece si queda alguna.
   */
  queuedActions?: string[];
  /** Segundos que faltan para poder lanzar otra perla. Solo aparece mientras hay recarga. */
  pearlCooldown?: number;
  /** Segundos que faltan para poder construir otro muro. Solo aparece mientras hay recarga. */
  buildCooldown?: number;
  /** Altura de tus pies sobre el piso de la arena. Solo aparece si estás arriba de algo. */
  height?: number;
  /** Bloques colocados en la línea recta entre tú y el rival. Solo aparece si hay alguno. */
  blocksBetween?: number;
  /** true si tienes bloques a los cuatro lados (estás encerrado). Solo aparece en ese caso. */
  enclosed?: boolean;
  /** Modo "thoughts": razonamientos del rival desde tu decisión anterior (el más nuevo al final). */
  rivalThoughts?: string[];
  /** Modo "chat": mensajes que te mandó el rival desde tu decisión anterior (el más nuevo al final). */
  rivalMessages?: string[];
  /**
   * Modo "chat": los últimos mensajes que se mandaron los dos ("tú" = este agente), el más
   * viejo primero. El historial de turnos que ve el LLM es corto; esto no se pierde con él.
   */
  conversation?: ConversationLine[];
  /**
   * Vida extra en corazones amarillos (la da la manzana dorada y no cuenta en `health`).
   * Solo aparece mientras queda alguna: comer otra manzana no la suma, solo la renueva.
   */
  absorption?: number;
};

function roundVec(v: Vec3Like): Vec3Like {
  return { x: round1(v.x), y: round1(v.y), z: round1(v.z) };
}

/** Segundos (un decimal) que faltan para `readyAt`; 0 si ya pasó o no hay recarga. */
function cooldownSeconds(readyAt: number | undefined, now: number): number {
  if (readyAt === undefined || !Number.isFinite(readyAt)) return 0;
  return Math.max(0, round1((readyAt - now) / 1000));
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
  const pearlCooldown = cooldownSeconds(input.pearlReadyAt, input.now);
  const buildCooldown = cooldownSeconds(input.buildReadyAt, input.now);
  const observation: Observation = {
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
  // Las recargas solo se mandan mientras corren: la observación se repite varias veces en
  // el historial y conviene que sea corta.
  if (input.queuedActions && input.queuedActions.length > 0) observation.queuedActions = [...input.queuedActions];
  if (pearlCooldown > 0) observation.pearlCooldown = pearlCooldown;
  if (buildCooldown > 0) observation.buildCooldown = buildCooldown;
  // Lo del terreno, igual: solo cuando dice algo (casi siempre estás en el piso, sin bloques cerca).
  const terrain = input.terrain;
  if (terrain) {
    if (terrain.height >= 0.5) observation.height = round1(terrain.height);
    if (terrain.blocksBetween > 0) observation.blocksBetween = terrain.blocksBetween;
    if (terrain.enclosed) observation.enclosed = true;
  }
  // Igual que las recargas: solo aparecen cuando traen algo nuevo.
  if (input.rivalThoughts && input.rivalThoughts.length > 0) observation.rivalThoughts = [...input.rivalThoughts];
  if (input.rivalMessages && input.rivalMessages.length > 0) observation.rivalMessages = [...input.rivalMessages];
  if (input.conversation && input.conversation.length > 0) {
    observation.conversation = input.conversation.map((line) => ({ ...line }));
  }
  // Igual con los corazones amarillos: solo los tiene quien acaba de comer una manzana dorada.
  const absorption = self.absorption;
  if (absorption !== undefined && Number.isFinite(absorption) && absorption > 0) {
    // Nunca 0 mientras quede algo, para que "aparece el campo" siempre signifique "tienes".
    observation.absorption = Math.max(0.1, round1(absorption));
  }
  return observation;
}
