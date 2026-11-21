import { arenaFor, type ArenaScenario } from "@phack/protocol";

/**
 * Escenario activo (ARENA_SCENARIO, el mismo que usa el orquestador). Se lee al usarse y no
 * al importar el módulo: así ya está aplicado el `.env` que carga loadConfig().
 */
export function activeArena(): ArenaScenario {
  return arenaFor(process.env.ARENA_SCENARIO);
}
