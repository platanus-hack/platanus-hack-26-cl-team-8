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

/** `usage` falta si el proveedor no informó el consumo (o lo informó con basura). */
export type LlmResponse = { text: string; toolCalls: ToolCall[]; usage?: TokenUsage };

export type LlmRequest = { messages: ChatMessage[]; tools: ToolDef[]; signal?: AbortSignal };

export interface LlmClient {
  readonly provider: Provider;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Claves de los proveedores que necesitan una ("mock" no usa). */
export type ApiKeys = {
  vercel?: string;
};
