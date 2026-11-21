import {
  AGENT_USERNAMES,
  MatchStateSchema,
  availableArenaScenarios,
  arenaFor,
  type ArenaPoint,
  type ArenaScenario,
  type ArenaScenarioId,
} from "@phack/protocol";

/**
 * Mapa que está mirando la cámara. El escenario es por pelea (la web o el torneo eligen
 * Platanus o Chunk Battle, que viven en el mismo mundo en lugares distintos), así que la
 * cámara se entera del mapa de la pelea en curso y se reencuadra:
 *  1. por el orquestador (GET /api/state trae `arena`), que lo sabe desde "preparing";
 *  2. si el orquestador no tiene pelea (p. ej. la corre el CLI del torneo, que no pasa por
 *     él) o no responde, por dónde están los peleadores, preguntando por RCON.
 * Hasta saber algo, el de ARENA_SCENARIO (el por defecto del servidor).
 */

let current: ArenaScenario | null = null;

/** Escenario por defecto del servidor. Se lee al usarse: así ya está aplicado el `.env`. */
export function defaultArena(): ArenaScenario {
  return arenaFor(process.env.ARENA_SCENARIO);
}

/** Mapa que debe encuadrar la cámara ahora. */
export function currentArena(): ArenaScenario {
  current ??= defaultArena();
  return current;
}

/** Cambia el mapa de la cámara; true si cambió. */
export function setCurrentArena(id: ArenaScenarioId): boolean {
  if (currentArena().id === id) return false;
  current = arenaFor(id);
  return true;
}

/** Caja en planta (inclusiva, con margen) que ocupa un escenario. */
export function arenaBox(arena: ArenaScenario, pad = 4): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (arena.kind === "built") {
    const { center: c, floor } = arena;
    return { minX: c.x - floor.halfX - pad, maxX: c.x + floor.halfX + pad, minZ: c.z - floor.halfZ - pad, maxZ: c.z + floor.halfZ + pad };
  }
  if (arena.kind === "islands") {
    const { from, to } = arena.clearBox;
    return { minX: from.x - pad, maxX: to.x + pad, minZ: from.z - pad, maxZ: to.z + pad };
  }
  const { center: c, radius } = arena;
  return { minX: c.x - radius - pad, maxX: c.x + radius + pad, minZ: c.z - radius - pad, maxZ: c.z + radius + pad };
}

/** Cuál de los escenarios `candidates` contiene ese punto (en planta), o null. */
export function arenaAt(point: { x: number; z: number }, candidates: readonly ArenaScenarioId[]): ArenaScenarioId | null {
  for (const id of candidates) {
    const b = arenaBox(arenaFor(id));
    if (point.x >= b.minX && point.x <= b.maxX && point.z >= b.minZ && point.z <= b.maxZ) return id;
  }
  return null;
}

/** Lo que dice el orquestador: fase y mapa de la pelea en curso (o de la última). */
export type OrchestratorView = { phase: string; scenario: ArenaScenarioId };

/** Lee la respuesta de GET /api/state; null si no tiene la forma esperada. */
export function orchestratorView(body: unknown): OrchestratorView | null {
  const parsed = MatchStateSchema.safeParse(body);
  return parsed.success ? { phase: parsed.data.phase, scenario: parsed.data.arena } : null;
}

/**
 * Posición de `data get entity <jugador> Pos`:
 * `AgenteRojo has the following entity data: [1000.5d, 65.0d, 0.5d]`. null si no está.
 */
export function parseEntityPos(reply: string): ArenaPoint | null {
  const match = /\[\s*(-?[\d.]+(?:E-?\d+)?)d,\s*(-?[\d.]+(?:E-?\d+)?)d,\s*(-?[\d.]+(?:E-?\d+)?)d\s*\]/i.exec(reply);
  if (!match) return null;
  const [x, y, z] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

/**
 * true si el orquestador tiene una pelea en curso. "finished" no cuenta: tras una pelea de
 * la web el orquestador se queda ahí, y entretanto el CLI del torneo puede pelear en otro mapa.
 */
function fightInProgress(view: OrchestratorView): boolean {
  return view.phase === "preparing" || view.phase === "running";
}

/**
 * Decide el mapa a encuadrar:
 *  - con pelea en curso en el orquestador (preparing/running), el suyo;
 *  - si no, el de un peleador que esté dentro de algún mapa (pelea del torneo por CLI);
 *  - si no, el que informa el orquestador en reposo (el de la última pelea);
 *  - si no se sabe nada, null (se deja el actual).
 */
export function pickScenario(
  view: OrchestratorView | null,
  fighters: readonly (ArenaPoint | null)[],
  candidates: readonly ArenaScenarioId[],
): ArenaScenarioId | null {
  const known = (id: ArenaScenarioId): ArenaScenarioId | null => (candidates.includes(id) ? id : null);
  if (view && fightInProgress(view)) return known(view.scenario);
  for (const point of fighters) {
    const id = point ? arenaAt(point, candidates) : null;
    if (id) return id;
  }
  return view ? known(view.scenario) : null;
}

export type ArenaTrackerDeps = {
  /** URL base del orquestador (sin /api). */
  orchestratorUrl: string;
  /** Manda comandos por RCON y devuelve las respuestas en orden. */
  rcon: (commands: readonly string[]) => Promise<string[]>;
  /** Se llama cuando cambia el mapa (ya aplicado en currentArena()). */
  onChange: (arena: ArenaScenario) => void;
  log: (level: "info" | "warn", text: string) => void;
  intervalMs?: number;
  fetchFn?: typeof fetch;
};

const STATE_TIMEOUT_MS = 2_000;

async function fetchView(deps: ArenaTrackerDeps): Promise<OrchestratorView | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`${deps.orchestratorUrl.replace(/\/+$/, "")}/api/state`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(STATE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return orchestratorView(await res.json());
  } catch {
    return null;
  }
}

async function fighterPositions(deps: ArenaTrackerDeps): Promise<(ArenaPoint | null)[]> {
  try {
    const replies = await deps.rcon([AGENT_USERNAMES.red, AGENT_USERNAMES.blue].map((u) => `data get entity ${u} Pos`));
    return replies.map(parseEntityPos);
  } catch {
    return [];
  }
}

/** Una vuelta del seguimiento: consulta, decide y aplica. Devuelve el mapa elegido (o null). */
export async function trackOnce(deps: ArenaTrackerDeps): Promise<ArenaScenarioId | null> {
  const candidates = availableArenaScenarios(defaultArena().id);
  if (candidates.length < 2) return null;
  const view = await fetchView(deps);
  // Solo se pregunta por RCON si el orquestador no tiene una pelea en curso.
  const fighters = view && fightInProgress(view) ? [] : await fighterPositions(deps);
  const id = pickScenario(view, fighters, candidates);
  if (id && setCurrentArena(id)) {
    const arena = currentArena();
    deps.log("info", `Mapa de la pelea: ${arena.name}. Reencuadrando la cámara.`);
    deps.onChange(arena);
  }
  return id;
}

/**
 * Sigue el mapa de la pelea en curso mientras viva el proceso. Con un servidor que solo
 * tiene un mapa posible (la pizza) no hace nada.
 */
export function startArenaTracking(deps: ArenaTrackerDeps): void {
  if (availableArenaScenarios(defaultArena().id).length < 2) return;
  const interval = deps.intervalMs ?? 2_000;
  let warned = false;
  const loop = async (): Promise<void> => {
    try {
      await trackOnce(deps);
      warned = false;
    } catch (err) {
      if (!warned) deps.log("warn", `No se pudo averiguar el mapa de la pelea: ${String(err)}`);
      warned = true;
    }
    setTimeout(() => void loop(), interval);
  };
  void loop();
}
