import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@phack/llm";
import { buildTurnMessages, trimHistory, summarizeObservation } from "./history";
import { ActionPlan, QUEUED_RESULT, replyResults } from "./plan";
import { parseToolArgs } from "./tools";

function turn(n: number): ChatMessage[] {
  return [
    { role: "user", content: `obs ${n}` },
    { role: "assistant", content: "", toolCalls: [{ id: `call-${n}`, name: "attack", args: {} }] },
    { role: "tool", toolCallId: `call-${n}`, name: "attack", content: "ok" },
  ];
}

describe("trimHistory", () => {
  it("el presupuesto de bytes elimina turnos completos, incluidos planos grandes", () => {
    const huge = turn(1);
    huge[1] = { role: "assistant", content: "", toolCalls: [{ id: "big", name: "build", args: { blocks: "x".repeat(10_000) } }] };
    const small = turn(2);
    expect(trimHistory([...huge, ...small], 12, 1000)).toEqual(small);
    expect(trimHistory(huge, 12, 1000)).toEqual([]);
  });

  it("el resumen conserva evolución y resultado pero no mapas, catálogos ni planos repetidos", () => {
    const summary = JSON.parse(summarizeObservation(JSON.stringify({ health: 12, inventory: { oak_planks: 5 }, currentAction: "build", lastActionResult: "faltó un apoyo", world: { huge: true }, resources: [{ uses: "manual repetido" }], construction: { status: "blocked", completed: 3, total: 10, reason: "falta apoyo", remaining: Array(500).fill({ x: 1, y: 2, z: 3 }) } })));
    expect(summary).toMatchObject({ health: 12, inventory: { oak_planks: 5 }, lastActionResult: "faltó un apoyo", construction: { status: "blocked", completed: 3, total: 10, reason: "falta apoyo" } });
    expect(summary).not.toHaveProperty("world");
    expect(summary).not.toHaveProperty("resources");
    expect(summary.construction).not.toHaveProperty("remaining");
  });
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

  it("con varias acciones, la primera lleva su resultado y las demás que están en cola", () => {
    const response = {
      text: "",
      toolCalls: [
        { id: "a", name: "eat", args: {} },
        { id: "b", name: "attack", args: {} },
        { id: "c", name: "wait", args: {} },
      ],
    };
    const results = replyResults(response.toolCalls.length, ["empezando a comer"]);
    const messages = buildTurnMessages("{}", response, (index) => results[index] ?? "");
    expect(messages.slice(2).map((m) => m.content)).toEqual(["empezando a comer", QUEUED_RESULT, QUEUED_RESULT]);
    expect(messages.some((m) => m.content.includes("ignorada"))).toBe(false);
    // Lo mismo que queda en cola para el cuerpo.
    const plan = new ActionPlan();
    plan.replace(response.toolCalls);
    plan.next();
    expect(plan.pending()).toEqual(["attack", "wait"]);
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
    expect(parseToolArgs({ reason: "  porque sí ", seconds: 3 })).toMatchObject({ reason: "porque sí", seconds: 3, target: "rival", where: "between", digTarget: "between", say: null });
    expect(parseToolArgs({ seconds: "2" })).toMatchObject({ reason: null, seconds: 2, target: "rival", where: "between", digTarget: "between", say: null });
  });

  it("tolera argumentos basura", () => {
    expect(parseToolArgs({ reason: 5, seconds: -1 })).toMatchObject({ reason: null, seconds: null, target: "rival", where: "between", digTarget: "between", say: null });
    expect(parseToolArgs(undefined)).toMatchObject({ reason: null, seconds: null, target: "rival", where: "between", digTarget: "between", say: null });
    expect(parseToolArgs({ seconds: 999 })).toMatchObject({ reason: null, seconds: 60, target: "rival", where: "between", digTarget: "between", say: null });
  });

  it("toma seconds en cualquier herramienta que no termina sola, con el mismo tope", () => {
    for (const tool of ["approach", "retreat", "move", "shoot", "shield", "wait"]) {
      expect(parseToolArgs({ tool, seconds: 4 }).seconds).toBe(4);
      expect(parseToolArgs({ tool, seconds: "1.5" }).seconds).toBe(1.5);
      expect(parseToolArgs({ tool, seconds: 0 }).seconds).toBeNull();
      expect(parseToolArgs({ tool, seconds: 120 }).seconds).toBe(60);
    }
  });

  it("extrae el destino de la perla", () => {
    expect(parseToolArgs({ reason: "me escapo", target: "away" })).toMatchObject({ reason: "me escapo", seconds: null, target: "away", where: "between", digTarget: "between", say: null });
  });
});
