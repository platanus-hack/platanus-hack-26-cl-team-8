/**
 * Persistencia del torneo en DATA_DIR/tournaments/<id>/:
 *   tournament.json  configuración congelada (se escribe una sola vez)
 *   catalog.json     catálogo crudo tal como se descargó (su sha256 va en la config)
 *   attempts.jsonl   un intento por línea, append-only (reintentos = varias líneas por matchId)
 *   state.json       lo que decidió la corrida (liga congelada, rondas adaptativas, parada)
 *   PAUSE            si existe, la corrida termina la partida en curso y sale
 * Además DATA_DIR/tournaments/.lock = { pid, id, startedAt } mientras un `run` está vivo.
 */
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { MatchAttempt, TournamentConfig } from "@phack/protocol";
import type { RunnerState, TournamentStore } from "./types";

// ---------- Partes puras ----------

/** Ids de torneo: minúsculas, dígitos y guiones (van en rutas de archivo y de la API). */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function isValidTournamentId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** Interpreta attempts.jsonl: ignora líneas vacías o corruptas (p. ej. una escritura cortada). */
export function parseAttemptLines(raw: string): MatchAttempt[] {
  const out: MatchAttempt[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const data = JSON.parse(trimmed) as MatchAttempt;
      if (data && typeof data.matchId === "string" && (data.status === "valid" || data.status === "infra") && data.spec) {
        out.push(data);
      }
    } catch {
      // línea corrupta: se ignora
    }
  }
  return out;
}

/**
 * Por cada matchId cuenta el PRIMER intento "valid" (en orden de archivo); los "infra"
 * no cuentan nunca. El resultado sale ordenado por matchId para que nada dependa del
 * orden de las líneas.
 */
export function validAttempts(attempts: MatchAttempt[]): MatchAttempt[] {
  const byId = new Map<string, MatchAttempt>();
  for (const a of attempts) {
    if (a.status !== "valid" || byId.has(a.matchId)) continue;
    byId.set(a.matchId, a);
  }
  return [...byId.values()].sort((x, y) => (x.matchId < y.matchId ? -1 : x.matchId > y.matchId ? 1 : 0));
}

export function emptyState(): RunnerState {
  return { leagueModels: null, leagueSeeds: null, adaptiveRounds: [], stopReason: null, paused: false };
}

/** Error de "no existe ese torneo" (la API lo traduce a 404). */
export class TournamentNotFoundError extends Error {
  constructor(id: string) {
    super(`No existe el torneo "${id}"`);
    this.name = "TournamentNotFoundError";
  }
}

// ---------- Disco ----------

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Escribe completo o nada: archivo temporal + rename (atómico en el mismo disco). */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, text, "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export function tournamentsDir(dataDir: string): string {
  return join(dataDir, "tournaments");
}

export class FileTournamentStore implements TournamentStore {
  readonly root: string;
  /** Escrituras de attempts.jsonl en serie (concurrencia > 1 no intercala líneas). */
  private appendChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.root = tournamentsDir(dataDir);
  }

  dir(id: string): string {
    if (!isValidTournamentId(id)) throw new TournamentNotFoundError(id);
    return join(this.root, id);
  }

  async exists(id: string): Promise<boolean> {
    if (!isValidTournamentId(id)) return false;
    return (await readIfExists(join(this.dir(id), "tournament.json"))) !== null;
  }

  async create(config: TournamentConfig, catalogRaw: string): Promise<void> {
    if (!isValidTournamentId(config.id)) throw new Error(`Id de torneo inválido: "${config.id}"`);
    const dir = this.dir(config.id);
    await mkdir(this.root, { recursive: true });
    try {
      await mkdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Ya existe el torneo "${config.id}"`);
      throw err;
    }
    await writeAtomic(join(dir, "catalog.json"), catalogRaw);
    await writeFile(join(dir, "attempts.jsonl"), "", "utf8");
    await writeAtomic(join(dir, "state.json"), `${JSON.stringify(emptyState(), null, 2)}\n`);
    // tournament.json al final: un torneo a medio crear no aparece en list().
    await writeAtomic(join(dir, "tournament.json"), `${JSON.stringify(config, null, 2)}\n`);
  }

  async load(id: string): Promise<TournamentConfig> {
    const raw = await readIfExists(join(this.dir(id), "tournament.json"));
    if (raw === null) throw new TournamentNotFoundError(id);
    return JSON.parse(raw) as TournamentConfig;
  }

  async catalogRaw(id: string): Promise<string | null> {
    return readIfExists(join(this.dir(id), "catalog.json"));
  }

  /** Todos los torneos, el más reciente primero. Ignora carpetas sin tournament.json válido. */
  async list(): Promise<TournamentConfig[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const configs: TournamentConfig[] = [];
    for (const name of names) {
      if (!isValidTournamentId(name)) continue;
      try {
        configs.push(await this.load(name));
      } catch {
        // carpeta incompleta o corrupta: se ignora
      }
    }
    return configs.sort((x, y) => y.createdAt - x.createdAt || (x.id < y.id ? -1 : 1));
  }

  appendAttempt(id: string, attempt: MatchAttempt): Promise<void> {
    const file = join(this.dir(id), "attempts.jsonl");
    const line = `${JSON.stringify(attempt)}\n`;
    const next = this.appendChain.then(() => appendFile(file, line, "utf8"));
    this.appendChain = next.catch(() => {});
    return next;
  }

  async attempts(id: string): Promise<MatchAttempt[]> {
    const raw = await readIfExists(join(this.dir(id), "attempts.jsonl"));
    return raw === null ? [] : parseAttemptLines(raw);
  }

  async saveState(id: string, state: RunnerState): Promise<void> {
    await writeAtomic(join(this.dir(id), "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  }

  async loadState(id: string): Promise<RunnerState | null> {
    const raw = await readIfExists(join(this.dir(id), "state.json"));
    if (raw === null) return null;
    try {
      return { ...emptyState(), ...(JSON.parse(raw) as Partial<RunnerState>) };
    } catch {
      return null;
    }
  }

  /** Marca de cambios (para cachear el reporte): mtime y tamaño de attempts y state. */
  async version(id: string): Promise<string> {
    const parts: string[] = [];
    for (const file of ["attempts.jsonl", "state.json"]) {
      try {
        const s = await stat(join(this.dir(id), file));
        parts.push(`${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push("-");
      }
    }
    return parts.join("|");
  }

  // ---------- Pausa por archivo ----------

  pauseFile(id: string): string {
    return join(this.dir(id), "PAUSE");
  }

  async requestPause(id: string): Promise<void> {
    await writeFile(this.pauseFile(id), `${new Date().toISOString()}\n`, "utf8");
  }

  async clearPause(id: string): Promise<void> {
    await rm(this.pauseFile(id), { force: true });
  }

  async pauseRequested(id: string): Promise<boolean> {
    return (await readIfExists(this.pauseFile(id))) !== null;
  }
}

// ---------- Lock de proceso ----------

export type LockInfo = {
  pid: number;
  id: string;
  startedAt: number;
  /**
   * Máquina (hostname) del proceso. Un pid solo se puede comprobar en la misma máquina:
   * el orquestador en Docker no ve los pids del host. Locks viejos no lo traen.
   */
  host?: string;
};

export function lockFile(dataDir: string): string {
  return join(tournamentsDir(dataDir), ".lock");
}

/** true si existe un proceso con ese pid (EPERM = existe pero es de otro usuario). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * El lock si pertenece a un proceso vivo; null si no hay o quedó huérfano. Un lock de
 * otra máquina (otro hostname, p. ej. el CLI en el host y el orquestador en Docker) no se
 * puede comprobar y cuenta como vivo: si quedó huérfano, hay que borrar el archivo a mano
 * o volver a correr `run` en esa máquina.
 */
export async function readLiveLock(dataDir: string, alive: (pid: number) => boolean = isPidAlive): Promise<LockInfo | null> {
  const raw = await readIfExists(lockFile(dataDir)).catch(() => null);
  if (raw === null) return null;
  try {
    const info = JSON.parse(raw) as LockInfo;
    if (typeof info.host === "string" && info.host !== hostname()) return info;
    return alive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

export class TournamentLockedError extends Error {
  constructor(readonly holder: LockInfo) {
    const where = holder.host && holder.host !== hostname() ? ` en ${holder.host}` : "";
    super(
      `Ya hay un torneo corriendo ("${holder.id}", pid ${holder.pid}${where}); páusalo o espera a que termine` +
        (where ? ` (si ese proceso ya no existe, borra el archivo .lock de DATA_DIR/tournaments)` : ""),
    );
    this.name = "TournamentLockedError";
  }
}

/**
 * Toma el lock de forma exclusiva (open "wx"). Un lock de un pid muerto se reemplaza.
 * Devuelve la función que lo suelta (solo borra el archivo si sigue siendo nuestro).
 */
export async function acquireLock(
  dataDir: string,
  id: string,
  alive: (pid: number) => boolean = isPidAlive,
): Promise<() => Promise<void>> {
  const file = lockFile(dataDir);
  await mkdir(tournamentsDir(dataDir), { recursive: true });
  const info: LockInfo = { pid: process.pid, id, startedAt: Date.now(), host: hostname() };
  for (let tries = 0; tries < 3; tries++) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(JSON.stringify(info), "utf8");
      await handle.close();
      return async () => {
        const current = await readIfExists(file).catch(() => null);
        try {
          if (current && (JSON.parse(current) as LockInfo).pid === info.pid) await unlink(file);
        } catch {
          // ya no está
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await readLiveLock(dataDir, alive);
      if (holder) throw new TournamentLockedError(holder);
      await rm(file, { force: true });
    }
  }
  throw new Error("No se pudo tomar el lock del torneo");
}
