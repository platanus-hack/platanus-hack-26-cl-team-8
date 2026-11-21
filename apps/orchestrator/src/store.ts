import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentConfigSchema,
  DEFAULT_PROMPTS,
  MatchRecordSchema,
  SIDES,
  type AgentConfig,
  type MatchRecord,
  type PromptsResponse,
  type Side,
  type UpdatePromptBody,
} from "@phack/protocol";
import { errorMessage, type LogFn } from "./util";

export const MAX_HISTORY = 50;

// ---------- Partes puras (testeadas) ----------

export function defaultPrompts(): PromptsResponse {
  return {
    red: { side: "red", prompt: DEFAULT_PROMPTS.red },
    blue: { side: "blue", prompt: DEFAULT_PROMPTS.blue },
  };
}

/** Normaliza lo que llega del cliente: modelo vacío = sin modelo. */
export function normalizeConfig(side: Side, body: UpdatePromptBody): AgentConfig {
  const config: AgentConfig = { side, prompt: body.prompt };
  if (body.provider) config.provider = body.provider;
  const model = body.model?.trim();
  if (model) config.model = model;
  return config;
}

/** Interpreta prompts.json; cualquier lado faltante o corrupto vuelve al valor por defecto. */
export function parsePrompts(raw: string): PromptsResponse {
  const prompts = defaultPrompts();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return prompts;
  }
  if (typeof data !== "object" || data === null) return prompts;
  for (const side of SIDES) {
    const parsed = AgentConfigSchema.safeParse((data as Record<string, unknown>)[side]);
    if (parsed.success) prompts[side] = normalizeConfig(side, parsed.data);
  }
  return prompts;
}

/**
 * Interpreta matches.jsonl (una pelea por línea, la más antigua primero).
 * Ignora líneas corruptas. Devuelve como máximo `limit`, las más recientes primero.
 * Si un id se repite, la línea posterior es una versión corregida del mismo registro
 * (ver MatchStore.update): gana su contenido, pero la pelea conserva su lugar original.
 */
export function parseMatchLines(raw: string, limit: number = MAX_HISTORY): MatchRecord[] {
  const byId = new Map<string, MatchRecord>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = MatchRecordSchema.safeParse(JSON.parse(trimmed));
      // Map.set sobre una clave existente no cambia su orden de inserción.
      if (parsed.success) byId.set(parsed.data.id, parsed.data);
    } catch {
      // línea corrupta: se ignora
    }
  }
  return [...byId.values()].slice(-limit).reverse();
}

// ---------- Persistencia ----------

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Prompts pendientes para la próxima pelea: en memoria + DATA_DIR/prompts.json. */
export class PromptStore {
  private prompts: PromptsResponse = defaultPrompts();
  private readonly file: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly log: LogFn,
  ) {
    this.file = join(dataDir, "prompts.json");
  }

  async load(): Promise<void> {
    const raw = await readIfExists(this.file);
    if (raw !== null) this.prompts = parsePrompts(raw);
  }

  get(): PromptsResponse {
    return structuredClone(this.prompts);
  }

  async update(side: Side, body: UpdatePromptBody): Promise<AgentConfig> {
    const config = normalizeConfig(side, body);
    this.prompts[side] = config;
    await this.persist();
    return structuredClone(config);
  }

  /** Escrituras en serie; un fallo de disco se registra pero no rompe la API. */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.prompts, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(this.dataDir, { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.file);
      } catch (err) {
        this.log("error", `No se pudieron guardar los prompts: ${errorMessage(err)}`);
      }
    });
    return this.writeChain;
  }
}

/** Historial de peleas: DATA_DIR/matches.jsonl + caché de las últimas 50 en memoria. */
export class MatchStore {
  private recent: MatchRecord[] = [];
  private readonly file: string;

  constructor(
    private readonly dataDir: string,
    private readonly log: LogFn,
  ) {
    this.file = join(dataDir, "matches.jsonl");
  }

  async load(): Promise<void> {
    const raw = await readIfExists(this.file);
    this.recent = raw === null ? [] : parseMatchLines(raw, MAX_HISTORY);
  }

  /** Más recientes primero, máx. 50. */
  latest(): MatchRecord[] {
    return structuredClone(this.recent);
  }

  async append(record: MatchRecord): Promise<void> {
    this.recent = [record, ...this.recent].slice(0, MAX_HISTORY);
    await this.writeLine(record, "No se pudo guardar la pelea en el historial");
  }

  /**
   * Corrige una pelea ya guardada (p. ej. para agregarle la explicación del resultado).
   * El archivo no se reescribe: se agrega una línea con el registro completo y el mismo
   * id, que al leer reemplaza a la anterior (ver parseMatchLines). Devuelve false si la
   * pelea ya no está entre las recientes.
   */
  async update(id: string, change: (record: MatchRecord) => MatchRecord): Promise<boolean> {
    const index = this.recent.findIndex((record) => record.id === id);
    const current = this.recent[index];
    if (!current) return false;
    const updated: MatchRecord = { ...change(structuredClone(current)), id };
    this.recent = this.recent.map((record, i) => (i === index ? updated : record));
    await this.writeLine(updated, "No se pudo actualizar la pelea en el historial");
    return true;
  }

  private async writeLine(record: MatchRecord, failure: string): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      this.log("error", `${failure}: ${errorMessage(err)}`);
    }
  }
}
