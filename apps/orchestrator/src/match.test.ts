import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionReport, FighterEvents, FighterOptions, Observation, SeriesView } from "@phack/agent";
import type { LlmClient, LlmRequest, LlmResponse, TokenUsage } from "@phack/llm";
import {
  KITS,
  MAX_HEALTH,
  COUNTDOWN_SECONDS,
  MAX_AGENT_MESSAGE_LENGTH,
  MAX_ROUNDS,
  type AgentConfig,
  type CommsMode,
  type MatchMode,
  type MatchRecord,
  type MatchState,
  type Provider,
  type Side,
  type TranscriptEntry,
} from "@phack/protocol";
import { clearPlacedBlocksCommands, teleportCommand, kitEffectCommands } from "./arena";
import { MatchManager, type MatchDeps, type MatchEnv } from "./match";
import { defaultPrompts } from "./store";
import type { SleepFn } from "./util";

/**
 * Pelea completa con dobles: RCON, sueño y luchadores falsos (sin Minecraft ni LLM reales).
 * Los eventos de los agentes se disparan a mano desde el test.
 */

type Complete = (req: LlmRequest) => Promise<LlmResponse>;

/** Observación mínima con la forma de la que arma el agente. */
const OBS: Observation = {
  secondsElapsed: 3,
  health: 20,
  food: 20,
  position: { x: 0, y: 65, z: 0 },
  opponentVisible: true,
  distance: 4,
  opponentHealth: 18,
  opponentRelative: { x: 4, y: 0, z: 0 },
  distanceToWall: 10,
  heldItem: "iron_sword",
  inventory: { iron_sword: 1 },
  currentAction: "wait",
  lastActionResult: "esperando",
};

/** Lo que informa el agente tras una respuesta del LLM. */
function decision(ms: number, usage?: TokenUsage, response: DecisionReport["response"] = { text: "", toolCalls: [] }): DecisionReport {
  return { ms, ...(usage ? { usage } : {}), observation: OBS, response };
}

type SetupOptions = {
  provider?: Provider;
  /** LLM_MODEL del servidor. */
  model?: string;
  complete?: Complete;
  /** Cambios sobre los prompts por defecto de cada lado. */
  prompts?: Partial<Record<Side, Partial<AgentConfig>>>;
  /** Modelos de la lista de permitidos; si falta, todos pasan. */
  allowed?: string[];
  comms?: CommsMode;
  /** Límite de tiempo: encendido si falta. */
  timer?: boolean;
  /** Duración elegida en la web, en segundos; si falta, la del servidor (600 en estos tests). */
  timerSeconds?: number | null;
  /** Tope de seguridad de las peleas sin límite de tiempo, en segundos. */
  maxSeconds?: number;
  /** Respuesta del servidor de Minecraft a cada comando; si falta, la de un servidor sano. */
  rconReply?: (command: string) => string;
  /** Si falta, las pausas no esperan. */
  sleep?: SleepFn;
  /** Una pelea o una serie por rondas; una pelea si falta. */
  mode?: MatchMode;
  /** Reemplaza ROUNDS_REFILL_KIT. */
  refillKit?: boolean;
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
    MATCH_MAX_SECONDS: opts.maxSeconds ?? 1800,
    AGENT_TICK_MS: 1500,
    AGENT_OBSERVATION_RADIUS: 16,
  };
  const events: Partial<Record<Side, FighterEvents>> = {};
  const fighters: Partial<Record<Side, FighterOptions>> = {};
  /** Lo que el orquestador le hizo llegar a cada agente con hear(). */
  const heard: Record<Side, { kind: string; text: string }[]> = { red: [], blue: [] };
  /** Lo que el orquestador le pidió a cada agente: start, pause y resume, en orden. */
  const calls: Record<Side, { call: "start" | "pause" | "resume"; note?: string; series?: SeriesView }[]> = { red: [], blue: [] };
  const rconCommands: string[] = [];
  const logs: { level: string; text: string }[] = [];
  let stored: MatchRecord | null = null;
  const llmCalls: LlmRequest[] = [];
  /** Lo que se escribió en las transcripciones, en orden. */
  const entries: { matchId: string; entry: TranscriptEntry }[] = [];
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
    settings: {
      get: () => ({
        comms: opts.comms ?? "none",
        timer: opts.timer ?? true,
        timerSeconds: opts.timerSeconds ?? null,
        mode: opts.mode ?? "single",
      }),
    },
    history,
    transcripts: {
      append: (matchId, entry) => {
        entries.push({ matchId, entry: structuredClone(entry) });
      },
    },
    createFighter: (o: FighterOptions) => {
      events[o.side] = o.events;
      fighters[o.side] = o;
      return {
        systemPrompt: `sistema ${o.side}: ${o.prompt}`,
        // Como el agente real: al entrar al mundo informa que está conectado.
        connect: async () => {
          o.events.onStatus({ connected: true, alive: true, health: 20, absorption: 0, food: 20, heldItem: "" });
        },
        start: () => {
          calls[o.side].push({ call: "start" });
        },
        pause: (note) => {
          calls[o.side].push({ call: "pause", note });
        },
        resume: (series, note) => {
          calls[o.side].push({ call: "resume", series: { ...series }, note });
        },
        stop: async () => {},
        hear: (kind, text) => {
          heard[o.side].push({ kind, text });
        },
      };
    },
    createLlmClient,
    models: { isAllowed: (id) => allowed === undefined || allowed.includes(id) },
    log: (level, text) => {
      logs.push({ level, text });
    },
    sleep: opts.sleep ?? (async () => {}),
    ...(opts.refillKit !== undefined ? { roundsRefillKit: opts.refillKit } : {}),
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
    heard,
    calls,
    rconCommands,
    logs,
    flushed,
    entries,
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

    t.ev("red").onStatus({ connected: true, alive: true, health: 20, absorption: 0, food: 20, heldItem: "iron_sword" });
    t.ev("red").onDecision(decision(800, { inputTokens: 100, outputTokens: 10 }));
    t.ev("red").onDecision(decision(1201));
    t.ev("red").onDecision(decision(600, { inputTokens: 50, outputTokens: 5 }));

    const red = t.manager.getState().agents.red;
    expect(red).toMatchObject({ heldItem: "iron_sword", tokensIn: 150, tokensOut: 15, avgDecisionMs: 867 });
    expect(t.manager.getState().agents.blue).toMatchObject({ tokensIn: 0, tokensOut: 0, avgDecisionMs: 0, heldItem: "" });

    t.ev("blue").onDeath();
    await vi.waitFor(() => expect(t.history.append).toHaveBeenCalled());
    t.ev("red").onDecision(decision(5000, { inputTokens: 999, outputTokens: 999 }));
    expect(t.manager.getState().agents.red).toMatchObject({ tokensIn: 150, avgDecisionMs: 867 });
    expect(t.stored()?.final.red).toMatchObject({ tokensIn: 150, tokensOut: 15, avgDecisionMs: 867 });
  });

  it("cuenta una decisión por respuesta del LLM, traiga varias acciones o ninguna", async () => {
    const t = setup();
    await startRunning(t);
    const red = (): number => t.manager.getState().agents.red.decisions;

    // Una respuesta con dos acciones: la segunda empieza después, desde la cola.
    t.ev("red").onDecision(
      decision(500, undefined, {
        text: "",
        toolCalls: [
          { name: "eat", args: { reason: "como primero" } },
          { name: "attack", args: { reason: "y después le pego" } },
        ],
      }),
    );
    t.ev("red").onThought("como primero");
    t.ev("red").onAction("eat", { reason: "como primero" }, "empezando a comer");
    expect(red()).toBe(1);
    t.ev("red").onThought("y después le pego");
    t.ev("red").onAction("attack", { reason: "y después le pego" }, "atacando cuerpo a cuerpo con la espada");
    expect(red()).toBe(1);

    // Una respuesta sin herramientas también es una decisión.
    t.ev("red").onDecision(decision(400, undefined, { text: "sigo comiendo", toolCalls: [] }));
    t.ev("red").onThought("sigo comiendo");
    expect(red()).toBe(2);
    expect(t.manager.getState().agents.blue.decisions).toBe(0);

    // Lo que llega después del final no cuenta.
    t.ev("blue").onDeath();
    await vi.waitFor(() => expect(t.history.append).toHaveBeenCalled());
    t.ev("red").onDecision(decision(300));
    expect(red()).toBe(2);
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

describe("MatchManager: desconexión antes de empezar", () => {
  it("si un agente se desconecta en la cuenta regresiva, la pelea termina por error sin ganador", async () => {
    let manager: MatchManager | null = null;
    let dropped = false;
    const t = setup({
      sleep: async () => {
        if (manager === null || manager.getState().countdownEndsAt === null || dropped) return;
        dropped = true;
        t.ev("blue").onStatus({ connected: false, alive: false, health: 0, absorption: 0, food: 20, heldItem: "" });
      },
    });
    manager = t.manager;
    current = t.manager;

    t.manager.start();
    await vi.waitFor(() => expect(t.manager.getState().phase).toBe("finished"));
    expect(t.manager.getState()).toMatchObject({ startedAt: null, result: { winner: null, reason: "error" } });
    expect(t.manager.getState().agents.blue).toMatchObject({ connected: false, alive: false });
    expect(t.logs).toContainEqual({ level: "error", text: "Azul se desconectó del servidor antes de empezar la pelea" });
    // Nunca pasó por "running": no entra al historial.
    expect(t.flushed.some((s) => s.phase === "running")).toBe(false);
    expect(t.history.append).not.toHaveBeenCalled();
  });
});

describe("MatchManager: corazones amarillos al acabarse el tiempo", () => {
  it("cuentan como vida para desempatar", async () => {
    const t = setup();
    await startRunning(t);
    t.ev("red").onStatus({ connected: true, alive: true, health: 16, absorption: 0, food: 20, heldItem: "iron_sword" });
    t.ev("blue").onStatus({ connected: true, alive: true, health: 14, absorption: 4, food: 20, heldItem: "iron_sword" });
    await t.manager["onTimeout"](t.manager["ctx"]!);
    expect(t.manager.getState().result).toMatchObject({ winner: "blue", reason: "timeout_health" });
  });
});

describe("MatchManager: vida máxima", () => {
  it("le da a cada agente la vida máxima antes de curarlo, y la pelea parte con ella", async () => {
    const t = setup();
    await startRunning(t);
    for (const username of ["AgenteRojo", "AgenteAzul"]) {
      const attribute = t.rconCommands.indexOf(`attribute ${username} minecraft:generic.max_health base set ${MAX_HEALTH}`);
      const heal = t.rconCommands.indexOf(`effect give ${username} minecraft:instant_health 1 10 true`);
      expect(attribute).toBeGreaterThanOrEqual(0);
      // Curar antes de subir el máximo lo dejaría con la vida de antes.
      expect(heal).toBeGreaterThan(attribute);
    }
    expect(MAX_HEALTH).toBe(30);
    expect(t.manager.getState().agents.red.health).toBe(MAX_HEALTH);
    expect(t.manager.getState().agents.blue.health).toBe(MAX_HEALTH);
    await t.manager.stop();
  });
});

describe("MatchManager: límite de tiempo apagado", () => {
  it("con el límite encendido la pelea tiene hora de término y el agente sabe cuánto dura", async () => {
    const t = setup();
    await startRunning(t);
    const state = t.manager.getState();
    expect(state.endsAt).toBe((state.startedAt ?? 0) + 600_000);
    expect(t.fighters.red?.durationSeconds).toBe(600);
    await t.manager.stop();
  });

  it("con una duración elegida en la web, la pelea dura eso y no lo del servidor", async () => {
    const t = setup({ timerSeconds: 7200 });
    await startRunning(t);
    const state = t.manager.getState();
    expect(state.endsAt).toBe((state.startedAt ?? 0) + 7_200_000);
    expect(state.settings.timerSeconds).toBe(7200);
    expect(t.fighters.red?.durationSeconds).toBe(7200);
    const start = t.entries.map((e) => e.entry).find((entry) => entry.type === "start");
    expect(start).toMatchObject({ durationSeconds: 7200 });
    await t.manager.stop();
  });

  it("con el límite apagado la duración elegida no cuenta", async () => {
    const t = setup({ timer: false, timerSeconds: 7200 });
    await startRunning(t);
    expect(t.manager.getState().endsAt).toBeNull();
    expect(t.fighters.red?.durationSeconds).toBeNull();
    await t.manager.stop();
  });

  it("apagado, la pelea no tiene hora de término ni se acaba por tiempo", async () => {
    const t = setup({ timer: false });
    await startRunning(t);
    const state = t.manager.getState();
    expect(state.phase).toBe("running");
    expect(state.endsAt).toBeNull();
    expect(state.settings.timer).toBe(false);
    expect(t.fighters.red?.durationSeconds).toBeNull();
    expect(t.fighters.blue?.durationSeconds).toBeNull();
    const start = t.entries.map((e) => e.entry).find((entry) => entry.type === "start");
    expect(start).toMatchObject({ durationSeconds: null });
    // Sigue terminando con una muerte.
    t.ev("blue").onDeath();
    await vi.waitFor(() => expect(t.manager.getState().phase).toBe("finished"));
    expect(t.manager.getState().result).toMatchObject({ winner: "red", reason: "kill" });
  });

  it("apagado, el tope de seguridad del servidor la detiene sin ganador", async () => {
    const t = setup({ timer: false, maxSeconds: 60 });
    await startRunning(t);
    await t.manager["onCeiling"](t.manager["ctx"]!);
    expect(t.manager.getState().result).toMatchObject({ winner: null, reason: "stopped" });
    expect(t.logs.some((l) => l.level === "warn" && l.text.includes("tope del servidor"))).toBe(true);
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

    expect(t.fighters.red?.kit.id).toBe("berserker");
    expect(t.fighters.blue?.kit.id).toBe("classic");
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
    expect(t.rconCommands.some((c) => c.includes("air replace"))).toBe(false);
    await t.manager.stop();
    await vi.waitFor(() => {
      for (const filter of ["#minecraft:planks", "#minecraft:wool", "minecraft:water", "minecraft:lava"]) {
        expect(t.rconCommands.some((c) => c.endsWith(`minecraft:air replace ${filter}`))).toBe(true);
      }
    });
  });
});

describe("MatchManager: comunicación entre agentes", () => {
  it("sin comunicación no le pasa nada al rival", async () => {
    const t = setup({ comms: "none" });
    await startRunning(t);
    expect(t.fighters.red?.comms).toBe("none");
    t.ev("red").onThought("voy por la espalda");
    t.ev("red").onMessage("tregua?");
    expect(t.heard.blue).toEqual([]);
    expect(t.hub.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "message" }));
  });

  it('en "thoughts" el rival recibe los razonamientos pero no hay mensajes', async () => {
    const t = setup({ comms: "thoughts" });
    await startRunning(t);
    t.ev("red").onThought("voy por la espalda");
    t.ev("blue").onMessage("hola");
    expect(t.heard.blue).toEqual([{ kind: "thought", text: "voy por la espalda" }]);
    expect(t.heard.red).toEqual([]);
    expect(t.manager.getState().settings).toEqual({ comms: "thoughts", timer: true, timerSeconds: null, mode: "single" });
  });

  it('en "chat" los mensajes llegan al rival y al público; los razonamientos no', async () => {
    const t = setup({ comms: "chat" });
    await startRunning(t);
    t.ev("blue").onThought("le voy a mentir");
    t.ev("blue").onMessage("no tengo flechas, en serio");
    expect(t.heard.red).toEqual([{ kind: "message", text: "no tengo flechas, en serio" }]);
    expect(t.hub.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "message", side: "blue", text: "no tengo flechas, en serio" }),
    );
    t.ev("red").onDeath();
    await vi.waitFor(() => expect(t.history.append).toHaveBeenCalled());
    expect(t.stored()?.settings).toEqual({ comms: "chat", timer: true, timerSeconds: null, mode: "single" });
  });

  it("pasa la duración de la pelea al agente", async () => {
    const t = setup();
    await startRunning(t);
    expect(t.fighters.blue?.durationSeconds).toBe(600);
  });
});

describe("MatchManager: kit personalizado", () => {
  const defineKit = async (req: LlmRequest): Promise<LlmResponse> => {
    if (req.tools[0]?.name === "define_kit") {
      return {
        text: "",
        toolCalls: [
          {
            id: "1",
            name: "define_kit",
            args: {
              items: [
                { item: "diamond_sword", enchantments: [{ id: "sharpness", level: 2 }] },
                { item: "golden_apple", count: 3 },
                { item: "tnt", count: 5 },
              ],
            },
          },
        ],
      };
    }
    return { text: "Explicación.", toolCalls: [] };
  };

  it("arma el kit con el LLM del lado y lo entrega por RCON", async () => {
    const t = setup({
      complete: defineKit,
      prompts: { red: { kit: "custom", prompt: "Llevo espada de diamante con filo II y 3 manzanas doradas" } },
    });
    await startRunning(t);
    const kit = t.fighters.red?.kit;
    expect(kit?.id).toBe("custom");
    expect(kit?.items.map((i) => [i.item, i.count])).toEqual([
      ["diamond_sword", 1],
      ["golden_apple", 3],
    ]);
    expect(t.manager.getState().configs.red.customKit?.items).toHaveLength(2);
    expect(t.fighters.blue?.kit.id).toBe("classic");
    expect(t.rconCommands).toContain(
      'item replace entity AgenteRojo hotbar.0 with minecraft:diamond_sword{Enchantments:[{id:"minecraft:sharpness",lvl:2s}]}',
    );
    expect(t.logs.some((l) => l.level === "warn" && l.text.includes("tnt"))).toBe(true);
  });

  it("si el LLM no entrega inventario pelea con el kit por defecto y lo avisa", async () => {
    const t = setup({ prompts: { blue: { kit: "custom", prompt: "solo sé valiente" } } });
    await startRunning(t);
    expect(t.fighters.blue?.kit.id).toBe("classic");
    expect(t.manager.getState().configs.blue.kit).toBe("classic");
    expect(t.manager.getState().configs.blue.customKit).toBeUndefined();
    expect(t.logs.some((l) => l.level === "warn" && l.text.includes("kit personalizado"))).toBe(true);
  });

  it("con el LLM simulado no intenta armarlo", async () => {
    const t = setup({ provider: "mock", prompts: { red: { kit: "custom", prompt: "arco y 64 flechas" } } });
    await startRunning(t);
    expect(t.fighters.red?.kit.id).toBe("classic");
    expect(t.llmCalls).toHaveLength(0);
  });
});

describe("MatchManager: transcripción", () => {
  it("conserva el perfil de bytes junto con los tokens reales y valida su contrato", async () => {
    const t = setup();
    await startRunning(t);
    const contextProfile = { totalBytes: 25_000, systemBytes: 9000, toolsBytes: 9000, observationBytes: 4000, historyBytes: 2500, historyMessages: 8, observationFields: { world: 2000 } };
    t.ev("red").onDecision({ ...decision(700, { inputTokens: 7000, outputTokens: 40 }), contextProfile });
    const entry = t.entries.find(({ entry }) => entry.type === "decision")?.entry;
    expect(entry).toMatchObject({ tokensIn: 7000, tokensOut: 40, contextProfile });
    // Los lectores de transcripciones no deben eliminar el perfil al validar con zod.
    const { parseTranscript } = await import("@phack/protocol");
    expect(parseTranscript(`${JSON.stringify(entry)}\n`)[0]).toMatchObject({ contextProfile });
    await t.manager.stop();
  });
  it("empieza con start, anota la pelea en orden y termina con end", async () => {
    const t = setup({ comms: "chat" });
    await startRunning(t);
    const id = t.manager.getState().id;

    t.ev("blue").onStatus({ connected: true, alive: true, health: 20, absorption: 0, food: 20, heldItem: "bow" });
    t.ev("blue").onStatus({ connected: true, alive: true, health: 20, absorption: 0, food: 20, heldItem: "bow" });
    t.ev("blue").onStatus({ connected: true, alive: true, health: 20, absorption: 0, food: 19, heldItem: "bow" });
    t.ev("red").onDecision(
      decision(
        700,
        { inputTokens: 10, outputTokens: 2 },
        {
          text: "voy",
          toolCalls: [
            { name: "attack", args: { reason: "voy por él", say: "ahí voy" } },
            { name: "volar", args: { alto: 100 } },
          ],
        },
      ),
    );
    t.ev("red").onThought("voy por él");
    t.ev("red").onMessage("ahí voy");
    t.ev("red").onAction("attack", { reason: "voy por él" }, "atacando cuerpo a cuerpo con la espada");
    t.ev("blue").onDamageTaken(4, 16, false);
    t.ev("blue").onDeath();
    await vi.waitFor(() => expect(t.history.update).toHaveBeenCalled());

    const entries = t.entries.map((e) => e.entry);
    expect(t.entries.every((e) => e.matchId === id)).toBe(true);
    const start = entries[0];
    expect(start?.type).toBe("start");
    if (start?.type === "start") {
      expect(start.matchId).toBe(id);
      expect(start.configs.red).toMatchObject({ provider: "vercel", kit: "classic" });
      expect(start.settings).toEqual({ comms: "chat", timer: true, timerSeconds: null, mode: "single" });
      expect(start.systemPrompts.red).toMatch(/^sistema red:/);
      expect(start.systemPrompts.blue).toMatch(/^sistema blue:/);
      expect(start.tickMs).toBe(1500);
      expect(start.durationSeconds).toBe(600);
    }
    // Lo que se anotó mientras se armaban los agentes va justo después, en orden.
    expect(entries[1]).toMatchObject({ type: "phase", phase: "preparing" });
    expect(entries[2]).toMatchObject({ type: "log", text: "Preparando la pelea…" });

    const types = entries.map((e) => e.type);
    expect(types.filter((type) => type === "start")).toHaveLength(1);
    expect(entries.filter((e) => e.type === "phase").map((e) => e.type === "phase" && e.phase)).toEqual([
      "preparing",
      "running",
      "finished",
    ]);
    // Solo se anota el estado cuando cambia algo: el de la conexión y los dos que cambian.
    expect(entries.filter((e) => e.type === "status" && e.side === "blue")).toHaveLength(3);

    // La respuesta del LLM queda tal cual, también la herramienta que no existe.
    const decided = entries.find((e) => e.type === "decision");
    expect(decided).toMatchObject({ side: "red", ms: 700, tokensIn: 10, tokensOut: 2, observation: { distance: 4 } });
    expect(decided?.type === "decision" && decided.response).toEqual({
      text: "voy",
      toolCalls: [
        { name: "attack", args: { reason: "voy por él", say: "ahí voy" } },
        { name: "volar", args: { alto: 100 } },
      ],
    });

    const order = ["decision", "thought", "message", "action", "damage", "death", "end", "explanation"].map((type) =>
      types.indexOf(type as TranscriptEntry["type"]),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const end = entries.find((e) => e.type === "end");
    expect(end?.type === "end" && end.record.result).toMatchObject({ winner: "red", reason: "kill" });
    expect(entries.find((e) => e.type === "explanation")).toMatchObject({ text: "Rojo ganó atacando sin parar." });
    // Las líneas del registro de la pelea también quedan.
    expect(entries).toContainEqual(expect.objectContaining({ type: "log", text: "¡Comienza la pelea!" }));
    expect(entries).toContainEqual(expect.objectContaining({ type: "log", text: "Ganó Rojo por KO" }));
  });

  it("todo lo que va a la web también queda anotado", async () => {
    const t = setup({ comms: "chat" });
    await startRunning(t);
    t.ev("red").onThought("pienso");
    t.ev("red").onMessage("hola");
    t.ev("red").onAction("wait", {}, "esperando");
    t.ev("red").onDamageTaken(1, 19, false);
    t.ev("red").onDeath();
    await vi.waitFor(() => expect(t.history.append).toHaveBeenCalled());
    const kinds = ["thought", "message", "action", "damage", "death", "log"];
    const broadcast = t.hub.broadcast.mock.calls
      .map(([event]) => event as { type: string })
      .filter((event) => kinds.includes(event.type));
    const recorded = t.entries.map((e) => e.entry).filter((entry) => kinds.includes(entry.type));
    expect(recorded).toEqual(broadcast);
  });

  it("una pelea detenida mientras se prepara igual deja start primero y end", async () => {
    const t = setup();
    current = t.manager;
    t.manager.start();
    await t.manager.stop();
    const entries = t.entries.map((e) => e.entry);
    expect(entries[0]).toMatchObject({ type: "start", systemPrompts: { red: "", blue: "" } });
    expect(entries.map((e) => e.type)).toContain("end");
    expect(entries.map((e) => e.type)).not.toContain("explanation");
    const end = entries.find((e) => e.type === "end");
    expect(end?.type === "end" && end.record.result).toEqual({ winner: null, reason: "stopped" });
  });

  it("si no se puede crear un agente, start va primero con su prompt de sistema vacío", async () => {
    const t = setup();
    const create = t.manager["deps"].createFighter;
    t.manager["deps"].createFighter = (o) => {
      if (o.side === "blue") throw new Error("sin memoria");
      return create(o);
    };
    current = t.manager;
    t.manager.start();
    await vi.waitFor(() => expect(t.entries.some((e) => e.entry.type === "end")).toBe(true));
    const entries = t.entries.map((e) => e.entry);
    expect(entries[0]).toMatchObject({ type: "start" });
    if (entries[0]?.type === "start") {
      expect(entries[0].systemPrompts.red).toMatch(/^sistema red:/);
      expect(entries[0].systemPrompts.blue).toBe("");
    }
    expect(entries).toContainEqual(expect.objectContaining({ type: "log", level: "error", text: expect.stringContaining("sin memoria") }));
  });

  it("los avisos del kit personalizado quedan en la transcripción", async () => {
    const t = setup({ prompts: { blue: { kit: "custom", prompt: "solo sé valiente" } } });
    await startRunning(t);
    const entries = t.entries.map((e) => e.entry);
    expect(entries[0]?.type).toBe("start");
    expect(entries).toContainEqual(
      expect.objectContaining({ type: "log", level: "warn", text: expect.stringContaining("kit personalizado") }),
    );
  });

  it("la explicación que llega tarde va a la transcripción de su pelea aunque ya empezó otra", async () => {
    let explain: (text: string) => void = () => {};
    const t = setup({
      complete: () =>
        new Promise<LlmResponse>((resolve) => {
          explain = (text) => resolve({ text, toolCalls: [] });
        }),
    });
    await startRunning(t);
    const first = t.manager.getState().id;
    t.ev("blue").onDeath();
    await vi.waitFor(() => expect(t.manager.isActive()).toBe(false));

    t.manager.start();
    await vi.waitFor(() => expect(t.manager.getState().phase).toBe("running"));
    const second = t.manager.getState().id;
    expect(second).not.toBe(first);

    explain("Rojo ganó por insistir.");
    await vi.waitFor(() => expect(t.history.update).toHaveBeenCalled());
    const explanation = t.entries.find((e) => e.entry.type === "explanation");
    expect(explanation?.matchId).toBe(first);
    // Cada pelea tiene su propio start.
    expect(t.entries.filter((e) => e.entry.type === "start").map((e) => e.matchId)).toEqual([first, second]);
  });

  it("las decisiones fuera de la pelea viva no se anotan", async () => {
    const t = setup();
    await startRunning(t);
    t.ev("red").onDeath();
    await vi.waitFor(() => expect(t.history.append).toHaveBeenCalled());
    t.ev("blue").onDecision(decision(100));
    expect(t.entries.some((e) => e.entry.type === "decision")).toBe(false);
  });
});

describe("MatchManager: los mensajes entre agentes llegan enteros", () => {
  it("dos mensajes iguales seguidos de un lado se transmiten y entregan los dos", async () => {
    const t = setup({ comms: "chat" });
    await startRunning(t);
    t.ev("red").onMessage("ríndete");
    t.ev("red").onMessage("ríndete");
    const messages = t.hub.broadcast.mock.calls.map(([event]) => event).filter((event) => event.type === "message");
    expect(messages).toEqual([
      expect.objectContaining({ side: "red", text: "ríndete" }),
      expect.objectContaining({ side: "red", text: "ríndete" }),
    ]);
    expect(t.heard.blue).toEqual([
      { kind: "message", text: "ríndete" },
      { kind: "message", text: "ríndete" },
    ]);
    expect(t.entries.filter((e) => e.entry.type === "message")).toHaveLength(2);
  });

  it("no reescribe el texto: saltos de línea, comillas y emojis llegan igual", async () => {
    const t = setup({ comms: "chat" });
    await startRunning(t);
    const text = '"Trato":\n  no te ataco si no me atacas 🤝';
    t.ev("blue").onMessage(text);
    expect(t.heard.red).toEqual([{ kind: "message", text }]);
    // Un mensaje justo en el tope (contado por punto de código) no se vuelve a cortar.
    const full = "😀".repeat(MAX_AGENT_MESSAGE_LENGTH);
    t.ev("blue").onMessage(full);
    expect(t.heard.red[1]?.text).toBe(full);
    // Uno más largo (no debería llegar así del agente) se corta sin partir emojis.
    t.ev("blue").onMessage(`${full}😀`);
    expect(t.heard.red[2]?.text).toBe(full);
  });
});

describe("MatchManager: modo por rondas", () => {
  type T = ReturnType<typeof setup>;
  const series = (t: T) => t.manager.getState().series;
  /** Espera a que empiece la ronda `round`. */
  const roundRunning = async (t: T, round: number): Promise<void> => {
    await vi.waitFor(() => {
      expect(t.manager.getState().phase).toBe("running");
      expect(series(t)?.round).toBe(round);
    });
  };
  /** Mata a `loser` y espera la ronda siguiente. */
  const kill = async (t: T, loser: Side, next: number): Promise<void> => {
    t.ev(loser).onDeath();
    await roundRunning(t, next);
  };
  const timeout = async (t: T): Promise<void> => {
    await t.manager["onTimeout"](t.manager["ctx"]!);
  };
  const healthy = (t: T, side: Side, health: number): void => {
    t.ev(side).onStatus({ connected: true, alive: true, health, absorption: 0, food: 20, heldItem: "iron_sword" });
  };

  it("KO, pausa y ronda siguiente hasta que la serie queda decidida (3-0)", async () => {
    const t = setup({ mode: "rounds" });
    await startRunning(t);
    expect(t.fighters.red?.rounds).toEqual({ maxRounds: MAX_ROUNDS });
    expect(series(t)).toMatchObject({ round: 1, maxRounds: MAX_ROUNDS, wins: { red: 0, blue: 0 }, rounds: [] });
    expect(series(t)?.roundStartedAt).toBe(t.manager.getState().startedAt);
    const startedAt = t.manager.getState().startedAt;

    await kill(t, "blue", 2);
    expect(series(t)).toMatchObject({ wins: { red: 1, blue: 0 }, rounds: [{ round: 1, winner: "red", reason: "kill" }] });
    // El comienzo de la pelea sigue siendo el de la ronda 1.
    expect(t.manager.getState().startedAt).toBe(startedAt);
    await kill(t, "blue", 3);
    t.ev("blue").onDeath();
    await vi.waitFor(() => expect(t.history.append).toHaveBeenCalled());

    expect(t.manager.getState().result).toMatchObject({ winner: "red", reason: "rounds" });
    const record = t.stored();
    expect(record?.series?.wins).toEqual({ red: 3, blue: 0 });
    expect(record?.series?.rounds.map((r) => [r.round, r.winner, r.reason])).toEqual([
      [1, "red", "kill"],
      [2, "red", "kill"],
      [3, "red", "kill"],
    ]);
    // Cada muerte se transmite y cada ronda termina con su evento.
    const broadcast = t.hub.broadcast.mock.calls.map(([event]) => event as { type: string });
    expect(broadcast.filter((e) => e.type === "death")).toHaveLength(3);
    expect(broadcast.filter((e) => e.type === "round_end")).toHaveLength(3);
    expect(t.logs).toContainEqual({ level: "info", text: "Ganó Rojo la serie 3 a 0" });

    // Los mismos agentes toda la serie: se pausan y se reanudan, no se vuelven a crear.
    expect(t.calls.red.map((c) => c.call)).toEqual(["start", "pause", "resume", "pause", "resume", "pause"]);
    expect(t.calls.red[1]?.note).toBe("terminó la ronda 1: la ganaste por K.O.");
    expect(t.calls.blue[2]).toEqual({
      call: "resume",
      series: { round: 2, won: 0, lost: 1, drawn: 0, maxRounds: MAX_ROUNDS },
      note: "terminó la ronda 1: la perdiste por K.O.; empieza la ronda 2",
    });
    expect(t.createLlmClient).toHaveBeenCalledTimes(3);
  });

  it("3-1: la serie sigue mientras el que va abajo pueda alcanzar", async () => {
    const t = setup({ mode: "rounds", provider: "mock" });
    await startRunning(t);
    await kill(t, "blue", 2);
    await kill(t, "red", 3);
    await kill(t, "blue", 4);
    t.ev("blue").onDeath();
    await vi.waitFor(() => expect(t.history.update).toHaveBeenCalled());
    expect(t.manager.getState().result).toMatchObject({ winner: "red", reason: "rounds" });
    expect(t.stored()?.series?.wins).toEqual({ red: 3, blue: 1 });
    expect(t.stored()?.series?.rounds).toHaveLength(4);
    expect(t.manager.getState().result?.explanation).toMatch(/^Rojo ganó la serie 3 a 1: ganó 3 rondas por KO/);
  });

  it("rendirse le da la ronda al otro; fuera de la ronda en juego no cuenta", async () => {
    const t = setup({ mode: "rounds" });
    await startRunning(t);
    t.ev("red").onSurrender();
    // Ya en la pausa: rendirse otra vez no hace nada.
    expect(t.manager.getState().phase).toBe("intermission");
    t.ev("blue").onSurrender();
    expect(series(t)?.rounds).toEqual([{ round: 1, winner: "blue", reason: "surrender", durationMs: expect.any(Number) }]);
    expect(t.logs).toContainEqual({ level: "info", text: "Rojo se rindió en la ronda 1" });
    expect(t.calls.red[1]?.note).toBe("terminó la ronda 1: la perdiste porque te rendiste");
    expect(t.calls.blue[1]?.note).toBe("terminó la ronda 1: la ganaste porque el otro agente se rindió");
    await roundRunning(t, 2);
    expect(series(t)?.wins).toEqual({ red: 0, blue: 1 });
    t.ev("blue").onSurrender();
    expect(t.logs).toContainEqual({ level: "info", text: "Azul se rindió en la ronda 2" });
    await roundRunning(t, 3);
    expect(series(t)?.wins).toEqual({ red: 1, blue: 1 });
  });

  it("ronda por tiempo: más vida gana, la misma vida es empate; y una serie empatada", async () => {
    const t = setup({ mode: "rounds" });
    await startRunning(t);
    expect(t.manager.getState().endsAt).toBe((t.manager.getState().startedAt ?? 0) + 600_000);
    await kill(t, "blue", 2);
    await kill(t, "red", 3);
    // Ronda 3: la misma vida al acabarse el tiempo.
    await timeout(t);
    await roundRunning(t, 4);
    expect(series(t)?.rounds[2]).toMatchObject({ round: 3, winner: null, reason: "draw" });
    // Ronda 4: Azul con menos vida, contando los corazones amarillos de Rojo.
    healthy(t, "blue", 20);
    t.ev("red").onStatus({ connected: true, alive: true, health: 18, absorption: 4, food: 20, heldItem: "" });
    await timeout(t);
    await roundRunning(t, 5);
    expect(series(t)?.rounds[3]).toMatchObject({ round: 4, winner: "red", reason: "timeout_health" });
    expect(t.calls.blue.at(-1)?.note).toBe(
      "terminó la ronda 4: la perdiste por tener menos vida al acabarse el tiempo; empieza la ronda 5",
    );
    expect(t.calls.red.at(-1)?.series).toEqual({ round: 5, won: 2, lost: 1, drawn: 1, maxRounds: MAX_ROUNDS });
    // Ronda 5: gana Azul y la serie queda 2 a 2.
    t.ev("red").onDeath();
    await vi.waitFor(() => expect(t.history.append).toHaveBeenCalled());
    expect(t.manager.getState().result).toMatchObject({ winner: null, reason: "draw" });
    expect(t.stored()?.series).toMatchObject({ wins: { red: 2, blue: 2 }, round: 5 });
    expect(t.stored()?.series?.rounds).toHaveLength(5);
    expect(t.logs).toContainEqual({ level: "info", text: "La serie terminó empatada: 2 a 2 en rondas" });
  });

  it("termina antes si al que va abajo ya no le alcanzan las rondas (2-0 con dos empates)", async () => {
    const t = setup({ mode: "rounds" });
    await startRunning(t);
    await timeout(t);
    await roundRunning(t, 2);
    await timeout(t);
    await roundRunning(t, 3);
    await kill(t, "red", 4);
    t.ev("red").onDeath();
    await vi.waitFor(() => expect(t.history.append).toHaveBeenCalled());
    expect(t.manager.getState().result).toMatchObject({ winner: "blue", reason: "rounds" });
    expect(t.stored()?.series?.rounds).toHaveLength(4);
    expect(t.calls.red.filter((c) => c.call === "resume")).toHaveLength(3);
  });

  it("entre rondas vuelven a su lugar con la vida completa y los efectos de su kit: ni clear ni ítems", async () => {
    const t = setup({ mode: "rounds", prompts: { red: { kit: "berserker" } } });
    await startRunning(t);
    const mark = t.rconCommands.length;
    await kill(t, "blue", 2);
    const between = t.rconCommands.slice(mark);
    expect(between).toEqual([
      ...clearPlacedBlocksCommands(),
      ...(["red", "blue"] as const).flatMap((side) => {
        const name = side === "red" ? "AgenteRojo" : "AgenteAzul";
        return [
          teleportCommand(side),
          `attribute ${name} minecraft:generic.max_health base set ${MAX_HEALTH}`,
          `effect give ${name} minecraft:instant_health 1 10 true`,
          `effect give ${name} minecraft:saturation 1 10 true`,
          // Rojo pelea con el kit Berserker: su efecto permanente vuelve, porque morir lo borra.
          ...(side === "red" ? kitEffectCommands(name, KITS.berserker) : []),
        ];
      }),
    ]);
    expect(kitEffectCommands("AgenteRojo", KITS.berserker).length).toBeGreaterThan(0);
    expect(between.some((c) => c.startsWith("clear ") || c.startsWith("item replace "))).toBe(false);
  });

  it("con ROUNDS_REFILL_KIT el kit se entrega de nuevo antes de cada ronda", async () => {
    const t = setup({ mode: "rounds", refillKit: true });
    await startRunning(t);
    const mark = t.rconCommands.length;
    await kill(t, "blue", 2);
    const between = t.rconCommands.slice(mark);
    expect(between).toContain("clear AgenteRojo");
    expect(between).toContain("item replace entity AgenteAzul hotbar.0 with minecraft:iron_sword");
  });

  it("la vida y el estar vivo vuelven en cada ronda; el daño, las decisiones y los tokens se suman", async () => {
    const t = setup({ mode: "rounds" });
    await startRunning(t);
    t.ev("red").onDecision(decision(500, { inputTokens: 100, outputTokens: 10 }));
    t.ev("blue").onDamageTaken(4, 26, false);
    t.ev("blue").onDeath();
    // En la pausa nada cuenta: ni daño, ni decisiones, ni muertes, ni rendiciones.
    expect(t.manager.getState().phase).toBe("intermission");
    t.ev("blue").onDamageTaken(10, 16, false);
    t.ev("red").onDecision(decision(500, { inputTokens: 999, outputTokens: 999 }));
    t.ev("red").onDeath();
    t.ev("red").onSurrender();
    await roundRunning(t, 2);
    const agents = t.manager.getState().agents;
    expect(agents.blue).toMatchObject({ alive: true, health: MAX_HEALTH });
    expect(agents.red).toMatchObject({ alive: true, health: MAX_HEALTH, damageDealt: 4, decisions: 1, tokensIn: 100 });
    expect(series(t)?.rounds).toHaveLength(1);
    t.ev("blue").onDamageTaken(3, 27, false);
    t.ev("red").onDecision(decision(700, { inputTokens: 50, outputTokens: 5 }));
    expect(t.manager.getState().agents.red).toMatchObject({ damageDealt: 7, decisions: 2, tokensIn: 150, avgDecisionMs: 600 });
    await t.manager.stop();
    expect(t.stored()?.final.red).toMatchObject({ damageDealt: 7, decisions: 2 });
  });

  it("detenerla en la pausa termina toda la serie y no empieza la ronda siguiente", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let manager: MatchManager | null = null;
    const t = setup({
      mode: "rounds",
      // Solo se queda esperando la cuenta regresiva entre rondas.
      sleep: async () => {
        const state = manager?.getState();
        if (state?.phase === "intermission" && state.countdownEndsAt !== null) await gate;
      },
    });
    manager = t.manager;
    await startRunning(t);
    const endedAt = Date.now();
    t.ev("blue").onDeath();
    await vi.waitFor(() => expect(t.manager.getState().countdownEndsAt).not.toBeNull());
    const paused = t.manager.getState();
    expect(paused).toMatchObject({ phase: "intermission", endsAt: null, series: { round: 2, roundStartedAt: null } });
    expect(paused.countdownEndsAt).toBeGreaterThanOrEqual(endedAt + 6000);
    expect(paused.countdownEndsAt).toBeLessThanOrEqual(Date.now() + 6000);
    expect(t.flushed.some((s) => s.phase === "intermission" && s.countdownEndsAt === null)).toBe(true);

    await t.manager.stop();
    expect(t.manager.getState()).toMatchObject({ phase: "finished", countdownEndsAt: null, result: { winner: null, reason: "stopped" } });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.manager.getState().phase).toBe("finished");
    expect(t.calls.red.map((c) => c.call)).toEqual(["start", "pause"]);
    expect(t.stored()?.series?.rounds).toHaveLength(1);
    expect(t.stored()?.result).toEqual({ winner: null, reason: "stopped" });
  });

  it("sin límite de tiempo cada ronda no tiene hora de término y el tope de seguridad corta la serie", async () => {
    const t = setup({ mode: "rounds", timer: false });
    await startRunning(t);
    expect(t.manager.getState().endsAt).toBeNull();
    await kill(t, "blue", 2);
    expect(t.manager.getState().endsAt).toBeNull();
    await t.manager["onCeiling"](t.manager["ctx"]!);
    expect(t.manager.getState().result).toEqual({ winner: null, reason: "stopped" });
    expect(t.stored()?.series?.rounds).toHaveLength(1);
  });

  it("la transcripción anota el comienzo y el final de cada ronda", async () => {
    const t = setup({ mode: "rounds" });
    await startRunning(t);
    await kill(t, "blue", 2);
    await kill(t, "red", 3);
    await t.manager.stop();
    const entries = t.entries.map((e) => e.entry);
    const rounds = entries.filter((e) => e.type === "round_start" || e.type === "round_end" || e.type === "phase");
    expect(rounds.map((e) => (e.type === "phase" ? e.phase : e.type === "round_start" ? `start ${e.round}` : `end ${e.result.round}`))).toEqual([
      "preparing",
      "running",
      "start 1",
      "end 1",
      "intermission",
      "running",
      "start 2",
      "end 2",
      "intermission",
      "running",
      "start 3",
      "finished",
    ]);
    const end = entries.find((e) => e.type === "round_end");
    expect(end).toMatchObject({ result: { round: 1, winner: "red", reason: "kill" }, series: { wins: { red: 1, blue: 0 } } });
    const last = entries.find((e) => e.type === "end");
    expect(last?.type === "end" && last.record.series?.rounds).toHaveLength(2);
    expect(entries).toContainEqual(expect.objectContaining({ type: "log", text: "¡Comienza la ronda 2!" }));
    // Lo que va a la web también queda anotado, con el evento de cada ronda.
    const sent = t.hub.broadcast.mock.calls.map(([event]) => event as { type: string }).filter((e) => e.type === "round_end");
    expect(entries.filter((e) => e.type === "round_end")).toEqual(sent);
  });

  it("si un agente se desconecta entre rondas, la serie termina por error", async () => {
    const t = setup({ mode: "rounds" });
    await startRunning(t);
    t.ev("blue").onDeath();
    t.ev("red").onStatus({ connected: false, alive: false, health: 0, absorption: 0, food: 20, heldItem: "" });
    await vi.waitFor(() => expect(t.manager.getState().phase).toBe("finished"));
    expect(t.manager.getState().result).toEqual({ winner: null, reason: "error" });
    expect(t.logs).toContainEqual({ level: "error", text: "Rojo se desconectó del servidor entre rondas" });
  });
});

describe("MatchManager: una sola pelea no cambia", () => {
  it("sin serie, una muerte termina la pelea y rendirse no hace nada", async () => {
    const t = setup();
    await startRunning(t);
    expect(t.manager.getState().series).toBeNull();
    expect(t.fighters.red?.rounds).toBeNull();
    t.ev("red").onSurrender();
    expect(t.manager.getState().phase).toBe("running");
    expect(t.logs.some((l) => l.text.includes("rindió"))).toBe(false);
    t.ev("blue").onDeath();
    await vi.waitFor(() => expect(t.history.append).toHaveBeenCalled());
    expect(t.manager.getState().result).toMatchObject({ winner: "red", reason: "kill" });
    expect(t.stored()?.series).toBeNull();
    expect(t.calls.red.map((c) => c.call)).toEqual(["start"]);
    expect(t.entries.some((e) => e.entry.type === "round_start" || e.entry.type === "round_end")).toBe(false);
  });
});
