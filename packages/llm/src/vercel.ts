import { createGateway, generateText, jsonSchema, tool } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import { LlmError, httpConfig, isRetryableStatus } from "./http";
import type { ChatMessage, GatewayRouting, LlmClient, ReasoningLevel, LlmRequest, LlmResponse, ToolCall, ToolDef } from "./types";
import { parseToolArgs, toTokenUsage } from "./util";

/**
 * Proveedor "vercel": Vercel AI Gateway a través del AI SDK (`ai`).
 *
 * Un solo `VERCEL_API_KEY` da acceso a los modelos del gateway, con ids del tipo
 * "proveedor/modelo" (p. ej. "deepseek/deepseek-v4.1-flash-1017-fast").
 *
 * Se llama a `generateText` con `reasoning: "none"` (salvo que `gatewayRouting.reasoning`
 * pida otro nivel, para modelos que no permiten apagarlo): cada decisión del agente debe
 * ser rápida y el razonamiento agrega latencia y costo.
 *
 * `gatewayRouting` fija el proveedor de inferencia del gateway (va en
 * `providerOptions.gateway`). El costo real de cada llamada sale de
 * `providerMetadata.gateway.cost` cuando el gateway lo informa.
 */

/** Lo que este adaptador necesita de `generateText`; así los tests pueden reemplazarlo. */
export type GenerateOptions = {
  model: ReturnType<ReturnType<typeof createGateway>>;
  instructions?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  reasoning: ReasoningLevel;
  /** Solo `gateway` (enrutamiento); falta si no se pidió enrutamiento. */
  providerOptions?: { gateway: { order?: string[]; only?: string[] } };
  maxRetries: number;
  timeout: number;
  abortSignal?: AbortSignal;
};

export type GenerateResult = {
  text: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown; invalid?: boolean }>;
  /**
   * Subconjunto de `LanguageModelUsage` del SDK (`result.usage`, suma de todos los pasos;
   * aquí hay uno solo porque las tools no tienen `execute`). Los campos pueden venir
   * undefined si el proveedor no informa el consumo.
   */
  usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined };
  /** `result.providerMetadata` del SDK; el gateway informa ahí `gateway.cost` (USD, número o string). */
  providerMetadata?: Record<string, Record<string, unknown>> | undefined;
};

export type GenerateFn = (options: GenerateOptions) => Promise<GenerateResult>;

const defaultGenerate: GenerateFn = (options) => generateText(options);

export type VercelOptions = {
  apiKey: string;
  model: string;
  gatewayRouting?: GatewayRouting;
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

type ErrorLike = {
  statusCode?: unknown;
  responseBody?: unknown;
  message?: unknown;
  name?: unknown;
  isRetryable?: unknown;
  lastError?: unknown;
};

/**
 * Status, cuerpo y si es reintentable a partir de un error del AI SDK. `APICallError` y
 * los errores del gateway traen `statusCode` (y `isRetryable`); un `RetryError` (se
 * agotaron los reintentos) envuelve el último error en `lastError`.
 */
export function describeError(err: unknown): { status: number | null; body: string; detail: string; retryable: boolean } {
  const outer = (err ?? {}) as ErrorLike;
  const inner = typeof outer.statusCode !== "number" && outer.lastError ? (outer.lastError as ErrorLike) : outer;
  const status = typeof inner.statusCode === "number" ? inner.statusCode : null;
  const message = typeof outer.message === "string" ? outer.message : String(err);
  const body = typeof inner.responseBody === "string" && inner.responseBody !== "" ? inner.responseBody : message;
  const detail = typeof outer.name === "string" && outer.name !== "Error" ? outer.name : "";
  // Sin status ni bandera del SDK: falló antes de tener respuesta HTTP (red / timeout).
  const retryable =
    status !== null ? isRetryableStatus(status) : typeof inner.isRetryable === "boolean" ? inner.isRetryable : true;
  return { status, body, detail, retryable };
}

/** Costo informado por el gateway en USD, o undefined si no viene o es basura. */
export function gatewayCost(metadata: GenerateResult["providerMetadata"]): number | undefined {
  const raw = metadata?.["gateway"]?.["cost"];
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** `providerOptions.gateway` con solo las listas no vacías; undefined si no hay enrutamiento. */
export function routingOptions(routing: GatewayRouting | undefined): GenerateOptions["providerOptions"] {
  const gateway: { order?: string[]; only?: string[] } = {};
  if (routing?.order && routing.order.length > 0) gateway.order = [...routing.order];
  if (routing?.only && routing.only.length > 0) gateway.only = [...routing.only];
  return Object.keys(gateway).length > 0 ? { gateway } : undefined;
}

export function createVercelClient(opts: VercelOptions): LlmClient {
  const gateway = createGateway({ apiKey: opts.apiKey });
  const generate = opts.generate ?? defaultGenerate;
  const providerOptions = routingOptions(opts.gatewayRouting);
  return {
    provider: "vercel",
    model: opts.model,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const { instructions, messages } = toModelMessages(req.messages);
      const options: GenerateOptions = {
        model: gateway(opts.model),
        messages,
        reasoning: opts.gatewayRouting?.reasoning ?? "none",
        maxRetries: httpConfig.retries,
        timeout: httpConfig.timeoutMs,
      };
      if (instructions !== "") options.instructions = instructions;
      if (providerOptions) options.providerOptions = providerOptions;
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
        const { status, body, detail, retryable } = describeError(err);
        throw new LlmError("vercel", status, body, detail, retryable);
      }

      const toolCalls: ToolCall[] = result.toolCalls
        .filter((call) => call.invalid !== true)
        .map((call) => ({ id: call.toolCallId, name: call.toolName, args: parseToolArgs(call.input) }));
      const response: LlmResponse = { text: result.text ?? "", toolCalls };
      const usage = toTokenUsage(result.usage?.inputTokens, result.usage?.outputTokens);
      if (usage) response.usage = usage;
      const costUsd = gatewayCost(result.providerMetadata);
      if (costUsd !== undefined) response.costUsd = costUsd;
      return response;
    },
  };
}
