import { describe, expect, it } from "vitest";
import { LlmError, createLlmClient } from "./index";
import { TOOLS } from "./test-helpers";
import type { ChatMessage } from "./types";
import { createVercelClient, gatewayCost, routingOptions, toModelMessages } from "./vercel";
import type { GenerateOptions, GenerateResult } from "./vercel";

const HISTORY: ChatMessage[] = [
  { role: "system", content: "Reglas de la arena" },
  { role: "system", content: "Estrategia: agresivo" },
  { role: "user", content: '{"distance":8}' },
  {
    role: "assistant",
    content: "me acerco",
    toolCalls: [{ id: "call_1", name: "approach", args: { reason: "lejos" } }],
  },
  { role: "tool", toolCallId: "call_1", name: "approach", content: "avanzando" },
  { role: "user", content: '{"distance":2}' },
];

function stubGenerate(result: GenerateResult): { calls: GenerateOptions[]; generate: (o: GenerateOptions) => Promise<GenerateResult> } {
  const calls: GenerateOptions[] = [];
  return {
    calls,
    generate: async (options) => {
      calls.push(options);
      return result;
    },
  };
}

describe("toModelMessages", () => {
  it("junta los mensajes de sistema y convierte tool calls y resultados", () => {
    const { instructions, messages } = toModelMessages(HISTORY);
    expect(instructions).toBe("Reglas de la arena\n\nEstrategia: agresivo");
    expect(messages).toEqual([
      { role: "user", content: '{"distance":8}' },
      {
        role: "assistant",
        content: [
          { type: "text", text: "me acerco" },
          { type: "tool-call", toolCallId: "call_1", toolName: "approach", input: { reason: "lejos" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_1", toolName: "approach", output: { type: "text", value: "avanzando" } },
        ],
      },
      { role: "user", content: '{"distance":2}' },
    ]);
  });

  it("no agrega una parte de texto vacía junto a las tool calls", () => {
    const { messages } = toModelMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "wait", args: {} }] },
    ]);
    expect(messages).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "wait", input: {} }] },
    ]);
  });
});

describe("createVercelClient", () => {
  it("llama a generateText sin razonamiento y devuelve las tool calls válidas", async () => {
    const stub = stubGenerate({
      text: "ataco",
      toolCalls: [
        { toolCallId: "t1", toolName: "attack", input: { reason: "cerca" } },
        { toolCallId: "t2", toolName: "wait", input: '{"seconds":1}' },
        { toolCallId: "t3", toolName: "inventada", input: {}, invalid: true },
      ],
    });
    const client = createVercelClient({ apiKey: "vck_test", model: "deepseek/x", generate: stub.generate });
    const response = await client.complete({ messages: HISTORY, tools: TOOLS });

    expect(client.provider).toBe("vercel");
    expect(client.model).toBe("deepseek/x");
    expect(response).toEqual({
      text: "ataco",
      toolCalls: [
        { id: "t1", name: "attack", args: { reason: "cerca" } },
        { id: "t2", name: "wait", args: { seconds: 1 } },
      ],
    });

    const options = stub.calls[0];
    expect(options?.reasoning).toBe("none");
    expect(options?.instructions).toBe("Reglas de la arena\n\nEstrategia: agresivo");
    expect(Object.keys(options?.tools ?? {})).toEqual(TOOLS.map((t) => t.name));
    expect(options?.messages).toHaveLength(4);
  });

  it("lee result.usage (inputTokens / outputTokens) del AI SDK", async () => {
    const stub = stubGenerate({ text: "", toolCalls: [], usage: { inputTokens: 640, outputTokens: 21 } });
    const client = createVercelClient({ apiKey: "vck_test", model: "m", generate: stub.generate });
    const response = await client.complete({ messages: HISTORY, tools: TOOLS });
    expect(response.usage).toEqual({ inputTokens: 640, outputTokens: 21 });
  });

  it("omite usage si el proveedor no lo informa", async () => {
    for (const usage of [undefined, { inputTokens: undefined, outputTokens: undefined }, { inputTokens: 3 }]) {
      const stub = stubGenerate({ text: "", toolCalls: [], usage });
      const client = createVercelClient({ apiKey: "vck_test", model: "m", generate: stub.generate });
      const response = await client.complete({ messages: HISTORY, tools: TOOLS });
      expect("usage" in response).toBe(false);
    }
  });

  it("omite tools e instructions cuando no hay", async () => {
    const stub = stubGenerate({ text: "hola", toolCalls: [] });
    const client = createVercelClient({ apiKey: "vck_test", model: "m", generate: stub.generate });
    await client.complete({ messages: [{ role: "user", content: "hola" }], tools: [] });
    expect(stub.calls[0]?.tools).toBeUndefined();
    expect(stub.calls[0]?.instructions).toBeUndefined();
  });

  it("envuelve los errores del gateway en LlmError con el status", async () => {
    const client = createVercelClient({
      apiKey: "vck_test",
      model: "m",
      generate: async () => {
        throw Object.assign(new Error("Unauthorized"), { statusCode: 401, responseBody: '{"error":"clave inválida"}' });
      },
    });
    const error = await client.complete({ messages: [{ role: "user", content: "x" }], tools: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).status).toBe(401);
    expect((error as LlmError).provider).toBe("vercel");
    expect((error as LlmError).body).toContain("clave inválida");
  });

  it("propaga la cancelación como AbortError", async () => {
    const controller = new AbortController();
    const client = createVercelClient({
      apiKey: "vck_test",
      model: "m",
      generate: async () => {
        controller.abort();
        throw new Error("aborted");
      },
    });
    const error = await client
      .complete({ messages: [{ role: "user", content: "x" }], tools: [], signal: controller.signal })
      .catch((e) => e);
    expect((error as Error).name).toBe("AbortError");
  });
});

describe("createVercelClient: enrutamiento, costo y errores clasificables", () => {
  it("pasa gatewayRouting en providerOptions.gateway y mantiene reasoning none", async () => {
    const stub = stubGenerate({ text: "", toolCalls: [] });
    const client = createVercelClient({
      apiKey: "vck_test",
      model: "deepseek/deepseek-v4.1-flash-1017-fast",
      gatewayRouting: { order: ["baseten"], only: ["baseten"] },
      generate: stub.generate,
    });
    await client.complete({ messages: HISTORY, tools: TOOLS });
    expect(stub.calls[0]?.providerOptions).toEqual({ gateway: { order: ["baseten"], only: ["baseten"] } });
    expect(stub.calls[0]?.reasoning).toBe("none");
  });

  it("sin enrutamiento (o con listas vacías) no manda providerOptions", async () => {
    for (const gatewayRouting of [undefined, {}, { order: [], only: [] }]) {
      const stub = stubGenerate({ text: "", toolCalls: [] });
      const client = createVercelClient({
        apiKey: "vck_test",
        model: "m",
        generate: stub.generate,
        ...(gatewayRouting ? { gatewayRouting } : {}),
      });
      await client.complete({ messages: HISTORY, tools: TOOLS });
      expect(stub.calls[0]?.providerOptions).toBeUndefined();
    }
    expect(routingOptions({ order: ["a"] })).toEqual({ gateway: { order: ["a"] } });
  });

  it("lee el costo de providerMetadata.gateway.cost (número o string)", async () => {
    for (const [cost, expected] of [
      [0.00042, 0.00042],
      ["0.0013", 0.0013],
    ] as const) {
      const stub = stubGenerate({ text: "", toolCalls: [], providerMetadata: { gateway: { cost } } });
      const client = createVercelClient({ apiKey: "vck_test", model: "m", generate: stub.generate });
      const response = await client.complete({ messages: HISTORY, tools: TOOLS });
      expect(response.costUsd).toBeCloseTo(expected, 10);
    }
    expect(gatewayCost(undefined)).toBeUndefined();
    expect(gatewayCost({ gateway: { cost: "nada" } })).toBeUndefined();
    expect(gatewayCost({ gateway: { cost: -1 } })).toBeUndefined();
    expect(gatewayCost({ openai: { cost: 1 } })).toBeUndefined();
  });

  it("omite costUsd si el gateway no lo informa", async () => {
    const stub = stubGenerate({ text: "", toolCalls: [] });
    const client = createVercelClient({ apiKey: "vck_test", model: "m", generate: stub.generate });
    const response = await client.complete({ messages: HISTORY, tools: TOOLS });
    expect("costUsd" in response).toBe(false);
  });

  it("marca 429 y 5xx como reintentables y 4xx como definitivos", async () => {
    const cases: Array<[unknown, number | null, boolean]> = [
      [Object.assign(new Error("Too Many Requests"), { statusCode: 429 }), 429, true],
      [Object.assign(new Error("Bad Gateway"), { statusCode: 502 }), 502, true],
      [Object.assign(new Error("Bad Request"), { statusCode: 400, isRetryable: false }), 400, false],
      [Object.assign(new Error("fetch failed"), { name: "TypeError" }), null, true],
      // RetryError del SDK: el status viene en el último error.
      [
        Object.assign(new Error("Failed after 2 attempts"), {
          name: "AI_RetryError",
          lastError: Object.assign(new Error("rate"), { statusCode: 429, responseBody: "limit" }),
        }),
        429,
        true,
      ],
    ];
    for (const [thrown, status, retryable] of cases) {
      const client = createVercelClient({
        apiKey: "vck_test",
        model: "m",
        generate: async () => {
          throw thrown;
        },
      });
      const error = (await client.complete({ messages: [{ role: "user", content: "x" }], tools: [] }).catch((e) => e)) as LlmError;
      expect(error).toBeInstanceOf(LlmError);
      expect(error.status).toBe(status);
      expect(error.retryable).toBe(retryable);
    }
  });
});

describe("createLlmClient con vercel", () => {
  it("exige VERCEL_API_KEY", () => {
    expect(() => createLlmClient({ provider: "vercel", apiKeys: {} })).toThrow(/VERCEL_API_KEY/);
  });

  it("usa el modelo por defecto del gateway", () => {
    const client = createLlmClient({ provider: "vercel", apiKeys: { vercel: "vck_test" } });
    expect(client.model).toBe("deepseek/deepseek-v4.1-flash-1017-fast");
  });

  it("acepta gatewayRouting", () => {
    const client = createLlmClient({
      provider: "vercel",
      apiKeys: { vercel: "vck_test" },
      gatewayRouting: { order: ["baseten"], only: ["baseten"] },
    });
    expect(client.provider).toBe("vercel");
  });
});

describe("LlmError.retryable", () => {
  it("se deduce del status si no se indica", () => {
    expect(new LlmError("x", 429, "").retryable).toBe(true);
    expect(new LlmError("x", 503, "").retryable).toBe(true);
    expect(new LlmError("x", null, "").retryable).toBe(true);
    expect(new LlmError("x", 401, "").retryable).toBe(false);
    expect(new LlmError("x", 401, "", undefined, true).retryable).toBe(true);
  });
});
