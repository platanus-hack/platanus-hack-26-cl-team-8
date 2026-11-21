import { afterEach, describe, expect, it, vi } from "vitest";
import { toAnthropicPayload } from "./anthropic";
import { createLlmClient } from "./index";
import { stubFetch, TOOLS } from "./test-helpers";
import type { ChatMessage } from "./types";

const HISTORY: ChatMessage[] = [
  { role: "system", content: "Reglas de la arena." },
  { role: "system", content: "Eres defensivo." },
  { role: "user", content: '{"distance":9}' },
  {
    role: "assistant",
    content: "Disparo y retrocedo",
    toolCalls: [
      { id: "toolu_a", name: "shoot", args: {} },
      { id: "toolu_b", name: "retreat", args: { blocks: 3 } },
    ],
  },
  { role: "tool", toolCallId: "toolu_a", name: "shoot", content: "flecha lanzada" },
  { role: "tool", toolCallId: "toolu_b", name: "retreat", content: "retrocediste" },
  { role: "user", content: '{"distance":12}' },
];

const OK_REPLY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [
    { type: "text", text: "El rival está lejos." },
    { type: "tool_use", id: "toolu_1", name: "shoot", input: { power: 1 } },
  ],
  stop_reason: "tool_use",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adaptador anthropic", () => {
  it("arma la solicitud: headers, system de nivel superior y tools con input_schema", async () => {
    const calls = stubFetch([{ body: OK_REPLY }]);
    const client = createLlmClient({ provider: "anthropic", apiKeys: { anthropic: "ak-test" } });
    await client.complete({ messages: HISTORY, tools: TOOLS });

    expect(client.model).toBe("claude-haiku-5-5");
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.method).toBe("POST");
    expect(call.headers["x-api-key"]).toBe("ak-test");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.body.model).toBe("claude-haiku-5-5");
    expect(typeof call.body.max_tokens).toBe("number");
    expect(call.body.system).toBe("Reglas de la arena.\n\nEres defensivo.");
    expect(call.body.tools[0]).toEqual({
      name: "approach",
      description: "Acercarse al rival",
      input_schema: TOOLS[0]!.parameters,
    });
    expect(call.body.tool_choice).toEqual({ type: "auto" });
  });

  it("mapea tool_use y fusiona tool_result consecutivos en un solo mensaje user", async () => {
    const calls = stubFetch([{ body: OK_REPLY }]);
    const client = createLlmClient({ provider: "anthropic", apiKeys: { anthropic: "ak-test" } });
    await client.complete({ messages: HISTORY, tools: TOOLS });

    expect(calls[0]!.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: '{"distance":9}' }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Disparo y retrocedo" },
          { type: "tool_use", id: "toolu_a", name: "shoot", input: {} },
          { type: "tool_use", id: "toolu_b", name: "retreat", input: { blocks: 3 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "flecha lanzada" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "retrocediste" },
          { type: "text", text: '{"distance":12}' },
        ],
      },
    ]);
  });

  it("mapea la respuesta: texto y tool_use -> toolCalls", async () => {
    stubFetch([{ body: OK_REPLY }]);
    const client = createLlmClient({ provider: "anthropic", apiKeys: { anthropic: "ak-test" } });
    const res = await client.complete({ messages: HISTORY, tools: TOOLS });
    expect(res).toEqual({
      text: "El rival está lejos.",
      toolCalls: [{ id: "toolu_1", name: "shoot", args: { power: 1 } }],
    });
  });

  it("omite system y tools cuando no hay", async () => {
    const calls = stubFetch([{ body: { content: [{ type: "text", text: "hola" }] } }]);
    const client = createLlmClient({ provider: "anthropic", apiKeys: { anthropic: "ak-test" } });
    const res = await client.complete({ messages: [{ role: "user", content: "hola" }], tools: [] });
    expect("system" in calls[0]!.body).toBe(false);
    expect("tools" in calls[0]!.body).toBe(false);
    expect(res).toEqual({ text: "hola", toolCalls: [] });
  });
});

describe("toAnthropicPayload", () => {
  it("garantiza que la conversación empiece con un mensaje user", () => {
    const payload = toAnthropicPayload([{ role: "system", content: "solo sistema" }]);
    expect(payload.system).toBe("solo sistema");
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]!.role).toBe("user");
  });

  it("descarta textos vacíos y fusiona mensajes consecutivos del mismo rol", () => {
    const payload = toAnthropicPayload([
      { role: "user", content: "uno" },
      { role: "user", content: "" },
      { role: "user", content: "dos" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "wait", args: {} }] },
    ]);
    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "uno" },
          { type: "text", text: "dos" },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "wait", input: {} }] },
    ]);
  });
});
