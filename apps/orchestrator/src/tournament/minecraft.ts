/**
 * MatchRunner real: una pelea de Minecraft con MatchManager.runOnce, con las reglas fijas
 * del benchmark (duración congelada, BENCHMARK_PROMPT en ambos lados, proveedor "vercel",
 * razonamiento apagado, sin "por qué ganó") y el proveedor de inferencia congelado
 * (gatewayRouting only/order).
 *
 * Una partida es "infra" (reintentable, fuera del rating) si no llegó a "running", si un
 * bot se desconectó, si el resultado fue "error"/"stopped", o si un lado acumuló errores
 * de LLM reintentables (429, 5xx, red, timeout) por sobre el umbral: ≥ 3 seguidos o
 * ≥ 20 % de sus llamadas, o si un lado tuvo errores de LLM y ninguna respuesta.
 */
import { createFighter } from "@phack/agent";
import type { Env } from "@phack/env";
import { createLlmClient, type GatewayRouting } from "@phack/llm";
import {
  BENCHMARK_PROMPT,
  type FrozenModel,
  type MatchAttempt,
  type MatchSpec,
  type Side,
  type SideStats,
} from "@phack/protocol";
import { applyWorldRules } from "../arena";
import { MatchManager, NOOP_HUB, type MatchOutcome, type RunOnceOptions, type SideOutcome } from "../match";
import { RconClient } from "../rcon";
import { defaultPrompts } from "../store";
import type { LogFn } from "../util";
import type { MatchRunner } from "./types";

/** Umbrales de errores reintentables del LLM que convierten la partida en "infra". */
export const INFRA_RETRYABLE_STREAK = 3;
export const INFRA_RETRYABLE_SHARE = 0.2;

/** Lo que necesita el runner de MatchManager (fácil de falsear en tests). */
export type OnceRunner = { runOnce(opts: RunOnceOptions): Promise<MatchOutcome> };

/** Enrutamiento del gateway para el proveedor congelado (null = el que elija el gateway). */
export function routingFor(model: FrozenModel): GatewayRouting | undefined {
  const routing: GatewayRouting = {};
  if (model.inferenceProvider) {
    routing.order = [model.inferenceProvider];
    routing.only = [model.inferenceProvider];
  }
  // El nivel congelado al crear el torneo: "none" o el mínimo que acepta el modelo.
  if (model.reasoning !== "none") routing.reasoning = model.reasoning;
  return Object.keys(routing).length > 0 ? routing : undefined;
}

/**
 * Motivo de "infra" por errores de LLM de un lado, o null. Además de los umbrales de
 * reintentables, un lado que tuvo errores y ni una respuesta (clave inválida, sin
 * créditos, sin permiso: 401/402/403, que no son reintentables) no jugó: sin esto la
 * pelea terminaría en un empate o derrota "por tiempo" que entraría al rating.
 */
export function llmInfraReason(side: SideOutcome, label: string): string | null {
  if (side.decisions === 0 && side.llmErrors > 0) {
    return `${label}: el LLM no respondió ninguna vez (${side.llmErrors} error(es): ${side.lastLlmError ?? "sin detalle"})`;
  }
  if (side.maxRetryableStreak >= INFRA_RETRYABLE_STREAK) {
    return `${label}: ${side.maxRetryableStreak} errores reintentables del LLM seguidos (${side.lastLlmError ?? "sin detalle"})`;
  }
  const calls = side.decisions + side.llmErrors;
  if (calls > 0 && side.retryableLlmErrors / calls >= INFRA_RETRYABLE_SHARE) {
    return `${label}: ${side.retryableLlmErrors} de ${calls} llamadas al LLM con error reintentable (${side.lastLlmError ?? "sin detalle"})`;
  }
  return null;
}

/** Clasifica un MatchOutcome: valid con ganador (key) o infra con motivo. */
export function classifyOutcome(
  spec: MatchSpec,
  outcome: MatchOutcome,
): { status: "valid"; outcome: NonNullable<MatchAttempt["outcome"]> } | { status: "infra"; error: string } {
  if (!outcome.reachedRunning) return { status: "infra", error: `no llegó a empezar: ${outcome.error ?? "sin detalle"}` };
  if (outcome.disconnected) return { status: "infra", error: `desconexión: ${outcome.error ?? "un bot se desconectó"}` };
  if (outcome.result.reason === "error" || outcome.result.reason === "stopped") {
    return { status: "infra", error: `${outcome.result.reason}: ${outcome.error ?? "sin detalle"}` };
  }
  for (const side of ["red", "blue"] as const) {
    const reason = llmInfraReason(outcome.sides[side], side === "red" ? "rojo" : "azul");
    if (reason) return { status: "infra", error: reason };
  }
  const winnerSide = outcome.result.winner;
  const winner = winnerSide === "red" ? spec.red : winnerSide === "blue" ? spec.blue : null;
  const reason = outcome.result.reason;
  return { status: "valid", outcome: { winner, reason: winner === null ? "draw" : reason } };
}

/** SideStats de un lado: costo informado por el gateway o estimado con el precio congelado. */
export function sideStats(model: FrozenModel, side: SideOutcome, final: { health: number; damageDealt: number } | null): SideStats {
  let costUsd = 0;
  let costSource: SideStats["costSource"] = "none";
  if (side.costReportedCalls > 0) {
    costUsd = side.costUsd;
    costSource = "reported";
  } else if (model.pricing && (side.tokensIn > 0 || side.tokensOut > 0)) {
    costUsd = side.tokensIn * model.pricing.input + side.tokensOut * model.pricing.output;
    costSource = "estimated";
  }
  return {
    model: model.key,
    health: final?.health ?? 20,
    damageDealt: final?.damageDealt ?? 0,
    decisions: side.decisions,
    invalidActions: side.invalidActions,
    tokensIn: side.tokensIn,
    tokensOut: side.tokensOut,
    costUsd,
    costSource,
    latencyMs: side.latencyMs,
    llmErrors: side.llmErrors,
  };
}

/** Convierte el resultado de runOnce en un MatchAttempt. */
export function attemptFromOutcome(
  spec: MatchSpec,
  models: Record<string, FrozenModel>,
  outcome: MatchOutcome,
  attempt: number,
  startedAt: number,
  endedAt: number,
): MatchAttempt {
  const red = models[spec.red]!;
  const blue = models[spec.blue]!;
  const c = classifyOutcome(spec, outcome);
  const final = (side: Side) => outcome.record?.final[side] ?? null;
  return {
    matchId: spec.id,
    attempt,
    status: c.status,
    spec,
    startedAt,
    endedAt,
    outcome: c.status === "valid" ? c.outcome : null,
    error: c.status === "infra" ? c.error : null,
    sides: { red: sideStats(red, outcome.sides.red, final("red")), blue: sideStats(blue, outcome.sides.blue, final("blue")) },
  };
}

/** MatchRunner sobre un MatchManager (o algo con runOnce). */
export function createMinecraftRunner(manager: OnceRunner, matchSeconds: number): MatchRunner {
  return {
    async run(spec, models, signal, info) {
      const red = models[spec.red];
      const blue = models[spec.blue];
      if (!red || !blue) throw new Error(`Modelo desconocido en ${spec.id}`);
      // El escenario se lee de forma diferida en arena.ts/prompt.ts.
      process.env.ARENA_SCENARIO = spec.scenario;
      const startedAt = Date.now();
      const side = (m: FrozenModel) => ({
        provider: m.clientProvider,
        model: m.gatewayId,
        prompt: BENCHMARK_PROMPT,
        gatewayRouting: routingFor(m),
      });
      const outcome = await manager.runOnce({
        configs: { red: side(red), blue: side(blue) },
        durationSeconds: matchSeconds,
        explain: false,
        signal,
      });
      return attemptFromOutcome(spec, models, outcome, info?.attempt ?? 1, startedAt, Date.now());
    },
  };
}

/**
 * Arma un MatchManager propio para el CLI (sin web ni historial de peleas) con el RCON
 * del entorno, y deja el mundo con sus reglas. `close` libera el RCON.
 */
export async function createRealMatchManager(
  env: Env,
  tickMs: number,
  log: LogFn,
): Promise<{ manager: MatchManager; close: () => Promise<void> }> {
  const rcon = new RconClient({ host: env.RCON_HOST, port: env.RCON_PORT, password: env.RCON_PASSWORD, log });
  await rcon.waitUntilReady();
  await applyWorldRules(rcon);
  const manager = new MatchManager({
    env: { ...env, AGENT_TICK_MS: tickMs },
    rcon,
    hub: NOOP_HUB,
    prompts: { get: () => defaultPrompts() },
    history: { append: async () => {}, update: async () => false },
    createFighter,
    createLlmClient,
    log,
  });
  return {
    manager,
    close: async () => {
      await manager.shutdown();
      await rcon.close();
    },
  };
}
