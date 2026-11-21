import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@phack/llm";
import { buildTurnMessages, trimHistory } from "./history";
import { parseToolArgs } from "./tools";

function turn(n: number): ChatMessage[] {
  return [
    { role: "user", content: `obs ${n}` },
    { role: "assistant", content: "", toolCalls: [{ id: `call-${n}`, name: "attack", args: {} }] },
    { role: "tool", toolCallId: `call-${n}`, name: "attack", content: "ok" },
  ];
}

describe("trimHistory", () => {
  it("no toca historiales cortos", () => {
    const history = [...turn(1), ...turn(2)];
    expect(trimHistory(history, 12)).toEqual(history);
  });

  it("bota turnos completos desde el principio", () => {
    const history = [...turn(1), ...turn(2), ...turn(3)];
    expect(trimHistory(history, 6)).toEqual([...turn(2), ...turn(3)]);
  });

  it("nunca deja un mensaje tool huérfano al inicio", () => {
    const history = [...turn(1), ...turn(2), ...turn(3)];
    const trimmed = trimHistory(history, 4);
    expect(trimmed).toEqual(turn(3));
    expect(trimmed[0]?.role).toBe("user");
  });

  it("devuelve vacío si no cabe ningún turno completo", () => {
    expect(trimHistory(turn(1), 2)).toEqual([]);
    expect(trimHistory(turn(1), 0)).toEqual([]);
  });
});

describe("buildTurnMessages", () => {
  it("responde cada tool call con un mensaje tool", () => {
    const messages = buildTurnMessages(
      "{}",
      {
        text: "",
        toolCalls: [
          { id: "a", name: "attack", args: {} },
          { id: "b", name: "eat", args: {} },
        ],
      },
      (index) => (index === 0 ? "primero" : "ignorada"),
    );
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({ role: "tool", toolCallId: "a", name: "attack", content: "primero" });
    expect(messages[3]).toEqual({ role: "tool", toolCallId: "b", name: "eat", content: "ignorada" });
  });

  it("sin tool calls deja solo el texto del asistente", () => {
    const messages = buildTurnMessages("{}", { text: "hola", toolCalls: [] }, () => "x");
    expect(messages).toEqual([
      { role: "user", content: "{}" },
      { role: "assistant", content: "hola" },
    ]);
  });
});

describe("parseToolArgs", () => {
  it("extrae reason y seconds válidos", () => {
    expect(parseToolArgs({ reason: "  porque sí ", seconds: 3 })).toEqual({ reason: "porque sí", seconds: 3, target: "rival", say: null });
    expect(parseToolArgs({ seconds: "2" })).toEqual({ reason: null, seconds: 2, target: "rival", say: null });
  });

  it("tolera argumentos basura", () => {
    expect(parseToolArgs({ reason: 5, seconds: -1 })).toEqual({ reason: null, seconds: null, target: "rival", say: null });
    expect(parseToolArgs(undefined)).toEqual({ reason: null, seconds: null, target: "rival", say: null });
    expect(parseToolArgs({ seconds: 999 })).toEqual({ reason: null, seconds: 60, target: "rival", say: null });
  });

  it("extrae el destino de la perla", () => {
    expect(parseToolArgs({ reason: "me escapo", target: "away" })).toEqual({ reason: "me escapo", seconds: null, target: "away", say: null });
  });
});
