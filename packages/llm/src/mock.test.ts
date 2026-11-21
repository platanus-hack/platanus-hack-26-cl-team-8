import { describe, expect, it, vi } from "vitest";
import { createLlmClient } from "./index";
import { buildArgs, decide, readObservation, readStyle } from "./mock";
import { TOOLS } from "./test-helpers";
import type { ChatMessage, ToolDef } from "./types";

function observation(obs: Record<string, unknown>, system = "Eres agresivo: ataca sin parar."): ChatMessage[] {
  return [
    { role: "system", content: system },
    { role: "user", content: `Observación actual:\n${JSON.stringify(obs)}` },
  ];
}

const mock = () => createLlmClient({ provider: "mock", apiKeys: {} });

async function pick(messages: ChatMessage[], tools: ToolDef[] = TOOLS): Promise<string | undefined> {
  const res = await mock().complete({ messages, tools });
  return res.toolCalls[0]?.name;
}

describe("proveedor mock", () => {
  it("no usa la red", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await mock().complete({ messages: observation({ distance: 2, health: 20, opponentHealth: 20 }), tools: TOOLS });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("no informa consumo de tokens", async () => {
    const res = await mock().complete({ messages: observation({ distance: 2, health: 20, opponentHealth: 20 }), tools: TOOLS });
    expect("usage" in res).toBe(false);
  });

  it("ataca si el rival está cerca", async () => {
    expect(await pick(observation({ distance: 2, health: 20, opponentHealth: 20 }))).toBe("attack");
  });

  it("se acerca si el rival está lejos", async () => {
    expect(await pick(observation({ distance: 9, health: 20, opponentHealth: 20 }))).toBe("approach");
  });

  it("busca al rival si no lo ve", async () => {
    expect(await pick(observation({ distance: null, health: 20, opponentHealth: null }))).toBe("approach");
  });

  it("con poca vida se aleja si el rival está encima y come si está lejos", async () => {
    expect(await pick(observation({ distance: 2, health: 4, opponentHealth: 15 }))).toBe("retreat");
    expect(await pick(observation({ distance: 10, health: 4, opponentHealth: 15 }))).toBe("eat");
  });

  it("con poca vida igual ataca si va ganando", async () => {
    expect(await pick(observation({ distance: 2, health: 5, opponentHealth: 3 }))).toBe("attack");
  });

  it("un prompt defensivo pelea a distancia", async () => {
    const system = "Eres defensivo: mantén distancia y usa el arco.";
    expect(await pick(observation({ distance: 9, health: 20, opponentHealth: 20 }, system))).toBe("shoot");
    expect(await pick(observation({ distance: 2, health: 20, opponentHealth: 20 }, system))).toBe("retreat");
    expect(await pick(observation({ distance: 2, health: 20, opponentHealth: 5 }, system))).toBe("attack");
  });

  it("solo elige tools presentes en la lista", async () => {
    const onlyWait = TOOLS.filter((t) => t.name === "wait");
    expect(await pick(observation({ distance: 2, health: 20, opponentHealth: 20 }), onlyWait)).toBe("wait");
    const res = await mock().complete({
      messages: observation({ distance: 2, health: 20, opponentHealth: 20 }),
      tools: [{ name: "bailar", description: "", parameters: { type: "object" } }],
    });
    expect(res.toolCalls).toEqual([]);
    expect(res.text).toContain("[mock]");
  });

  it("es determinista", async () => {
    const messages = observation({ distance: 7.5, health: 12, opponentHealth: 9 });
    const a = await mock().complete({ messages, tools: TOOLS });
    const b = await mock().complete({ messages, tools: TOOLS });
    expect(a).toEqual(b);
    expect(a.text).toContain("[mock]");
  });

  it("no falla con un mensaje que no trae JSON", async () => {
    expect(await pick([{ role: "user", content: "sin datos" }])).toBe("approach");
    expect(await pick([])).toBe("approach");
  });
});

describe("piezas de la política mock", () => {
  it("readObservation usa el último mensaje user y tolera campos faltantes", () => {
    const obs = readObservation([
      { role: "user", content: '{"distance":1,"health":3,"opponentHealth":2}' },
      { role: "assistant", content: "ok" },
      { role: "user", content: 'Estado: {"distance":6.5,"opponentHealth":null}' },
    ]);
    expect(obs).toEqual({ distance: 6.5, health: 20, opponentHealth: null });
  });

  it("readStyle detecta el estilo desde los mensajes system", () => {
    expect(readStyle([{ role: "system", content: "Usa el ARCO siempre" }])).toBe("ranged");
    expect(readStyle([{ role: "system", content: "Pega fuerte" }])).toBe("melee");
  });

  it("decide alterna disparo y acercamiento según el turno cuando está muy lejos", () => {
    const far = { distance: 15, health: 20, opponentHealth: 20 };
    expect(decide(far, "melee", 0).preferences[0]).toBe("approach");
    expect(decide(far, "melee", 2).preferences[0]).toBe("shoot");
  });

  it("buildArgs rellena solo los argumentos obligatorios", () => {
    const wait = TOOLS.find((t) => t.name === "wait")!;
    expect(buildArgs(wait)).toEqual({ seconds: 0.5 });
    expect(buildArgs(TOOLS[0]!)).toEqual({});
  });
});
