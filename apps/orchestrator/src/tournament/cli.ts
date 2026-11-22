/**
 * CLI del torneo de modelos (proceso aparte del orquestador, con su propio MatchManager).
 *
 *   pnpm tournament plan [flags]          dry-run: catálogo + endpoints públicos, sin gastar créditos
 *   pnpm tournament create [flags]        congela catálogo, modelos y benchmark en DATA_DIR/tournaments/<id>
 *   pnpm tournament run <id>              corre o reanuda (Ctrl+C = pausa tras la partida en curso)
 *   pnpm tournament pause <id>            pide la pausa a un `run` vivo (archivo PAUSE)
 *   pnpm tournament status <id>           progreso y calibración
 *   pnpm tournament leaderboard <id>      tabla y matriz en la terminal
 *   pnpm tournament speed <id> | --dir    velocidad por modelo junto al Elo (solo lee)
 *   pnpm tournament list                  torneos guardados
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv, type Env } from "@phack/env";
import {
  SELECTABLE_ARENA_SCENARIOS,
  availableArenaScenarios,
  type FrozenModel,
  type MatchAttempt,
  type OmittedLine,
  type TournamentConfig,
  type TournamentLimits,
  type TournamentReport,
} from "@phack/protocol";
import { BENCHMARK_MATCH_SECONDS, benchmarkVersion, sha256 } from "./benchmark";
import {
  CATALOG_URL,
  DEFAULT_PRIORITY_LINES,
  DEFAULT_REFERENCE_ID,
  DEFAULT_REFERENCE_PROVIDER,
  fetchCatalog,
  fetchEndpoints,
  freezeModel,
  resolveCatalog,
} from "./catalog";
import { eligibleModels, parseCatalog } from "../models";
import { buildReport, summarize } from "./report";
import { BenchmarkMismatchError, DEFAULT_OVERHEAD_SECONDS, runTournament } from "./runner";
import { DEFAULT_SEEDS, estimateMatch, planPreview } from "./schedule";
import { createSimRunner } from "./sim";
import { buildSpeedReport, type SpeedReport } from "./speed";
import { FileTournamentStore, TournamentLockedError, acquireLock, parseAttemptLines, readLiveLock } from "./store";
import type { CatalogModel, MatchRunner, ResolvedLine, RunnerState } from "./types";

// ---------- Opciones ----------

const FLAGS = {
  name: { type: "string" },
  "max-minutes": { type: "string", default: "60" },
  "max-matches": { type: "string", default: "1000" },
  "max-usd": { type: "string", default: "10" },
  concurrency: { type: "string", default: "1" },
  "max-candidates": { type: "string", default: "8" },
  "max-attempts": { type: "string", default: "3" },
  "calibration-share": { type: "string", default: "0.5" },
  band: { type: "string", default: "150" },
  z: { type: "string", default: "1.645" },
  "prior-sd": { type: "string", default: "400" },
  scenario: { type: "string" },
  /** Alias de --scenario: el mapa de las partidas. */
  map: { type: "string" },
  reference: { type: "string", default: DEFAULT_REFERENCE_ID },
  "reference-provider": { type: "string", default: DEFAULT_REFERENCE_PROVIDER },
  /** Catálogo desde un archivo JSON local ({ data: [...] }) en vez de descargarlo. */
  catalog: { type: "string" },
  simulate: { type: "boolean", default: false },
  /** speed: carpeta con tournament.json, attempts.jsonl y state.json (p. ej. descargada del servidor). */
  dir: { type: "string" },
  /** speed: league (por defecto), calibration o all. */
  stage: { type: "string", default: "league" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

type Flags = {
  [K in keyof typeof FLAGS]: (typeof FLAGS)[K]["type"] extends "boolean" ? boolean : string | undefined;
};

const USAGE = `Uso: pnpm tournament <comando> [opciones]

Comandos:
  plan                 dry-run: modelos exactos, omitidos, calendario y costo (sin gastar créditos)
  create               congela y escribe el torneo (imprime su id)
  run <id>             corre o reanuda; Ctrl+C pausa al terminar la partida en curso (2.º Ctrl+C corta)
  pause <id>           pide la pausa a un run vivo
  status <id>          progreso y calibración
  leaderboard <id>     ranking oficial (solo liga) y matriz
  speed [<id>]         velocidad y eficiencia por modelo junto al Elo, y su correlación (solo lee)
  list                 torneos guardados

Opciones de speed:
  --dir <carpeta>              leer tournament.json, attempts.jsonl y state.json de esa carpeta
  --stage league               partidas: league | calibration | all
  --json                       salida cruda (SpeedReport)

Opciones de plan/create:
  --name <texto>               nombre del torneo
  --max-minutes 60             límite de reloj total
  --max-matches 1000           máximo de partidas válidas
  --max-usd 10                 gasto máximo (USD)
  --concurrency 1              partidas simultáneas (1 servidor de Minecraft por partida)
  --max-candidates 8           candidatos sin contar la referencia
  --max-attempts 3             intentos por partida ante fallos de infraestructura
  --calibration-share 0.5      fracción de la capacidad para la calibración
  --band 150                   banda de nivel ±Elo respecto de la referencia
  --z 1.645                    z del intervalo de calibración (90 %)
  --prior-sd 400               desviación del prior del Bradley–Terry (Elo)
  --scenario <id>, --map <id>  mapa de todas las partidas: ${SELECTABLE_ARENA_SCENARIOS.join(" | ")}
                               (por defecto ARENA_SCENARIO, que por defecto es platanus)
  --catalog <archivo.json>     usar un catálogo local en vez de descargarlo
  --simulate                   agentes simulados: sin Minecraft, sin claves, sin endpoints
`;

function num(flags: Flags, key: keyof Flags, opts: { min?: number; int?: boolean } = {}): number {
  const raw = flags[key];
  const value = Number(raw);
  const bad =
    typeof raw !== "string" ||
    !Number.isFinite(value) ||
    (opts.int === true && !Number.isInteger(value)) ||
    (opts.min !== undefined && value < opts.min);
  if (bad) throw new UsageError(`--${key} inválido: "${String(raw)}"`);
  return value;
}

export class UsageError extends Error {}

function limitsFrom(flags: Flags): TournamentLimits {
  return {
    maxMinutes: num(flags, "max-minutes", { min: 1 }),
    maxMatches: num(flags, "max-matches", { min: 1, int: true }),
    maxUsd: num(flags, "max-usd", { min: 0 }),
    concurrency: num(flags, "concurrency", { min: 1, int: true }),
    maxCandidates: num(flags, "max-candidates", { min: 1, int: true }),
    calibrationShare: num(flags, "calibration-share", { min: 0 }),
    maxAttempts: num(flags, "max-attempts", { min: 1, int: true }),
  };
}

// ---------- Formato ----------

const out = (text = ""): void => {
  process.stdout.write(`${text}\n`);
};

function table(headers: string[], rows: string[][], right: number[] = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (right.includes(i) ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [fmt(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(fmt)].join("\n");
}

function date(epochSeconds: number | null): string {
  return epochSeconds ? new Date(epochSeconds * 1000).toISOString().slice(0, 10) : "?";
}

const usd = (x: number): string => `${x.toFixed(x < 1 ? 3 : 2)} USD`;
const signed = (x: number): string => `${x >= 0 ? "+" : ""}${Math.round(x)}`;

// ---------- Preparar (plan y create) ----------

type Prepared = {
  catalog: { models: CatalogModel[]; raw: string; fetchedAt: number; source: string };
  reference: FrozenModel;
  candidates: FrozenModel[];
  omitted: OmittedLine[];
  overflow: ResolvedLine[];
  scenario: string;
  tickMs: number;
};

async function loadCatalog(flags: Flags): Promise<Prepared["catalog"]> {
  if (flags.catalog) {
    // pnpm corre el script en apps/orchestrator; INIT_CWD es la carpeta desde donde se llamó.
    const path = resolve(process.env.INIT_CWD ?? process.cwd(), flags.catalog);
    const raw = await readFile(path, "utf8");
    const body = JSON.parse(raw) as { data?: CatalogModel[] };
    if (!Array.isArray(body.data)) throw new Error(`${path} no trae una lista data`);
    return { models: body.data, raw, fetchedAt: Date.now(), source: `file:${path}` };
  }
  return { ...(await fetchCatalog()), source: CATALOG_URL };
}

/**
 * Mapa del torneo. Valen los que el servidor puede construir por partida: Platanus y
 * Chunk Battle comparten el mundo "arena"; con ARENA_SCENARIO=pizza-spleef-2 (otro
 * mundo) solo vale la pizza.
 */
export function scenarioFrom(
  flags: { scenario?: string | undefined; map?: string | undefined },
  env: Pick<Env, "ARENA_SCENARIO">,
): string {
  if (flags.scenario !== undefined && flags.map !== undefined && flags.scenario.trim() !== flags.map.trim()) {
    throw new UsageError(`--scenario "${flags.scenario}" y --map "${flags.map}" no coinciden: usa uno solo`);
  }
  const scenario = (flags.scenario ?? flags.map ?? env.ARENA_SCENARIO).trim();
  const valid: readonly string[] = availableArenaScenarios(env.ARENA_SCENARIO);
  if (!valid.includes(scenario)) {
    throw new UsageError(`--scenario inválido: "${scenario}" (válidos con ARENA_SCENARIO=${env.ARENA_SCENARIO}: ${valid.join(", ")})`);
  }
  return scenario;
}

/**
 * Resuelve el catálogo y congela referencia + candidatos. Sin --simulate consulta los
 * endpoints públicos de cada modelo (no gasta créditos): si la versión más reciente exige
 * razonamiento o no tiene proveedor disponible, la línea se omite y entra la siguiente.
 */
async function prepare(flags: Flags, env: Env, limits: TournamentLimits): Promise<Prepared> {
  const simulate = flags.simulate;
  const catalog = await loadCatalog(flags);
  const referenceId = flags.reference ?? DEFAULT_REFERENCE_ID;
  // Misma lista que el selector de la web (GET /api/models): solo modelos con tools y
  // dentro de MODEL_PRICE_CAP; la referencia se salta el tope.
  const allowed = new Set(parseCatalog({ data: catalog.models }, [referenceId]).map((m) => m.id));
  const resolution = resolveCatalog(eligibleModels({ data: catalog.models }, allowed), {
    priorityLines: DEFAULT_PRIORITY_LINES,
    referenceId,
    maxCandidates: limits.maxCandidates,
  });

  const endpointsOf = async (id: string) => (simulate ? null : fetchEndpoints(id));
  const asMode = (m: FrozenModel): FrozenModel => (simulate ? { ...m, clientProvider: "mock" } : m);

  const ref = freezeModel(resolution.reference, await endpointsOf(resolution.reference.id), {
    isReference: true,
    priority: null,
    pinProvider: flags["reference-provider"] || undefined,
  });
  if ("omittedReason" in ref) throw new Error(`La referencia ${referenceId} no sirve: ${ref.omittedReason}`);

  const omitted = [...resolution.omitted];
  const candidates: FrozenModel[] = [];
  const overflow: ResolvedLine[] = [];
  for (const line of [...resolution.candidates, ...resolution.overflow]) {
    const chosen = line.chosen;
    if (!chosen) continue;
    if (candidates.length >= limits.maxCandidates) {
      overflow.push(line);
      continue;
    }
    let frozen: FrozenModel | { omittedReason: string };
    try {
      frozen = freezeModel(chosen, await endpointsOf(chosen.id), { isReference: false, priority: line.priority });
    } catch (err) {
      frozen = { omittedReason: `inaccesible: no se pudieron leer los endpoints (${err instanceof Error ? err.message : String(err)})` };
    }
    if ("omittedReason" in frozen) omitted.push({ line: line.line, latestId: chosen.id, reason: frozen.omittedReason });
    else candidates.push(asMode(frozen));
  }
  return {
    catalog,
    reference: asMode(ref),
    candidates,
    omitted,
    overflow,
    scenario: scenarioFrom(flags, env),
    tickMs: env.AGENT_TICK_MS,
  };
}

function printPlan(p: Prepared, limits: TournamentLimits, simulate: boolean): void {
  const all = [p.reference, ...p.candidates];
  out(`Catálogo: ${p.catalog.models.length} modelos (${p.catalog.source}), sha256 ${sha256(p.catalog.raw).slice(0, 16)}…`);
  out(`Benchmark: ${benchmarkVersion(p.scenario, BENCHMARK_MATCH_SECONDS, p.tickMs).id} (escenario ${p.scenario}, ${BENCHMARK_MATCH_SECONDS} s, tick ${p.tickMs} ms)`);
  out(`Modo: ${simulate ? "simulado (sin Minecraft ni créditos; endpoints no consultados)" : "real (Minecraft + Vercel AI Gateway)"}`);
  out();
  out("Modelos exactos:");
  out(
    table(
      ["#", "origen", "nombre", "id del gateway", "proveedor", "razonamiento", "versión", "lanzado"],
      all.map((m, i) => [
        i === 0 ? "ref" : String(i),
        m.isReference ? "referencia" : m.priority !== null ? `prioridad ${m.priority + 1}` : "automático",
        m.name,
        m.gatewayId,
        m.inferenceProvider ?? "(gateway)",
        m.reasoning,
        m.version,
        date(m.released),
      ]),
    ),
  );
  out();
  out(`Líneas omitidas (${p.omitted.length}):`);
  if (p.omitted.length === 0) out("  (ninguna)");
  for (const o of p.omitted) out(`  - ${o.line} [${o.latestId || "sin versión en el catálogo"}]: ${o.reason}`);
  out();
  out(`Compatibles fuera por --max-candidates ${limits.maxCandidates} (overflow): ${p.overflow.length}`);
  if (p.overflow.length > 0) {
    out(`  ${p.overflow.slice(0, 8).map((l) => l.chosen?.id ?? l.line).join(", ")}${p.overflow.length > 8 ? ", …" : ""}`);
  }
  out();

  const est = estimateMatch(all, BENCHMARK_MATCH_SECONDS, p.tickMs, DEFAULT_OVERHEAD_SECONDS);
  const preview = planPreview({
    reference: p.reference,
    candidates: p.candidates,
    limits,
    scenarios: [p.scenario],
    est: { minutesPerMatch: est.minutesPerMatch, usdPerMatch: est.usdPerMatch },
  });
  out("Estimación por partida:");
  for (const a of est.assumptions) out(`  - ${a}`);
  if (est.unpriced.length > 0) out(`  - sin precio en el catálogo (cuentan 0 USD): ${est.unpriced.join(", ")}`);
  out(`  ⇒ ${est.minutesPerMatch.toFixed(2)} min y ${usd(est.usdPerMatch)} por partida`);
  out();
  const name = (key: string): string => all.find((m) => m.key === key)?.name ?? key;
  out(`Calendario de calibración (ronda base, semilla ${DEFAULT_SEEDS.calibrationBase}, ida y vuelta):`);
  preview.calibration.pairs.forEach((pair, i) => out(`  ${String(i + 1).padStart(2)}. ${name(pair.a)}  vs  ${name(pair.b)}`));
  out();
  out(
    table(
      ["etapa", "parejas", "partidas", "minutos", "USD"],
      [
        ["calibración base", String(preview.calibration.pairs.length), String(preview.calibration.matches), preview.calibration.minutes.toFixed(1), preview.calibration.usd.toFixed(2)],
        ["calibración adaptativa (máx.)", "-", String(preview.adaptiveMax), "-", "-"],
        [
          `liga (${preview.league.expectedModels} modelos × ${preview.league.seeds} semilla(s))`,
          String(preview.league.pairs),
          String(preview.league.matches),
          preview.league.minutes.toFixed(1),
          preview.league.usd.toFixed(2),
        ],
        ["total (peor caso)", "-", String(preview.total.matches), preview.total.minutes.toFixed(1), preview.total.usd.toFixed(2)],
      ],
      [1, 2, 3, 4],
    ),
  );
  out();
  out(`Capacidad: ${preview.total.capacity} partidas. ¿Cabe en el presupuesto? ${preview.fits ? "sí" : "NO"}`);
  for (const n of preview.notes) out(`  - ${n}`);
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "torneo"
  );
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
}

async function cmdCreate(flags: Flags, env: Env, store: FileTournamentStore): Promise<void> {
  const limits = limitsFrom(flags);
  const p = await prepare(flags, env, limits);
  if (p.candidates.length === 0) throw new Error("No quedó ningún candidato compatible: no se crea el torneo");
  const createdAt = Date.now();
  const name = flags.name ?? `Torneo ${new Date(createdAt).toISOString().slice(0, 16).replace("T", " ")}`;
  let id = `${slug(name)}-${stamp(createdAt)}`;
  for (let i = 2; await store.exists(id); i++) id = `${slug(name)}-${stamp(createdAt)}-${i}`;
  const config: TournamentConfig = {
    id,
    name,
    createdAt,
    catalog: { fetchedAt: p.catalog.fetchedAt, sha256: sha256(p.catalog.raw), source: p.catalog.source },
    benchmark: benchmarkVersion(p.scenario, BENCHMARK_MATCH_SECONDS, p.tickMs),
    reference: p.reference,
    candidates: p.candidates,
    omitted: p.omitted,
    limits,
    rule: { bandElo: num(flags, "band", { min: 0 }), z: num(flags, "z", { min: 0 }), priorSdElo: num(flags, "prior-sd", { min: 1 }) },
    scenarios: [p.scenario],
    seeds: { calibrationBase: DEFAULT_SEEDS.calibrationBase, leagueBase: DEFAULT_SEEDS.leagueBase },
    mode: flags.simulate ? "simulated" : "real",
  };
  printPlan(p, limits, flags.simulate);
  await store.create(config, p.catalog.raw);
  out();
  out(`Torneo creado: ${id}`);
  out(`  carpeta: ${store.dir(id)}`);
  out(`  siguiente paso: pnpm tournament run ${id}`);
}

// ---------- run ----------

async function cmdRun(id: string, env: Env, store: FileTournamentStore, dataDir: string): Promise<number> {
  const config = await store.load(id);
  const current = benchmarkVersion(config.benchmark.scenario, config.benchmark.matchSeconds, config.benchmark.tickMs);

  let runner: MatchRunner;
  let close = async (): Promise<void> => {};
  if (config.mode === "simulated") {
    runner = createSimRunner({ matchSeconds: config.benchmark.matchSeconds, tickMs: config.benchmark.tickMs });
  } else {
    if (!env.VERCEL_API_KEY) throw new Error("Falta VERCEL_API_KEY en el .env: el torneo real usa el proveedor vercel");
    if (config.limits.concurrency > 1) {
      throw new Error("concurrency > 1 necesita un servidor de Minecraft por partida y por ahora hay uno solo: crea el torneo con --concurrency 1");
    }
    // Platanus y Chunk Battle se construyen por partida en el mismo mundo; la pizza es otro.
    const available: readonly string[] = availableArenaScenarios(env.ARENA_SCENARIO);
    const wrong = config.scenarios.find((s) => !available.includes(s));
    if (wrong) {
      throw new Error(
        `El torneo usa el escenario "${wrong}" pero el servidor carga el mundo de ARENA_SCENARIO=${env.ARENA_SCENARIO} ` +
          `(mapas posibles: ${available.join(", ")}): cambia el .env y reinicia Minecraft`,
      );
    }
  }

  const release = await acquireLock(dataDir, id);
  try {
    if (config.mode === "real") {
      // Import diferido: el modo simulado no carga mineflayer ni RCON.
      const { createMinecraftRunner, createRealMatchManager } = await import("./minecraft");
      const real = await createRealMatchManager(env, config.benchmark.tickMs, (level, text) => {
        if (level !== "info") out(`[${level}] ${text}`);
      });
      runner = createMinecraftRunner(real.manager, config.benchmark.matchSeconds);
      close = real.close;
    }
    await store.clearPause(id);

    const abort = new AbortController();
    let pauseAsked = false;
    const onSigint = (): void => {
      if (!pauseAsked) {
        pauseAsked = true;
        out("\nPausa pedida: se termina la partida en curso y se guarda (Ctrl+C otra vez para cortar ya).");
      } else {
        out("\nCortando la partida en curso (no cuenta como intento).");
        abort.abort();
      }
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigint);

    out(`Corriendo ${config.name} (${id}), modo ${config.mode}…`);
    const summary = await runTournament(store, id, runner!, {
      benchmark: current,
      signal: abort.signal,
      pauseRequested: async () => pauseAsked || (await store.pauseRequested(id)),
      log: (text) => out(`· ${text}`),
      onAttempt: (a) => {
        const result =
          a.status === "infra"
            ? `INFRA (${a.error ?? "?"})`
            : a.outcome?.winner
              ? `gana ${a.outcome.winner} (${a.outcome.reason})`
              : "empate";
        out(`  ${a.matchId} #${a.attempt}: ${result}`);
      },
    });
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
    if (summary.paused) await store.clearPause(id);

    out();
    out(
      `Fin de la corrida: etapa ${summary.stage}, ${summary.played} intento(s) nuevos` +
        (summary.stopReason ? `; motivo: ${summary.stopReason}` : ""),
    );
    if (summary.paused) out(`Para reanudar: pnpm tournament run ${id}`);
    out();
    printLeaderboard(buildReport(config, await store.attempts(id), await store.loadState(id)));
    return 0;
  } finally {
    await close().catch(() => {});
    await release();
  }
}

// ---------- status / leaderboard / list ----------

function printProgress(r: TournamentReport): void {
  const p = r.progress;
  out(`${r.config.name} (${r.config.id}) — modo ${r.config.mode}, etapa ${p.stage}`);
  out(
    `  calibración: ${p.calibration.valid}/${p.calibration.planned} válidas, ${p.calibration.infra} intentos infra` +
      ` · liga: ${p.league.valid}/${p.league.planned} válidas, ${p.league.infra} infra, semillas ${p.league.seedsDone}/${p.league.seedsPlanned}`,
  );
  out(
    `  reloj ${p.elapsedMinutes} de ${p.limits.maxMinutes} min · gasto ${usd(p.costUsd)} de ${p.limits.maxUsd} USD` +
      (p.stopReason ? ` · parada: ${p.stopReason}` : ""),
  );
}

function printCalibration(r: TournamentReport): void {
  out(`Calibración (banda ±${r.config.rule.bandElo} Elo, z ${r.config.rule.z}; intervalo en diferencia con la referencia):`);
  out(
    table(
      ["modelo", "diff", "intervalo", "partidas", "rivales", "veredicto", "liga", "por qué"],
      r.calibration.map((c) => [
        c.name,
        signed(c.diff),
        `[${signed(c.lo)}, ${signed(c.hi)}]`,
        String(c.games),
        String(c.opponents),
        c.verdict,
        c.league ? "sí" : "no",
        c.why,
      ]),
      [1, 3, 4],
    ),
  );
}

function printLeaderboard(r: TournamentReport): void {
  printProgress(r);
  out();
  if (r.standings.length === 0) {
    out("Sin ranking oficial todavía (sale solo de partidas válidas de la liga).");
  } else {
    out(`Ranking oficial (liga)${r.provisional ? " — PROVISIONAL" : ""}:`);
    out(
      table(
        ["#", "modelo", "rating", "intervalo", "método", "partidas", "V", "E", "D", "USD", "lat. p50", "lat. p95"],
        r.standings.map((s) => [
          String(s.rank),
          `${s.name}${s.isReference ? " (ref)" : ""}`,
          String(Math.round(s.rating)),
          `[${Math.round(s.lo)}, ${Math.round(s.hi)}]`,
          s.ciMethod,
          String(s.games),
          String(s.wins),
          String(s.draws),
          String(s.losses),
          s.costUsd.toFixed(3),
          `${s.latencyMs.p50} ms`,
          `${s.latencyMs.p95} ms`,
        ]),
        [0, 2, 5, 6, 7, 8, 9, 10, 11],
      ),
    );
    out();
    out("Matriz fila vs columna ((V + 0.5·E) / válidas; \"—\" = sin partidas):");
    const order = r.standings.map((s) => s.model);
    const cell = (row: string, col: string): string => {
      if (row === col) return "·";
      const c = r.matrix.find((m) => m.row === row && m.col === col);
      return c && c.score !== null ? `${Math.round(c.score * 100)}%/${c.games}` : "—";
    };
    out(
      table(
        ["", ...order.map((_, i) => String(i + 1))],
        order.map((row, i) => [`${i + 1}. ${r.standings[i]!.name}`, ...order.map((col) => cell(row, col))]),
        order.map((_, i) => i + 1),
      ),
    );
  }
  if (r.provisionalWhy.length > 0) {
    out();
    out("Provisional porque:");
    for (const w of r.provisionalWhy) out(`  - ${w}`);
  }
}

async function loadAll(store: FileTournamentStore, id: string) {
  return { config: await store.load(id), attempts: await store.attempts(id), state: await store.loadState(id) };
}

/** Los archivos de un torneo sueltos en una carpeta (sin el resto de DATA_DIR). */
async function readTournamentDir(dir: string): Promise<{ config: TournamentConfig; attempts: MatchAttempt[]; state: RunnerState | null }> {
  const base = resolve(dir);
  const read = async (name: string): Promise<string | null> => {
    try {
      return await readFile(resolve(base, name), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };
  const config = await read("tournament.json");
  if (config === null) throw new UsageError(`No hay tournament.json en ${base}`);
  const attempts = await read("attempts.jsonl");
  const state = await read("state.json");
  return {
    config: JSON.parse(config) as TournamentConfig,
    attempts: attempts === null ? [] : parseAttemptLines(attempts),
    state: state === null ? null : (JSON.parse(state) as RunnerState),
  };
}

function printSpeed(r: SpeedReport): void {
  const f = (x: number | null, d = 0): string => (x === null ? "—" : x.toFixed(d));
  const pct = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  out(`Velocidad por modelo · torneo ${r.tournamentId} · partidas ${r.stage}: ${r.validMatches} válidas`);
  out();
  out(
    table(
      ["#", "Modelo", "Elo", "V-E-D", "Parte decis.", "Decis/part.", "Lat. media", "p50", "p95", "Inválidas", "Tok in/dec", "Daño/dec", "USD/dec"],
      r.rows.map((row) => [
        row.rank === null ? "—" : String(row.rank),
        `${row.name}${row.isReference ? " (ref)" : ""}`,
        f(row.rating),
        `${row.wins}-${row.draws}-${row.losses}`,
        pct(row.decisionShare),
        f(row.decisionsPerMatch, 1),
        f(row.latencyMeanMs),
        f(row.latencyP50Ms),
        f(row.latencyP95Ms),
        pct(row.invalidRate),
        f(row.tokensInPerDecision),
        f(row.damagePerDecision, 2),
        row.costPerDecisionUsd === null ? "—" : row.costPerDecisionUsd.toFixed(5),
      ]),
      [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    ),
  );
  out();
  out("Correlación de rangos (Spearman) con el Elo: +1 = sube con el Elo, −1 = baja con el Elo.");
  out(
    table(
      ["Métrica", "rho", "n"],
      r.correlations.map((c) => [c.label, c.rho === null ? "—" : (c.rho >= 0 ? "+" : "") + c.rho.toFixed(2), String(c.n)]),
      [1, 2],
    ),
  );
  out();
  out("Parte decis. = mis decisiones / las de los dos en la misma partida (50% = igual de rápido que el rival).");
  out("Latencias en ms (estado -> acción válida). Con pocos modelos, una rho no es prueba de causa.");
}

async function reportOf(store: FileTournamentStore, id: string): Promise<TournamentReport> {
  return buildReport(await store.load(id), await store.attempts(id), await store.loadState(id));
}

// ---------- main ----------

export async function main(argv: string[]): Promise<number> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({ args, options: FLAGS, allowPositionals: true, strict: true });
  const flags = values as Flags;
  const [command, id] = positionals;
  if (flags.help || !command) {
    out(USAGE);
    return command ? 0 : 1;
  }

  const env = loadEnv();
  const dataDir = resolve(env.DATA_DIR);
  const store = new FileTournamentStore(dataDir);
  const needId = (): string => {
    if (!id) throw new UsageError(`Falta el id: pnpm tournament ${command} <id> (ver pnpm tournament list)`);
    return id;
  };

  switch (command) {
    case "plan": {
      const limits = limitsFrom(flags);
      printPlan(await prepare(flags, env, limits), limits, flags.simulate);
      out();
      out("Dry-run: no se escribió nada ni se gastaron créditos. Para crearlo: pnpm tournament create (mismas opciones).");
      return 0;
    }
    case "create":
      await cmdCreate(flags, env, store);
      return 0;
    case "run":
      return cmdRun(needId(), env, store, dataDir);
    case "pause": {
      const tid = needId();
      await store.load(tid);
      await store.requestPause(tid);
      const lock = await readLiveLock(dataDir);
      out(
        lock?.id === tid
          ? `Pausa pedida: el run (pid ${lock.pid}) termina la partida en curso y sale.`
          : "Pausa pedida, pero no hay un run vivo de este torneo (el próximo run la borra al empezar).",
      );
      return 0;
    }
    case "status": {
      const r = await reportOf(store, needId());
      printProgress(r);
      out();
      printCalibration(r);
      const omitted = r.config.omitted;
      if (omitted.length > 0) {
        out();
        out("Líneas omitidas al crear:");
        for (const o of omitted) out(`  - ${o.line} [${o.latestId || "—"}]: ${o.reason}`);
      }
      return 0;
    }
    case "leaderboard":
      printLeaderboard(await reportOf(store, needId()));
      return 0;
    case "speed": {
      const stage = flags.stage ?? "league";
      if (stage !== "league" && stage !== "calibration" && stage !== "all") {
        throw new UsageError(`--stage inválido: "${stage}" (league | calibration | all)`);
      }
      const { config, attempts, state } = flags.dir ? await readTournamentDir(flags.dir) : await loadAll(store, needId());
      const speed = buildSpeedReport(config, attempts, buildReport(config, attempts, state), stage);
      if (flags.json) out(JSON.stringify(speed, null, 2));
      else printSpeed(speed);
      return 0;
    }
    case "list": {
      const configs = await store.list();
      if (configs.length === 0) {
        out(`No hay torneos en ${store.root}`);
        return 0;
      }
      const rows = [];
      for (const c of configs) {
        const s = summarize(c, await store.attempts(c.id), await store.loadState(c.id));
        rows.push([s.id, s.name, s.mode, s.stage, String(s.models), String(s.validMatches), new Date(s.createdAt).toISOString().slice(0, 16)]);
      }
      out(table(["id", "nombre", "modo", "etapa", "modelos", "válidas", "creado"], rows, [4, 5]));
      return 0;
    }
    default:
      throw new UsageError(`Comando desconocido: ${command}\n\n${USAGE}`);
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      if (err instanceof UsageError || err instanceof BenchmarkMismatchError || err instanceof TournamentLockedError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(2);
      }
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
