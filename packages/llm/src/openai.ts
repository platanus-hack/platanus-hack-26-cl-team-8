import { LlmError, postJson } from "./http";
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, ToolCall, ToolDef } from "./types";
import { isRecord, parseToolArgs, toTokenUsage } from "./util";

/**
 * Adaptador para el formato "chat completions" de OpenAI.
 * OpenRouter y Vercel AI Gateway usan el mismo formato, así que comparten este código
 * con otra base URL.
 */

type WireMessage = Record<string, unknown>;

export function toOpenAiMessages(messages: ChatMessage[]): WireMessage[] {
  return messages.map((m): WireMessage => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant") {
      const out: WireMessage = { role: "assistant", content: m.content === "" ? null : m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }));
      } else if (m.content === "") {
        // Un mensaje de asistente sin contenido ni tool calls es inválido.
        out.content = "";
      }
      return out;
    }
    return { role: m.role, content: m.content };
  });
}

export function toOpenAiTools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  // Algunos modelos (vía OpenRouter) devuelven el contenido como lista de partes.
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

export function fromOpenAiResponse(provider: string, data: unknown): LlmResponse {
  const choices = isRecord(data) ? data.choices : undefined;
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) ? first.message : undefined;
  if (!isRecord(message)) {
    throw new LlmError(provider, 200, JSON.stringify(data ?? null), "respuesta sin choices[0].message");
  }

  const toolCalls: ToolCall[] = [];
  const rawCalls: unknown[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  rawCalls.forEach((raw, index) => {
    if (!isRecord(raw) || !isRecord(raw.function)) return;
    const name = raw.function.name;
    if (typeof name !== "string" || name === "") return;
    toolCalls.push({
      id: typeof raw.id === "string" && raw.id !== "" ? raw.id : `call_${index}`,
      name,
      args: parseToolArgs(raw.function.arguments),
    });
  });

  const response: LlmResponse = { text: contentToText(message.content), toolCalls };
  // OpenAI, OpenRouter y el AI Gateway informan el consumo en usage.prompt_tokens /
  // usage.completion_tokens; algunos modelos de OpenRouter no lo mandan.
  const usage = isRecord(data) && isRecord(data.usage)
    ? toTokenUsage(data.usage.prompt_tokens, data.usage.completion_tokens)
    : undefined;
  if (usage) response.usage = usage;
  return response;
}

export type OpenAiCompatibleOptions = {
  provider: "openai" | "openrouter" | "gateway";
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
};

/** true si el 400 del proveedor se queja del parámetro reasoning_effort. */
function rejectsReasoningEffort(err: unknown): boolean {
  return err instanceof LlmError && err.status === 400 && /reasoning_effort|reasoning\.effort/i.test(err.body);
}

export function createOpenAiCompatibleClient(opts: OpenAiCompatibleOptions): LlmClient {
  // Los modelos de razonamiento de OpenAI (p. ej. gpt-6-luna, el modelo por defecto) solo
  // aceptan function calling en Chat Completions con reasoning_effort "none". Solo se envía
  // al proveedor "openai" (en OpenRouter otros modelos pueden rechazarlo) y solo junto con
  // tools. Si el modelo elegido no conoce el parámetro (400), se reintenta sin él y no se
  // vuelve a enviar.
  let sendReasoningEffort = opts.provider === "openai";
  return {
    provider: opts.provider,
    model: opts.model,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      // No se envían temperature ni max_tokens: los modelos nuevos rechazan algunos
      // de esos parámetros y los valores por defecto sirven para este caso.
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: toOpenAiMessages(req.messages),
      };
      if (req.tools.length > 0) {
        body.tools = toOpenAiTools(req.tools);
        body.tool_choice = "auto";
      }
      const hasTools = req.tools.length > 0;
      const send = (withEffort: boolean): Promise<unknown> =>
        postJson({
          provider: opts.provider,
          url: `${opts.baseUrl}/chat/completions`,
          headers: { authorization: `Bearer ${opts.apiKey}`, ...opts.extraHeaders },
          body: withEffort ? { ...body, reasoning_effort: "none" } : body,
          signal: req.signal,
        });
      let data: unknown;
      try {
        data = await send(hasTools && sendReasoningEffort);
      } catch (err) {
        if (!hasTools || !sendReasoningEffort || !rejectsReasoningEffort(err)) throw err;
        sendReasoningEffort = false;
        data = await send(false);
      }
      return fromOpenAiResponse(opts.provider, data);
    },
  };
}
