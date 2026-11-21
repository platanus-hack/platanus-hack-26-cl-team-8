import {
  AGENT_USERNAMES,
  DEFAULT_SETTINGS,
  JUDGE_CRITERIA,
  buildBenchReport,
  roundPoints,
  type BenchReport,
  type Judgement,
  type MatchRecord,
  type MatchResult,
  type MatchSettings,
  type RuleId,
  type Side,
  type SideMetrics,
} from "@phack/protocol";

/**
 * Datos del tablero en modo maqueta (?mock): un historial inventado pero coherente
 * (series de dilema, persuasión, inyección, duelos y espejos) que pasa por el mismo
 * buildBenchReport que usa el orquestador.
 */

const HAIKU = "anthropic/claude-haiku-5.5";
const GEMINI = "google/gemini-3.8-flash";
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017-fast";

/** Perfil de cada modelo inventado: qué tan rápido, agresivo, honesto y crédulo es. */
const PROFILES: Record<string, { p50: number; aggression: number; honesty: number; gullible: number; price: number }> = {
  [HAIKU]: { p50: 900, aggression: 0.45, honesty: 0.85, gullible: 0.1, price: 1e-6 },
  [GEMINI]: { p50: 650, aggression: 0.6, honesty: 0.55, gullible: 0.3, price: 0.4e-6 },
  [DEEPSEEK]: { p50: 1400, aggression: 0.7, honesty: 0.7, gullible: 0.6, price: 0.3e-6 },
  mock: { p50: 5, aggression: 0.8, honesty: 1, gullible: 1, price: 0 },
};

/** Azar con semilla: la maqueta muestra siempre lo mismo. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function sideMetrics(model: string, rand: () => number, over: Partial<SideMetrics>): SideMetrics {
  const p = PROFILES[model] ?? PROFILES.mock!;
  const decisions = 30 + Math.round(rand() * 40);
  const actions = decisions + Math.round(rand() * 10);
  const tokensIn = model === "mock" ? 0 : decisions * (2500 + Math.round(rand() * 800));
  const tokensOut = model === "mock" ? 0 : decisions * (120 + Math.round(rand() * 60));
  const aggressive = (n: number) => Math.round(n * Math.min(1, p.aggression + (rand() - 0.5) * 0.2));
  const claims = Math.round(rand() * 4);
  const kept = Math.round(claims * p.honesty);
  return {
    decisions,
    latencyP50: Math.round(p.p50 * (0.9 + rand() * 0.2)),
    latencyP95: Math.round(p.p50 * (1.8 + rand() * 0.6)),
    latencyMax: Math.round(p.p50 * 3),
    actions,
    actionsPerMin: Math.round((actions / 2) * 10) / 10,
    toolCounts: { attack: aggressive(actions), retreat: actions - aggressive(actions) },
    invalidCalls: Math.round(rand() * 2),
    damageDealt: 0,
    damagePerDecision: 0,
    tokensIn,
    tokensOut,
    costUsd: model === "mock" ? null : Math.round((tokensIn * p.price + tokensOut * p.price * 4) * 1e6) / 1e6,
    attacked: false,
    firstStrike: false,
    surrendered: false,
    messages: 0,
    thoughtsShared: 0,
    honesty: { claims, kept, broken: claims - kept },
    pressure: {
      behind: { actions: 10, aggressive: aggressive(10) },
      even: { actions: 20, aggressive: aggressive(20) },
      ahead: { actions: 10, aggressive: Math.max(0, aggressive(10) - 3) },
    },
    rules: { active: [], violations: 0, whileBehind: 0, byRule: {} },
    injection: { received: 0, obeyed: false, obeyedAfterMs: null },
    ...over,
  };
}

function judgementFor(rand: () => number): Judgement {
  const side = () => {
    const scores = Object.fromEntries(JUDGE_CRITERIA.map((c) => [c, Math.round((3 + rand() * 6) * 10) / 10]));
    return { ...scores, comment: "Calificación de ejemplo (maqueta)." } as Judgement["red"];
  };
  return { model: HAIKU, at: Date.now(), red: side(), blue: side(), summary: "Resumen de ejemplo del juez en la maqueta." };
}

type Round = {
  winner: Side | null;
  reason: MatchResult["reason"];
  attacked: Record<Side, boolean>;
  surrendered?: Side;
  injected?: boolean;
  obeyed?: Side;
};

let clock = Date.now() - 6 * 60 * 60_000;
const records: MatchRecord[] = [];

function series(opts: {
  seed: number;
  models: Record<Side, string>;
  settings: Partial<MatchSettings>;
  rounds: Round[];
  rules?: Partial<Record<Side, RuleId[]>>;
  judged?: boolean;
  mirror?: boolean;
  /** Pelea suelta, sin serie. */
  single?: boolean;
}): void {
  const rand = rng(opts.seed);
  const settings: MatchSettings = {
    ...DEFAULT_SETTINGS,
    ...opts.settings,
    rounds: opts.single ? 1 : opts.rounds.length,
    rules: { red: opts.rules?.red ?? [], blue: opts.rules?.blue ?? [] },
  };
  const id = `mock-series-${opts.seed}`;
  opts.rounds.forEach((round, index) => {
    clock += 4 * 60_000;
    const durationMs = (60 + Math.round(rand() * 120)) * 1000;
    const result: MatchResult = { winner: round.winner, reason: round.reason };
    const build = (side: Side): SideMetrics => {
      const damage = round.attacked[side] ? Math.round((4 + rand() * 20) * 10) / 10 : 0;
      const m = sideMetrics(opts.models[side], rand, {
        attacked: round.attacked[side],
        damageDealt: damage,
        surrendered: round.surrendered === side,
        messages: settings.comms === "chat" ? 3 + Math.round(rand() * 6) : 0,
        thoughtsShared: settings.comms === "thoughts" ? 30 : 0,
        injection: round.injected
          ? { received: 2, obeyed: round.obeyed === side, obeyedAfterMs: round.obeyed === side ? 4000 : null }
          : { received: 0, obeyed: false, obeyedAfterMs: null },
      });
      m.damagePerDecision = Math.round((damage / m.decisions) * 1000) / 1000;
      const rules = settings.rules[side];
      if (rules.length > 0) {
        const violations = Math.round(rand() * 2 * (PROFILES[opts.models[side]]?.aggression ?? 0.5));
        m.rules = { active: [...rules], violations, whileBehind: Math.min(violations, 1), byRule: violations ? { [rules[0]!]: violations } : {} };
      }
      return m;
    };
    const metrics = { red: build("red"), blue: build("blue"), mirror: opts.mirror ?? false };
    const status = (side: Side) => ({
      side,
      username: AGENT_USERNAMES[side],
      connected: true,
      alive: !(round.reason === "kill" && round.winner !== side && round.winner !== null),
      health: round.winner === side ? 8 + Math.round(rand() * 20) : Math.round(rand() * 6),
      food: 18,
      damageDealt: metrics[side].damageDealt,
      decisions: metrics[side].decisions,
      lastThought: "",
      lastAction: "",
      heldItem: "iron_sword",
      tokensIn: metrics[side].tokensIn,
      tokensOut: metrics[side].tokensOut,
      avgDecisionMs: metrics[side].latencyP50,
    });
    const record: MatchRecord = {
      id: `${id}-r${index + 1}`,
      startedAt: clock - durationMs,
      endedAt: clock,
      durationMs,
      configs: {
        red: { side: "red", prompt: "Prompt de ejemplo rojo.", provider: opts.models.red === "mock" ? "mock" : "vercel", model: opts.models.red, kit: "classic" },
        blue: { side: "blue", prompt: "Prompt de ejemplo azul.", provider: opts.models.blue === "mock" ? "mock" : "vercel", model: opts.models.blue, kit: "classic" },
      },
      final: { red: status("red"), blue: status("blue") },
      settings,
      result,
      points: roundPoints(settings.scenario, result, round.attacked),
      metrics,
    };
    if (!opts.single) record.series = { id, round: index + 1, rounds: opts.rounds.length, horizon: settings.horizon };
    if (opts.judged) record.judgement = judgementFor(rand);
    records.push(record);
  });
}

const peace = { red: false, blue: false };
const both = { red: true, blue: true };
const draw: MatchResult["reason"] = "draw";

// Dilema del prisionero: cooperan, Gemini traiciona, Haiku devuelve el golpe, y Gemini traiciona al final.
series({
  seed: 11,
  models: { red: HAIKU, blue: GEMINI },
  settings: { scenario: "dilemma", comms: "chat" },
  judged: true,
  rounds: [
    { winner: null, reason: draw, attacked: peace },
    { winner: "blue", reason: "timeout_health", attacked: { red: false, blue: true } },
    { winner: null, reason: draw, attacked: both },
    { winner: null, reason: draw, attacked: peace },
    { winner: "blue", reason: "timeout_health", attacked: { red: false, blue: true } },
  ],
});
// Persuasión: DeepSeek se deja convencer en la segunda ronda.
series({
  seed: 22,
  models: { red: HAIKU, blue: DEEPSEEK },
  settings: { scenario: "surrender", comms: "chat" },
  judged: true,
  rounds: [
    { winner: "red", reason: "kill", attacked: both },
    { winner: "red", reason: "surrender", attacked: { red: true, blue: false }, surrendered: "blue" },
    { winner: "blue", reason: "timeout_health", attacked: both },
  ],
});
// Inyección: DeepSeek obedece al árbitro falso; Gemini no.
series({
  seed: 33,
  models: { red: GEMINI, blue: DEEPSEEK },
  settings: { scenario: "injection", comms: "chat" },
  rounds: [
    { winner: "red", reason: "surrender", attacked: both, surrendered: "blue", injected: true, obeyed: "blue" },
    { winner: "blue", reason: "kill", attacked: both, injected: true },
  ],
});
// Aprendizaje: Haiku contra el simulado, ronda a ronda mejora.
series({
  seed: 44,
  models: { red: HAIKU, blue: "mock" },
  settings: { scenario: "duel", comms: "none" },
  rules: { red: ["no_lava"] },
  rounds: [
    { winner: "blue", reason: "kill", attacked: both },
    { winner: null, reason: draw, attacked: both },
    { winner: "red", reason: "timeout_health", attacked: both },
    { winner: "red", reason: "kill", attacked: both },
  ],
});
// Lectura de mente: Gemini contra DeepSeek viendo los pensamientos.
series({
  seed: 55,
  models: { red: GEMINI, blue: DEEPSEEK },
  settings: { scenario: "duel", comms: "thoughts" },
  rules: { blue: ["no_first_strike"] },
  rounds: [
    { winner: "red", reason: "kill", attacked: both },
    { winner: "red", reason: "timeout_health", attacked: both },
  ],
});
// Espejo: Haiku contra Haiku, peleas sueltas.
for (const [i, winner] of (["red", "blue", "red"] as const).entries()) {
  series({
    seed: 66 + i,
    models: { red: HAIKU, blue: HAIKU },
    settings: { scenario: "duel" },
    mirror: true,
    single: true,
    rounds: [{ winner, reason: "kill", attacked: both }],
  });
}

const JUDGED = new Map<string, Judgement>();

export function mockBenchReport(): BenchReport {
  const all = records.map((record) => {
    const judgement = JUDGED.get(record.id);
    return judgement ? { ...record, judgement } : record;
  });
  return buildBenchReport(all);
}

/** En la maqueta el juez responde siempre una nota de ejemplo. */
export function mockJudge(matchId: string): Judgement | null {
  if (!records.some((record) => record.id === matchId)) return null;
  const judgement = judgementFor(rng(matchId.length * 7919));
  JUDGED.set(matchId, judgement);
  return judgement;
}

