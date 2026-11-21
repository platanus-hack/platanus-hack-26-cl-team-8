import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionReport, FighterEvents, FighterOptions, Observation } from "@phack/agent";
import type { LlmClient, TokenUsage } from "@phack/llm";
import { DEFAULT_SETTINGS, type MatchRecord, type Provider, type Side } from "@phack/protocol";
import { MatchActiveError, MatchManager, NOOP_HUB, latencySummary, tournamentSettings, type MatchDeps, type MatchEnv } from "./match";
import { defaultPrompts } from "./store";

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

function decision(extra: Partial<DecisionReport> & { ms: number; usage?: TokenUsage }): DecisionReport {
  return { observation: OBS, response: { text: "", toolCalls: [] }, ...extra };
}

/** Lo que responde un servidor 1.20.4 de verdad: prepareFighter revisa los comandos del kit. */
function serverReply(command: string): string {
  if (command.startsWith("item replace entity ")) return "Replaced a slot on Agente with [Objeto]";
  if (command.startsWith("effect give ")) return "Applied effect Efecto to Agente";
  return "";
}

let current: MatchManager | null = null;
afterEach(async () => {
  await current?.shutdown();
  current = null;
});

describe("latencySummary", () => {
  it("media y percentiles por rango más cercano; vacío = ceros", () => {
    expect(latencySummary([])).toEqual({ count: 0, mean: 0, p50: 0, p95: 0 });
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(latencySummary(values)).toEqual({ count: 20, mean: 1050, p50: 1000, p95: 1900 });
    expect(latencySummary([300, Number.NaN, -1, 100])).toEqual({ count: 2, mean: 200, p50: 100, p95: 300 });
  });
});

describe("tournamentSettings", () => {
  it("una sola pelea a tiempo fijo, sin chat, voz ni juez", () => {
    expect(tournamentSettings(60)).toEqual({
      ...DEFAULT_SETTINGS,
      comms: "none",
      timer: true,
      timerSeconds: 60,
      mode: "single",
      voice: false,
      scenario: "duel",
      rounds: 1,
      judge: false,
      rules: { red: [], blue: [] },
    });
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

  function setupOnce(opts: { connect?: (events: FighterEvents) => Promise<void> } = {}) {
    const env: MatchEnv = {
      LLM_PROVIDER: "vercel",
      LLM_MODEL: "",
      VERCEL_API_KEY: "vck",
      MC_HOST: "localhost",
      MC_PORT: 25565,
      MC_VERSION: "1.20.4",
      MATCH_DURATION_SECONDS: 600,
      MATCH_MAX_SECONDS: 1800,
      AGENT_TICK_MS: 1500,
      AGENT_OBSERVATION_RADIUS: 16,
    };
    const records: MatchRecord[] = [];
    const created: FighterOptions[] = [];
    const llmCalls: unknown[] = [];
    const createLlmClient = vi.fn(
      (o: { provider: Provider; model?: string }): LlmClient => ({
        provider: o.provider,
        model: o.model ?? "modelo",
        complete: async (req) => {
          llmCalls.push(req);
          return { text: "", toolCalls: [] };
        },
      }),
    );
    // Como el agente real: al entrar al mundo informa que está conectado.
    const connected = async (events: FighterEvents): Promise<void> => {
      events.onStatus({ connected: true, alive: true, health: 20, absorption: 0, food: 20, heldItem: "" });
    };
    const deps: MatchDeps = {
      env,
      rcon: { send: async (command) => serverReply(command) },
      hub: NOOP_HUB,
      // runOnce no usa los prompts ni los ajustes de la web.
      prompts: { get: defaultPrompts },
      settings: { get: () => ({ ...DEFAULT_SETTINGS, comms: "chat", timerSeconds: 900, judge: true }) },
      history: {
        append: async (r) => {
          records.push(r);
        },
        update: async () => false,
      },
      transcripts: { append: () => {} },
      // La lista de permitidos de la web no aplica a los modelos del torneo.
      models: { isAllowed: () => false },
      createFighter: (o) => {
        created.push(o);
        return {
          systemPrompt: `sistema ${o.side}: ${o.prompt}`,
          connect: () => (opts.connect ?? connected)(o.events),
          start: () => {},
          pause: () => {},
          resume: () => {},
          stop: async () => {},
          hear: () => {},
        };
      },
      createLlmClient,
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
    return { manager, ev, records, created, createLlmClient, llmCalls };
  }

  it("corre una pelea explícita y devuelve resultado, record y estadísticas por lado", async () => {
    const t = setupOnce();
    const pending = t.manager.runOnce({ configs, durationSeconds: 60 });
    await vi.waitFor(() => expect(t.manager.getState().phase).toBe("running"));
    expect(t.manager.getState().endsAt! - t.manager.getState().startedAt!).toBe(60_000);
    expect(t.manager.getState().settings.comms).toBe("none");

    const red = t.ev("red");
    red.onDecision(decision({ ms: 400, decisionMs: 450, usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.001 }));
    red.onDecision(decision({ ms: 500, invalid: true, usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.002 }));
    red.onLlmError?.({ status: 429, retryable: true, message: "limit" });
    red.onLlmError?.({ status: 503, retryable: true, message: "caído" });
    red.onDecision(decision({ ms: 700, decisionMs: 750 }));
    red.onLlmError?.({ status: 429, retryable: true, message: "limit" });
    red.onLlmError?.({ status: 400, retryable: false, message: "malo" });
    t.ev("blue").onDecision(decision({ ms: 900, decisionMs: 950, usage: { inputTokens: 7, outputTokens: 3 } }));
    t.ev("blue").onDeath();

    const outcome = await pending;
    expect(outcome.reachedRunning).toBe(true);
    expect(outcome.result).toMatchObject({ winner: "red", reason: "kill" });
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

    // Enrutamiento solo en el lado que lo pidió; el modelo no pasa por la lista de permitidos.
    expect(t.createLlmClient.mock.calls[0]?.[0]).toMatchObject({
      provider: "vercel",
      model: configs.red.model,
      gatewayRouting: { order: ["baseten"], only: ["baseten"] },
    });
    expect(t.createLlmClient.mock.calls[1]?.[0]).toMatchObject({ model: configs.blue.model });
    expect(t.createLlmClient.mock.calls[1]?.[0]).not.toHaveProperty("gatewayRouting");
    // Sin explicación ni juez: no hay más clientes ni llamadas.
    expect(t.createLlmClient).toHaveBeenCalledTimes(2);
    expect(t.llmCalls).toHaveLength(0);
    expect(t.created[0]?.prompt).toBe("P fijo");

    // Se puede encadenar otra pelea de inmediato.
    const second = t.manager.runOnce({ configs, durationSeconds: 60 });
    await vi.waitFor(() => expect(t.manager.getState().phase).toBe("running"));
    t.ev("red").onDeath();
    expect((await second).result).toMatchObject({ winner: "blue", reason: "kill" });
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
    t.ev("blue").onStatus({ connected: false, alive: false, health: 0, absorption: 0, food: 0, heldItem: "" });
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
      t.ev("red").onDamageTaken(5, 15, false);
      await vi.advanceTimersByTimeAsync(60_000);
      const outcome = await pending;
      expect(outcome.result).toMatchObject({ winner: "blue", reason: "timeout_health" });
    } finally {
      vi.useRealTimers();
    }
  });
});
