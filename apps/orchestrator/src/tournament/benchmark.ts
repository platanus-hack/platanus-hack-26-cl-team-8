/**
 * Versión del benchmark: un id que cambia si cambia cualquier cosa que afecte cómo se
 * juega (prompt fijo, tools del agente, escenario, duración o tick). Se congela al crear
 * el torneo y se compara al reanudar.
 */
import { createHash } from "node:crypto";
import { TOOL_DEFS } from "@phack/agent";
import { ARENAS, BENCHMARK_PROMPT, type ArenaScenarioId, type BenchmarkVersion } from "@phack/protocol";
import { loadChunkBattleMetadata } from "../chunkbattle";

/**
 * Generación del benchmark: se sube a mano cuando cambian las reglas de forma que el hash
 * no alcanza a reflejar. v2 = mapa por partida (Platanus o Chunk Battle, en el mismo
 * mundo), con la semilla de la partida decidiendo las islas y, en Chunk Battle, bloques y
 * pico de más en el kit para cruzar el hueco con build/dig.
 */
export const BENCHMARK_GENERATION = "v2";

/** Duración fija de las peleas del benchmark (s). */
export const BENCHMARK_MATCH_SECONDS = 60;

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** sha256 en hex (completo) de un texto: para el catálogo congelado. */
export function sha256(text: string): string {
  return sha(text);
}

/**
 * Arma la versión del benchmark con el código actual. `tools` se puede inyectar en tests.
 * El hash del prompt incluye la geometría del escenario (el prompt de sistema la usa) y,
 * en Chunk Battle, los metadatos de las islas (temas y spawns que sortea la semilla).
 */
export function benchmarkVersion(
  scenario: string,
  matchSeconds: number,
  tickMs: number,
  tools: unknown = TOOL_DEFS,
): BenchmarkVersion {
  const arena = (ARENAS as Record<string, (typeof ARENAS)[ArenaScenarioId] | undefined>)[scenario] ?? null;
  const islands = arena?.kind === "islands" ? loadChunkBattleMetadata() : null;
  const promptHash = sha(JSON.stringify({ prompt: BENCHMARK_PROMPT, arena, ...(islands ? { islands } : {}) })).slice(0, 12);
  const toolsHash = sha(JSON.stringify(tools)).slice(0, 12);
  const all = sha(JSON.stringify({ scenario, matchSeconds, tickMs, promptHash, toolsHash })).slice(0, 12);
  return { id: `pvp-${scenario}-${BENCHMARK_GENERATION}+${all}`, scenario, matchSeconds, tickMs, promptHash, toolsHash };
}

/** null si coinciden; si no, un texto que dice qué cambió. */
export function benchmarkMismatch(frozen: BenchmarkVersion, current: BenchmarkVersion): string | null {
  if (frozen.id === current.id) return null;
  const changes: string[] = [];
  if (frozen.promptHash !== current.promptHash) changes.push("prompt o escenario");
  if (frozen.toolsHash !== current.toolsHash) changes.push("tools del agente");
  if (frozen.matchSeconds !== current.matchSeconds) changes.push("duración");
  if (frozen.tickMs !== current.tickMs) changes.push("tick");
  if (frozen.scenario !== current.scenario) changes.push("escenario");
  return (
    `El benchmark cambió desde que se creó el torneo (congelado ${frozen.id}, actual ${current.id}` +
    `${changes.length > 0 ? `: cambió ${changes.join(", ")}` : ""}). ` +
    "Un torneo solo se reanuda con exactamente el mismo benchmark: crea uno nuevo."
  );
}
