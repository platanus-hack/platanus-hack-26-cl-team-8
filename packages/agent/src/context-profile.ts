import type { ChatMessage, ToolDef } from "@phack/llm";

/** Bytes UTF-8 de JSON, no una estimación de tokens de un tokenizer diferente. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "");
}

export type ContextProfile = ReturnType<typeof profileContext>;

export function profileContext(messages: ChatMessage[], tools: ToolDef[]) {
  const latest = messages.reduce((found, message, index) => message.role === "user" ? index : found, -1);
  const current = latest >= 0 ? messages[latest] : undefined;
  const history = messages.filter((message, index) => message.role !== "system" && index !== latest);
  let observationFields: Record<string, number> = {};
  if (current) {
    try {
      const observation: unknown = JSON.parse(current.content);
      if (observation && typeof observation === "object" && !Array.isArray(observation)) {
        observationFields = Object.fromEntries(Object.entries(observation).map(([key, value]) => [key, jsonBytes(value)]));
      }
    } catch { /* También se puede medir un mensaje de usuario que no sea JSON. */ }
  }
  return {
    totalBytes: jsonBytes({ messages, tools }),
    systemBytes: jsonBytes(messages.filter((message) => message.role === "system")),
    toolsBytes: jsonBytes(tools),
    historyBytes: jsonBytes(history),
    observationBytes: current ? Buffer.byteLength(current.content) : 0,
    historyMessages: history.length,
    observationFields,
  };
}
