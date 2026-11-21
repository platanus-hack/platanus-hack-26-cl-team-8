import type { Provider } from "@phack/protocol";
import { createAnthropicClient } from "./anthropic";
import { createMockClient } from "./mock";
import { createOpenAiCompatibleClient } from "./openai";
import type { ApiKeys, LlmClient } from "./types";
import { createVercelClient } from "./vercel";

export type { ApiKeys, ChatMessage, LlmClient, LlmRequest, LlmResponse, TokenUsage, ToolCall, ToolDef } from "./types";
export { LlmError, httpConfig } from "./http";
export { parseToolArgs } from "./util";
export { MOCK_TOOL_NAMES } from "./mock";
export type { MockToolName } from "./mock";

/**
 * Modelo por defecto de cada proveedor (se usa si `model` viene vacío).
 * openai / openrouter: verificados en la documentación pública en nov. 2026.
 * gateway: id del catálogo de Vercel AI Gateway ("creador/modelo"), verificado el 2026-11-21.
 */
export const DEFAULT_MODELS: Record<Provider, string> = {
  mock: "mock-scripted",
  // Id del Vercel AI Gateway: "proveedor/modelo".
  vercel: "deepseek/deepseek-v4.1-flash-1017-fast",
  openai: "gpt-6-luna",
  openrouter: "openai/gpt-6-luna",
  anthropic: "claude-haiku-5-5",
  gateway: "anthropic/claude-haiku-5.5",
};

const KEY_ENV_NAMES = {
  vercel: "VERCEL_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gateway: "AI_GATEWAY_API_KEY",
} as const;

function requireKey(provider: keyof typeof KEY_ENV_NAMES, apiKeys: ApiKeys): string {
  const key = apiKeys[provider]?.trim();
  if (!key) {
    throw new Error(
      `Falta la API key del proveedor "${provider}": define ${KEY_ENV_NAMES[provider]} o usa el proveedor "mock".`,
    );
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
      return createVercelClient({ apiKey: requireKey("vercel", opts.apiKeys), model });
    case "openai":
      return createOpenAiCompatibleClient({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: requireKey("openai", opts.apiKeys),
        model,
      });
    case "openrouter":
      return createOpenAiCompatibleClient({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: requireKey("openrouter", opts.apiKeys),
        model,
        extraHeaders: { "x-title": "Arena de prompts" },
      });
    case "gateway":
      // Vercel AI Gateway habla el formato "chat completions" de OpenAI.
      return createOpenAiCompatibleClient({
        provider: "gateway",
        baseUrl: "https://ai-gateway.vercel.sh/v1",
        apiKey: requireKey("gateway", opts.apiKeys),
        model,
      });
    case "anthropic":
      return createAnthropicClient({ apiKey: requireKey("anthropic", opts.apiKeys), model });
    default: {
      const unknownProvider: never = opts.provider;
      throw new Error(`Proveedor de LLM desconocido: ${String(unknownProvider)}`);
    }
  }
}
