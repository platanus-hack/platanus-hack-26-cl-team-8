import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentConfigSchema,
  DEFAULT_KIT,
  DEFAULT_PROMPTS,
  DEFAULT_SETTINGS,
  MatchRecordSchema,
  MatchSettingsSchema,
  ProviderSchema,
  SIDES,
  kitOf,
  type AgentConfig,
  type MatchRecord,
  type MatchSettings,
  type PromptsResponse,
  type Side,
  type UpdatePromptBody,
} from "@phack/protocol";
import { errorMessage, type LogFn } from "./util";

export const MAX_HISTORY = 50;

// ---------- Partes puras (testeadas) ----------

export function defaultPrompts(): PromptsResponse {
  return {
    red: { side: "red", prompt: DEFAULT_PROMPTS.red, kit: DEFAULT_KIT },
    blue: { side: "blue", prompt: DEFAULT_PROMPTS.blue, kit: DEFAULT_KIT },
  };
}

/** Normaliza lo que llega del cliente: modelo vacío = sin modelo; kit ausente o desconocido = kit por defecto. */
export function normalizeConfig(side: Side, body: UpdatePromptBody): AgentConfig {
  const config: AgentConfig = { side, prompt: body.prompt, kit: kitOf(body).id };
  if (body.provider) config.provider = body.provider;
  const model = body.model?.trim();
  if (model) config.model = model;
  return config;
}

/**
 * Adapta una configuración guardada antes de que quedaran solo los proveedores "mock" y
 * "vercel". "gateway" era el mismo servicio que "vercel", y los modelos de "openrouter" ya
 * venían con el formato del gateway ("openai/gpt-…"): los dos pasan a "vercel" con su
 * modelo. Con cualquier otro proveedor que ya no existe ("openai", "anthropic"…) se borran
 * el proveedor y el modelo, que fuera de ese proveedor no significa nada: ese lado pasa a
 * usar el proveedor y el modelo por defecto. El prompt se conserva siempre. Se aplica al
 * leer, no reescribe archivos y repetirla no cambia nada.
 * `keepModel`: para el historial, donde el modelo no se vuelve a usar y es la verdad de lo
 * que peleó, se conserva igual.
 */
export function migrateStoredConfig(raw: unknown, keepModel = false): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const config = { ...(raw as Record<string, unknown>) };
  if (config.provider === undefined || ProviderSchema.safeParse(config.provider).success) return config;
  if (config.provider === "gateway" || config.provider === "openrouter") {
    config.provider = "vercel";
  } else {
    delete config.provider;
    if (!keepModel) delete config.model;
  }
  return config;
}

/** Aplica migrateStoredConfig a los dos lados de una pelea guardada (conservando los modelos). */
function migrateStoredRecord(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const record = raw as Record<string, unknown>;
  const configs = record.configs;
  if (typeof configs !== "object" || configs === null) return raw;
  const bySide = configs as Record<string, unknown>;
  return {
    ...record,
    configs: { ...bySide, red: migrateStoredConfig(bySide.red, true), blue: migrateStoredConfig(bySide.blue, true) },
  };
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
    const parsed = AgentConfigSchema.safeParse(migrateStoredConfig((data as Record<string, unknown>)[side]));
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
      const parsed = MatchRecordSchema.safeParse(migrateStoredRecord(JSON.parse(trimmed)));
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

/** Interpreta settings.json; si falta o está corrupto, los ajustes por defecto. */
export function parseSettings(raw: string): MatchSettings {
  try {
    const parsed = MatchSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Ajustes pendientes para la próxima pelea (modo de comunicación): en memoria + DATA_DIR/settings.json. */
export class SettingsStore {
  private settings: MatchSettings = { ...DEFAULT_SETTINGS };
  private readonly file: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly log: LogFn,
  ) {
    this.file = join(dataDir, "settings.json");
  }

  async load(): Promise<void> {
    const raw = await readIfExists(this.file);
    if (raw !== null) this.settings = parseSettings(raw);
  }

  get(): MatchSettings {
    return structuredClone(this.settings);
  }

  async update(change: Partial<MatchSettings>): Promise<MatchSettings> {
    this.settings = MatchSettingsSchema.parse({ ...this.settings, ...change });
    const snapshot = JSON.stringify(this.settings, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(this.dataDir, { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.file);
      } catch (err) {
        this.log("error", `No se pudieron guardar los ajustes: ${errorMessage(err)}`);
      }
    });
    await this.writeChain;
    return this.get();
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

  /** Todo el historial guardado (para el tablero de benchmarks), más recientes primero. */
  async all(): Promise<MatchRecord[]> {
    const raw = await readIfExists(this.file);
    if (raw === null) return this.latest();
    return parseMatchLines(raw, Number.POSITIVE_INFINITY);
  }

  /** Una pelea por id: de las recientes o, si no, del archivo completo. */
  async find(id: string): Promise<MatchRecord | null> {
    const recent = this.recent.find((record) => record.id === id);
    if (recent) return structuredClone(recent);
    return (await this.all()).find((record) => record.id === id) ?? null;
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
    if (!current) {
      // Una pelea más vieja que las de la caché (p. ej. calificada desde el tablero): se
      // corrige igual en el archivo, con una línea nueva del mismo id.
      const old = (await this.all()).find((record) => record.id === id);
      if (!old) return false;
      await this.writeLine({ ...change(old), id }, "No se pudo actualizar la pelea en el historial");
      return true;
    }
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
