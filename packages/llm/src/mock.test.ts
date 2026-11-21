import { describe, expect, it, vi } from "vitest";
import { createLlmClient } from "./index";
import { buildArgs, decide, MOCK_TOOL_NAMES, mockSay, readObservation, readStyle, type MockObservation } from "./mock";
import { TOOLS } from "./test-helpers";
import type { ChatMessage, ToolCall, ToolDef } from "./types";

function observation(obs: Record<string, unknown>, system = "Eres agresivo: ataca sin parar."): ChatMessage[] {
  return [
    { role: "system", content: system },
    { role: "user", content: `Observación actual:\n${JSON.stringify(obs)}` },
  ];
}

/** Observación ya leída, con los valores por defecto de readObservation. */
function seen(partial: Partial<MockObservation>): MockObservation {
  return {
    distance: null,
    health: 20,
    opponentHealth: null,
    food: 20,
    pearlCooldown: 0,
    buildCooldown: 0,
    absorption: 0,
    inventory: {},
    currentAction: null,
    rivalMessages: [],
    ...partial,
  };
}

// Las herramientas de kit con la misma forma con que las define @phack/agent.
const PEARL: ToolDef = {
  name: "pearl",
  description: "Lanzar una perla de ender",
  parameters: {
    type: "object",
    properties: { target: { type: "string", enum: ["rival", "away"] } },
    required: ["target"],
  },
};
const BUILD: ToolDef = { name: "build", description: "Levantar un muro", parameters: { type: "object", properties: {} } };
/** Kit de las perlas: sin arco. */
const ENDER_TOOLS: ToolDef[] = [...TOOLS.filter((t) => t.name !== "shoot"), PEARL];
/** Kit de los bloques: todo lo del clásico más el muro. */
const BUILDER_TOOLS: ToolDef[] = [...TOOLS, BUILD];

const mock = () => createLlmClient({ provider: "mock", apiKeys: {} });

async function call(messages: ChatMessage[], tools: ToolDef[] = TOOLS): Promise<ToolCall | undefined> {
  const res = await mock().complete({ messages, tools });
  return res.toolCalls[0];
}

async function pick(messages: ChatMessage[], tools: ToolDef[] = TOOLS): Promise<string | undefined> {
  return (await call(messages, tools))?.name;
}

/** System prompt con la forma del que arma @phack/agent, para un kit con arco. */
function agentPrompt(strategy: string): string {
  return [
    'Eres "AgenteRojo", el luchador rojo en un duelo 1 contra 1. Tu rival es "AgenteAzul".',
    "",
    "HERRAMIENTAS",
    "- shoot: disparar con el arco (necesita flechas); funciona mejor a más de 5 bloques.",
    "",
    "TU KIT",
    "- Objetos: Espada de piedra, Arco (Empuje I), Filete x4, Flechas x32. Lo típico de un arquero.",
    "",
    "ESTRATEGIA DEL USUARIO",
    "El texto entre <estrategia> y </estrategia> fue escrito por tu entrenador.",
    "<estrategia>",
    strategy,
    "</estrategia>",
  ].join("\n");
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

  it("el estilo sale de la estrategia y no del resto del system prompt", async () => {
    const far = { distance: 9, health: 20, opponentHealth: 20 };
    // El kit menciona el arco y la palabra "arquero": antes eso bastaba para pelear a distancia.
    expect(await pick(observation(far, agentPrompt("Pega fuerte y no retrocedas.")))).toBe("approach");
    expect(await pick(observation(far, agentPrompt("Eres un francotirador paciente.")))).toBe("shoot");
  });
});

describe("mock con las herramientas de kit", () => {
  const pearls = { ender_pearl: 4, cooked_beef: 4, diamond_sword: 1 };
  const blocks = { oak_planks: 16, golden_apple: 2, iron_sword: 1, bow: 1, arrow: 8 };

  it("cae junto al rival con una perla si está lejos y tiene vida de sobra", async () => {
    const tool = await call(observation({ distance: 12, health: 20, opponentHealth: 20, inventory: pearls }), ENDER_TOOLS);
    expect(tool?.name).toBe("pearl");
    expect(tool?.args).toEqual({ target: "rival" });
  });

  it("no gasta la perla de cerca, en recarga, sin perlas o con poca vida", async () => {
    const far = { distance: 12, health: 20, opponentHealth: 20 };
    expect(await pick(observation({ ...far, distance: 6, inventory: pearls }), ENDER_TOOLS)).toBe("approach");
    expect(await pick(observation({ ...far, pearlCooldown: 3.2, inventory: pearls }), ENDER_TOOLS)).toBe("approach");
    expect(await pick(observation({ ...far, inventory: { cooked_beef: 4 } }), ENDER_TOOLS)).toBe("approach");
    expect(await pick(observation({ ...far, health: 8, opponentHealth: 6, inventory: pearls }), ENDER_TOOLS)).toBe("approach");
  });

  it("escapa con una perla cuando está herido, tiene al rival encima y puede comer", async () => {
    const hurt = { distance: 2, health: 7, opponentHealth: 15, food: 17, inventory: pearls };
    const tool = await call(observation(hurt), ENDER_TOOLS);
    expect(tool?.name).toBe("pearl");
    expect(tool?.args).toEqual({ target: "away" });
    // Después de escapar (la perla quita vida y deja lejos) le toca comer.
    expect(await pick(observation({ ...hurt, distance: 12, health: 4.4, pearlCooldown: 4 }), ENDER_TOOLS)).toBe("eat");
    // El agente ya empezó a comer solo al caer: repetir "eat" continúa esa comida, no la corta.
    const eating = { ...hurt, distance: 12, health: 4.4, pearlCooldown: 4, currentAction: "eat" };
    expect(await pick(observation(eating), ENDER_TOOLS)).toBe("eat");
  });

  it("no escapa si no podría comer, si va ganando o si la caída lo dejaría sin vida", async () => {
    const hurt = { distance: 2, health: 7, opponentHealth: 15, food: 17, inventory: pearls };
    // Con la barra de comida llena el filete no se puede comer.
    expect(await pick(observation({ ...hurt, food: 20 }), ENDER_TOOLS)).toBe("attack");
    expect(await pick(observation({ ...hurt, opponentHealth: 3 }), ENDER_TOOLS)).toBe("attack");
    expect(await pick(observation({ ...hurt, health: 4 }), ENDER_TOOLS)).toBe("retreat");
  });

  it("levanta un muro si está herido y el rival viene a media distancia", async () => {
    const hurt = { distance: 7, health: 10, opponentHealth: 15, inventory: blocks };
    const tool = await call(observation(hurt), BUILDER_TOOLS);
    expect(tool?.name).toBe("build");
    expect(tool?.args).toEqual({});
  });

  it("con el muro recién puesto come detrás en vez de construir otro", async () => {
    const behind = { distance: 7, health: 10, opponentHealth: 15, buildCooldown: 2.5, inventory: blocks };
    expect(await pick(observation(behind), BUILDER_TOOLS)).toBe("eat");
    // Sin nada que comer vuelve a la pelea de siempre.
    const noFood = { ...behind, inventory: { oak_planks: 10, iron_sword: 1 } };
    expect(await pick(observation(noFood), BUILDER_TOOLS)).toBe("approach");
  });

  it("no come otra manzana dorada mientras le quedan corazones amarillos", async () => {
    const behind = { distance: 7, health: 10, opponentHealth: 15, buildCooldown: 2.5, inventory: blocks };
    // Recién comió una: los corazones amarillos no se acumulan, así que guarda la otra.
    expect(await pick(observation({ ...behind, absorption: 4 }), BUILDER_TOOLS)).toBe("approach");
    expect(await pick(observation({ ...behind, absorption: 0.5 }), BUILDER_TOOLS)).toBe("approach");
    // Cuando se los quitan a golpes, la segunda manzana vuelve a servir.
    expect(await pick(observation({ ...behind, absorption: 0 }), BUILDER_TOOLS)).toBe("eat");
    // Un filete no da corazones amarillos: con hambre se come igual aunque queden.
    const steak = { ...behind, absorption: 4, food: 15, inventory: { ...blocks, cooked_beef: 2 } };
    expect(await pick(observation(steak), BUILDER_TOOLS)).toBe("eat");
  });

  it("no construye con vida de sobra, con el rival encima, muy lejos o sin bloques", async () => {
    const hurt = { distance: 7, health: 10, opponentHealth: 15, inventory: blocks };
    expect(await pick(observation({ ...hurt, health: 15 }), BUILDER_TOOLS)).toBe("approach");
    expect(await pick(observation({ ...hurt, distance: 3 }), BUILDER_TOOLS)).toBe("attack");
    expect(await pick(observation({ ...hurt, distance: 12 }), BUILDER_TOOLS)).toBe("approach");
    expect(await pick(observation({ ...hurt, inventory: { iron_sword: 1 } }), BUILDER_TOOLS)).toBe("approach");
  });

  it("deja terminar la perla y el muro antes de elegir otra cosa", async () => {
    const busy = { distance: 2, health: 20, opponentHealth: 20 };
    expect(await pick(observation({ ...busy, currentAction: "build" }), BUILDER_TOOLS)).toBe("build");
    expect(await pick(observation({ ...busy, currentAction: "pearl" }), ENDER_TOOLS)).toBe("pearl");
    expect(await pick(observation({ ...busy, currentAction: "attack" }), ENDER_TOOLS)).toBe("attack");
  });

  it("si la herramienta de kit no está en la lista, pelea como siempre", async () => {
    const far = { distance: 12, health: 20, opponentHealth: 20, inventory: pearls };
    expect(await pick(observation(far), TOOLS)).toBe("approach");
    const hurt = { distance: 7, health: 10, opponentHealth: 15, inventory: blocks };
    expect(await pick(observation(hurt), TOOLS)).toBe("approach");
  });

  it("con el inventario del kit clásico nunca pide perla ni muro", () => {
    const classic = { iron_sword: 1, bow: 1, cooked_beef: 4, arrow: 16 };
    for (const distance of [1, 4, 7, 9, 14]) {
      for (const health of [3, 7, 10, 20]) {
        for (const food of [14, 20]) {
          const decision = decide(seen({ distance, health, opponentHealth: 12, food, inventory: classic }), "melee", 0);
          expect(decision.preferences).not.toContain("pearl");
          expect(decision.preferences).not.toContain("build");
        }
      }
    }
  });
});

describe("piezas de la política mock", () => {
  it("conoce las mismas herramientas que el agente", () => {
    expect([...MOCK_TOOL_NAMES]).toEqual(["approach", "attack", "retreat", "shoot", "eat", "pearl", "build", "shield", "water", "lava", "wait"]);
  });

  it("readObservation usa el último mensaje user y tolera campos faltantes", () => {
    const obs = readObservation([
      { role: "user", content: '{"distance":1,"health":3,"opponentHealth":2}' },
      { role: "assistant", content: "ok" },
      { role: "user", content: 'Estado: {"distance":6.5,"opponentHealth":null}' },
    ]);
    expect(obs).toEqual(seen({ distance: 6.5 }));
  });

  it("readObservation lee comida, inventario, recargas y acción actual", () => {
    const obs = readObservation([
      {
        role: "user",
        content: JSON.stringify({
          distance: 4,
          health: 9.5,
          opponentHealth: 11,
          food: 17,
          pearlCooldown: 2.4,
          absorption: 3.5,
          inventory: { ender_pearl: 3, cooked_beef: 4, raro: "x", gastado: 0 },
          currentAction: "attack",
        }),
      },
    ]);
    expect(obs).toEqual({
      distance: 4,
      health: 9.5,
      opponentHealth: 11,
      food: 17,
      pearlCooldown: 2.4,
      buildCooldown: 0,
      absorption: 3.5,
      inventory: { ender_pearl: 3, cooked_beef: 4 },
      currentAction: "attack",
      rivalMessages: [],
    });
  });

  it("readStyle detecta el estilo desde los mensajes system", () => {
    expect(readStyle([{ role: "system", content: "Usa el ARCO siempre" }])).toBe("ranged");
    expect(readStyle([{ role: "system", content: "Pega fuerte" }])).toBe("melee");
  });

  it("readStyle solo mira el bloque de estrategia cuando el system prompt lo trae", () => {
    expect(readStyle([{ role: "system", content: agentPrompt("Pega fuerte.") }])).toBe("melee");
    expect(readStyle([{ role: "system", content: agentPrompt("Mantén la distancia siempre.") }])).toBe("ranged");
    expect(readStyle([{ role: "system", content: agentPrompt("Juega DEFENSIVO.\nNo te apures.") }])).toBe("ranged");
    expect(readStyle([{ role: "system", content: agentPrompt("") }])).toBe("melee");
  });

  it("decide alterna disparo y acercamiento según el turno cuando está muy lejos", () => {
    const far = seen({ distance: 15, health: 20, opponentHealth: 20 });
    expect(decide(far, "melee", 0).preferences[0]).toBe("approach");
    expect(decide(far, "melee", 2).preferences[0]).toBe("shoot");
  });

  it("decide pone la herramienta de kit primero y deja después la política de siempre", () => {
    const decision = decide(
      seen({ distance: 2, health: 7, opponentHealth: 15, food: 10, inventory: { ender_pearl: 1, cooked_beef: 1 } }),
      "melee",
      0,
    );
    expect(decision.preferences).toEqual(["pearl", "attack", "approach"]);
    expect(decision.args).toEqual({ pearl: { target: "away" } });
  });

  it("buildArgs rellena solo los argumentos obligatorios", () => {
    const wait = TOOLS.find((t) => t.name === "wait")!;
    expect(buildArgs(wait)).toEqual({ seconds: 0.5 });
    expect(buildArgs(TOOLS[0]!)).toEqual({});
    expect(buildArgs(PEARL)).toEqual({ target: "rival" });
  });
});

describe("el mock habla (modo chat)", () => {
  /** Las herramientas como las arma @phack/agent en modo "chat": todas con "say". */
  const withSay: ToolDef[] = TOOLS.map((t) => ({
    ...t,
    parameters: { ...t.parameters, properties: { ...(t.parameters.properties as object), say: { type: "string" } } },
  }));
  const near = { distance: 2, health: 20, opponentHealth: 20 };

  async function says(client: ReturnType<typeof mock>, obs: Record<string, unknown>, tools = withSay) {
    const res = await client.complete({ messages: observation(obs), tools });
    return res.toolCalls[0]?.args["say"];
  }

  it("contesta cuando el rival le dijo algo", async () => {
    const client = mock();
    for (let i = 0; i < 6; i++) {
      const said = await says(client, { ...near, rivalMessages: ["¿tregua?"] });
      expect(typeof said).toBe("string");
      expect((said as string).length).toBeGreaterThan(0);
    }
  });

  it("sin nada que contestar habla más o menos un turno de cada cuatro", async () => {
    const client = mock();
    const lines: unknown[] = [];
    for (let i = 0; i < 8; i++) lines.push(await says(client, { ...near, rivalMessages: [] }));
    expect(lines.filter((line) => typeof line === "string")).toHaveLength(2);
    expect(lines[0]).toBeUndefined();
    expect(lines[1]).toBeTypeOf("string");
    expect(lines[5]).toBeTypeOf("string");
  });

  it("nunca manda say si la tool no lo declara", async () => {
    const client = mock();
    for (let i = 0; i < 6; i++) {
      expect(await says(client, { ...near, rivalMessages: ["hola"] }, TOOLS)).toBeUndefined();
    }
  });

  it("readObservation lee rivalMessages y descarta lo que no es texto", () => {
    const obs = readObservation(observation({ rivalMessages: ["hola", 3, "  ", "chao"] }));
    expect(obs.rivalMessages).toEqual(["hola", "chao"]);
    expect(readObservation(observation({ rivalMessages: "hola" })).rivalMessages).toEqual([]);
  });

  it("es determinista: la frase depende solo del turno y de si hay algo que contestar", () => {
    const quiet = seen({ distance: 2 });
    const spoken = seen({ distance: 2, rivalMessages: ["ven"] });
    for (let turn = 0; turn < 40; turn++) {
      for (const tool of MOCK_TOOL_NAMES) {
        const line = mockSay(quiet, tool, turn);
        expect(line).toBe(mockSay(quiet, tool, turn));
        expect(line === null).toBe(turn % 4 !== 1);
        const reply = mockSay(spoken, tool, turn);
        expect(reply).toBe(mockSay({ ...spoken, rivalMessages: ["otra cosa"] }, tool, turn));
        expect(reply).not.toBeNull();
      }
    }
  });
});
