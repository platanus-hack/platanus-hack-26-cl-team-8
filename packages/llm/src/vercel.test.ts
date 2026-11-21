import { describe, expect, it } from "vitest";
import { LlmError, createLlmClient } from "./index";
import { TOOLS } from "./test-helpers";
import type { ChatMessage } from "./types";
import { createVercelClient, toModelMessages } from "./vercel";
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

describe("createLlmClient con vercel", () => {
  it("exige VERCEL_API_KEY", () => {
    expect(() => createLlmClient({ provider: "vercel", apiKeys: {} })).toThrow(/VERCEL_API_KEY/);
  });

  it("usa el modelo por defecto del gateway", () => {
    const client = createLlmClient({ provider: "vercel", apiKeys: { vercel: "vck_test" } });
    expect(client.model).toBe("deepseek/deepseek-v4.1-flash-1017-fast");
  });
});
