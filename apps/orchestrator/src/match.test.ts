import { afterEach, describe, expect, it, vi } from "vitest";
import type { FighterEvents, FighterOptions } from "@phack/agent";
import type { LlmClient, LlmRequest, LlmResponse } from "@phack/llm";
import type { MatchRecord, Provider, Side } from "@phack/protocol";
import { MatchActiveError, MatchManager, NOOP_HUB, latencySummary, type MatchDeps, type MatchEnv } from "./match";
import { defaultPrompts } from "./store";

/**
 * Pelea completa con dobles: RCON, sueño y luchadores falsos (sin Minecraft ni LLM reales).
 * Los eventos de los agentes se disparan a mano desde el test.
 */

type Complete = (req: LlmRequest) => Promise<LlmResponse>;

function setup(opts: { provider?: Provider; complete?: Complete } = {}) {
  const env: MatchEnv = {
    LLM_PROVIDER: opts.provider ?? "openai",
    LLM_MODEL: "",
    VERCEL_API_KEY: "",
    OPENAI_API_KEY: "sk-test",
    ANTHROPIC_API_KEY: "",
    OPENROUTER_API_KEY: "",
    AI_GATEWAY_API_KEY: "",
    MC_HOST: "localhost",
    MC_PORT: 25565,
    MC_VERSION: "1.20.4",
    MATCH_DURATION_SECONDS: 600,
    AGENT_TICK_MS: 1500,
  };
  const events: Partial<Record<Side, FighterEvents>> = {};
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
  const hub = { broadcast: vi.fn(), markStateDirty: vi.fn(), flushState: vi.fn() };
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
  const deps: MatchDeps = {
    env,
    rcon: { send: async () => "" },
    hub,
    prompts: { get: defaultPrompts },
    history,
    createFighter: (o: FighterOptions) => {
      events[o.side] = o.events;
      return { connect: async () => {}, start: () => {}, stop: async () => {} };
    },
    createLlmClient,
    log: () => {},
    sleep: async () => {},
  };
  const manager = new MatchManager(deps);
  const ev = (side: Side): FighterEvents => {
    const e = events[side];
    if (!e) throw new Error(`sin eventos para ${side}`);
    return e;
  };
  return { manager, ev, history, hub, createLlmClient, llmCalls, env, stored: () => stored };
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
    expect(t.createLlmClient.mock.calls[2]?.[0]).toMatchObject({ provider: "openai", model: undefined });
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

describe("latencySummary", () => {
  it("media y percentiles por rango más cercano; vacío = ceros", () => {
    expect(latencySummary([])).toEqual({ count: 0, mean: 0, p50: 0, p95: 0 });
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(latencySummary(values)).toEqual({ count: 20, mean: 1050, p50: 1000, p95: 1900 });
    expect(latencySummary([300, Number.NaN, -1, 100])).toEqual({ count: 2, mean: 200, p50: 100, p95: 300 });
  });
});

describe("MatchManager.runOnce", () => {
  const configs = {
    red: {
      provider: "vercel" as const,
      model: "deepseek/deepseek-v4.1-flash-1017-fast",
      prompt: "P fijo",
      gatewayRouting: { order: ["baseten"], only: ["baseten"] },
    },
    blue: { provider: "vercel" as const, model: "openai/gpt-6-luna-fast", prompt: "P fijo" },
  };

  function setupOnce(opts: { connect?: () => Promise<void> } = {}) {
    const t = setup();
    const records: MatchRecord[] = [];
    const created: FighterOptions[] = [];
    const deps: MatchDeps = {
      env: { ...t.env, MATCH_DURATION_SECONDS: 600, VERCEL_API_KEY: "vck" },
      rcon: { send: async () => "" },
      hub: NOOP_HUB,
      // runOnce no usa los prompts de la web.
      prompts: { get: defaultPrompts },
      history: {
        append: async (r) => {
          records.push(r);
        },
        update: async () => false,
      },
      createFighter: (o) => {
        created.push(o);
        return { connect: opts.connect ?? (async () => {}), start: () => {}, stop: async () => {} };
      },
      createLlmClient: t.createLlmClient,
      log: () => {},
      sleep: async () => {},
    };
    const manager = new MatchManager(deps);
    current = manager;
    const ev = (side: Side): FighterEvents => {
      const o = [...created].reverse().find((c) => c.side === side);
      if (!o) throw new Error(`sin eventos para ${side}`);
      return o.events;
    };
    return { manager, ev, records, created, createLlmClient: t.createLlmClient, llmCalls: t.llmCalls };
  }

  it("corre una pelea explícita y devuelve resultado, record y estadísticas por lado", async () => {
    const t = setupOnce();
    const pending = t.manager.runOnce({ configs, durationSeconds: 60 });
    await vi.waitFor(() => expect(t.manager.getState().phase).toBe("running"));
    expect(t.manager.getState().endsAt! - t.manager.getState().startedAt!).toBe(60_000);

    const red = t.ev("red");
    red.onDecision({ ms: 400, decisionMs: 450, usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.001 });
    red.onDecision({ ms: 500, invalid: true, usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.002 });
    red.onLlmError?.({ status: 429, retryable: true, message: "limit" });
    red.onLlmError?.({ status: 503, retryable: true, message: "caído" });
    red.onDecision({ ms: 700, decisionMs: 750 });
    red.onLlmError?.({ status: 429, retryable: true, message: "limit" });
    red.onLlmError?.({ status: 400, retryable: false, message: "malo" });
    t.ev("blue").onDecision({ ms: 900, decisionMs: 950, usage: { inputTokens: 7, outputTokens: 3 } });
    t.ev("blue").onDeath();

    const outcome = await pending;
    expect(outcome.reachedRunning).toBe(true);
    expect(outcome.result).toEqual({ winner: "red", reason: "kill" });
    expect(outcome.error).toBeNull();
    expect(outcome.record?.id).toBe(outcome.id);
    expect(t.records).toHaveLength(1);
    expect(outcome.record?.configs.red).toMatchObject({ prompt: "P fijo", model: configs.red.model });

    expect(outcome.sides.red).toMatchObject({
      provider: "vercel",
      model: configs.red.model,
      decisions: 3,
      invalidActions: 1,
      tokensIn: 200,
      tokensOut: 20,
      costReportedCalls: 2,
      decisionLatenciesMs: [450, 750],
      latencyMs: { count: 2, mean: 600, p50: 450, p95: 750 },
      llmErrors: 4,
      retryableLlmErrors: 3,
      maxRetryableStreak: 2,
      lastLlmError: "malo",
    });
    expect(outcome.sides.red.costUsd).toBeCloseTo(0.003, 10);
    expect(outcome.sides.blue).toMatchObject({ decisions: 1, tokensIn: 7, costUsd: 0, costReportedCalls: 0, llmErrors: 0 });

    // Enrutamiento solo en el lado que lo pidió; sin explicación (no hay tercera llamada).
    expect(t.createLlmClient.mock.calls[0]?.[0]).toMatchObject({
      provider: "vercel",
      model: configs.red.model,
      gatewayRouting: { order: ["baseten"], only: ["baseten"] },
    });
    expect(t.createLlmClient.mock.calls[1]?.[0]).not.toHaveProperty("gatewayRouting");
    expect(t.createLlmClient).toHaveBeenCalledTimes(2);
    expect(t.llmCalls).toHaveLength(0);
    expect(t.created[0]?.prompt).toBe("P fijo");

    // Se puede encadenar otra pelea de inmediato.
    const second = t.manager.runOnce({ configs, durationSeconds: 60 });
    await vi.waitFor(() => expect(t.manager.getState().phase).toBe("running"));
    t.ev("red").onDeath();
    expect((await second).result).toEqual({ winner: "blue", reason: "kill" });
  });

  it("una falla al preparar no llega a running ni al historial, y trae el motivo", async () => {
    const t = setupOnce({
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const outcome = await t.manager.runOnce({ configs, durationSeconds: 60 });
    expect(outcome.reachedRunning).toBe(false);
    expect(outcome.record).toBeNull();
    expect(outcome.result).toEqual({ winner: null, reason: "error" });
    expect(outcome.error).toMatch(/ECONNREFUSED/);
    expect(t.records).toHaveLength(0);
  });

  it("una desconexión en plena pelea queda marcada", async () => {
    const t = setupOnce();
    const pending = t.manager.runOnce({ configs, durationSeconds: 60 });
    await vi.waitFor(() => expect(t.manager.getState().phase).toBe("running"));
    t.ev("blue").onStatus({ connected: false, alive: false, health: 0, food: 0, heldItem: "" });
    const outcome = await pending;
    expect(outcome).toMatchObject({ reachedRunning: true, disconnected: true, result: { reason: "error" } });
    expect(outcome.error).toMatch(/Azul se desconectó/);
  });

  it("la señal detiene la pelea; con otra en curso rechaza", async () => {
    const t = setupOnce();
    const abort = new AbortController();
    const pending = t.manager.runOnce({ configs, durationSeconds: 60, signal: abort.signal });
    await vi.waitFor(() => expect(t.manager.getState().phase).toBe("running"));
    await expect(t.manager.runOnce({ configs, durationSeconds: 60 })).rejects.toBeInstanceOf(MatchActiveError);
    expect(() => t.manager.start()).toThrow(MatchActiveError);
    abort.abort();
    const outcome = await pending;
    expect(outcome.result).toEqual({ winner: null, reason: "stopped" });
    expect(outcome.error).toMatch(/detenida/);
  });

  it("termina por tiempo con la duración pedida", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const t = setupOnce();
      const pending = t.manager.runOnce({ configs, durationSeconds: 60 });
      await vi.waitFor(() => expect(t.manager.getState().phase).toBe("running"));
      t.ev("red").onDamageTaken(5, 15);
      await vi.advanceTimersByTimeAsync(60_000);
      const outcome = await pending;
      expect(outcome.result).toMatchObject({ winner: "blue", reason: "timeout_health" });
    } finally {
      vi.useRealTimers();
    }
  });
});
