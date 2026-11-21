import { describe, expect, it } from "vitest";
import { BENCHMARK_PROMPT, type MatchSpec } from "@phack/protocol";
import type { MatchOutcome, RunOnceOptions, SideOutcome } from "../match";
import { REF_KEY, fakeModel } from "./fixtures";
import { attemptFromOutcome, classifyOutcome, createMinecraftRunner, routingFor, sideStats } from "./minecraft";

const spec: MatchSpec = {
  id: "calibration:platanus:s1:a/x~b/y:vuelta",
  stage: "calibration",
  scenario: "platanus",
  seed: 1,
  a: "a/x",
  b: "b/y",
  leg: "vuelta",
  red: "b/y",
  blue: "a/x",
  round: 0,
};

function side(extra: Partial<SideOutcome> = {}): SideOutcome {
  return {
    provider: "vercel",
    model: "m",
    decisions: 30,
    invalidActions: 1,
    tokensIn: 60_000,
    tokensOut: 4_000,
    costUsd: 0,
    costReportedCalls: 0,
    decisionLatenciesMs: [],
    latencyMs: { count: 29, mean: 800, p50: 700, p95: 1500 },
    llmErrors: 0,
    retryableLlmErrors: 0,
    maxRetryableStreak: 0,
    lastLlmError: null,
    ...extra,
  };
}

function outcome(extra: Partial<MatchOutcome> = {}): MatchOutcome {
  return {
    id: "x",
    reachedRunning: true,
    record: null,
    result: { winner: "red", reason: "kill" },
    error: null,
    disconnected: false,
    startedAt: 1,
    endedAt: 2,
    sides: { red: side(), blue: side() },
    ...extra,
  };
}

describe("classifyOutcome", () => {
  it("valid: traduce el lado ganador a la key del modelo", () => {
    expect(classifyOutcome(spec, outcome())).toEqual({ status: "valid", outcome: { winner: "b/y", reason: "kill" } });
    expect(classifyOutcome(spec, outcome({ result: { winner: "blue", reason: "timeout_health" } }))).toEqual({
      status: "valid",
      outcome: { winner: "a/x", reason: "timeout_health" },
    });
    expect(classifyOutcome(spec, outcome({ result: { winner: null, reason: "draw" } }))).toEqual({
      status: "valid",
      outcome: { winner: null, reason: "draw" },
    });
  });

  it("infra: no empezó, desconexión, error/stopped", () => {
    expect(classifyOutcome(spec, outcome({ reachedRunning: false, error: "sin RCON" })).status).toBe("infra");
    expect(classifyOutcome(spec, outcome({ disconnected: true })).status).toBe("infra");
    expect(classifyOutcome(spec, outcome({ result: { winner: null, reason: "error" } })).status).toBe("infra");
    expect(classifyOutcome(spec, outcome({ result: { winner: null, reason: "stopped" } })).status).toBe("infra");
  });

  it("infra por errores reintentables del LLM: ≥ 3 seguidos o ≥ 20 % de las llamadas", () => {
    const streak = outcome({ sides: { red: side({ maxRetryableStreak: 3, retryableLlmErrors: 3, llmErrors: 3 }), blue: side() } });
    expect(classifyOutcome(spec, streak)).toMatchObject({ status: "infra" });
    const share = outcome({ sides: { red: side(), blue: side({ decisions: 8, llmErrors: 2, retryableLlmErrors: 2, maxRetryableStreak: 1 }) } });
    expect(classifyOutcome(spec, share)).toMatchObject({ status: "infra" });
    // Un error suelto o errores no reintentables (400) no anulan la partida: es derrota por reglas.
    const fine = outcome({ sides: { red: side({ llmErrors: 5, retryableLlmErrors: 1, maxRetryableStreak: 1 }), blue: side() } });
    expect(classifyOutcome(spec, fine).status).toBe("valid");
  });

  it("infra si un lado nunca obtuvo respuesta del LLM (401/402/403: clave, créditos o permisos)", () => {
    // Sin créditos el gateway responde 402 (no reintentable): ningún lado decide, la pelea
    // termina en empate por tiempo y no debe entrar al rating como un empate de verdad.
    const dead = side({ decisions: 0, llmErrors: 12, retryableLlmErrors: 0, maxRetryableStreak: 0, lastLlmError: "402 sin créditos" });
    const both = outcome({ result: { winner: null, reason: "draw" }, sides: { red: dead, blue: dead } });
    expect(classifyOutcome(spec, both)).toMatchObject({ status: "infra" });
    const one = outcome({ result: { winner: "blue", reason: "timeout_health" }, sides: { red: dead, blue: side() } });
    expect(classifyOutcome(spec, one)).toMatchObject({ status: "infra" });
    // Sin errores y sin decisiones (p. ej. murió enseguida) sigue siendo una partida válida.
    const quiet = outcome({ sides: { red: side({ decisions: 0 }), blue: side() } });
    expect(classifyOutcome(spec, quiet).status).toBe("valid");
  });
});

describe("sideStats y costo", () => {
  const model = fakeModel("a/x");
  it("usa el costo informado si hay; si no, estima con el precio congelado", () => {
    expect(sideStats(model, side({ costUsd: 0.05, costReportedCalls: 10 }), null)).toMatchObject({ costUsd: 0.05, costSource: "reported" });
    const est = sideStats(model, side(), { health: 7, damageDealt: 13 });
    expect(est.costSource).toBe("estimated");
    expect(est.costUsd).toBeCloseTo(60_000 * 1e-7 + 4_000 * 4e-7);
    expect(est).toMatchObject({ health: 7, damageDealt: 13, decisions: 30, invalidActions: 1 });
    expect(sideStats({ ...model, pricing: null }, side(), null).costSource).toBe("none");
  });

  it("attemptFromOutcome arma rojo/azul según el spec", () => {
    const models = { "a/x": fakeModel("a/x"), "b/y": fakeModel("b/y") };
    const a = attemptFromOutcome(spec, models, outcome(), 2, 10, 20);
    expect(a).toMatchObject({ matchId: spec.id, attempt: 2, status: "valid", startedAt: 10, endedAt: 20 });
    expect(a.sides.red.model).toBe("b/y");
    expect(a.sides.blue.model).toBe("a/x");
  });
});

describe("createMinecraftRunner", () => {
  it("pide runOnce con el prompt fijo, proveedor congelado, sin explicación y 60 s", async () => {
    const calls: RunOnceOptions[] = [];
    const runner = createMinecraftRunner(
      {
        runOnce: async (opts) => {
          calls.push(opts);
          return outcome();
        },
      },
      60,
    );
    const ref = fakeModel(REF_KEY, { isReference: true, inferenceProvider: "baseten", clientProvider: "vercel" });
    const other = fakeModel("b/y", { clientProvider: "vercel" });
    const s: MatchSpec = { ...spec, a: REF_KEY, b: "b/y", red: REF_KEY, blue: "b/y", leg: "ida" };
    const attempt = await runner.run(s, { [REF_KEY]: ref, "b/y": other }, new AbortController().signal, {
      attempt: 1,
      tournamentId: "t",
    });
    expect(attempt.status).toBe("valid");
    const opts = calls[0]!;
    expect(opts.durationSeconds).toBe(60);
    expect(opts.explain).toBe(false);
    expect(opts.configs.red).toEqual({
      provider: "vercel",
      model: REF_KEY,
      prompt: BENCHMARK_PROMPT,
      gatewayRouting: { order: ["baseten"], only: ["baseten"] },
    });
    expect(opts.configs.blue.prompt).toBe(BENCHMARK_PROMPT);
    expect(opts.configs.blue.gatewayRouting).toBeUndefined();
    expect(routingFor(other)).toBeUndefined();
  });
});
