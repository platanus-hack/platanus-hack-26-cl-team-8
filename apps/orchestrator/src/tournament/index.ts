/**
 * Torneo de modelos: lectura para la API del orquestador y reexportaciones de los módulos.
 * El torneo corre como proceso aparte (cli.ts); el servidor solo lee DATA_DIR/tournaments.
 */
import type { MatchAttempt, TournamentReport, TournamentSummary } from "@phack/protocol";
import { buildReport, pairAttempts, summarize } from "./report";
import { FileTournamentStore, isValidTournamentId, readLiveLock, type LockInfo } from "./store";

export * from "./types";
export * from "./store";
export * from "./report";
export * from "./runner";
export * from "./sim";
export * from "./benchmark";

/** Lo que la API necesita del torneo (fácil de falsear en tests). */
export type TournamentReader = {
  list(): Promise<TournamentSummary[]>;
  /** null si no existe. */
  report(id: string): Promise<TournamentReport | null>;
  /** Intentos de la pareja (cualquier orden de a/b); null si el torneo no existe. */
  pair(id: string, a: string, b: string): Promise<MatchAttempt[] | null>;
  /** Lock de un `pnpm tournament run` vivo, o null. */
  lock(): Promise<LockInfo | null>;
};

/** Lector sobre DATA_DIR con caché del reporte (se invalida si cambian attempts o state). */
export function createTournamentReader(dataDir: string): TournamentReader {
  const store = new FileTournamentStore(dataDir);
  const cache = new Map<string, { version: string; report: TournamentReport }>();

  return {
    async list() {
      const configs = await store.list();
      const out: TournamentSummary[] = [];
      for (const config of configs) {
        out.push(summarize(config, await store.attempts(config.id), await store.loadState(config.id)));
      }
      return out;
    },
    async report(id) {
      if (!(await store.exists(id))) return null;
      const version = await store.version(id);
      const hit = cache.get(id);
      if (hit && hit.version === version) return hit.report;
      const report = buildReport(await store.load(id), await store.attempts(id), await store.loadState(id));
      cache.set(id, { version, report });
      return report;
    },
    async pair(id, a, b) {
      if (!isValidTournamentId(id) || !(await store.exists(id))) return null;
      return pairAttempts(await store.attempts(id), a, b);
    },
    lock: () => readLiveLock(dataDir),
  };
}
