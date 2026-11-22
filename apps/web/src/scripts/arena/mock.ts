/**
 * Modo maqueta del leaderboard (`/arena?mock`): un torneo inventado, generado de forma
 * determinista (ratings ocultos + RNG con semilla), para diseñar la página sin orquestador.
 * Los modelos, sus ratings ocultos, su latencia y su precio se parecen a los de la liga real
 * de nueve modelos, para que la maqueta tenga la misma forma que los datos de verdad.
 * Responde las mismas rutas GET que el servidor:
 *
 *   /arena?mock           liga terminada: cuatro semillas completas
 *   /arena?mock=running   la misma liga a medio camino, con reintentos por infraestructura
 *                         y una pareja que todavía no tiene partidas válidas
 *
 * Los números no salen de un Bradley–Terry de verdad: solo tienen la forma correcta.
 * Se carga con import() dinámico, así que no pesa en el sitio real.
 */
import {
  MAX_HEALTH,
  REFERENCE_RATING,
  TOURNAMENT_ROUTES,
  type CalibrationRow,
  type FrozenModel,
  type Leg,
  type ReasoningLevel,
  type MatchAttempt,
  type MatrixCell,
  type MatchSpec,
  type SideStats,
  type StandingRow,
  type TournamentConfig,
  type TournamentReport,
  type TournamentStage,
  type TournamentSummary,
} from "@phack/protocol";

type Seed = {
  gatewayId: string;
  name: string;
  line: string;
  version: string;
  released: number;
  provider: string | null;
  reasoning: ReasoningLevel;
  /** Rating "verdadero" con el que se sortean los resultados. */
  hidden: number;
  /** Latencia típica por decisión (ms). */
  latency: number;
  /** Costo típico de una decisión (USD). */
  usd: number;
  priority: number | null;
};

const REFERENCE: Seed = {
  gatewayId: "deepseek/deepseek-v4.1-flash-1017-fast",
  name: "DeepSeek V4.1 Flash 1017 Fast",
  line: "deepseek/deepseek-v*-flash",
  version: "4.1 · snapshot 1017 · ruta fast",
  released: 1792195200,
  provider: "baseten",
  reasoning: "none",
  hidden: REFERENCE_RATING,
  latency: 805,
  usd: 0.0027,
  priority: null,
};

const seed = (
  gatewayId: string,
  name: string,
  version: string,
  provider: string,
  reasoning: ReasoningLevel,
  hidden: number,
  latency: number,
  usd: number,
  priority: number,
): Seed => ({
  gatewayId,
  name,
  line: gatewayId.replace(/\d+(\.\d+)?/, "*"),
  version,
  released: 1790035200,
  provider,
  reasoning,
  hidden,
  latency,
  usd,
  priority,
});

const CANDIDATES: Seed[] = [
  seed("openai/gpt-6-luna-fast", "GPT-6 Luna (Fast)", "6 · ruta fast", "openai", "none", 1053, 1388, 0.00088, 0),
  seed("google/gemini-3.8-flash", "Gemini 3.8 Flash", "3.8", "google", "low", 1029, 2336, 0.0047, 1),
  seed("anthropic/claude-haiku-5.5", "Claude Haiku 5.5", "5.5", "anthropic", "none", 1029, 2046, 0.00155, 2),
  seed("alibaba/qwen3.8-flash", "Qwen 3.8 Flash", "3.8", "alibaba", "none", 688, 3511, 0.00066, 3),
  seed("zai/glm-5.3-flash", "GLM 5.3 Flash", "5.3", "boundless", "low", 465, 7658, 0.0008, 4),
  seed("xiaomi/mimo-v2.6-flash", "MiMo V2.6 Flash", "2.6", "boundless", "none", 1138, 1276, 0.00047, 5),
  seed("minimax/minimax-m3.1-flash", "MiniMax-M3.1-Flash", "3.1", "digitalocean", "low", 1219, 1154, 0.00058, 6),
  seed("meta/muse-ember", "Muse Ember", "sin versión", "meta", "minimal", 993, 1186, 0.00074, 7),
];

/** RNG determinista (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function freeze(s: Seed, isReference: boolean, mode: TournamentConfig["mode"]): FrozenModel {
  return {
    key: s.gatewayId,
    name: s.name,
    line: s.line,
    gatewayId: s.gatewayId,
    version: s.version,
    released: s.released,
    inferenceProvider: s.provider,
    clientProvider: mode === "real" ? "vercel" : "mock",
    reasoning: s.reasoning,
    pricing: { input: 0.0000002, output: 0.0000008, cacheRead: null },
    isReference,
    priority: s.priority,
  };
}

function side(model: Seed, health: number, damage: number, random: () => number, mode: TournamentConfig["mode"]): SideStats {
  // Quien tarda más en decidir, decide menos veces en una pelea de un minuto.
  const decisions = Math.max(1, Math.round((60_000 / (model.latency + 2500)) * (0.8 + random() * 0.4)));
  const tokensIn = decisions * 11_000;
  const tokensOut = decisions * 60;
  const latency = model.latency * (0.85 + random() * 0.3);
  return {
    model: model.gatewayId,
    health,
    damageDealt: damage,
    decisions,
    invalidActions: random() < 0.15 ? 1 : 0,
    tokensIn,
    tokensOut,
    costUsd: mode === "real" ? decisions * model.usd : 0,
    costSource: mode === "real" ? "reported" : "none",
    latencyMs: { count: decisions, mean: latency, p50: latency * 0.92, p95: latency * 1.9 },
    llmErrors: 0,
  };
}

function pairsOf<T>(items: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) out.push([items[i]!, items[j]!]);
  return out;
}

type Fixture = { report: TournamentReport; attempts: MatchAttempt[]; summary: TournamentSummary };

type FixtureOptions = {
  id: string;
  name: string;
  mode: TournamentConfig["mode"];
  seed: number;
  createdAt: number;
  leagueSeeds: number;
  /** Partidas de la última semilla que alcanzaron a jugarse (null = todas). */
  lastSeedMatches: number | null;
  /** Pareja de la liga que solo tuvo fallos de infraestructura. */
  brokenPair: [string, string] | null;
  stopReason: string | null;
  stage: TournamentReport["progress"]["stage"];
};

function buildFixture(o: FixtureOptions): Fixture {
  const random = rng(o.seed);
  const scenario = "platanus";
  const all = [REFERENCE, ...CANDIDATES];
  const byId = new Map(all.map((s) => [s.gatewayId, s]));
  const attempts: MatchAttempt[] = [];
  let clock = o.createdAt + 60_000;

  const play = (stage: TournamentStage, seed: number, x: Seed, y: Seed, round: number, broken: boolean): void => {
    const [a, b] = x.gatewayId < y.gatewayId ? [x, y] : [y, x];
    for (const leg of ["ida", "vuelta"] as Leg[]) {
      const red = leg === "ida" ? a : b;
      const blue = leg === "ida" ? b : a;
      const spec: MatchSpec = {
        id: `${stage}:${scenario}:s${seed}:${a.gatewayId}~${b.gatewayId}:${leg}`,
        stage,
        scenario,
        seed,
        a: a.gatewayId,
        b: b.gatewayId,
        leg,
        red: red.gatewayId,
        blue: blue.gatewayId,
        round,
      };
      // De vez en cuando, un 429 antes de la partida válida; en la pareja rota, siempre.
      const failures = broken ? 3 : random() < 0.08 ? 1 : 0;
      for (let n = 1; n <= failures; n++) {
        const startedAt = clock;
        clock += 12_000;
        attempts.push({
          matchId: spec.id,
          attempt: n,
          status: "infra",
          spec,
          startedAt,
          endedAt: clock,
          outcome: null,
          error: n % 2 === 1 ? "429 Too Many Requests del gateway (3 errores seguidos)" : "El bot AgenteAzul se desconectó",
          sides: { red: side(red, MAX_HEALTH, 0, random, o.mode), blue: side(blue, MAX_HEALTH, 0, random, o.mode) },
        });
      }
      if (broken) continue;

      const p = 1 / (1 + 10 ** ((blue.hidden - red.hidden) / 400));
      const roll = random();
      const draw = roll < 0.03;
      const redWins = !draw && random() < p;
      const kill = !draw && random() < 0.55;
      const loserHp = kill ? 0 : 3 + Math.floor(random() * 18);
      const winnerHp = draw ? 9 + Math.floor(random() * 12) : loserHp + 1 + Math.floor(random() * (MAX_HEALTH - loserHp - 1));
      const redHp = draw ? winnerHp : redWins ? winnerHp : loserHp;
      const blueHp = draw ? winnerHp : redWins ? loserHp : winnerHp;
      const startedAt = clock;
      clock += kill ? 30_000 + Math.floor(random() * 30_000) : 61_000;
      attempts.push({
        matchId: spec.id,
        attempt: failures + 1,
        status: "valid",
        spec,
        startedAt,
        endedAt: clock,
        outcome: {
          winner: draw ? null : redWins ? red.gatewayId : blue.gatewayId,
          reason: draw ? "draw" : kill ? "kill" : "timeout_health",
        },
        error: null,
        sides: {
          red: side(red, redHp, MAX_HEALTH - blueHp, random, o.mode),
          blue: side(blue, blueHp, MAX_HEALTH - redHp, random, o.mode),
        },
      });
      clock += 20_000;
    }
  };

  // ---------- Calibración: cada candidato vs DeepSeek + un anillo entre candidatos ----------
  const calibrationBase = 100;
  let round = 0;
  for (const c of CANDIDATES) play("calibration", calibrationBase, c, REFERENCE, round, false);
  round++;
  CANDIDATES.forEach((c, i) => play("calibration", calibrationBase, c, CANDIDATES[(i + 1) % CANDIDATES.length]!, round, false));
  round++;
  // Adaptativa para los pendientes.
  play("calibration", calibrationBase + 1, byId.get("minimax/minimax-m3.1-flash")!, byId.get("openai/gpt-6-luna-fast")!, round, false);
  play("calibration", calibrationBase + 1, byId.get("anthropic/claude-haiku-5.5")!, byId.get("zai/glm-5.3-flash")!, round, false);

  // ---------- Veredictos de calibración ----------
  const rule = { bandElo: 1000, z: 1.645, priorSdElo: 400 };
  const calibrationValid = attempts.filter((a) => a.status === "valid" && a.spec.stage === "calibration");
  const calibration: CalibrationRow[] = CANDIDATES.map((c) => {
    const games = calibrationValid.filter((a) => a.spec.a === c.gatewayId || a.spec.b === c.gatewayId);
    const opponents = new Set(games.map((a) => (a.spec.a === c.gatewayId ? a.spec.b : a.spec.a))).size;
    const diff = c.hidden - REFERENCE_RATING + (random() - 0.5) * 30;
    const se = 190 / Math.sqrt(Math.max(1, games.length / 4));
    const lo = diff - rule.z * se;
    const hi = diff + rule.z * se;
    const verdict = lo >= -rule.bandElo && hi <= rule.bandElo ? "inside" : hi < -rule.bandElo || lo > rule.bandElo ? "outside" : "pending";
    const league = verdict === "inside" || (verdict === "pending" && Math.abs(diff) <= rule.bandElo);
    const why =
      verdict === "inside"
        ? `Intervalo completo dentro de la banda ±${rule.bandElo}: mismo nivel que la referencia.`
        : verdict === "outside"
          ? `Intervalo entero ${diff < 0 ? "por debajo" : "por sobre"} la banda ±${rule.bandElo}: no juega parecido a la referencia.`
          : league
            ? "El intervalo cruza el borde, pero la estimación cae dentro: entra a la liga como provisional."
            : "El intervalo cruza el borde y la estimación cae fuera; sin presupuesto para más cruces.";
    return {
      model: c.gatewayId,
      name: c.name,
      rating: REFERENCE_RATING + diff,
      diff,
      se,
      lo,
      hi,
      games: games.length,
      opponents,
      verdict,
      league,
      why,
    };
  });

  // ---------- Liga: referencia + clasificados, semilla por semilla ----------
  const leagueModels = [REFERENCE, ...CANDIDATES.filter((c) => calibration.find((r) => r.model === c.gatewayId)?.league)];
  const leagueBase = 1000;
  const leaguePairs = pairsOf(leagueModels);
  const isBroken = (x: Seed, y: Seed) =>
    o.brokenPair !== null && o.brokenPair.includes(x.gatewayId) && o.brokenPair.includes(y.gatewayId);
  for (let s = 0; s < o.leagueSeeds; s++) {
    const last = s === o.leagueSeeds - 1;
    const limit = last && o.lastSeedMatches !== null ? o.lastSeedMatches / 2 : leaguePairs.length;
    leaguePairs.slice(0, limit).forEach(([x, y], i) => play("league", leagueBase + s, x, y, round + s * 100 + i, isBroken(x, y)));
  }
  const leagueValid = attempts.filter((a) => a.status === "valid" && a.spec.stage === "league");

  // ---------- Tabla ----------
  const standings: StandingRow[] = leagueModels
    .map((m) => {
      const games = leagueValid.filter((a) => a.spec.a === m.gatewayId || a.spec.b === m.gatewayId);
      const wins = games.filter((a) => a.outcome?.winner === m.gatewayId).length;
      const draws = games.filter((a) => a.outcome?.winner === null).length;
      const isReference = m === REFERENCE;
      const rating = isReference ? REFERENCE_RATING : m.hidden + (random() - 0.5) * 40;
      const half = isReference ? 0 : 1050 / Math.sqrt(Math.max(1, games.length));
      const mine = attempts.flatMap((a) =>
        [a.sides.red, a.sides.blue].filter((s) => s.model === m.gatewayId && a.spec.stage === "league"),
      );
      const fight = { koWins: 0, koLosses: 0, damageDealt: 0, damageTaken: 0, decisions: 0, invalidActions: 0, tokens: 0, costUsd: 0 };
      for (const a of games) {
        const [me, rival] = a.sides.red.model === m.gatewayId ? [a.sides.red, a.sides.blue] : [a.sides.blue, a.sides.red];
        if (a.outcome?.reason === "kill") {
          if (a.outcome.winner === m.gatewayId) fight.koWins++;
          else fight.koLosses++;
        }
        fight.damageDealt += me.damageDealt;
        fight.damageTaken += rival.damageDealt;
        fight.decisions += me.decisions;
        fight.invalidActions += me.invalidActions;
        fight.tokens += me.tokensIn + me.tokensOut;
        fight.costUsd += me.costUsd;
      }
      return {
        rank: 0,
        model: m.gatewayId,
        name: m.name,
        version: m.version,
        gatewayId: m.gatewayId,
        inferenceProvider: m.provider,
        reasoning: m.reasoning,
        isReference,
        rating,
        lo: rating - half,
        hi: rating + half * 1.08,
        ciMethod: o.leagueSeeds >= 5 ? ("bootstrap" as const) : ("laplace" as const),
        games: games.length,
        wins,
        draws,
        losses: games.length - wins - draws,
        costUsd: mine.reduce((sum, s) => sum + s.costUsd, 0),
        latencyMs: {
          p50: m.latency * 0.92,
          p95: m.latency * 1.9,
          count: mine.reduce((sum, s) => sum + s.decisions, 0),
        },
        fight,
      };
    })
    .sort((x, y) => y.rating - x.rating)
    .map((row, i) => ({ ...row, rank: i + 1 }));

  // ---------- Matriz (orden de la tabla) ----------
  const matrix: MatrixCell[] = [];
  for (const row of standings) {
    for (const col of standings) {
      if (row.model === col.model) continue;
      const games = leagueValid.filter(
        (a) => (a.spec.a === row.model && a.spec.b === col.model) || (a.spec.a === col.model && a.spec.b === row.model),
      );
      const wins = games.filter((a) => a.outcome?.winner === row.model).length;
      const draws = games.filter((a) => a.outcome?.winner === null).length;
      matrix.push({
        row: row.model,
        col: col.model,
        games: games.length,
        wins,
        draws,
        losses: games.length - wins - draws,
        score: games.length > 0 ? (wins + 0.5 * draws) / games.length : null,
      });
    }
  }

  const count = (stage: TournamentStage, status: MatchAttempt["status"]) =>
    attempts.filter((a) => a.spec.stage === stage && a.status === status).length;
  // El reloj de la maqueta deja 20 s entre peleas; el torneo real las corre seguidas.
  const elapsedMinutes = attempts.reduce((sum, a) => sum + (a.endedAt - a.startedAt), 0) / 60_000;
  const costUsd = attempts.reduce((sum, a) => sum + a.sides.red.costUsd + a.sides.blue.costUsd, 0);
  const limits = {
    maxMinutes: 240,
    maxMatches: 1000,
    maxUsd: 14,
    concurrency: 1,
    maxCandidates: 8,
    calibrationShare: 0.5,
    maxAttempts: 3,
  };
  const seedsDone = o.lastSeedMatches === null ? o.leagueSeeds : o.leagueSeeds - 1;
  const reference = freeze(REFERENCE, true, o.mode);
  const config: TournamentConfig = {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    catalog: {
      fetchedAt: o.createdAt - 30_000,
      sha256: "3f7a1c9e5b2d8f40a6c1e93b7d2f5a8c0e4b6d1f9a3c7e2b5d8f0a4c6e1b9d3f",
      source: "https://ai-gateway.vercel.sh/v1/models",
    },
    benchmark: {
      id: "pvp-platanus-v2+c5d5264140cf",
      scenario,
      matchSeconds: 60,
      tickMs: 1500,
      promptHash: "a41f0c",
      toolsHash: "77d9be",
    },
    reference,
    candidates: CANDIDATES.map((c) => freeze(c, false, o.mode)),
    omitted: [
      {
        line: "alibaba/qwen*-omni-flash",
        latestId: "alibaba/qwen3.8-omni-flash",
        reason: "La versión más reciente exige razonamiento (reasoning.mandatory): no se puede correr con reasoning \"none\".",
      },
      {
        line: "openai/gpt-*-luna-decisions",
        latestId: "openai/gpt-6-luna-decisions",
        reason: "Sin soporte de tools en el catálogo.",
      },
      {
        line: "google/gemini-*-flash-tts",
        latestId: "google/gemini-3.8-flash-tts",
        reason: "Modelo de voz: la salida no es texto.",
      },
    ],
    limits,
    rule,
    scenarios: [scenario],
    seeds: { calibrationBase, leagueBase },
    mode: o.mode,
  };

  const provisionalWhy: string[] = [];
  if (seedsDone < 5) provisionalWhy.push(`Solo ${seedsDone} semilla(s) completas de la liga; el bootstrap pide al menos 5.`);
  if (o.brokenPair) {
    const [x, y] = o.brokenPair.map((id) => byId.get(id)!.name);
    provisionalWhy.push(`${x} y ${y} todavía no tienen partidas válidas entre sí en la liga.`);
  }
  if (calibration.some((r) => r.league && r.verdict === "pending")) {
    provisionalWhy.push("Hay modelos que entraron a la liga con la calibración pendiente.");
  }

  const report: TournamentReport = {
    config,
    progress: {
      stage: o.stage,
      calibration: { planned: new Set(attempts.filter((a) => a.spec.stage === "calibration").map((a) => a.matchId)).size, valid: count("calibration", "valid"), infra: count("calibration", "infra") },
      league: {
        planned: leaguePairs.length * 2 * 4,
        valid: count("league", "valid"),
        infra: count("league", "infra"),
        seedsPlanned: 4,
        seedsDone,
      },
      elapsedMinutes,
      costUsd,
      limits,
      stopReason: o.stopReason,
    },
    provisional: provisionalWhy.length > 0,
    provisionalWhy,
    standings,
    matrix,
    calibration,
  };

  const summary: TournamentSummary = {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    mode: o.mode,
    stage: o.stage,
    models: leagueModels.length,
    validMatches: calibrationValid.length + leagueValid.length,
  };
  return { report, attempts, summary };
}

let fixtures: Fixture[] | null = null;

function all(): Fixture[] {
  // Un solo torneo a la vez, como ve la página: el terminado o, con ?mock=running, a medio camino.
  const running = new URLSearchParams(window.location.search).get("mock") === "running";
  fixtures ??= [
    buildFixture({
      id: "liga-9-modelos",
      name: "Liga 9 modelos",
      mode: "real",
      seed: 7,
      createdAt: Date.UTC(2026, 10, 21, 23, 7),
      leagueSeeds: running ? 2 : 4,
      lastSeedMatches: running ? 30 : null,
      brokenPair: running ? ["alibaba/qwen3.8-flash", "zai/glm-5.3-flash"] : null,
      stopReason: null,
      stage: running ? "league" : "done",
    }),
  ];
  return fixtures;
}

function fail(status: number, message: string): never {
  throw { status, message };
}

/** Responde una ruta GET del torneo como lo haría el orquestador. */
export async function mockTournamentRequest(path: string): Promise<unknown> {
  await new Promise((resolve) => window.setTimeout(resolve, 150));
  if (path === TOURNAMENT_ROUTES.list) return all().map((f) => f.summary);

  const prefix = TOURNAMENT_ROUTES.list + "/";
  if (!path.startsWith(prefix)) return fail(404, "Ruta no encontrada");
  const parts = path.slice(prefix.length).split("/").map(decodeURIComponent);
  const fixture = all().find((f) => f.report.config.id === parts[0]);
  if (!fixture) return fail(404, "No existe ese torneo.");
  if (parts.length === 1) return fixture.report;
  if (parts.length === 4 && parts[1] === "pairs") {
    const [, , a, b] = parts;
    return fixture.attempts.filter((t) => (t.spec.a === a && t.spec.b === b) || (t.spec.a === b && t.spec.b === a));
  }
  return fail(404, "Ruta no encontrada");
}
