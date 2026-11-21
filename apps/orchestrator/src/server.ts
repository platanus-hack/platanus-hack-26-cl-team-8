import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  MAX_TIMER_SECONDS,
  MIN_TIMER_SECONDS,
  API_ROUTES,
  FlagBodySchema,
  MAX_PROMPT_LENGTH,
  SideSchema,
  UpdatePromptBodySchema,
  UpdateSettingsBodySchema,
  formatTranscript,
  parseTranscript,
  type AgentConfig,
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
  type UpdatePromptBody,
} from "@phack/protocol";
import { sourceOfRecord, type FlagSource } from "./flags";
import type { Hub } from "./hub";
import { MatchActiveError } from "./match";
import { createRateLimiter } from "./ratelimit";
import { isSpeechId } from "./speech";
import { isTranscriptId } from "./transcript";

export type ServerDeps = {
  hub: Hub;
  match: {
    getState(): MatchState;
    start(): MatchState;
    stop(): Promise<MatchState>;
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
  return "Cuerpo inválido: se espera un JSON { prompt, provider?, model?, kit? }";
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
    const update = applyModelPolicy(body.data, deps.defaults.provider, deps.models);
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
              `Cuerpo inválido: se espera un JSON { comms?, timer?, timerSeconds?, mode?, voice? } con comms = none, thoughts o chat, timer = true o false, timerSeconds entre ${MIN_TIMER_SECONDS} y ${MAX_TIMER_SECONDS} (o null), mode = single o rounds y voice = true o false`,
            ),
          );
      }
      // Solo lo que vino: una clave ausente no debe pisar el ajuste guardado.
      const change: Partial<MatchSettings> = {};
      if (body.data.comms !== undefined) change.comms = body.data.comms;
      if (body.data.timer !== undefined) change.timer = body.data.timer;
      if (body.data.timerSeconds !== undefined) change.timerSeconds = body.data.timerSeconds;
      if (body.data.mode !== undefined) change.mode = body.data.mode;
      if (body.data.voice !== undefined) change.voice = body.data.voice;
      const updated = await settings.update(change);
      deps.hub.broadcast({ type: "settings", at: Date.now(), settings: updated });
      return updated;
    });
  }

  app.post(API_ROUTES.matchStart, async (_req, reply) => {
    try {
      return deps.match.start();
    } catch (err) {
      if (err instanceof MatchActiveError) {
        return reply.code(409).send(errorBody("Ya hay una pelea en curso"));
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

  app.get(API_ROUTES.defaults, async () => deps.defaults);

  app.get(API_ROUTES.models, async () => deps.models.snapshot());

  // ---------- WebSocket (solo servidor -> cliente) ----------

  // @fastify/websocket v11 (Fastify 5): el handler recibe (socket, request);
  // socket es el WebSocket de "ws" directamente.
  app.get(API_ROUTES.ws, { websocket: true }, (socket) => {
    deps.hub.add(socket);
  });

  return app;
}
