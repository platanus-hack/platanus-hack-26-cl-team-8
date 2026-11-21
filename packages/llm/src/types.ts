import type { Provider } from "@phack/protocol";

/** `parameters` es un objeto JSON Schema. */
export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type LlmResponse = { text: string; toolCalls: ToolCall[] };

export type LlmRequest = { messages: ChatMessage[]; tools: ToolDef[]; signal?: AbortSignal };

export interface LlmClient {
  readonly provider: Provider;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type ApiKeys = { openai?: string; anthropic?: string; openrouter?: string; gateway?: string };
