import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  API_ROUTES,
  MAX_PROMPT_LENGTH,
  SideSchema,
  UpdatePromptBodySchema,
  type AgentConfig,
  type MatchRecord,
  type MatchState,
  type PromptsResponse,
  type ServerDefaults,
  type Side,
  type UpdatePromptBody,
} from "@phack/protocol";
import type { Hub } from "./hub";
import { MatchActiveError } from "./match";
import { createRateLimiter } from "./ratelimit";

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
  history: { latest(): MatchRecord[] };
  /** Proveedor y modelos que se usan cuando un agente no elige los suyos. */
  defaults: ServerDefaults;
  /** Límite de solicitudes que modifican estado, por IP. */
  rateLimit?: { limit: number; windowMs: number };
};

/** Cuerpo de error uniforme: { error, message } con el mismo texto en español. */
function errorBody(text: string): { error: string; message: string } {
  return { error: text, message: text };
}

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
  if (first?.path[0] === "provider") {
    return "Proveedor inválido: usa mock, vercel, openai, anthropic, openrouter o gateway";
  }
  if (first?.path[0] === "model") return "Modelo inválido: debe ser texto de hasta 100 caracteres";
  return "Cuerpo inválido: se espera un JSON { prompt, provider?, model? }";
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

  await app.register(cors, { origin: true, methods: ["GET", "HEAD", "PUT", "POST", "OPTIONS"] });
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
      return reply.code(400).send(errorBody("Lado inválido: usa 'red' o 'blue'"));
    }
    const body = UpdatePromptBodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send(errorBody(describeBodyError(body.error.issues)));
    }
    const config = await deps.prompts.update(side.data, body.data);
    deps.hub.broadcast({ type: "prompts", at: Date.now(), prompts: deps.prompts.get() });
    return config;
  });

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

  app.get(API_ROUTES.defaults, async () => deps.defaults);

  // ---------- WebSocket (solo servidor -> cliente) ----------

  // @fastify/websocket v11 (Fastify 5): el handler recibe (socket, request);
  // socket es el WebSocket de "ws" directamente.
  app.get(API_ROUTES.ws, { websocket: true }, (socket) => {
    deps.hub.add(socket);
  });

  return app;
}
