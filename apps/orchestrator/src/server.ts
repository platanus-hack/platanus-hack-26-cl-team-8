import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  MAX_TIMER_SECONDS,
  MIN_TIMER_SECONDS,
  API_ROUTES,
  DEFAULT_MIN_MATCHES,
  LEGACY_SERIES_ROUNDS,
  SCENARIO_IDS,
  ScenarioIdSchema,
  FlagBodySchema,
  MAX_PROMPT_LENGTH,
  SELECTABLE_ARENA_SCENARIOS,
  SideSchema,
  StartMatchBodySchema,
  TOURNAMENT_ROUTES,
  UpdatePromptBodySchema,
  UpdateSettingsBodySchema,
  formatTranscript,
  parseTranscript,
  validateCustomKit,
  type AgentConfig,
  type BenchOptions,
  type BenchReport,
  type PresetsResponse,
  type FlagBody,
  type FlaggedPrompt,
  type MatchSettings,
  type MatchRecord,
  type MatchState,
  type ModelsResponse,
  type PromptsResponse,
  type Provider,
  type ServerDefaults,
  type Side,
  type StartMatchBody,
  type UpdatePromptBody,
} from "@phack/protocol";
import { sourceOfRecord, type FlagSource } from "./flags";
import type { Hub } from "./hub";
import type { JudgeOutcome } from "./judge";
import { UnknownPresetError } from "./presets";
import { ArenaUnavailableError, MatchActiveError } from "./match";
import { createRateLimiter } from "./ratelimit";
import type { TournamentReader } from "./tournament";
import { isSpeechId } from "./speech";
import { isTranscriptId } from "./transcript";

export type ServerDeps = {
  hub: Hub;
  match: {
    getState(): MatchState;
    /** Lanza MatchActiveError (409) o ArenaUnavailableError (400). */
    start(opts?: StartMatchBody): MatchState;
    stop(): Promise<MatchState>;
    /** Hay una pelea (o una serie) en curso; opcional para los tests que no lo usan. */
    isActive?(): boolean;
  };
  prompts: {
    get(): PromptsResponse;
    update(side: Side, body: UpdatePromptBody): Promise<AgentConfig>;
  };
  /** Ajustes de la próxima pelea; opcional para los tests que no los usan. */
  settings?: {
    get(): MatchSettings;
    update(change: Partial<MatchSettings>): Promise<MatchSettings>;
  };
  history: { latest(): MatchRecord[] };
  /** Prompts marcados (ver flags.ts); opcional para los tests que no los usan. */
  flags?: {
    list(): FlaggedPrompt[];
    put(source: FlagSource, side: Side, body: FlagBody, now: number): Promise<FlaggedPrompt>;
    edit(matchId: string, side: Side, body: FlagBody, now: number): Promise<FlaggedPrompt | null>;
    remove(matchId: string, side: Side): Promise<boolean>;
  };
  /** Tablero de benchmarks (ver buildBenchReport); opcional para los tests que no lo usan. */
  bench?: { report(options: BenchOptions): Promise<BenchReport> };
  /** Pre-ajustes de benchmark y la batería que los corre (ver presets.ts). */
  presets?: {
    snapshot(): PresetsResponse;
    run(id: string, start: boolean): Promise<PresetsResponse>;
    stop(): PresetsResponse;
    isRunning(): boolean;
  };
  /** Archiva el historial de peleas (ver MatchStore.archive). */
  archiveHistory?: () => Promise<string | null>;
  /** Califica una pelea con el LLM juez; null si esa pelea no existe. */
  judge?: (matchId: string) => Promise<JudgeOutcome | null>;
  /** Transcripción cruda (JSONL) de una pelea; null si no existe. */
  transcripts: { read(matchId: string): Promise<string | null> };
  /** Proveedor y modelos que se usan cuando un agente no elige los suyos. */
  defaults: ServerDefaults;
  /** Lista de modelos permitidos (ver models.ts). */
  models: ModelPolicy & { snapshot(): ModelsResponse };
  /**
   * true si el servidor tiene la clave de Vercel AI Gateway (VERCEL_API_KEY). Sin ella solo
   * se puede guardar el LLM simulado: cualquier pelea con "vercel" fallaría al empezar.
   */
  vercelKeyConfigured: boolean;
  /**
   * Audio de las frases de los agentes (ver speech.ts). get espera la síntesis en curso y
   * devuelve null si el id no existe o falló. Opcional: sin esto la ruta siempre da 404.
   */
  speech?: { get(speechId: string): Promise<Buffer | null> };
  /** Límite de solicitudes que modifican estado, por IP. */
  rateLimit?: { limit: number; windowMs: number };
  /** Torneos guardados en DATA_DIR (solo lectura) y lock del CLI que los corre. */
  tournaments?: TournamentReader;
};

export type ModelPolicy = { isAllowed(id: string): boolean };

/**
 * Aplica la lista de modelos permitidos a lo que se quiere guardar. Devuelve el cuerpo
 * listo para guardar, o null si pide un modelo que no está permitido (HTTP 400).
 * Con el proveedor simulado no hay modelo que elegir: el que venga se descarta.
 * `defaultProvider` es el proveedor del servidor, que vale cuando el cuerpo no trae uno.
 */
export function applyModelPolicy(
  body: UpdatePromptBody,
  defaultProvider: Provider,
  models: ModelPolicy,
): UpdatePromptBody | null {
  const model = body.model?.trim();
  if (!model) return body;
  if ((body.provider ?? defaultProvider) === "mock") {
    const withoutModel = { ...body };
    delete withoutModel.model;
    return withoutModel;
  }
  return models.isAllowed(model) ? body : null;
}

/** Cuerpo de error uniforme: { error, message } con el mismo texto en español. */
function errorBody(text: string): { error: string; message: string } {
  return { error: text, message: text };
}

const INVALID_SIDE = "Lado inválido: usa 'red' o 'blue'";

const NO_VERCEL_KEY =
  "El servidor no tiene configurada la clave de Vercel AI Gateway: por ahora solo está disponible el LLM simulado (mock)";

/** Detrás de Cloudflare Tunnel + Caddy la IP real viene en cabeceras. */
function clientIp(req: FastifyRequest): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
  return req.ip;
}

function describeBodyError(issues: { path: (string | number)[]; code: string }[]): string {
  const first = issues[0];
  if (first?.path[0] === "prompt" && first.code === "too_big") {
    return `El prompt supera el máximo de ${MAX_PROMPT_LENGTH} caracteres`;
  }
  if (first?.path[0] === "prompt") return "Falta el campo 'prompt' o no es texto";
  if (first?.path[0] === "provider") return "Proveedor inválido: usa mock o vercel";
  if (first?.path[0] === "model") return "Modelo inválido: debe ser texto de hasta 100 caracteres";
  if (first?.path[0] === "customKit") return "Inventario inválido: no tiene la forma de un kit";
  return "Cuerpo inválido: se espera un JSON { prompt, provider?, model?, kit?, customKit? }";
}

/**
 * Un solo rango "bytes=inicio-fin" (o "bytes=-n", los últimos n). null = sin Range o en una
 * forma que no se atiende (se responde entero); "invalid" = fuera del archivo (HTTP 416).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match) return null;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return null;
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: "info" },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  // El parser JSON por defecto rechaza cuerpos vacíos; aquí un POST sin cuerpo es válido.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("JSON inválido") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(cors, { origin: true, methods: ["GET", "HEAD", "PUT", "POST", "DELETE", "OPTIONS"] });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  // ---------- Rate limit de rutas que modifican estado ----------

  const limiter = createRateLimiter(deps.rateLimit ?? { limit: 30, windowMs: 10_000 });
  const pruneTimer = setInterval(() => limiter.prune(), 60_000);
  pruneTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(pruneTimer);
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "PUT" && req.method !== "POST" && req.method !== "DELETE" && req.method !== "PATCH") return;
    if (!limiter.allow(clientIp(req))) {
      return reply.code(429).send(errorBody("Demasiadas solicitudes: espera unos segundos e inténtalo de nuevo"));
    }
  });

  // ---------- Errores ----------

  app.setNotFoundHandler((_req, reply) => {
    return reply.code(404).send(errorBody("Ruta no encontrada"));
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error(err);
      return reply.code(500).send(errorBody("Error interno del orquestador"));
    }
    if (status === 413) return reply.code(413).send(errorBody("El cuerpo de la solicitud es demasiado grande"));
    if (status === 415) return reply.code(415).send(errorBody("Tipo de contenido no soportado: usa application/json"));
    return reply.code(status).send(errorBody("Solicitud inválida"));
  });

  // ---------- HTTP ----------

  app.get(API_ROUTES.health, async () => ({ ok: true }));

  app.get(API_ROUTES.state, async () => deps.match.getState());

  app.get(API_ROUTES.prompts, async () => deps.prompts.get());

  app.put<{ Params: { side: string } }>("/api/prompts/:side", async (req, reply) => {
    const side = SideSchema.safeParse(req.params.side);
    if (!side.success) {
      return reply.code(400).send(errorBody(INVALID_SIDE));
    }
    const body = UpdatePromptBodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send(errorBody(describeBodyError(body.error.issues)));
    }
    // Mismo criterio que la pelea: sin proveedor en el cuerpo vale el del servidor.
    if ((body.data.provider ?? deps.defaults.provider) === "vercel" && !deps.vercelKeyConfigured) {
      return reply.code(400).send(errorBody(NO_VERCEL_KEY));
    }
    // El inventario armado en la web solo vale con kit "custom"; con otro kit se ignora.
    let request = body.data;
    if (request.customKit) {
      if (request.kit !== "custom") {
        request = { ...request };
        delete request.customKit;
      } else {
        const { kit, problems } = validateCustomKit(request.customKit);
        if (problems.length > 0) return reply.code(400).send(errorBody(`Inventario inválido: ${problems[0]}`));
        request = { ...request, customKit: kit };
      }
    }
    const update = applyModelPolicy(request, deps.defaults.provider, deps.models);
    if (!update) {
      return reply.code(400).send(errorBody("Modelo no permitido: elige uno de la lista"));
    }
    const config = await deps.prompts.update(side.data, update);
    deps.hub.broadcast({ type: "prompts", at: Date.now(), prompts: deps.prompts.get() });
    return config;
  });

  const settings = deps.settings;
  if (settings) {
    app.get(API_ROUTES.settings, async () => settings.get());

    app.put(API_ROUTES.settings, async (req, reply) => {
      const body = UpdateSettingsBodySchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .code(400)
          .send(
            errorBody(
              `Cuerpo inválido: se espera un JSON { comms?, timer?, timerSeconds?, mode?, voice?, voiceSet?, scenario?, rounds?, horizon?, seriesWin?, refillKit?, judge?, rules?, arena? } con comms = none, thoughts o chat, timer = true o false, timerSeconds entre ${MIN_TIMER_SECONDS} y ${MAX_TIMER_SECONDS} (o null), mode = single o rounds, voice = true o false y rounds de 2 a 5`,
            ),
          );
      }
      // Solo lo que vino: una clave ausente no debe pisar el ajuste guardado.
      const change: Partial<MatchSettings> = {};
      if (body.data.comms !== undefined) change.comms = body.data.comms;
      if (body.data.timer !== undefined) change.timer = body.data.timer;
      if (body.data.timerSeconds !== undefined) change.timerSeconds = body.data.timerSeconds;
      // El formato sale de las rondas (ver syncMode). Un cliente de antes que solo manda
      // mode: "rounds" pide una serie; "single", una pelea suelta.
      if (body.data.mode !== undefined && body.data.rounds === undefined) {
        const current = settings.get().rounds;
        change.rounds = body.data.mode === "single" ? 1 : current > 1 ? current : LEGACY_SERIES_ROUNDS;
      }
      if (body.data.voice !== undefined) change.voice = body.data.voice;
      if (body.data.voiceSet !== undefined) change.voiceSet = body.data.voiceSet;
      const b = body.data;
      if (b.scenario !== undefined) change.scenario = b.scenario;
      if (b.rounds !== undefined) change.rounds = b.rounds;
      if (b.horizon !== undefined) change.horizon = b.horizon;
      if (b.seriesWin !== undefined) change.seriesWin = b.seriesWin;
      if (b.refillKit !== undefined) change.refillKit = b.refillKit;
      if (b.judge !== undefined) change.judge = b.judge;
      if (b.arena !== undefined) {
        // Solo los mapas que este servidor construye (ServerDefaults.arenas); null = el por defecto.
        if (b.arena !== null && !deps.defaults.arenas.some((option) => option.id === b.arena)) {
          return reply.code(400).send(errorBody(`El mapa "${b.arena}" no está disponible en este servidor`));
        }
        change.arena = b.arena;
      }
      if (b.rules !== undefined) {
        // Las reglas van por lado: el lado que no viene conserva las suyas.
        const current = settings.get().rules;
        change.rules = { red: b.rules.red ?? current.red, blue: b.rules.blue ?? current.blue };
      }
      const updated = await settings.update(change);
      deps.hub.broadcast({ type: "settings", at: Date.now(), settings: updated });
      return updated;
    });
  }

  app.post(API_ROUTES.matchStart, async (req, reply) => {
    // Sin cuerpo = el mapa de los ajustes (o el por defecto del servidor).
    const body = StartMatchBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send(errorBody(`Mapa inválido: usa ${SELECTABLE_ARENA_SCENARIOS.join(" o ")}`));
    }
    // El CLI del torneo usa el mismo servidor de Minecraft y los mismos bots.
    const lock = await deps.tournaments?.lock();
    if (lock) {
      return reply
        .code(409)
        .send(errorBody(`Hay un torneo corriendo ("${lock.id}"): la arena está ocupada hasta que termine o se pause`));
    }
    try {
      return deps.match.start(body.data);
    } catch (err) {
      if (err instanceof MatchActiveError) {
        return reply.code(409).send(errorBody("Ya hay una pelea en curso"));
      }
      if (err instanceof ArenaUnavailableError) {
        return reply.code(400).send(errorBody(err.message));
      }
      throw err;
    }
  });

  app.post(API_ROUTES.matchStop, async () => deps.match.stop());

  app.get(API_ROUTES.matches, async () => deps.history.latest());

  // Funciona también con la pelea en curso: devuelve lo que se lleva escrito.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    API_ROUTES.transcript(":id"),
    async (req, reply) => {
      const id = req.params.id;
      if (!isTranscriptId(id)) return reply.code(400).send(errorBody("Id de pelea inválido"));
      const raw = await deps.transcripts.read(id);
      if (raw === null) return reply.code(404).send(errorBody("No hay transcripción de esa pelea"));
      reply.header("Cache-Control", "no-store");
      if (req.query.format === "text") {
        return reply.type("text/plain; charset=utf-8").send(formatTranscript(parseTranscript(raw)));
      }
      return reply.type("application/x-ndjson; charset=utf-8").send(raw);
    },
  );

  const flags = deps.flags;
  if (flags) {
    app.get(API_ROUTES.flags, async () => flags.list());

    /**
     * La pelea que se quiere marcar: del historial si ya quedó guardada (trae cómo terminó),
     * si no la pelea en vivo (sin resultado: se completa al guardarse, ver withFlagOutcomes).
     */
    const findMatch = (id: string): FlagSource | null => {
      const record = deps.history.latest().find((r) => r.id === id);
      if (record) return sourceOfRecord(record);
      const state = deps.match.getState();
      if (state.id !== id) return null;
      return { matchId: id, configs: state.configs, settings: state.settings, outcome: null };
    };

    app.put<{ Params: { id: string; side: string } }>("/api/matches/:id/flags/:side", async (req, reply) => {
      const id = req.params.id;
      if (!isTranscriptId(id)) return reply.code(400).send(errorBody("Id de pelea inválido"));
      const side = SideSchema.safeParse(req.params.side);
      if (!side.success) return reply.code(400).send(errorBody(INVALID_SIDE));
      const body = FlagBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        return reply
          .code(400)
          .send(errorBody("Cuerpo inválido: se espera un JSON { tags, note } con hasta 8 etiquetas"));
      }
      const now = Date.now();
      const source = findMatch(id);
      if (source) return flags.put(source, side.data, body.data, now);
      // Una marca ya hecha se puede editar aunque su pelea ya no esté en el historial.
      const edited = await flags.edit(id, side.data, body.data, now);
      if (edited) return edited;
      return reply.code(404).send(errorBody("Esa pelea ya no está en el historial: no se puede marcar"));
    });

    app.delete<{ Params: { id: string; side: string } }>("/api/matches/:id/flags/:side", async (req, reply) => {
      if (!isTranscriptId(req.params.id)) return reply.code(400).send(errorBody("Id de pelea inválido"));
      const side = SideSchema.safeParse(req.params.side);
      if (!side.success) return reply.code(400).send(errorBody(INVALID_SIDE));
      await flags.remove(req.params.id, side.data);
      return { ok: true };
    });
  }

  // Audio de una frase: la web lo pide apenas llega el mensaje; si aún se genera, se espera.
  app.get<{ Params: { id: string } }>(API_ROUTES.speech(":id"), async (req, reply) => {
    const id = req.params.id;
    if (!isSpeechId(id)) return reply.code(400).send(errorBody("Id de audio inválido"));
    const audio = deps.speech ? await deps.speech.get(id) : null;
    if (!audio) return reply.code(404).send(errorBody("No hay audio para esa frase"));
    reply.header("Cache-Control", "public, max-age=3600, immutable");
    reply.header("Accept-Ranges", "bytes");
    // Safari pide el audio por partes (Range): se le responde solo la parte pedida.
    const range = parseRange(req.headers.range, audio.length);
    if (range === "invalid") {
      reply.header("Content-Range", `bytes */${audio.length}`);
      return reply.code(416).send(errorBody("Rango inválido"));
    }
    if (range) {
      reply.header("Content-Range", `bytes ${range.start}-${range.end}/${audio.length}`);
      return reply.code(206).type("audio/mpeg").send(audio.subarray(range.start, range.end + 1));
    }
    return reply.type("audio/mpeg").send(audio);
  });
  const bench = deps.bench;
  if (bench) {
    // ?scenario=dilemma filtra por escenario ("all" o ausente = todos); ?min=5 son las
    // partidas mínimas para entrar al ranking.
    app.get<{ Querystring: { scenario?: string; min?: string } }>(API_ROUTES.bench, async (req, reply) => {
      const rawScenario = req.query.scenario;
      const scenario = rawScenario === undefined || rawScenario === "" || rawScenario === "all" ? null : ScenarioIdSchema.safeParse(rawScenario);
      if (scenario && !scenario.success) {
        return reply.code(400).send(errorBody(`Escenario inválido: usa all, ${SCENARIO_IDS.join(", ")}`));
      }
      const rawMin = req.query.min;
      const min = rawMin === undefined || rawMin === "" ? DEFAULT_MIN_MATCHES : Number(rawMin);
      if (!Number.isInteger(min) || min < 1 || min > 1000) {
        return reply.code(400).send(errorBody("min debe ser un entero entre 1 y 1000"));
      }
      reply.header("Cache-Control", "no-store");
      return bench.report({ scenario: scenario ? scenario.data : null, minMatches: min });
    });
  }

  const presets = deps.presets;
  if (presets) {
    app.get(API_ROUTES.presets, async (_req, reply) => {
      reply.header("Cache-Control", "no-store");
      return presets.snapshot();
    });

    app.post(API_ROUTES.presetsStop, async () => presets.stop());

    app.post<{ Params: { id: string } }>("/api/presets/:id", async (req, reply) => {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      if (body.start !== undefined && typeof body.start !== "boolean") {
        return reply.code(400).send(errorBody("Cuerpo inválido: se espera un JSON { start?: true o false }"));
      }
      try {
        return await presets.run(req.params.id, body.start === true);
      } catch (err) {
        if (err instanceof UnknownPresetError) return reply.code(404).send(errorBody(err.message));
        if (err instanceof MatchActiveError) {
          return reply.code(409).send(errorBody("Hay una pelea o una batería en curso: espera a que termine o detenla"));
        }
        throw err;
      }
    });
  }

  const archiveHistory = deps.archiveHistory;
  if (archiveHistory) {
    // Doble confirmación: la web pregunta dos veces y además el cuerpo debe decir "BORRAR".
    app.delete(API_ROUTES.history, async (req, reply) => {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      if (body.confirm !== "BORRAR") {
        return reply.code(400).send(errorBody('Para borrar el historial manda { "confirm": "BORRAR" }'));
      }
      if (deps.match.isActive?.() || presets?.isRunning()) {
        return reply.code(409).send(errorBody("No se puede borrar el historial con una pelea o una batería en curso"));
      }
      const archived = await archiveHistory();
      deps.hub.broadcast({ type: "log", at: Date.now(), level: "warn", text: "Se borró el historial de peleas (quedó archivado en el servidor)" });
      return { archived };
    });
  }

  const judge = deps.judge;
  if (judge) {
    app.post<{ Params: { id: string } }>("/api/matches/:id/judge", async (req, reply) => {
      const id = req.params.id;
      if (!isTranscriptId(id)) return reply.code(400).send(errorBody("Id de pelea inválido"));
      const outcome = await judge(id);
      if (outcome === null) return reply.code(404).send(errorBody("Esa pelea no está en el historial"));
      if (!outcome.ok) return reply.code(outcome.status).send(errorBody(`No se pudo calificar: ${outcome.reason}`));
      return outcome.judgement;
    });
  }

  app.get(API_ROUTES.defaults, async () => deps.defaults);

  app.get(API_ROUTES.models, async () => deps.models.snapshot());
  // ---------- Torneo (solo lectura) ----------

  const tournaments = deps.tournaments;
  app.get(TOURNAMENT_ROUTES.list, async () => (tournaments ? tournaments.list() : []));

  app.get<{ Params: { id: string } }>(TOURNAMENT_ROUTES.report, async (req, reply) => {
    const report = tournaments ? await tournaments.report(req.params.id) : null;
    if (!report) return reply.code(404).send(errorBody("No existe ese torneo"));
    return report;
  });

  // Las keys traen "/" (ids del gateway): la web las manda codificadas y Fastify las decodifica.
  app.get<{ Params: { id: string; a: string; b: string } }>(TOURNAMENT_ROUTES.pair, async (req, reply) => {
    const attempts = tournaments ? await tournaments.pair(req.params.id, req.params.a, req.params.b) : null;
    if (!attempts) return reply.code(404).send(errorBody("No existe ese torneo"));
    return attempts;
  });

  // ---------- WebSocket (solo servidor -> cliente) ----------

  // @fastify/websocket v11 (Fastify 5): el handler recibe (socket, request);
  // socket es el WebSocket de "ws" directamente.
  app.get(API_ROUTES.ws, { websocket: true }, (socket) => {
    deps.hub.add(socket);
  });

  return app;
}
