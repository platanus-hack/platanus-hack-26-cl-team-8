import { MODEL_PRICE_CAP, type AllowedModel, type ModelsResponse } from "@phack/protocol";
import { errorMessage, type LogFn } from "./util";

/**
 * Modelos permitidos: los del catálogo público de Vercel AI Gateway que saben llamar
 * herramientas y no pasan de MODEL_PRICE_CAP. El orquestador baja el catálogo, lo filtra,
 * lo sirve en GET /api/models y lo hace cumplir al guardar un prompt y al iniciar una pelea.
 */

/** Catálogo público del gateway: no pide clave. */
export const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

/** Cada cuánto se vuelve a bajar el catálogo cuando la última descarga salió bien. */
const REFRESH_MS = 6 * 60 * 60 * 1000;
/** Cada cuánto se reintenta cuando la última descarga falló. */
const RETRY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

// ---------- Partes puras (testeadas) ----------

/**
 * Precio por token -> dólares por millón de tokens. Se redondea a 6 decimales para que
 * los modelos que están justo en el tope no queden afuera por un error de coma flotante.
 */
export function pricePerMillion(pricePerToken: number): number {
  return Math.round(pricePerToken * 1_000_000 * 1_000_000) / 1_000_000;
}

export function withinPriceCap(model: Pick<AllowedModel, "inputPrice" | "outputPrice">): boolean {
  return (
    pricePerMillion(model.inputPrice) <= MODEL_PRICE_CAP.inputPerMillion &&
    pricePerMillion(model.outputPrice) <= MODEL_PRICE_CAP.outputPerMillion
  );
}

/** El catálogo publica los precios como texto ("0.0000006"); null si falta o no es un número válido. */
function readPrice(value: unknown): number | null {
  const price =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(price) && price >= 0 ? price : null;
}

/**
 * Interpreta la respuesta del catálogo y deja solo los modelos permitidos: de texto, que
 * saben llamar herramientas, con precio publicado y dentro del tope. Los ids de
 * `alwaysAllowed` (el modelo por defecto del servidor) se saltan el tope de precio.
 * Nunca lanza: con datos que no entiende devuelve una lista vacía.
 */
export function parseCatalog(data: unknown, alwaysAllowed: readonly string[] = []): AllowedModel[] {
  const list = typeof data === "object" && data !== null ? (data as { data?: unknown }).data : undefined;
  if (!Array.isArray(list)) return [];
  const models: AllowedModel[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { id, name, type, tags, pricing } = item as Record<string, unknown>;
    if (typeof id !== "string" || id === "" || type !== "language") continue;
    if (!Array.isArray(tags) || !tags.includes("tool-use")) continue;
    // Las variantes "-batch" responden en diferido: no sirven para pelear en vivo.
    if (id.endsWith("-batch")) continue;
    if (typeof pricing !== "object" || pricing === null) continue;
    const { input, output } = pricing as Record<string, unknown>;
    const inputPrice = readPrice(input);
    const outputPrice = readPrice(output);
    // Sin precio publicado no se puede saber si es barato: queda afuera.
    if (inputPrice === null || outputPrice === null) continue;
    const model: AllowedModel = {
      id,
      name: typeof name === "string" && name.trim() !== "" ? name : id,
      inputPrice,
      outputPrice,
    };
    if (!withinPriceCap(model) && !alwaysAllowed.includes(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push(model);
  }
  return models;
}

function fallbackModel(id: string, name: string, inputPerMillion: number, outputPerMillion: number): AllowedModel {
  return { id, name, inputPrice: inputPerMillion / 1_000_000, outputPrice: outputPerMillion / 1_000_000 };
}

/**
 * Lista fija para cuando no se puede bajar el catálogo. Ids y precios (dólares por millón
 * de tokens de entrada y de salida) verificados en el catálogo el 2026-11-21.
 */
export const FALLBACK_MODELS: readonly AllowedModel[] = [
  fallbackModel("deepseek/deepseek-v4.1-flash-1017-fast", "DeepSeek V4.1 Flash 1017 Fast", 0.6, 2.4),
  fallbackModel("anthropic/claude-haiku-5.5", "Claude Haiku 5.5", 0.1, 0.5),
  fallbackModel("openai/gpt-6-luna", "GPT-6 Luna", 0.1, 0.5),
  fallbackModel("google/gemini-3.8-flash", "Gemini 3.8 Flash", 0.75, 3.75),
  fallbackModel("meta/muse-ember", "Muse Ember", 0.1, 0.5),
  fallbackModel("mistral/mistral-large-4", "Mistral Large 4", 0.7, 2.1),
  fallbackModel("zai/glm-5.3-flash", "GLM 5.3 Flash", 0.15, 0.5),
  fallbackModel("minimax/minimax-m3.1-flash", "MiniMax-M3.1-Flash", 0.15, 0.6),
  fallbackModel("moonshotai/kimi-k2.6", "Kimi K2.6", 0.95, 4),
  fallbackModel("amazon/nova-2-lite", "Nova 2 Lite", 0.33, 2.75),
];

// ---------- Descarga y caché ----------

/** Lo que se usa de `fetch`; así los tests pueden reemplazarlo. */
export type CatalogFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type ModelCatalogOptions = {
  /** Modelo por defecto del servidor para "vercel": siempre está permitido. */
  defaultModel: string;
  log: LogFn;
  /** Solo para tests. */
  fetch?: CatalogFetch;
  now?: () => number;
};

/**
 * Lista de modelos permitidos en memoria. Parte con FALLBACK_MODELS y la reemplaza por el
 * catálogo vivo cuando logra bajarlo; si una descarga falla conserva la última lista buena.
 */
export class ModelCatalog {
  private models: AllowedModel[] = [...FALLBACK_MODELS];
  private ids = new Set(FALLBACK_MODELS.map((model) => model.id));
  private source: ModelsResponse["source"] = "fallback";
  private updatedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Resultado de la última descarga, para no repetir el mismo aviso en cada intento. */
  private lastOk: boolean | null = null;
  private readonly fetchCatalog: CatalogFetch;
  private readonly now: () => number;

  constructor(private readonly opts: ModelCatalogOptions) {
    this.fetchCatalog = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
  }

  /** Baja el catálogo en segundo plano (no bloquea el arranque) y lo refresca cada tanto. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.cycle();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** El modelo por defecto del servidor siempre pasa, aunque el catálogo no lo traiga. */
  isAllowed(id: string): boolean {
    const model = id.trim();
    if (model === "") return false;
    return model === this.opts.defaultModel || this.ids.has(model);
  }

  snapshot(): ModelsResponse {
    return { models: this.models.map((model) => ({ ...model })), source: this.source, updatedAt: this.updatedAt };
  }

  /** Una descarga del catálogo. Nunca lanza: devuelve false y conserva la lista que había. */
  async refresh(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchCatalog(CATALOG_URL, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const models = parseCatalog(await res.json(), [this.opts.defaultModel]);
      if (models.length === 0) throw new Error("el catálogo no trae ningún modelo permitido");
      this.models = models;
      this.ids = new Set(models.map((model) => model.id));
      this.source = "catalog";
      this.updatedAt = this.now();
      if (this.lastOk !== true) this.opts.log("info", `Catálogo de modelos cargado: ${models.length} permitidos`);
      this.lastOk = true;
      return true;
    } catch (err) {
      if (this.lastOk !== false) {
        const kept = this.source === "catalog" ? "la última lista buena" : "la lista fija";
        this.opts.log("warn", `No se pudo bajar el catálogo de modelos (se usa ${kept}): ${errorMessage(err)}`);
      }
      this.lastOk = false;
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async cycle(): Promise<void> {
    const ok = await this.refresh();
    if (!this.running) return;
    this.timer = setTimeout(() => void this.cycle(), ok ? REFRESH_MS : RETRY_MS);
    // El refresco no debe mantener vivo el proceso.
    this.timer.unref();
  }
}
