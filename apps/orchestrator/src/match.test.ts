import { afterEach, describe, expect, it, vi } from "vitest";
import type { FighterEvents, FighterOptions } from "@phack/agent";
import type { LlmClient, LlmRequest, LlmResponse } from "@phack/llm";
import {
  COUNTDOWN_SECONDS,
  type AgentConfig,
  type MatchRecord,
  type MatchState,
  type Provider,
  type Side,
} from "@phack/protocol";
import { MatchManager, type MatchDeps, type MatchEnv } from "./match";
import { defaultPrompts } from "./store";
import type { SleepFn } from "./util";

/**
 * Pelea completa con dobles: RCON, sueño y luchadores falsos (sin Minecraft ni LLM reales).
 * Los eventos de los agentes se disparan a mano desde el test.
 */

type Complete = (req: LlmRequest) => Promise<LlmResponse>;

type SetupOptions = {
  provider?: Provider;
  /** LLM_MODEL del servidor. */
  model?: string;
  complete?: Complete;
  /** Cambios sobre los prompts por defecto de cada lado. */
  prompts?: Partial<Record<Side, Partial<AgentConfig>>>;
  /** Modelos de la lista de permitidos; si falta, todos pasan. */
  allowed?: string[];
  /** Respuesta del servidor de Minecraft a cada comando; si falta, la de un servidor sano. */
  rconReply?: (command: string) => string;
  /** Si falta, las pausas no esperan. */
  sleep?: SleepFn;
};

/** Lo que responde un servidor 1.20.4 de verdad: prepareFighter revisa la respuesta de los comandos del kit. */
function serverReply(command: string): string {
  if (command.startsWith("item replace entity ")) return "Replaced a slot on Agente with [Objeto]";
  if (command.startsWith("effect give ")) return "Applied effect Efecto to Agente";
  return "";
}

function setup(opts: SetupOptions = {}) {
  const env: MatchEnv = {
    LLM_PROVIDER: opts.provider ?? "vercel",
    LLM_MODEL: opts.model ?? "",
    VERCEL_API_KEY: "vck-test",
    MC_HOST: "localhost",
    MC_PORT: 25565,
    MC_VERSION: "1.20.4",
    MATCH_DURATION_SECONDS: 600,
    AGENT_TICK_MS: 1500,
  };
  const events: Partial<Record<Side, FighterEvents>> = {};
  const fighters: Partial<Record<Side, FighterOptions>> = {};
  const rconCommands: string[] = [];
  const logs: { level: string; text: string }[] = [];
  let stored: MatchRecord | null = null;
  const llmCalls: LlmRequest[] = [];
  const complete: Complete = opts.complete ?? (async () => ({ text: '  "Rojo ganó\n atacando sin parar."  ', toolCalls: [] }));

  const history = {
    append: vi.fn(async (record: MatchRecord) => {
      stored = record;
    }),
    update: vi.fn(async (id: string, change: (record: MatchRecord) => MatchRecord) => {
      if (!stored || stored.id !== id) return false;
      stored = change(stored);
      return true;
    }),
  };
  /** El estado de cada envío inmediato, en orden (lo que el hub real mandaría a la web). */
  const flushed: MatchState[] = [];
  const hub = {
    broadcast: vi.fn(),
    markStateDirty: vi.fn(),
    flushState: vi.fn(() => {
      flushed.push(manager.getState());
    }),
  };
  const createLlmClient = vi.fn(
    (o: { provider: Provider; model?: string }): LlmClient => ({
      provider: o.provider,
      model: o.model ?? "modelo",
      complete: (req) => {
        llmCalls.push(req);
        return complete(req);
      },
    }),
  );
  const prompts = () => {
    const base = defaultPrompts();
    return {
      red: { ...base.red, ...opts.prompts?.red },
      blue: { ...base.blue, ...opts.prompts?.blue },
    };
  };
  const allowed = opts.allowed;
  const rconReply = opts.rconReply ?? serverReply;
  const deps: MatchDeps = {
    env,
    rcon: {
      send: async (command) => {
        rconCommands.push(command);
        return rconReply(command);
      },
    },
    hub,
    prompts: { get: prompts },
    history,
    createFighter: (o: FighterOptions) => {
      events[o.side] = o.events;
      fighters[o.side] = o;
      return { connect: async () => {}, start: () => {}, stop: async () => {} };
    },
    createLlmClient,
    models: { isAllowed: (id) => allowed === undefined || allowed.includes(id) },
    log: (level, text) => {
      logs.push({ level, text });
    },
    sleep: opts.sleep ?? (async () => {}),
  };
  const manager: MatchManager = new MatchManager(deps);
  const ev = (side: Side): FighterEvents => {
    const e = events[side];
    if (!e) throw new Error(`sin eventos para ${side}`);
    return e;
  };
  return {
    manager,
    ev,
    history,
    hub,
    createLlmClient,
    llmCalls,
    fighters,
    rconCommands,
    logs,
    flushed,
    stored: () => stored,
  };
}

let current: MatchManager | null = null;

afterEach(async () => {
  await current?.shutdown();
  current = null;
});

async function startRunning(t: ReturnType<typeof setup>): Promise<void> {
  current = t.manager;
  t.manager.start();
  await vi.waitFor(() => expect(t.manager.getState().phase).toBe("running"));
}

describe("MatchManager: estadísticas del LLM y mano", () => {
  it("acumula tokens, promedia la latencia y copia el ítem en la mano; ignora eventos tardíos", async () => {
    const t = setup();
    await startRunning(t);

    t.ev("red").onStatus({ connected: true, alive: true, health: 20, food: 20, heldItem: "iron_sword" });
    t.ev("red").onDecision({ ms: 800, usage: { inputTokens: 100, outputTokens: 10 } });
    t.ev("red").onDecision({ ms: 1201 });
    t.ev("red").onDecision({ ms: 600, usage: { inputTokens: 50, outputTokens: 5 } });

    const red = t.manager.getState().agents.red;
    expect(red).toMatchObject({ heldItem: "iron_sword", tokensIn: 150, tokensOut: 15, avgDecisionMs: 867 });
    expect(t.manager.getState().agents.blue).toMatchObject({ tokensIn: 0, tokensOut: 0, avgDecisionMs: 0, heldItem: "" });

    t.ev("blue").onDeath();
    await vi.waitFor(() => expect(t.history.append).toHaveBeenCalled());
    t.ev("red").onDecision({ ms: 5000, usage: { inputTokens: 999, outputTokens: 999 } });
    expect(t.manager.getState().agents.red).toMatchObject({ tokensIn: 150, avgDecisionMs: 867 });
    expect(t.stored()?.final.red).toMatchObject({ tokensIn: 150, tokensOut: 15, avgDecisionMs: 867 });
  });
});

describe("MatchManager: por qué ganó", () => {
  it("tras un KO pide la frase al LLM por defecto y la agrega al estado y al historial", async () => {
    const t = setup();
    await startRunning(t);
    t.ev("blue").onDeath();

    await vi.waitFor(() => expect(t.history.update).toHaveBeenCalled());
    const state = t.manager.getState();
    expect(state.result).toEqual({ winner: "red", reason: "kill", explanation: "Rojo ganó atacando sin parar." });
    expect(t.stored()?.result.explanation).toBe("Rojo ganó atacando sin parar.");
    expect(t.hub.flushState).toHaveBeenCalled();

    // Dos clientes para los agentes + uno para la explicación, sin tools.
    expect(t.createLlmClient).toHaveBeenCalledTimes(3);
    expect(t.createLlmClient.mock.calls[2]?.[0]).toMatchObject({ provider: "vercel", model: undefined });
    expect(t.llmCalls).toHaveLength(1);
    expect(t.llmCalls[0]?.tools).toEqual([]);
  });

  it("si el LLM falla usa la plantilla", async () => {
    const t = setup({
      complete: async () => {
        throw new Error("503");
      },
    });
    await startRunning(t);
    t.ev("red").onDeath();
    await vi.waitFor(() => expect(t.history.update).toHaveBeenCalled());
    expect(t.manager.getState().result?.explanation).toMatch(/^Azul ganó por KO/);
  });

  it("si el LLM responde vacío usa la plantilla", async () => {
    const t = setup({ complete: async () => ({ text: '  ""  ', toolCalls: [] }) });
    await startRunning(t);
    t.ev("red").onDeath();
    await vi.waitFor(() => expect(t.history.update).toHaveBeenCalled());
    expect(t.manager.getState().result?.explanation).toMatch(/^Azul ganó por KO/);
  });

  it("con el proveedor mock no llama a ningún LLM y usa la plantilla", async () => {
    const t = setup({ provider: "mock" });
    await startRunning(t);
    t.ev("blue").onDeath();
    await vi.waitFor(() => expect(t.history.update).toHaveBeenCalled());
    expect(t.manager.getState().result?.explanation).toMatch(/^Rojo ganó por KO/);
    expect(t.createLlmClient).toHaveBeenCalledTimes(2);
  });

  it("una pelea detenida a mano no se explica", async () => {
    const t = setup();
    await startRunning(t);
    await t.manager.stop();
    expect(t.history.append).toHaveBeenCalled();
    expect(t.manager.getState().result).toEqual({ winner: null, reason: "stopped" });
    expect(t.history.update).not.toHaveBeenCalled();
    expect(t.llmCalls).toHaveLength(0);
  });
});

describe("MatchManager: cuenta regresiva", () => {
  it("anuncia cuándo termina la cuenta regresiva y la borra en el mismo estado que pasa a pelear", async () => {
    const t = setup();
    const before = Date.now();
    await startRunning(t);
    const after = Date.now();

    // Tres envíos inmediatos: al iniciar, al empezar la cuenta regresiva y al empezar la pelea.
    expect(t.flushed.map((s) => s.phase)).toEqual(["preparing", "preparing", "running"]);
    const [preparing, countdown, running] = t.flushed;
    expect(preparing?.countdownEndsAt).toBeNull();
    expect(countdown?.countdownEndsAt).toBeGreaterThanOrEqual(before + COUNTDOWN_SECONDS * 1000);
    expect(countdown?.countdownEndsAt).toBeLessThanOrEqual(after + COUNTDOWN_SECONDS * 1000);
    expect(countdown).toMatchObject({ startedAt: null, endsAt: null, result: null });
    expect(running?.countdownEndsAt).toBeNull();
    expect(running?.startedAt).not.toBeNull();
    expect(t.manager.getState().countdownEndsAt).toBeNull();
  });

  it("empieza cuando los dos peleadores ya tienen su kit, y al detenerla ahí queda en null", async () => {
    // Las pausas de la preparación no esperan; las de la cuenta regresiva quedan detenidas.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let manager: MatchManager | null = null;
    const t = setup({
      sleep: async () => {
        if (manager !== null && manager.getState().countdownEndsAt !== null) await gate;
      },
    });
    manager = t.manager;
    current = t.manager;

    t.manager.start();
    await vi.waitFor(() => expect(t.manager.getState().countdownEndsAt).not.toBeNull());
    expect(t.manager.getState().phase).toBe("preparing");
    for (const username of ["AgenteRojo", "AgenteAzul"]) {
      expect(t.rconCommands).toContain(`item replace entity ${username} hotbar.0 with minecraft:iron_sword`);
    }

    await t.manager.stop();
    expect(t.manager.getState()).toMatchObject({
      phase: "finished",
      countdownEndsAt: null,
      result: { winner: null, reason: "stopped" },
    });

    // Aunque la pausa termine después, la pelea cancelada no llega a empezar.
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.manager.getState()).toMatchObject({ phase: "finished", startedAt: null, countdownEndsAt: null });
    expect(t.flushed.every((s) => s.phase === "preparing" || s.countdownEndsAt === null)).toBe(true);
    expect(t.history.append).not.toHaveBeenCalled();
  });
});

describe("MatchManager: lista de modelos permitidos", () => {
  it("un modelo guardado que no está permitido se cambia por el del servidor, con aviso", async () => {
    const t = setup({
      model: "deepseek/barato",
      prompts: { red: { provider: "vercel", model: "openai/caro" }, blue: { model: "meta/permitido" } },
      allowed: ["meta/permitido"],
    });
    await startRunning(t);

    // Rojo pidió un modelo fuera de la lista: pelea con LLM_MODEL. Azul conserva el suyo.
    expect(t.createLlmClient.mock.calls[0]?.[0]).toMatchObject({ provider: "vercel", model: "deepseek/barato" });
    expect(t.createLlmClient.mock.calls[1]?.[0]).toMatchObject({ provider: "vercel", model: "meta/permitido" });
    // El estado muestra el modelo que de verdad pelea.
    const { configs } = t.manager.getState();
    expect(configs.red.model).toBe("deepseek/barato");
    expect(configs.blue.model).toBe("meta/permitido");

    const warnings = t.logs.filter((l) => l.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("[Rojo]");
    expect(warnings[0]?.text).toContain("openai/caro");
    // El aviso también llega a la web.
    expect(t.hub.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "log", level: "warn" }));
  });

  it("sin LLM_MODEL el modelo no permitido cae al modelo por defecto del proveedor", async () => {
    const t = setup({ prompts: { red: { model: "openai/caro" } }, allowed: [] });
    await startRunning(t);
    expect(t.createLlmClient.mock.calls[0]?.[0]).toMatchObject({ provider: "vercel", model: undefined });
  });

  it("con el proveedor simulado el modelo guardado se descarta sin avisar", async () => {
    const t = setup({ prompts: { red: { provider: "mock", model: "openai/caro" } }, allowed: [] });
    await startRunning(t);
    expect(t.createLlmClient.mock.calls[0]?.[0]).toMatchObject({ provider: "mock", model: undefined });
    expect(t.logs.some((l) => l.level === "warn")).toBe(false);
  });
});

describe("MatchManager: kits", () => {
  it("cada lado pelea con su kit: llega al agente, a los comandos de RCON y al estado", async () => {
    const t = setup({ prompts: { red: { kit: "berserker" } } });
    await startRunning(t);

    expect(t.fighters.red?.kit).toBe("berserker");
    expect(t.fighters.blue?.kit).toBe("classic");
    expect(t.manager.getState().configs).toMatchObject({ red: { kit: "berserker" }, blue: { kit: "classic" } });

    expect(t.rconCommands).toContain("item replace entity AgenteRojo hotbar.0 with minecraft:diamond_axe");
    expect(t.rconCommands).toContain("item replace entity AgenteAzul hotbar.0 with minecraft:iron_sword");
    expect(t.rconCommands).toContain("item replace entity AgenteAzul hotbar.8 with minecraft:arrow 16");
    expect(t.rconCommands.some((c) => c.startsWith("item replace entity AgenteRojo hotbar.8 "))).toBe(false);
    // El efecto permanente del berserker va después de `effect clear`, y solo para él.
    const speed = "effect give AgenteRojo minecraft:speed infinite 0 true";
    expect(t.rconCommands.indexOf(speed)).toBeGreaterThan(t.rconCommands.indexOf("effect clear AgenteRojo"));
    expect(t.rconCommands.indexOf("effect clear AgenteRojo")).toBeGreaterThanOrEqual(0);
    expect(t.rconCommands.some((c) => c.startsWith("effect give AgenteAzul minecraft:speed"))).toBe(false);
    // El servidor confirmó todos los comandos: no hay avisos.
    expect(t.logs.some((l) => l.level === "warn")).toBe(false);
  });

  it("si el servidor no confirma un comando del kit, avisa (también a la web) y la pelea sigue", async () => {
    const rejected = "item replace entity AgenteAzul hotbar.1 with minecraft:bow";
    const t = setup({
      rconReply: (command) => (command === rejected ? "Unknown item 'minecraft:bow'" : serverReply(command)),
    });
    await startRunning(t);

    const warnings = t.logs.filter((l) => l.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain(rejected);
    expect(warnings[0]?.text).toContain("Unknown item 'minecraft:bow'");
    expect(t.hub.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "log", level: "warn" }));
  });

  it("el daño que un peleador se hace solo no se le acredita al rival, pero sí se informa", async () => {
    const t = setup();
    await startRunning(t);

    t.ev("red").onDamageTaken(4, 16, false);
    t.ev("red").onDamageTaken(2.5, 13.5, true);

    const state = t.manager.getState();
    expect(state.agents.red.health).toBe(13.5);
    expect(state.agents.blue.damageDealt).toBe(4);
    expect(t.hub.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "damage", side: "red", amount: 2.5, health: 13.5 }),
    );
  });

  it("al terminar la pelea borra los bloques que colocaron los peleadores", async () => {
    const t = setup();
    await startRunning(t);
    expect(t.rconCommands.some((c) => c.includes("replace minecraft:oak_planks"))).toBe(false);
    await t.manager.stop();
    await vi.waitFor(() =>
      expect(t.rconCommands.some((c) => c.endsWith("minecraft:air replace minecraft:oak_planks"))).toBe(true),
    );
  });
});
