import { createGateway, generateText, jsonSchema, tool } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import { LlmError, httpConfig } from "./http";
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, ToolCall, ToolDef } from "./types";
import { parseToolArgs } from "./util";

/**
 * Proveedor "vercel": Vercel AI Gateway a través del AI SDK (`ai`).
 *
 * Un solo `VERCEL_API_KEY` da acceso a los modelos del gateway, con ids del tipo
 * "proveedor/modelo" (p. ej. "deepseek/deepseek-v4.1-flash-1017-fast").
 *
 * Se llama a `generateText` con `reasoning: "none"`: cada decisión del agente debe
 * ser rápida y el razonamiento agrega latencia y costo.
 */

/** Lo que este adaptador necesita de `generateText`; así los tests pueden reemplazarlo. */
export type GenerateOptions = {
  model: ReturnType<ReturnType<typeof createGateway>>;
  instructions?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  reasoning: "none";
  maxRetries: number;
  timeout: number;
  abortSignal?: AbortSignal;
};

export type GenerateResult = {
  text: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown; invalid?: boolean }>;
};

export type GenerateFn = (options: GenerateOptions) => Promise<GenerateResult>;

const defaultGenerate: GenerateFn = (options) => generateText(options);

export type VercelOptions = {
  apiKey: string;
  model: string;
  /** Solo para tests. */
  generate?: GenerateFn;
};

/** Separa los mensajes de sistema (van en `instructions`) y convierte el resto al formato del AI SDK. */
export function toModelMessages(messages: ChatMessage[]): { instructions: string; messages: ModelMessage[] } {
  const system: string[] = [];
  const out: ModelMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        if (message.content.trim() !== "") system.push(message.content);
        break;
      case "user":
        out.push({ role: "user", content: message.content });
        break;
      case "assistant": {
        const calls = message.toolCalls ?? [];
        if (calls.length === 0) {
          out.push({ role: "assistant", content: message.content });
          break;
        }
        out.push({
          role: "assistant",
          content: [
            ...(message.content !== "" ? [{ type: "text" as const, text: message.content }] : []),
            ...calls.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.id,
              toolName: call.name,
              input: call.args,
            })),
          ],
        });
        break;
      }
      case "tool":
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: message.name,
              output: { type: "text", value: message.content },
            },
          ],
        });
        break;
    }
  }
  return { instructions: system.join("\n\n"), messages: out };
}

/** Las tools van sin `execute`: el SDK solo devuelve la llamada y el agente la ejecuta. */
export function toToolSet(tools: ToolDef[]): ToolSet {
  const set: ToolSet = {};
  for (const def of tools) {
    set[def.name] = tool({
      description: def.description,
      inputSchema: jsonSchema(def.parameters as Parameters<typeof jsonSchema>[0]),
    });
  }
  return set;
}

function describeError(err: unknown): { status: number | null; body: string; detail: string } {
  const anyErr = err as { statusCode?: unknown; responseBody?: unknown; message?: unknown; name?: unknown };
  const status = typeof anyErr?.statusCode === "number" ? anyErr.statusCode : null;
  const message = typeof anyErr?.message === "string" ? anyErr.message : String(err);
  const body = typeof anyErr?.responseBody === "string" && anyErr.responseBody !== "" ? anyErr.responseBody : message;
  const detail = typeof anyErr?.name === "string" && anyErr.name !== "Error" ? anyErr.name : "";
  return { status, body, detail };
}

export function createVercelClient(opts: VercelOptions): LlmClient {
  const gateway = createGateway({ apiKey: opts.apiKey });
  const generate = opts.generate ?? defaultGenerate;
  return {
    provider: "vercel",
    model: opts.model,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const { instructions, messages } = toModelMessages(req.messages);
      const options: GenerateOptions = {
        model: gateway(opts.model),
        messages,
        reasoning: "none",
        maxRetries: httpConfig.retries,
        timeout: httpConfig.timeoutMs,
      };
      if (instructions !== "") options.instructions = instructions;
      if (req.tools.length > 0) options.tools = toToolSet(req.tools);
      if (req.signal) options.abortSignal = req.signal;

      let result: GenerateResult;
      try {
        result = await generate(options);
      } catch (err) {
        if (req.signal?.aborted) {
          const aborted = new Error("[llm:vercel] solicitud cancelada");
          aborted.name = "AbortError";
          throw aborted;
        }
        const { status, body, detail } = describeError(err);
        throw new LlmError("vercel", status, body, detail);
      }

      const toolCalls: ToolCall[] = result.toolCalls
        .filter((call) => call.invalid !== true)
        .map((call) => ({ id: call.toolCallId, name: call.toolName, args: parseToolArgs(call.input) }));
      return { text: result.text ?? "", toolCalls };
    },
  };
}
