import type { Provider } from "@phack/protocol";

/** `parameters` es un objeto JSON Schema. */
export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** Tokens que consumió UNA llamada al modelo, según el proveedor. */
export type TokenUsage = { inputTokens: number; outputTokens: number };

/**
 * `usage` falta si el proveedor no informó el consumo (o lo informó con basura).
 * `costUsd`: costo real de la llamada en USD, solo si el proveedor lo informa (Vercel AI Gateway).
 */
export type LlmResponse = { text: string; toolCalls: ToolCall[]; usage?: TokenUsage; costUsd?: number };

/**
 * Enrutamiento de Vercel AI Gateway: `order` = proveedores de inferencia a probar en orden;
 * `only` = restringe a esos (p. ej. `{ order: ["baseten"], only: ["baseten"] }`).
 */
/** Nivel de razonamiento que acepta el AI SDK ("none" = apagado). */
export type ReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Opciones por modelo para Vercel AI Gateway: proveedor de inferencia (order/only) y nivel
 * de razonamiento (por defecto "none").
 */
export type GatewayRouting = { order?: string[]; only?: string[]; reasoning?: ReasoningLevel };

export type LlmRequest = { messages: ChatMessage[]; tools: ToolDef[]; signal?: AbortSignal };

export interface LlmClient {
  readonly provider: Provider;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type ApiKeys = {
  vercel?: string;
  openai?: string;
  anthropic?: string;
  openrouter?: string;
  gateway?: string;
};
