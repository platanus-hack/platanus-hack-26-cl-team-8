import { afterEach, describe, expect, it, vi } from "vitest";
import type { FighterEvents, FighterOptions } from "@phack/agent";
import type { LlmClient, LlmRequest, LlmResponse } from "@phack/llm";
import type { MatchRecord, Provider, Side } from "@phack/protocol";
import { MatchManager, type MatchDeps, type MatchEnv } from "./match";
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
  return { manager, ev, history, hub, createLlmClient, llmCalls, stored: () => stored };
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
