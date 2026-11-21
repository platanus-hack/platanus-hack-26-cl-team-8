/**
 * Catálogo de modelos para el selector de cada prompt.
 *
 * Se lee del catálogo público de Vercel AI Gateway (no pide clave y acepta llamadas
 * desde el navegador). Solo se listan modelos de texto que saben llamar herramientas,
 * que es lo que necesita un agente. Si la consulta falla (sin internet, etc.) queda
 * una lista corta fija, y siempre se puede escribir un id a mano.
 */

export type CatalogModel = {
  id: string;
  name: string;
  /** Precio en dólares POR TOKEN de entrada y de salida, si el catálogo lo publica. */
  inputPrice?: number;
  outputPrice?: number;
};

const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

/** Respaldo sin red. Ids verificados en el catálogo el 2026-11-21. */
const FALLBACK: CatalogModel[] = [
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5" },
  { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" },
  { id: "openai/gpt-6.2-sol", name: "GPT-6.2 Sol" },
  { id: "openai/gpt-6.2-astra", name: "GPT-6.2 Astra" },
  { id: "google/gemini-4-neon", name: "Gemini 4 Neon" },
  { id: "deepseek/deepseek-v4.1-flash-1017-fast", name: "DeepSeek V4.1 Flash 1017 Fast" },
  { id: "spacexai/grok-4.7", name: "Grok 4.7" },
  { id: "meta/muse-ember", name: "Muse Ember" },
  { id: "mistral/mistral-large-4", name: "Mistral Large 4" },
  { id: "alibaba/qwen4-max", name: "Qwen 4 Max" },
  { id: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
];

function parseCatalog(data: unknown): CatalogModel[] {
  const list = typeof data === "object" && data !== null ? (data as { data?: unknown }).data : undefined;
  if (!Array.isArray(list)) return [];
  const models: CatalogModel[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { id, name, type, tags, pricing } = item as Record<string, unknown>;
    if (typeof id !== "string" || type !== "language") continue;
    if (!Array.isArray(tags) || !tags.includes("tool-use")) continue;
    // Las variantes "-batch" responden en diferido: no sirven para pelear en vivo.
    if (id.endsWith("-batch")) continue;
    const model: CatalogModel = { id, name: typeof name === "string" && name.trim() !== "" ? name : id };
    if (typeof pricing === "object" && pricing !== null) {
      const { input, output } = pricing as Record<string, unknown>;
      const inputPrice = Number(input);
      const outputPrice = Number(output);
      if (Number.isFinite(inputPrice) && Number.isFinite(outputPrice)) {
        model.inputPrice = inputPrice;
        model.outputPrice = outputPrice;
      }
    }
    models.push(model);
  }
  return models;
}

let cached: Promise<CatalogModel[]> | null = null;

/** Los modelos disponibles. Se consulta una sola vez por página; nunca rechaza. */
export function loadCatalog(): Promise<CatalogModel[]> {
  cached ??= fetch(CATALOG_URL, { headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const models = parseCatalog(data);
      return models.length > 0 ? models : FALLBACK;
    })
    .catch(() => FALLBACK);
  return cached;
}

// ---------- Costo de una pelea ----------

let loaded: Map<string, CatalogModel> | null = null;
const readyListeners: (() => void)[] = [];

/** Avisa cuando el catálogo queda cargado (para volver a dibujar los costos). */
export function onCatalogReady(listener: () => void): void {
  readyListeners.push(listener);
}

/**
 * Costo en dólares de lo consumido por un modelo, o null si no se puede saber: el
 * catálogo aún no carga (se pide en ese momento) o no publica precio para ese modelo.
 */
export function costOf(modelId: string, tokensIn: number, tokensOut: number): number | null {
  if (!loaded) {
    void loadCatalog().then((models) => {
      if (loaded) return;
      loaded = new Map(models.map((model) => [model.id, model]));
      for (const listener of readyListeners) listener();
    });
    return null;
  }
  const model = loaded.get(modelId);
  if (!model || model.inputPrice === undefined || model.outputPrice === undefined) return null;
  return tokensIn * model.inputPrice + tokensOut * model.outputPrice;
}
