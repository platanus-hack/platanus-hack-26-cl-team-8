import type { ToolCall } from "@phack/llm";
import { isToolName } from "./tools";

/** Error de una llamada al LLM, reducido a lo que importa para separar infraestructura de juego. */
export type LlmErrorReport = {
  /** Status HTTP; null si no hubo respuesta (red, timeout) o no se sabe. */
  status: number | null;
  /** true = fallo pasajero (429, 5xx, red, timeout): no es culpa del modelo. */
  retryable: boolean;
  message: string;
};

/**
 * Clasifica un error lanzado por `LlmClient.complete`. Usa `status`/`retryable` de
 * `LlmError` si vienen; un corte por el timeout propio del agente es reintentable.
 * Un error sin datos se toma como definitivo (no se puede saber si es pasajero).
 */
export function classifyLlmError(err: unknown, opts: { timedOut: boolean }): LlmErrorReport {
  const e = (err ?? {}) as { status?: unknown; retryable?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message : String(err);
  const status = typeof e.status === "number" && Number.isFinite(e.status) ? e.status : null;
  if (opts.timedOut) return { status, retryable: true, message: `tiempo de espera agotado: ${message}` };
  if (typeof e.retryable === "boolean") return { status, retryable: e.retryable, message };
  if (status !== null) return { status, retryable: status === 408 || status === 429 || status >= 500, message };
  return { status: null, retryable: false, message };
}

/**
 * true si la primera tool call es una acción válida del benchmark: herramienta conocida y
 * argumentos como objeto. Sin tool call (o con una desconocida) la decisión es inválida.
 */
export function isValidAction(first: ToolCall | undefined): boolean {
  if (!first || typeof first.name !== "string" || !isToolName(first.name)) return false;
  return typeof first.args === "object" && first.args !== null && !Array.isArray(first.args);
}
