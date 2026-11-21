/**
 * Contrato interno del torneo entre módulos del orquestador. Cada módulo implementa
 * exactamente estas firmas; los tipos de datos que ve la web están en @phack/protocol
 * (packages/protocol/src/tournament.ts).
 */
import type {
  CalibrationRow,
  CalibrationRule,
  FrozenModel,
  MatchAttempt,
  MatchSpec,
  OmittedLine,
  TournamentConfig,
  TournamentLimits,
} from "@phack/protocol";

// ---------- catalog.ts ----------

/** Entrada cruda de https://ai-gateway.vercel.sh/v1/models (solo lo que se usa). */
export type CatalogModel = {
  id: string;
  name?: string;
  released?: number | null;
  type?: string;
  tags?: string[];
  description?: string;
  supported_parameters?: string[];
  reasoning_options?: Array<{ type: string; values?: string[] }>;
  modalities?: { input?: string[]; output?: string[] };
  pricing?: { input?: string; output?: string; input_cache_read?: string } | null;
};

/** De https://ai-gateway.vercel.sh/v1/models/{id}/endpoints (solo lo que se usa). */
export type CatalogEndpoints = {
  reasoning?: { mandatory?: boolean; supported_efforts?: string[] } | null;
  endpoints: Array<{ provider_name: string; status?: number; uptime_last_1h?: number | null }>;
};

/** Una línea de modelos y todas sus versiones/rutas en el catálogo. */
export type ResolvedLine = {
  line: string;
  /** Versión elegida (la más reciente) o null si la más reciente no sirve. */
  chosen: CatalogModel | null;
  /** Todas las ids de la línea, de la más nueva a la más vieja. */
  members: string[];
  /** Motivo si chosen === null (o si se omitió por otra razón). */
  omittedReason: string | null;
  priority: number | null;
};

export type ResolveOptions = {
  /** Líneas prioritarias en orden (claves de línea, ver lineKey). */
  priorityLines: string[];
  /** Id del modelo de referencia: su línea no compite como candidata. */
  referenceId: string;
  maxCandidates: number;
};

export type CatalogResolution = {
  reference: CatalogModel;
  candidates: ResolvedLine[];
  /** Líneas compatibles que no entraron por maxCandidates (no es omisión por error). */
  overflow: ResolvedLine[];
  omitted: OmittedLine[];
};

/*
 * catalog.ts exporta:
 *   lineKey(id: string): { line: string; version: string; snapshot: string | null; route: "base" | "fast" | "free" | "batch" }
 *   isCompatible(m: CatalogModel): string | null          // null = compatible; si no, motivo
 *   resolveCatalog(models: CatalogModel[], opts: ResolveOptions): CatalogResolution
 *   fetchCatalog(fetchFn?): Promise<{ models: CatalogModel[]; raw: string; fetchedAt: number }>
 *   fetchEndpoints(id, fetchFn?): Promise<CatalogEndpoints>
 *   freezeModel(m: CatalogModel, endpoints: CatalogEndpoints | null, extra: { isReference: boolean; priority: number | null; pinProvider?: string }): FrozenModel | { omittedReason: string }
 *   DEFAULT_PRIORITY_LINES: string[]   // GPT Luna, Gemini Flash, Claude Haiku, Qwen Flash, GLM Flash, MiMo Flash, MiniMax Flash, Muse Ember
 *   DEFAULT_REFERENCE_ID = "deepseek/deepseek-v4.1-flash-1017-fast"; DEFAULT_REFERENCE_PROVIDER = "baseten"
 */

// ---------- rating.ts ----------

/** Resultado de una partida válida reducido a lo que usa el rating. */
export type Game = {
  /** Para el bootstrap por grupos: partidas con mismo escenario y semilla van juntas. */
  cluster: string;
  a: string;
  b: string;
  /** Puntos de a: 1 victoria, 0.5 empate, 0 derrota. */
  scoreA: 0 | 0.5 | 1;
};

export type RatingFit = {
  ratings: Record<string, number>;
  /** Error estándar (Laplace, inversa del hessiano) de rating - referencia. */
  se: Record<string, number>;
  iterations: number;
  converged: boolean;
};

/*
 * rating.ts exporta:
 *   fitBradleyTerry(models: string[], games: Game[], opts: { reference: string; priorSdElo: number; origin?: number }): RatingFit
 *     - p(a gana) = 1 / (1 + 10^((Rb - Ra)/400)); verosimilitud con puntaje s: s·log p + (1-s)·log(1-p)
 *     - prior N(origin, priorSdElo²) sobre todos menos la referencia, que queda fija en origin (1000)
 *     - Newton determinista sobre estadísticos agregados por par (independiente del orden de games)
 *     - solo empates  ⇒ todos exactamente en 1000
 *   clusterBootstrap(models, games, opts & { samples: number; seed: number }): Record<string, { lo: number; hi: number }> | null
 *     - remuestrea clusters completos (escenario+semilla); null si hay < 5 clusters
 *   headToHead(models: string[], games: Game[]): MatrixCell[] (de @phack/protocol)
 *   calibrate(models: FrozenModel[], games: Game[], rule: CalibrationRule): CalibrationRow[]
 *     - inside: [diff - z·se, diff + z·se] ⊂ [-band, band]; outside: intervalo sin intersección con la banda; si no, pending
 *     - league = inside, o pending con |diff| <= band (provisional). La referencia no aparece.
 */

// ---------- schedule.ts ----------

export type Pair = { a: string; b: string };

/*
 * schedule.ts exporta:
 *   pairKey(x, y): Pair                                   // ordena por key
 *   matchId(stage, scenario, seed, pair, leg): string     // formato de MatchSpec.id
 *   legsFor(pair, stage, scenario, seed, round): MatchSpec[]   // ida (a rojo) y vuelta (a azul)
 *   roundRobinRounds(models: string[]): Pair[][]          // método del círculo, determinista
 *   calibrationBasePairs(reference: string, candidates: string[]): Pair[]
 *       // cada candidato vs referencia + al menos un rival distinto entre candidatos (emparejamiento
 *       // balanceado, grados parejos, grafo conexo). Determinista.
 *   adaptivePairs(rows: CalibrationRow[], played: Pair[], reference: string, maxPairs: number): Pair[]
 *       // solo para candidatos pending: prioriza rivales no jugados y cercanos en rating; reparte parejo
 *   leagueSchedule(models: string[], scenarios: string[], seeds: number[]): MatchSpec[]
 *       // semilla por semilla; dentro de cada semilla todas las parejas con ida y vuelta.
 *       // 10 modelos, 1 escenario: 45 parejas, 90 partidas por semilla.
 *   capacity(limits: TournamentLimits, est: { minutesPerMatch: number; usdPerMatch: number }): number
 *   leagueSize(capacityLeft: number, scenarios: number): number   // mayor n con n(n-1)·scenarios <= capacityLeft (mín. 2)
 *   planPreview(...)  → objeto para el dry-run (candidatos, parejas, partidas, minutos y USD estimados por etapa)
 */

// ---------- store.ts ----------

export interface TournamentStore {
  create(config: TournamentConfig, catalogRaw: string): Promise<void>;
  load(id: string): Promise<TournamentConfig>;
  list(): Promise<TournamentConfig[]>;
  /** Append-only. Varias líneas por matchId posibles (reintentos). */
  appendAttempt(id: string, attempt: MatchAttempt): Promise<void>;
  attempts(id: string): Promise<MatchAttempt[]>;
  /** Lo que la corrida decidió (calendario de liga congelado, motivo de parada). */
  saveState(id: string, state: RunnerState): Promise<void>;
  loadState(id: string): Promise<RunnerState | null>;
}

export type RunnerState = {
  /** Calendario de la liga, congelado al terminar la calibración (resume usa el mismo). */
  leagueModels: string[] | null;
  leagueSeeds: number[] | null;
  /** Parejas adaptativas ya programadas (para que un resume no las cambie). */
  adaptiveRounds: Array<{ round: number; pairs: Pair[] }>;
  stopReason: string | null;
  paused: boolean;
  /**
   * Clasificados a la liga que quedaron fuera porque no cabía una semilla completa
   * (opcional: estados viejos no lo traen).
   */
  leagueCut?: Array<{ model: string; why: string }>;
  /** true cuando la corrida terminó (calendario completo o límite alcanzado); no con pausa. */
  finished?: boolean;
};

/**
 * Valida (reducción de intentos): por cada matchId, el PRIMER intento "valid" cuenta;
 * los intentos "infra" no cuentan nunca. Implementado en store.ts como función pura:
 *   validAttempts(attempts: MatchAttempt[]): MatchAttempt[]
 */

// ---------- runner.ts ----------

/** Corre UNA partida. La implementación real usa MatchManager + Minecraft; la simulada, un RNG. */
export interface MatchRunner {
  run(
    spec: MatchSpec,
    models: Record<string, FrozenModel>,
    signal: AbortSignal,
    /** Número de intento (1 = primero) e id del torneo; opcional para no romper implementaciones. */
    info?: { attempt: number; tournamentId: string },
  ): Promise<MatchAttempt>;
}

export type RunOptions = {
  /** Se llama tras cada intento (para logs/CLI). */
  onAttempt?: (a: MatchAttempt) => void;
  log?: (text: string) => void;
  /** Reloj inyectable (tests). */
  now?: () => number;
  signal?: AbortSignal;
};

export type { CalibrationRow, CalibrationRule, FrozenModel, MatchAttempt, MatchSpec, TournamentConfig, TournamentLimits };
