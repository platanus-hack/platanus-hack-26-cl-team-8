import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KITS, type CommsMode } from "@phack/protocol";
import type { LlmRequest, LlmResponse } from "@phack/llm";
import type { Fighter, FighterOptions } from "./types";

const driver = vi.hoisted(() => ({ createBot: vi.fn(), goals: vi.fn() }));
vi.mock("node:module", () => ({
  createRequire: () => (name: string) => name === "mineflayer" ? { createBot: driver.createBot } : {
    pathfinder: () => {}, Movements: class {},
    goals: { GoalNear: class { constructor(...args: unknown[]) { driver.goals(...args); } }, GoalPlaceBlock: class {} },
  },
}));
import { createFighter } from "./fighter";

class Point {
  constructor(public x: number, public y: number, public z: number) {}
  clone() { return new Point(this.x, this.y, this.z); }
  offset(x: number, y: number, z: number) { return new Point(this.x + x, this.y + y, this.z + z); }
  minus(p: Point) { return new Point(this.x - p.x, this.y - p.y, this.z - p.z); }
  norm() { return Math.hypot(this.x, this.y, this.z); }
}
const item = (name: string, slot: number) => ({ name, count: 16, slot, maxDurability: 0, durabilityUsed: 0, enchants: [] });
class SimulatedBot extends EventEmitter {
  _client = new EventEmitter();
  health = 20;
  food = 20;
  entity = { id: 1, position: new Point(0.5, 65, 0.5), velocity: new Point(0, 0, 0), yaw: 0, pitch: 0, onGround: true, effects: [] };
  entities = {};
  players = {};
  registry = { effects: {}, effectsByName: {} };
  stock = [item("oak_planks", 36), item("red_wool", 37)];
  inventory = { items: () => this.stock.filter((entry) => entry.count > 0), slots: [] };
  heldItem = this.stock[0]!;
  world = {};
  cells = new Map<string, string>();
  pathfinder = { setGoal: vi.fn(), setMovements: vi.fn() };
  loadPlugin() {}
  clearControlStates() {}
  lookAt = vi.fn(async () => {});
  equip = vi.fn(async (entry: ReturnType<typeof item>) => { this.heldItem = entry; });
  blockAt = (point: Point) => {
    const position = new Point(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z));
    const name = this.cells.get(`${position.x},${position.y},${position.z}`) ?? (position.y === 64 ? "smooth_stone" : "air");
    return { name, position, boundingBox: name === "air" ? "empty" : "block" };
  };
  placeBlock = vi.fn(async (support: ReturnType<SimulatedBot["blockAt"]>, face: Point) => {
    const at = support.position.offset(face.x, face.y, face.z);
    this.cells.set(`${at.x},${at.y},${at.z}`, this.heldItem.name);
    this.heldItem.count--;
  });
  quit() { this.emit("end", "test complete"); }
}

const fighters: Fighter[] = [];
afterEach(async () => {
  await Promise.all(fighters.splice(0).map((fighter) => fighter.stop()));
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

type ScriptedAction = { name: string; args: Record<string, unknown> };

type StartOptions = {
  comms?: CommsMode;
  rounds?: { maxRounds: number } | null;
  /** Si se da, reemplaza la respuesta guionada del LLM. */
  complete?: (request: LlmRequest) => Promise<LlmResponse>;
};

/** El tercer argumento es el modo de comunicación a secas, o las opciones completas. */
async function start(
  actions: (ScriptedAction | ScriptedAction[])[],
  tickMs = 1000,
  options3: CommsMode | StartOptions = {},
) {
  const extra: StartOptions = typeof options3 === "string" ? { comms: options3 } : options3;
  vi.useFakeTimers();
  const bot = new SimulatedBot();
  driver.createBot.mockReturnValue(bot);
  const received: Record<string, unknown>[] = [];
  const requests: LlmRequest[] = [];
  let turn = 0;
  const options: FighterOptions = {
    side: "red", username: "Red", opponentUsername: "Blue", prompt: "Explora tus recursos", kit: KITS.builder,
    comms: extra.comms ?? "none", durationSeconds: 120, rounds: extra.rounds ?? null, tickMs, observationRadius: 8,
    mc: { host: "test", port: 25565, version: "1.20.4" },
    llm: {
      provider: "mock", model: "scripted",
      complete: async (request: LlmRequest) => {
        requests.push(request);
        if (extra.complete) return extra.complete(request);
        const observation = request.messages.at(-1);
        if (observation?.role === "user") received.push(JSON.parse(observation.content));
        const action = actions[turn++] ?? { name: "wait", args: {} };
        const calls = Array.isArray(action) ? action : [action];
        return { text: "", toolCalls: calls.map((call, index) => ({ id: `${turn}_${index}`, ...call })) };
      },
    },
    events: { onStatus: vi.fn(), onDecision: vi.fn(), onThought: vi.fn(), onAction: vi.fn(), onDamageTaken: vi.fn(), onDeath: vi.fn(), onMessage: vi.fn(), onSurrender: vi.fn(), onLog: vi.fn() },
  };
  const fighter = createFighter(options);
  fighters.push(fighter);
  const connected = fighter.connect();
  bot.emit("spawn");
  await connected;
  fighter.start();
  await vi.advanceTimersByTimeAsync(0);
  return { fighter, bot, received, requests, events: options.events };
}

describe("agente: observar, decidir y construir", () => {
  it("entrega cada mensaje al orquestador apenas lo dice, sin pausa ni descarte", async () => {
    const { received, events } = await start([
      { name: "wait", args: { say: "Hola." } },
      { name: "wait", args: { say: "¿Sigues ahí?" } },
      { name: "wait", args: {} },
    ], 1000, "chat");
    expect(events.onMessage).toHaveBeenCalledWith("Hola.");
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.onMessage).toHaveBeenCalledTimes(2);
    expect(events.onMessage).toHaveBeenLastCalledWith("¿Sigues ahí?");
    expect(vi.mocked(events.onAction).mock.calls.every(([, , result]) => !String(result).includes("no enviado"))).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(received.every((observation) => !("sayCooldown" in observation))).toBe(true);
    expect(received[2]?.conversation).toEqual([{ from: "tú", text: "Hola." }, { from: "tú", text: "¿Sigues ahí?" }]);
  });

  it("al oír un mensaje decide enseguida, sin esperar el resto de su pausa", async () => {
    const { fighter, received, events } = await start([
      { name: "wait", args: {} },
      { name: "wait", args: { say: "Vamos." } },
    ], 10_000, "chat");
    expect(received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    fighter.hear("message", "¿Nos movemos hacia el centro?");
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(2);
    expect(received[1]?.rivalMessages).toEqual(["¿Nos movemos hacia el centro?"]);
    expect(events.onMessage).toHaveBeenCalledWith("Vamos.");
    expect(received[1]?.conversation).toEqual([{ from: "rival", text: "¿Nos movemos hacia el centro?" }]);
    // Después vuelve a su ritmo de siempre.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(received).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toHaveLength(3);
  });

  it("un mensaje que llega mientras el LLM piensa hace que la decisión siguiente empiece sin dormir", async () => {
    const answers: ((response: LlmResponse) => void)[] = [];
    const seen: Record<string, unknown>[] = [];
    const { fighter, requests } = await start([], 10_000, {
      comms: "chat",
      complete: (request) => {
        const observation = request.messages.at(-1);
        if (observation?.role === "user") seen.push(JSON.parse(observation.content));
        return new Promise<LlmResponse>((resolve) => answers.push(resolve));
      },
    });
    expect(requests).toHaveLength(1);
    fighter.hear("message", "Te veo.");
    await vi.advanceTimersByTimeAsync(2000);
    // Mientras el LLM no responde, no hay otra llamada.
    expect(requests).toHaveLength(1);
    answers[0]!({ text: "", toolCalls: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
    expect(seen[1]?.rivalMessages).toEqual(["Te veo."]);
    // Sin mensajes nuevos, la siguiente espera la pausa completa.
    answers[1]!({ text: "", toolCalls: [] });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(requests).toHaveLength(2);
  });

  it.each(["none", "thoughts"] as const)("en modo %s no se habla y oír no adelanta la decisión", async (comms) => {
    const { fighter, received, events } = await start([
      { name: "wait", args: {} },
      { name: "wait", args: { reason: "Voy a esperar.", say: "Hola." } },
    ], 1000, comms);
    fighter.hear("message", "¿Nos movemos hacia el centro?");
    fighter.hear("thought", "Voy al centro.");
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(2);
    expect(events.onMessage).not.toHaveBeenCalled();
    expect(events.onThought).toHaveBeenCalledWith("Voy a esperar.");
    expect(events.onAction).toHaveBeenCalledTimes(2);
  });

  it("los mensajes de acciones en cola también se entregan, cada uno al empezar su acción", async () => {
    const { events } = await start([[
      { name: "wait", args: { seconds: 1, say: "Primero." } },
      { name: "wait", args: { say: "Segundo." } },
    ]], 10_000, "chat");
    expect(events.onMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(events.onDecision).toHaveBeenCalledTimes(1);
    expect(events.onAction).toHaveBeenCalledTimes(2);
    expect(vi.mocked(events.onMessage).mock.calls).toEqual([["Primero."], ["Segundo."]]);
  });

  it("el request real mantiene el mapa actual y resúmenes acotados de turnos anteriores", async () => {
    const { requests } = await start(Array.from({ length: 15 }, () => []), 100);
    await vi.advanceTimersByTimeAsync(1200);
    const request = requests.at(-1)!;
    const observations = request.messages.filter((message) => message.role === "user").map((message) => JSON.parse(message.content));
    expect(observations.at(-1)).toHaveProperty("world.regions");
    expect(observations.at(-1)).toHaveProperty("resources");
    expect(observations.slice(0, -1).every((observation) => !observation.world && !observation.resources)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(request.messages.slice(1, -1)))).toBeLessThanOrEqual(6000);
  });
  it("termina el plano y sigue la cola aunque lleguen respuestas sin herramientas", async () => {
    const { bot, received, events } = await start([
      [
        { name: "build", args: { blocks: [{ x: 2, y: 65, z: 0, material: "oak_planks" }, { x: 2, y: 66, z: 0, material: "red_wool" }] } },
        { name: "wait", args: { reason: "plano terminado" } },
      ],
      ...Array.from({ length: 15 }, () => []),
    ], 100);
    await vi.advanceTimersByTimeAsync(1100);
    expect(received.some((observation) => Array.isArray(observation.queuedActions) && observation.queuedActions.includes("wait"))).toBe(true);
    expect(bot.cells.get("2,65,0")).toBe("oak_planks");
    expect(bot.cells.get("2,66,0")).toBe("red_wool");
    expect(received.at(-1)?.construction).toMatchObject({ status: "complete", completed: 2, total: 2 });
    expect(vi.mocked(events.onAction).mock.calls.map(([name]) => name)).toEqual(["build", "wait"]);
    expect(events.onThought).toHaveBeenCalledWith("plano terminado");
    expect(events.onLog).not.toHaveBeenCalledWith("warn", expect.anything());
  });

  it("entrega contexto por radio al LLM y ejecuta un plano de varios materiales", async () => {
    const { bot, received, events } = await start([{ name: "build", args: { blocks: [{ x: 2, y: 65, z: 0, material: "oak_planks" }, { x: 2, y: 66, z: 0, material: "red_wool" }] } }]);
    expect(received[0]?.world).toMatchObject({ coverage: { radius: 8 } });
    expect(received[0]?.resources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "oak_planks", count: 16 })]));
    expect(events.onDecision).toHaveBeenCalledWith(expect.objectContaining({ contextProfile: expect.objectContaining({ totalBytes: expect.any(Number), observationFields: expect.objectContaining({ world: expect.any(Number) }) }) }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(bot.cells.get("2,65,0")).toBe("oak_planks");
    expect(bot.cells.get("2,66,0")).toBe("red_wool");
    expect(received[1]?.construction).toMatchObject({ status: "complete", completed: 2, total: 2 });
    expect(events.onLog).not.toHaveBeenCalledWith("warn", expect.anything());
  });

  it("reemplaza el plano al repetir build con celdas nuevas, y conserva el resultado físico anterior", async () => {
    const { bot } = await start([
      { name: "build", args: { blocks: [{ x: 2, y: 65, z: 0, material: "oak_planks" }, { x: 3, y: 67, z: 0, material: "oak_planks" }] } },
      { name: "build", args: { blocks: [{ x: 1, y: 65, z: 2, material: "red_wool" }] } },
    ]);
    await vi.advanceTimersByTimeAsync(1900);
    expect(bot.cells.get("2,65,0")).toBe("oak_planks");
    expect(bot.cells.get("3,67,0")).toBeUndefined();
    expect(bot.cells.get("1,65,2")).toBe("red_wool");
  });

  it("un rechazo del servidor aparece como bloqueo y no como construcción completa", async () => {
    const { bot, received } = await start([{ name: "build", args: { blocks: [{ x: 2, y: 65, z: 0, material: "oak_planks" }] } }]);
    bot.placeBlock.mockImplementation(async () => {});
    await vi.advanceTimersByTimeAsync(1100);
    expect(received[1]?.construction).toMatchObject({ status: "blocked", completed: 0, reason: expect.stringContaining("no confirmó") });
  });

  it("wait pausa el plano y build sin blocks lo retoma", async () => {
    const { bot, received } = await start([
      { name: "build", args: { blocks: [{ x: 2, y: 65, z: 0, material: "oak_planks" }, { x: 2, y: 66, z: 0, material: "red_wool" }] } },
      { name: "wait", args: {} }, { name: "build", args: {} },
      { name: "build", args: {} }, { name: "build", args: {} }, { name: "build", args: {} },
    ], 100);
    await vi.advanceTimersByTimeAsync(200);
    expect(received[2]?.construction).toMatchObject({ status: "paused" });
    await vi.advanceTimersByTimeAsync(400);
    expect(bot.cells.get("2,65,0")).toBe("oak_planks");
    expect(bot.cells.get("2,66,0")).toBe("red_wool");
  });

  it("move goto usa la posición libre y rechaza un destino fuera de la arena", async () => {
    const { events } = await start([
      { name: "move", args: { style: "goto", position: { x: 3, y: 65, z: 4 } } },
      { name: "move", args: { style: "goto", position: { x: 300, y: 65, z: 4 } } },
    ]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(driver.goals).toHaveBeenCalledWith(3, 65, 4, 1);
    expect(events.onAction).toHaveBeenCalledWith("move", expect.anything(), expect.stringContaining("destino fuera de la arena"));
  });
});

describe("agente: modo por rondas", () => {
  const ROUNDS = { maxRounds: 5 };

  it("una respuesta que llega en pausa no ejecuta nada y la cola queda vacía", async () => {
    let answer: (response: LlmResponse) => void = () => {};
    let calls = 0;
    const { bot, fighter, requests, events } = await start([], 100, {
      rounds: ROUNDS,
      complete: () => {
        calls += 1;
        return calls === 1
          ? new Promise<LlmResponse>((resolve) => {
              answer = resolve;
            })
          : Promise.resolve({ text: "", toolCalls: [] });
      },
    });
    expect(requests).toHaveLength(1);
    fighter.pause("terminó la ronda 1");
    answer({
      text: "",
      toolCalls: [
        { id: "1", name: "build", args: { blocks: [{ x: 2, y: 65, z: 0, material: "oak_planks" }] } },
        { id: "2", name: "attack", args: {} },
      ],
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.onAction).not.toHaveBeenCalled();
    expect(events.onDecision).not.toHaveBeenCalled();
    expect(bot.placeBlock).not.toHaveBeenCalled();
    // En pausa no vuelve a preguntarle al LLM.
    expect(requests).toHaveLength(1);
  });

  it("al reanudar decide con la serie al día y la nota como resultado de la última acción", async () => {
    const { fighter, received } = await start([{ name: "wait", args: {} }], 100, { rounds: ROUNDS });
    expect(received[0]).toMatchObject({ round: 1, maxRounds: 5, roundsWon: 0, roundsLost: 0, roundsDrawn: 0 });
    fighter.pause("terminó la ronda 1");
    await vi.advanceTimersByTimeAsync(300);
    const seen = received.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(seen);
    const note = "terminó la ronda 1: la ganaste por K.O.; empieza la ronda 2";
    fighter.resume({ round: 2, won: 1, lost: 0, drawn: 0, maxRounds: 5 }, note);
    await vi.advanceTimersByTimeAsync(0);
    expect(received[seen]).toMatchObject({ round: 2, roundsWon: 1, roundsLost: 0, lastActionResult: note, currentAction: "wait" });
  });

  it("morir en pausa no lo detiene: reaparece y espera a que lo reanuden", async () => {
    const { bot, fighter, received, events } = await start([], 100, { rounds: ROUNDS });
    fighter.pause("terminó la ronda 1");
    await vi.advanceTimersByTimeAsync(200);
    bot.emit("death");
    bot.emit("spawn");
    const seen = received.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.onDeath).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(seen);
    fighter.resume({ round: 2, won: 0, lost: 1, drawn: 0, maxRounds: 5 }, "empieza la ronda 2");
    await vi.advanceTimersByTimeAsync(0);
    expect(received[seen]).toMatchObject({ round: 2, roundsLost: 1, lastActionResult: "empieza la ronda 2" });
  });

  it("surrender avisa la acción, después la rendición, y no corre lo que venía en cola", async () => {
    const { requests, events } = await start([[{ name: "surrender", args: { reason: "no me alcanza" } }, { name: "attack", args: {} }]], 1000, {
      rounds: ROUNDS,
    });
    expect(requests[0]?.tools.map((tool) => tool.name)).toContain("surrender");
    expect(vi.mocked(events.onAction).mock.calls).toEqual([["surrender", { reason: "no me alcanza" }, "te rendiste en la ronda 1"]]);
    expect(events.onSurrender).toHaveBeenCalledTimes(1);
    expect(vi.mocked(events.onAction).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(events.onSurrender).mock.invocationCallOrder[0]!);
    expect(events.onThought).toHaveBeenCalledWith("no me alcanza");
  });

  it("en una sola pelea no hay surrender ni campos de la serie", async () => {
    const { requests, received, events } = await start([{ name: "surrender", args: {} }]);
    expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("surrender");
    expect(received[0]).not.toHaveProperty("round");
    expect(events.onSurrender).not.toHaveBeenCalled();
    expect(events.onAction).toHaveBeenCalledWith("surrender", {}, expect.stringContaining("herramienta desconocida"));
  });
});
