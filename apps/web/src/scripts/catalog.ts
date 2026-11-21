/**
 * Catálogo de modelos para el selector de cada prompt y para el costo de la pelea.
 *
 * La lista la entrega el orquestador en /api/models: ya viene filtrada a los modelos
 * permitidos (los que no pasan del tope de precio) y con el precio de cada uno. La página
 * no consulta a nadie más ni decide qué modelo se puede usar: solo muestra esa lista.
 */
import type { AllowedModel } from "@phack/protocol";
import { fetchModels } from "./api";

/** Tras una consulta fallida se espera esto antes de volver a preguntar al servidor. */
const RETRY_MS = 15_000;

let cached: Promise<AllowedModel[]> | null = null;

/**
 * Los modelos permitidos. Se consulta una sola vez por página. Si la consulta falla
 * (servidor caído, o uno más viejo que no tiene la ruta) la promesa rechaza, y pasado
 * RETRY_MS la siguiente llamada vuelve a intentar.
 */
export function loadCatalog(): Promise<AllowedModel[]> {
  if (cached) return cached;
  const request = fetchModels().then((response) => response.models);
  cached = request;
  request.catch(() => {
    window.setTimeout(() => {
      if (cached === request) cached = null;
    }, RETRY_MS);
  });
  return request;
}

/** Precio por millón de tokens: "$0.10", "$0.075" (dos decimales, o tres si hacen falta). */
function perMillion(perToken: number): string {
  const text = (perToken * 1_000_000).toFixed(3);
  return `$${text.endsWith("0") ? text.slice(0, -1) : text}`;
}

function isFree(model: AllowedModel): boolean {
  return model.inputPrice === 0 && model.outputPrice === 0;
}

/** Precio corto para la lista del selector: "$0.10 / $0.50 por M" (entrada / salida). */
export function priceHint(model: AllowedModel): string {
  if (isFree(model)) return "Gratis";
  return `${perMillion(model.inputPrice)} / ${perMillion(model.outputPrice)} por M`;
}

/** El mismo precio en palabras, para el tooltip de la fila. */
export function priceDetail(model: AllowedModel): string {
  if (isFree(model)) return "Gratis";
  return `${perMillion(model.inputPrice)} de entrada y ${perMillion(model.outputPrice)} de salida por millón de tokens`;
}

// ---------- Costo de una pelea ----------

let loaded: Map<string, AllowedModel> | null = null;
let loading = false;
const readyListeners: (() => void)[] = [];

/** Avisa cuando el catálogo queda cargado (para volver a dibujar los costos). */
export function onCatalogReady(listener: () => void): void {
  readyListeners.push(listener);
}

function requestPrices(): void {
  if (loading) return;
  loading = true;
  loadCatalog()
    .then((models) => {
      loaded = new Map(models.map((model) => [model.id, model]));
      for (const listener of readyListeners) listener();
    })
    .catch(() => {
      // Sin catálogo los costos se quedan en tokens; se reintenta con el próximo estado.
    })
    .finally(() => {
      loading = false;
    });
}

/**
 * Costo en dólares de lo consumido por un modelo, o null si no se puede saber: el
 * catálogo aún no carga (se pide en ese momento) o el modelo no está en la lista de
 * permitidos (por ejemplo, el de una pelea vieja).
 */
export function costOf(modelId: string, tokensIn: number, tokensOut: number): number | null {
  if (!loaded) {
    requestPrices();
    return null;
  }
  const model = loaded.get(modelId);
  if (!model) return null;
  return tokensIn * model.inputPrice + tokensOut * model.outputPrice;
}
