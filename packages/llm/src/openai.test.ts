import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmClient, httpConfig, LlmError } from "./index";
import { stubFetch, TOOLS } from "./test-helpers";
import type { ChatMessage } from "./types";

const HISTORY: ChatMessage[] = [
  { role: "system", content: "Eres agresivo." },
  { role: "user", content: '{"distance":2}' },
  { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "attack", args: { force: 1 } }] },
  { role: "tool", toolCallId: "call_a", name: "attack", content: "golpe conectado" },
  { role: "user", content: '{"distance":3}' },
];

const OK_REPLY = {
  choices: [
    {
      message: {
        role: "assistant",
        content: "Voy a atacar",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "attack", arguments: '{"times":2}' } },
          { id: "call_2", type: "function", function: { name: "wait", arguments: "esto no es json" } },
        ],
      },
    },
  ],
};

beforeEach(() => {
  httpConfig.retryDelayMs = 1;
});

afterEach(() => {
  vi.unstubAllGlobals();
  httpConfig.retryDelayMs = 600;
  httpConfig.timeoutMs = 15_000;
});

describe("adaptador openai", () => {
  it("arma la solicitud con mensajes, tools y tool_choice auto", async () => {
    const calls = stubFetch([{ body: OK_REPLY }]);
    const client = createLlmClient({ provider: "openai", model: "modelo-x", apiKeys: { openai: "sk-test" } });
    await client.complete({ messages: HISTORY, tools: TOOLS });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer sk-test");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body.model).toBe("modelo-x");
    expect(call.body.tool_choice).toBe("auto");
    expect(call.body.tools).toHaveLength(TOOLS.length);
    expect(call.body.tools[0]).toEqual({
      type: "function",
      function: { name: "approach", description: "Acercarse al rival", parameters: TOOLS[0]!.parameters },
    });
    expect(call.body.messages).toEqual([
      { role: "system", content: "Eres agresivo." },
      { role: "user", content: '{"distance":2}' },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_a", type: "function", function: { name: "attack", arguments: '{"force":1}' } }],
      },
      { role: "tool", tool_call_id: "call_a", content: "golpe conectado" },
      { role: "user", content: '{"distance":3}' },
    ]);
  });

  it("omite tools y tool_choice si no hay tools", async () => {
    const calls = stubFetch([{ body: OK_REPLY }]);
    const client = createLlmClient({ provider: "openai", apiKeys: { openai: "sk-test" } });
    await client.complete({ messages: [{ role: "user", content: "hola" }], tools: [] });
    expect("tools" in calls[0]!.body).toBe(false);
    expect("tool_choice" in calls[0]!.body).toBe(false);
  });

  it("mapea texto y tool calls, tolerando argumentos que no son JSON", async () => {
    stubFetch([{ body: OK_REPLY }]);
    const client = createLlmClient({ provider: "openai", apiKeys: { openai: "sk-test" } });
    const res = await client.complete({ messages: HISTORY, tools: TOOLS });
    expect(res.text).toBe("Voy a atacar");
    expect(res.toolCalls).toEqual([
      { id: "call_1", name: "attack", args: { times: 2 } },
      { id: "call_2", name: "wait", args: {} },
    ]);
  });

  it("devuelve texto vacío y sin tool calls cuando content es null", async () => {
    stubFetch([{ body: { choices: [{ message: { role: "assistant", content: null } }] } }]);
    const client = createLlmClient({ provider: "openai", apiKeys: { openai: "sk-test" } });
    const res = await client.complete({ messages: HISTORY, tools: TOOLS });
    expect(res).toEqual({ text: "", toolCalls: [] });
  });

  it("lee el consumo de tokens de usage.prompt_tokens / completion_tokens", async () => {
    stubFetch([{ body: { ...OK_REPLY, usage: { prompt_tokens: 812, completion_tokens: 37, total_tokens: 849 } } }]);
    const client = createLlmClient({ provider: "openai", apiKeys: { openai: "sk-test" } });
    const res = await client.complete({ messages: HISTORY, tools: TOOLS });
    expect(res.usage).toEqual({ inputTokens: 812, outputTokens: 37 });
  });

  it("omite usage si falta o trae basura", async () => {
    const client = createLlmClient({ provider: "openai", apiKeys: { openai: "sk-test" } });
    for (const usage of [undefined, null, "mucho", { prompt_tokens: "812", completion_tokens: 3 }, { prompt_tokens: -1, completion_tokens: 3 }, { prompt_tokens: 5 }]) {
      stubFetch([{ body: { ...OK_REPLY, usage } }]);
      const res = await client.complete({ messages: HISTORY, tools: TOOLS });
      expect("usage" in res).toBe(false);
    }
  });

  it("reintenta una vez ante 429 y luego responde", async () => {
    const calls = stubFetch([{ status: 429, body: "rate limit" }, { body: OK_REPLY }]);
    const client = createLlmClient({ provider: "openai", apiKeys: { openai: "sk-test" } });
    const res = await client.complete({ messages: HISTORY, tools: TOOLS });
    expect(calls).toHaveLength(2);
    expect(res.toolCalls).toHaveLength(2);
  });

  it("tras dos 5xx lanza LlmError con proveedor, status y cuerpo", async () => {
    const calls = stubFetch([{ status: 503, body: "servicio caído" }]);
    const client = createLlmClient({ provider: "openai", apiKeys: { openai: "sk-test" } });
    const err = await client.complete({ messages: HISTORY, tools: TOOLS }).catch((e: unknown) => e);
    expect(calls).toHaveLength(2);
    expect(err).toBeInstanceOf(LlmError);
    const llmErr = err as LlmError;
    expect(llmErr.provider).toBe("openai");
    expect(llmErr.status).toBe(503);
    expect(llmErr.message).toContain("openai");
    expect(llmErr.message).toContain("503");
    expect(llmErr.message).toContain("servicio caído");
  });

  it("no reintenta ante 4xx y trunca el cuerpo del error", async () => {
    const calls = stubFetch([{ status: 401, body: "x".repeat(5000) }]);
    const client = createLlmClient({ provider: "openai", apiKeys: { openai: "sk-test" } });
    const err = await client.complete({ messages: HISTORY, tools: TOOLS }).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message.length).toBeLessThan(500);
  });

  it("corta por timeout si el proveedor no responde", async () => {
    httpConfig.timeoutMs = 20;
    vi.stubGlobal(
      "fetch",
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const client = createLlmClient({ provider: "openai", apiKeys: { openai: "sk-test" } });
    const err = await client.complete({ messages: HISTORY, tools: TOOLS }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).toContain("tiempo de espera agotado");
  });

  it("respeta la señal de quien llama", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const controller = new AbortController();
    const client = createLlmClient({ provider: "openai", apiKeys: { openai: "sk-test" } });
    const pending = client.complete({ messages: HISTORY, tools: TOOLS, signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("adaptador openrouter", () => {
  it("usa la base de OpenRouter con el mismo formato y su modelo por defecto", async () => {
    const calls = stubFetch([{ body: OK_REPLY }]);
    const client = createLlmClient({ provider: "openrouter", model: "", apiKeys: { openrouter: "or-test" } });
    const res = await client.complete({ messages: HISTORY, tools: TOOLS });

    expect(client.provider).toBe("openrouter");
    expect(client.model).toBe("openai/gpt-6-luna");
    const call = calls[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer or-test");
    expect(call.body.model).toBe("openai/gpt-6-luna");
    expect(call.body.tool_choice).toBe("auto");
    expect(res.toolCalls[0]).toEqual({ id: "call_1", name: "attack", args: { times: 2 } });
  });

  it("acepta contenido como lista de partes y argumentos ya parseados", async () => {
    stubFetch([
      {
        body: {
          choices: [
            {
              message: {
                content: [{ type: "text", text: "Me " }, { type: "text", text: "acerco" }],
                tool_calls: [{ type: "function", function: { name: "approach", arguments: { fast: true } } }],
              },
            },
          ],
        },
      },
    ]);
    const client = createLlmClient({ provider: "openrouter", apiKeys: { openrouter: "or-test" } });
    const res = await client.complete({ messages: HISTORY, tools: TOOLS });
    expect(res.text).toBe("Me acerco");
    expect(res.toolCalls).toEqual([{ id: "call_0", name: "approach", args: { fast: true } }]);
  });
});

describe("createLlmClient", () => {
  it("lanza un error claro en español si falta la API key", () => {
    expect(() => createLlmClient({ provider: "openai", apiKeys: {} })).toThrow(/OPENAI_API_KEY/);
    expect(() => createLlmClient({ provider: "anthropic", apiKeys: { anthropic: "  " } })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(() => createLlmClient({ provider: "openrouter", apiKeys: { openai: "sk" } })).toThrow(/Falta la API key/);
  });

  it("no necesita keys para el proveedor mock", () => {
    const client = createLlmClient({ provider: "mock", apiKeys: {} });
    expect(client.provider).toBe("mock");
  });
});
