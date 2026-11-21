import type { Provider } from "@phack/protocol";
import { createMockClient } from "./mock";
import type { ApiKeys, LlmClient } from "./types";
import { createVercelClient } from "./vercel";

export type { ApiKeys, ChatMessage, LlmClient, LlmRequest, LlmResponse, TokenUsage, ToolCall, ToolDef } from "./types";
export { LlmError, httpConfig } from "./http";
export { parseToolArgs } from "./util";
export { MOCK_TOOL_NAMES } from "./mock";
export type { MockToolName } from "./mock";

/**
 * Modelo por defecto de cada proveedor (se usa si `model` viene vacío).
 * vercel: id del catálogo de Vercel AI Gateway ("creador/modelo"), verificado el 2026-11-21.
 */
export const DEFAULT_MODELS: Record<Provider, string> = {
  mock: "mock-scripted",
  vercel: "deepseek/deepseek-v4.1-flash-1017-fast",
};

function requireVercelKey(apiKeys: ApiKeys): string {
  const key = apiKeys.vercel?.trim();
  if (!key) {
    throw new Error('Falta la API key del proveedor "vercel": define VERCEL_API_KEY o usa el proveedor "mock".');
  }
  return key;
}

/** Crea el cliente del proveedor pedido. Lanza un error claro si falta su API key. */
export function createLlmClient(opts: { provider: Provider; model?: string; apiKeys: ApiKeys }): LlmClient {
  const model = opts.model?.trim() || DEFAULT_MODELS[opts.provider];
  switch (opts.provider) {
    case "mock":
      return createMockClient(model);
    case "vercel":
      return createVercelClient({ apiKey: requireVercelKey(opts.apiKeys), model });
    default: {
      const unknownProvider: never = opts.provider;
      throw new Error(`Proveedor de LLM desconocido: ${String(unknownProvider)}`);
    }
  }
}
