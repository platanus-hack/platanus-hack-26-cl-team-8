import { LlmError, postJson } from "./http";
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, TokenUsage, ToolCall, ToolDef } from "./types";
import { isRecord, parseToolArgs, tokenCount, toTokenUsage } from "./util";

/** Adaptador para la Messages API de Anthropic (POST /v1/messages). */

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
/**
 * Las respuestas son una idea corta + una tool call, pero los modelos actuales
 * (p. ej. claude-haiku-5-5) piensan por defecto y esos tokens de razonamiento cuentan
 * contra max_tokens: con un tope chico la respuesta se corta antes de la tool call.
 */
const MAX_TOKENS = 4096;
/**
 * Esfuerzo bajo: decisiones cortas y rápidas (el tick es de ~1,5 s). Va en
 * output_config.effort. Los modelos antiguos (Haiku 4.5, Sonnet 4.5...) rechazan el
 * parámetro con un 400; en ese caso el cliente reintenta sin él y no lo vuelve a enviar.
 */
const EFFORT = "low";

/** true si el 400 del proveedor se queja del parámetro de esfuerzo. */
function rejectsEffort(err: unknown): boolean {
  return err instanceof LlmError && err.status === 400 && /output_config|effort/i.test(err.body);
}

type Block = Record<string, unknown>;
type WireMessage = { role: "user" | "assistant"; content: Block[] };

export type AnthropicPayload = { system: string; messages: WireMessage[] };

/**
 * Convierte el historial al formato de Anthropic:
 * - los mensajes "system" van juntos en el campo "system" de nivel superior;
 * - las tool calls del asistente son bloques "tool_use";
 * - los resultados son bloques "tool_result" dentro de un mensaje "user";
 * - mensajes consecutivos del mismo rol se fusionan en uno (así varios resultados
 *   seguidos quedan en UN solo mensaje user, con los tool_result primero).
 */
export function toAnthropicPayload(messages: ChatMessage[]): AnthropicPayload {
  const systemParts: string[] = [];
  const out: WireMessage[] = [];

  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.trim() !== "") systemParts.push(m.content);
    } else if (m.role === "user") {
      // Los bloques de texto vacíos son rechazados por la API.
      if (m.content.trim() !== "") push("user", [{ type: "text", text: m.content }]);
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.content.trim() !== "") blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      push("assistant", blocks);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]);
    }
  }

  // La conversación debe empezar con un mensaje del usuario y no puede estar vacía.
  const firstMessage = out[0];
  if (!firstMessage || firstMessage.role !== "user") {
    out.unshift({ role: "user", content: [{ type: "text", text: "Continúa." }] });
  }

  return { system: systemParts.join("\n\n"), messages: out };
}

export function toAnthropicTools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

export function fromAnthropicResponse(data: unknown): LlmResponse {
  const content = isRecord(data) ? data.content : undefined;
  if (!Array.isArray(content)) {
    throw new LlmError("anthropic", 200, JSON.stringify(data ?? null), "respuesta sin content");
  }
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  content.forEach((block: unknown, index) => {
    if (!isRecord(block)) return;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      toolCalls.push({
        id: typeof block.id === "string" && block.id !== "" ? block.id : `toolu_${index}`,
        name: block.name,
        args: parseToolArgs(block.input),
      });
    }
  });
  let text = texts.join("\n").trim();
  if (toolCalls.length === 0 && text === "" && isRecord(data) && data.stop_reason === "max_tokens") {
    // Se gastó todo el presupuesto (normalmente pensando) antes de elegir una acción.
    text = "(respuesta cortada por max_tokens antes de elegir una acción)";
  }
  const response: LlmResponse = { text, toolCalls };
  const usage = isRecord(data) && isRecord(data.usage) ? anthropicUsage(data.usage) : undefined;
  if (usage) response.usage = usage;
  return response;
}

/**
 * En Anthropic, input_tokens NO incluye los tokens leídos o escritos en caché: van
 * aparte (cache_read_input_tokens / cache_creation_input_tokens) y se suman si vienen.
 */
function anthropicUsage(raw: Record<string, unknown>): TokenUsage | undefined {
  const usage = toTokenUsage(raw.input_tokens, raw.output_tokens);
  if (!usage) return undefined;
  for (const extra of [raw.cache_read_input_tokens, raw.cache_creation_input_tokens]) {
    usage.inputTokens += tokenCount(extra) ?? 0;
  }
  return usage;
}

export function createAnthropicClient(opts: { apiKey: string; model: string }): LlmClient {
  // Se apaga solo si el modelo rechaza output_config.effort (ver EFFORT).
  let sendEffort = true;
  return {
    provider: "anthropic",
    model: opts.model,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const payload = toAnthropicPayload(req.messages);
      const body: Record<string, unknown> = {
        model: opts.model,
        max_tokens: MAX_TOKENS,
        messages: payload.messages,
      };
      if (payload.system !== "") body.system = payload.system;
      if (req.tools.length > 0) {
        body.tools = toAnthropicTools(req.tools);
        body.tool_choice = { type: "auto" };
      }
      const send = (withEffort: boolean): Promise<unknown> =>
        postJson({
          provider: "anthropic",
          url: ANTHROPIC_URL,
          headers: { "x-api-key": opts.apiKey, "anthropic-version": ANTHROPIC_VERSION },
          body: withEffort ? { ...body, output_config: { effort: EFFORT } } : body,
          signal: req.signal,
        });
      let data: unknown;
      try {
        data = await send(sendEffort);
      } catch (err) {
        if (!sendEffort || !rejectsEffort(err)) throw err;
        sendEffort = false;
        data = await send(false);
      }
      return fromAnthropicResponse(data);
    },
  };
}
