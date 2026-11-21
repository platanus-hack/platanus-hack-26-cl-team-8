import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FlaggedPromptSchema,
  normalizeTags,
  type AgentConfig,
  type FlagBody,
  type FlaggedPrompt,
  type MatchRecord,
  type MatchSettings,
  type Side,
} from "@phack/protocol";
import { migrateStoredConfig } from "./store";
import { errorMessage, type LogFn } from "./util";

/** Cómo terminó la pelea de una marca; null mientras sigue en curso. */
export type FlagOutcome = FlaggedPrompt["outcome"];

/** Lo que se sabe de la pelea al marcarla: de la pelea en vivo o del historial. */
export type FlagSource = {
  matchId: string;
  configs: { red: AgentConfig; blue: AgentConfig };
  settings: MatchSettings;
  outcome: FlagOutcome;
};

const otherSide = (side: Side): Side => (side === "red" ? "blue" : "red");

/** Cómo terminó una pelea guardada, en la forma que se guarda en la marca. */
export function outcomeOf(record: MatchRecord): NonNullable<FlagOutcome> {
  return {
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    result: record.result,
    final: record.final,
  };
}

/** La pelea de un registro del historial, como fuente para marcar. */
export function sourceOfRecord(record: MatchRecord): FlagSource {
  return { matchId: record.id, configs: record.configs, settings: record.settings, outcome: outcomeOf(record) };
}

/** Adapta una marca guardada antes de que quedaran solo los proveedores "mock" y "vercel". */
function migrateStoredFlag(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const flag = raw as Record<string, unknown>;
  // Como en el historial, el modelo se conserva: es la verdad de lo que peleó.
  return { ...flag, config: migrateStoredConfig(flag.config, true), rival: migrateStoredConfig(flag.rival, true) };
}

/**
 * Interpreta flags.json (un arreglo JSON). Si el archivo está corrupto, ninguna marca;
 * una marca inválida se salta y las demás se conservan. Si una pelea y un lado se repiten,
 * vale la primera. Devuelve las marcadas más recientemente primero.
 */
export function parseFlags(raw: string): FlaggedPrompt[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const flags: FlaggedPrompt[] = [];
  for (const item of data) {
    const parsed = FlaggedPromptSchema.safeParse(migrateStoredFlag(item));
    if (!parsed.success) continue;
    const flag = parsed.data;
    if (flags.some((f) => f.matchId === flag.matchId && f.side === flag.side)) continue;
    flags.push(flag);
  }
  return sortFlags(flags);
}

function sortFlags(flags: FlaggedPrompt[]): FlaggedPrompt[] {
  return flags.sort((a, b) => b.flaggedAt - a.flaggedAt);
}

/** Prompts marcados: en memoria + DATA_DIR/flags.json. No dependen del historial de peleas. */
export class FlagStore {
  private flags: FlaggedPrompt[] = [];
  private readonly file: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly log: LogFn,
  ) {
    this.file = join(dataDir, "flags.json");
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return;
    }
    this.flags = parseFlags(raw);
  }

  /** Las marcadas más recientemente primero. */
  list(): FlaggedPrompt[] {
    return structuredClone(this.flags);
  }

  /**
   * Marca ese lado de la pelea, o edita la marca si ya existe. Al marcar se guarda una copia
   * de la pelea (el prompt, el rival, los ajustes y cómo terminó). Al editar solo cambian las
   * etiquetas y la nota, y el resultado si faltaba y la pelea ya terminó.
   */
  async put(source: FlagSource, side: Side, body: FlagBody, now: number): Promise<FlaggedPrompt> {
    const existing = this.find(source.matchId, side);
    if (existing) {
      if (existing.outcome === null && source.outcome !== null) existing.outcome = structuredClone(source.outcome);
      return this.write(existing, body, now);
    }
    const flag: FlaggedPrompt = {
      matchId: source.matchId,
      side,
      flaggedAt: now,
      updatedAt: now,
      tags: normalizeTags(body.tags),
      note: body.note.trim(),
      config: structuredClone(source.configs[side]),
      rival: structuredClone(source.configs[otherSide(side)]),
      settings: structuredClone(source.settings),
      outcome: structuredClone(source.outcome),
    };
    this.flags = sortFlags([flag, ...this.flags]);
    await this.persist();
    return structuredClone(flag);
  }

  /** Cambia las etiquetas y la nota de una marca que ya existe; null si no existe. */
  async edit(matchId: string, side: Side, body: FlagBody, now: number): Promise<FlaggedPrompt | null> {
    const flag = this.find(matchId, side);
    return flag ? this.write(flag, body, now) : null;
  }

  private async write(flag: FlaggedPrompt, body: FlagBody, now: number): Promise<FlaggedPrompt> {
    flag.tags = normalizeTags(body.tags);
    flag.note = body.note.trim();
    flag.updatedAt = now;
    await this.persist();
    return structuredClone(flag);
  }

  /** Quita la marca; false si no había. */
  async remove(matchId: string, side: Side): Promise<boolean> {
    const before = this.flags.length;
    this.flags = this.flags.filter((f) => !(f.matchId === matchId && f.side === side));
    if (this.flags.length === before) return false;
    await this.persist();
    return true;
  }

  /**
   * Completa las marcas de una pelea con su registro: cómo terminó y los prompts ya resueltos.
   * Se llama al guardar la pelea y otra vez al corregirla (llega la explicación del resultado).
   * Sin marcas de esa pelea no hace nada.
   */
  async attachOutcome(record: MatchRecord): Promise<void> {
    const matching = this.flags.filter((f) => f.matchId === record.id);
    if (matching.length === 0) return;
    for (const flag of matching) {
      flag.outcome = structuredClone(outcomeOf(record));
      flag.config = structuredClone(record.configs[flag.side]);
      flag.rival = structuredClone(record.configs[otherSide(flag.side)]);
      flag.settings = structuredClone(record.settings);
    }
    await this.persist();
  }

  private find(matchId: string, side: Side): FlaggedPrompt | undefined {
    return this.flags.find((f) => f.matchId === matchId && f.side === side);
  }

  /** Escrituras en serie; un fallo de disco se registra pero no rompe la API. */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.flags, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(this.dataDir, { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.file);
      } catch (err) {
        this.log("error", `No se pudieron guardar los prompts marcados: ${errorMessage(err)}`);
      }
    });
    return this.writeChain;
  }
}

type History = {
  append(record: MatchRecord): Promise<void>;
  update(id: string, change: (record: MatchRecord) => MatchRecord): Promise<boolean>;
};

/**
 * Envuelve el historial que usa la pelea para que, al guardar o corregir una pelea, sus
 * marcas reciban el registro. Un fallo en las marcas se registra y nunca impide guardar la pelea.
 */
export function withFlagOutcomes(
  history: History,
  flags: Pick<FlagStore, "attachOutcome">,
  log: LogFn,
): History {
  const attach = async (record: MatchRecord): Promise<void> => {
    try {
      await flags.attachOutcome(record);
    } catch (err) {
      log("error", `No se pudo completar el resultado de los prompts marcados: ${errorMessage(err)}`);
    }
  };
  return {
    async append(record) {
      await history.append(record);
      await attach(record);
    },
    async update(id, change) {
      // `as`: TypeScript no ve la asignación dentro del callback y lo daría por null.
      let updated = null as MatchRecord | null;
      const ok = await history.update(id, (record) => {
        updated = { ...change(record), id };
        return updated;
      });
      if (ok && updated) await attach(updated);
      return ok;
    },
  };
}
