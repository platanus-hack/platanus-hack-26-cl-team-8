/**
 * Contrato del torneo de modelos (arena 1v1 con rating Bradley–Terry en escala Elo).
 *
 * Lo comparten el orquestador (que corre el torneo y arma el reporte) y la web (que
 * dibuja el leaderboard). Solo tipos y constantes: nada de lógica.
 */

// ---------- Benchmark ----------

/**
 * Prompt único y congelado para los dos lados en el torneo: así lo que se compara es el
 * modelo, no el prompt. Cambiarlo cambia la versión del benchmark.
 */
export const BENCHMARK_PROMPT =
  "Gana el duelo: elimina al rival o termina con más vida que él cuando se acabe el tiempo. " +
  "Decide tú cuándo atacar cuerpo a cuerpo, cuándo usar el arco y cuándo comer.";

/** Id del modelo de referencia (origen de la escala: 1000). */
export const REFERENCE_RATING = 1000;

/** Fase del torneo a la que pertenece una partida. */
export type TournamentStage = "calibration" | "league";

/** Lado = quién parte en el spawn rojo o en el azul. "ida" = A rojo, "vuelta" = A azul. */
export type Leg = "ida" | "vuelta";

// ---------- Configuración congelada ----------

/** Niveles de razonamiento, de menor a mayor ("none" = apagado). */
export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type FrozenModel = {
  /** Id estable dentro del torneo (= gatewayId del modelo resuelto). */
  key: string;
  /** Nombre legible ("GPT-6 Luna Fast"). */
  name: string;
  /** Línea del modelo, p. ej. "openai/gpt-*-luna". */
  line: string;
  /** Id exacto pedido al gateway, p. ej. "openai/gpt-6-luna-fast". */
  gatewayId: string;
  /** Versión legible y fecha de lanzamiento (epoch s del catálogo). */
  version: string;
  released: number | null;
  /** Proveedor de inferencia fijado en el gateway (p. ej. "baseten"). null = el que elija el gateway. */
  inferenceProvider: string | null;
  /** Proveedor del cliente LLM del repo ("vercel" o "mock" en simulación). */
  clientProvider: "vercel" | "mock";
  /**
   * Razonamiento con que juega: "none" si el modelo permite apagarlo; si no, el nivel más
   * bajo que acepta (p. ej. "minimal" o "low"). Queda congelado en el torneo.
   */
  reasoning: ReasoningLevel;
  /** USD por token, del catálogo, para estimar costo si el gateway no lo informa. */
  pricing: { input: number; output: number; cacheRead: number | null } | null;
  isReference: boolean;
  /** Posición en la lista de prioridad (0 = primera); null = entró automáticamente. */
  priority: number | null;
};

export type OmittedLine = {
  line: string;
  /** Id de la versión más reciente de la línea (la que se habría usado). */
  latestId: string;
  reason: string;
};

export type TournamentLimits = {
  /** Límite de reloj total del torneo, en minutos. */
  maxMinutes: number;
  /** Máximo de partidas (intentos válidos + fallidos cuentan para el reloj, no para este límite). */
  maxMatches: number;
  /** Gasto máximo en USD (costo real informado o estimado por tokens). */
  maxUsd: number;
  /** Partidas simultáneas; requiere un servidor de Minecraft por partida. */
  concurrency: number;
  /** Máximo de candidatos (sin contar la referencia). */
  maxCandidates: number;
  /** Fracción de la capacidad que puede usar la calibración adaptativa (la ronda base siempre corre). */
  calibrationShare: number;
  /** Reintentos por partida ante fallos de infraestructura. */
  maxAttempts: number;
};

export type CalibrationRule = {
  /** Banda de nivel: |rating - referencia| <= bandElo. */
  bandElo: number;
  /** z del intervalo usado para decidir (1.645 = 90 %). */
  z: number;
  /** Desviación estándar del prior gaussiano del BT, en Elo (regularización). */
  priorSdElo: number;
};

export type BenchmarkVersion = {
  /** "pvp-platanus-v1+<hash>": cambia si cambia cualquier cosa de abajo. */
  id: string;
  scenario: string;
  matchSeconds: number;
  tickMs: number;
  promptHash: string;
  toolsHash: string;
};

export type TournamentConfig = {
  id: string;
  name: string;
  createdAt: number;
  /** Fecha y hash del catálogo usado (congelado en catalog.json del torneo). */
  catalog: { fetchedAt: number; sha256: string; source: string };
  benchmark: BenchmarkVersion;
  reference: FrozenModel;
  candidates: FrozenModel[];
  omitted: OmittedLine[];
  limits: TournamentLimits;
  rule: CalibrationRule;
  /** Escenarios del torneo (hoy uno solo). */
  scenarios: string[];
  /** Semillas reservadas: la calibración y la liga nunca comparten semilla. */
  seeds: { calibrationBase: number; leagueBase: number };
  /** "real" = Minecraft; "simulated" = agentes simulados (sin Minecraft ni créditos). */
  mode: "real" | "simulated";
};

// ---------- Partidas ----------

export type MatchSpec = {
  /** Id estable: `${stage}:${scenario}:s${seed}:${a}~${b}:${leg}` (a < b en orden de key). */
  id: string;
  stage: TournamentStage;
  scenario: string;
  seed: number;
  /** Par ordenado por key (a < b). */
  a: string;
  b: string;
  leg: Leg;
  /** Quién va en cada spawn (derivado de leg). */
  red: string;
  blue: string;
  /** Ronda de programación (para reportar progreso y orden). */
  round: number;
};

/** valid = terminó por las reglas del juego; infra = fallo reintentable (429, caída, desconexión). */
export type AttemptStatus = "valid" | "infra";

export type SideStats = {
  model: string;
  health: number;
  damageDealt: number;
  decisions: number;
  invalidActions: number;
  tokensIn: number;
  tokensOut: number;
  /** USD: informado por el gateway si está; si no, estimado con el precio del catálogo. */
  costUsd: number;
  costSource: "reported" | "estimated" | "none";
  /** Latencia por decisión: desde que el agente recibe el estado hasta que entrega una acción válida. */
  latencyMs: { count: number; mean: number; p50: number; p95: number };
  llmErrors: number;
  /**
   * Latencia de cada decisión válida, en orden (ms). Los intentos de antes no la traen.
   * Sirve para ver si un modelo se pone más lento a medida que crece la pelea.
   */
  latenciesMs?: number[];
};

export type MatchAttempt = {
  matchId: string;
  attempt: number;
  status: AttemptStatus;
  spec: MatchSpec;
  startedAt: number;
  endedAt: number;
  /** Solo si status = "valid". winner = key del modelo ganador o null si empate. */
  outcome: { winner: string | null; reason: "kill" | "timeout_health" | "draw" } | null;
  /** Solo si status = "infra". */
  error: string | null;
  sides: { red: SideStats; blue: SideStats };
  /**
   * Id de la pelea: su registro está en tournaments/<id>/matches.jsonl y su transcripción en
   * tournaments/<id>/transcripts/<recordId>.jsonl. null si no llegó a empezar; los intentos de
   * antes no lo traen.
   */
  recordId?: string | null;
  /**
   * Duración real de la pelea (ms), sin la preparación: startedAt/endedAt del intento sí la
   * incluyen. null si no llegó a empezar; los intentos de antes no la traen.
   */
  fightMs?: number | null;
};

// ---------- Reporte (lo que dibuja la web) ----------

export type CalibrationVerdict = "inside" | "outside" | "pending";

export type CalibrationRow = {
  model: string;
  name: string;
  rating: number;
  /** Diferencia con la referencia y su error estándar (Elo). */
  diff: number;
  se: number;
  /** Intervalo de decisión diff ± z·se: en la escala de la diferencia, no del rating. */
  lo: number;
  hi: number;
  games: number;
  opponents: number;
  verdict: CalibrationVerdict;
  /** Entra a la liga (puede ser "pending" con estimación dentro de la banda). */
  league: boolean;
  why: string;
};

export type StandingRow = {
  rank: number;
  model: string;
  name: string;
  version: string;
  gatewayId: string;
  inferenceProvider: string | null;
  /** Razonamiento congelado con que jugó ("none" = apagado). */
  reasoning: ReasoningLevel;
  isReference: boolean;
  rating: number;
  /** Intervalo (Elo) y su método. */
  lo: number;
  hi: number;
  ciMethod: "bootstrap" | "laplace";
  games: number;
  wins: number;
  draws: number;
  losses: number;
  costUsd: number;
  latencyMs: { p50: number; p95: number; count: number };
  /** Cómo fueron sus peleas de la liga. Opcional: un orquestador anterior no lo informa. */
  fight?: FightReadings;
};

/** Lecturas de las peleas válidas de la liga de un modelo, sumadas. */
export type FightReadings = {
  /** Victorias y derrotas que terminaron por K.O. (el resto se decidió por vida al acabar el tiempo). */
  koWins: number;
  koLosses: number;
  /** Daño hecho al rival y daño recibido, en puntos de vida. */
  damageDealt: number;
  damageTaken: number;
  /** Decisiones tomadas y cuántas pidieron una acción que el juego rechazó. */
  decisions: number;
  invalidActions: number;
  /** Tokens de entrada + salida. */
  tokens: number;
  /** USD gastados en esas peleas (sin calibración ni intentos fallidos, que sí cuentan en `costUsd`). */
  costUsd: number;
};

export type MatrixCell = {
  row: string;
  col: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** (wins + 0.5·draws) / games; null si no hay partidas válidas. */
  score: number | null;
};

export type TournamentProgress = {
  stage: "created" | "calibration" | "league" | "done" | "paused";
  calibration: { planned: number; valid: number; infra: number };
  league: { planned: number; valid: number; infra: number; seedsPlanned: number; seedsDone: number };
  elapsedMinutes: number;
  costUsd: number;
  limits: TournamentLimits;
  stopReason: string | null;
};

export type TournamentReport = {
  config: TournamentConfig;
  progress: TournamentProgress;
  /** true si hay pocos datos (pocas partidas por modelo o pocas semillas). */
  provisional: boolean;
  provisionalWhy: string[];
  standings: StandingRow[];
  /** Orden de filas/columnas = orden de standings. */
  matrix: MatrixCell[];
  calibration: CalibrationRow[];
};

export type TournamentSummary = {
  id: string;
  name: string;
  createdAt: number;
  mode: "real" | "simulated";
  stage: TournamentProgress["stage"];
  models: number;
  validMatches: number;
};

export const TOURNAMENT_ROUTES = {
  list: "/api/tournaments",
  /** :id */
  report: "/api/tournaments/:id",
  /** :id, :a, :b  → MatchAttempt[] de esa pareja (válidas e infra, todas las etapas). */
  pair: "/api/tournaments/:id/pairs/:a/:b",
} as const;
