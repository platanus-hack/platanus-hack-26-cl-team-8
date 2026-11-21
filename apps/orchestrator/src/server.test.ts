import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  type MatchState,
  type Provider,
  type ServerDefaults,
  type Side,
  type UpdatePromptBody,
} from "@phack/protocol";
import { Hub } from "./hub";
import { applyModelPolicy, buildServer, type ModelPolicy } from "./server";
import { defaultPrompts } from "./store";

/** Regla que aplica PUT /api/prompts/:side antes de guardar (la parte pura de la ruta). */

const ALLOWED = ["deepseek/barato"];
const models: ModelPolicy = { isAllowed: (id) => ALLOWED.includes(id) };

describe("applyModelPolicy", () => {
  it("sin modelo no hay nada que revisar", () => {
    const body = { prompt: "hola", kit: "tank" as const };
    expect(applyModelPolicy(body, "vercel", models)).toEqual(body);
    expect(applyModelPolicy({ prompt: "hola", model: "   " }, "vercel", models)).toEqual({ prompt: "hola", model: "   " });
  });

  it("acepta un modelo de la lista y conserva el resto del cuerpo", () => {
    const body = { prompt: "hola", provider: "vercel" as const, model: "deepseek/barato", kit: "ender" as const };
    expect(applyModelPolicy(body, "mock", models)).toEqual(body);
    // Sin proveedor en el cuerpo vale el del servidor.
    expect(applyModelPolicy({ prompt: "hola", model: "deepseek/barato" }, "vercel", models)).toEqual({
      prompt: "hola",
      model: "deepseek/barato",
    });
  });

  it("rechaza un modelo que no está en la lista", () => {
    expect(applyModelPolicy({ prompt: "hola", provider: "vercel", model: "openai/caro" }, "mock", models)).toBeNull();
    expect(applyModelPolicy({ prompt: "hola", model: "openai/caro" }, "vercel", models)).toBeNull();
  });

  it("con el proveedor simulado descarta el modelo en vez de rechazar", () => {
    expect(
      applyModelPolicy({ prompt: "hola", provider: "mock", model: "openai/caro", kit: "archer" }, "vercel", models),
    ).toEqual({ prompt: "hola", provider: "mock", kit: "archer" });
    // El servidor simula por defecto y el cuerpo no elige proveedor: también es simulado.
    const dropped = applyModelPolicy({ prompt: "hola", model: "openai/caro" }, "mock", models);
    expect(dropped).toEqual({ prompt: "hola" });
    expect(dropped && "model" in dropped).toBe(false);
  });

  it("no modifica el cuerpo que recibe", () => {
    const body = { prompt: "hola", provider: "mock" as const, model: "openai/caro" };
    applyModelPolicy(body, "vercel", models);
    expect(body).toEqual({ prompt: "hola", provider: "mock", model: "openai/caro" });
  });
});

const ID = randomUUID();
const RAW = `${JSON.stringify({ type: "phase", at: 1000, phase: "running" })}\n${JSON.stringify({ type: "message", at: 2000, side: "red", text: "¡Hola!" })}\n`;

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

type ServerOptions = { provider?: Provider; vercelKeyConfigured?: boolean };

/** Lo que llegó a guardarse con PUT /api/prompts/:side. */
let saved: { side: Side; body: UpdatePromptBody }[] = [];

async function server(opts: ServerOptions = {}): Promise<FastifyInstance> {
  saved = [];
  app = await buildServer({
    hub: new Hub(),
    match: {
      getState: () => ({}) as MatchState,
      start: () => ({}) as MatchState,
      stop: async () => ({}) as MatchState,
    },
    prompts: {
      get: defaultPrompts,
      update: async (side, body) => {
        saved.push({ side, body });
        return { side, prompt: body.prompt };
      },
    },
    history: { latest: () => [] },
    transcripts: { read: async (id) => (id === ID ? RAW : null) },
    defaults: { provider: opts.provider ?? "mock", models: {} } as unknown as ServerDefaults,
    models: { isAllowed: () => true, snapshot: () => ({ models: [], source: "fallback", updatedAt: null }) },
    vercelKeyConfigured: opts.vercelKeyConfigured ?? false,
  });
  return app;
}

describe("PUT /api/prompts/:side sin clave de Vercel", () => {
  const put = (s: FastifyInstance, payload: Record<string, unknown>) =>
    s.inject({ method: "PUT", url: "/api/prompts/red", payload });

  it("rechaza elegir vercel (con o sin modelo) y no guarda nada", async () => {
    const s = await server();
    for (const payload of [
      { prompt: "hola", provider: "vercel" },
      { prompt: "hola", provider: "vercel", model: "deepseek/barato" },
    ]) {
      const res = await put(s, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/no tiene configurada la clave de Vercel AI Gateway.*solo está disponible el LLM simulado/);
    }
    expect(saved).toEqual([]);
  });

  it("también rechaza un cuerpo sin proveedor si el del servidor es vercel", async () => {
    const res = await put(await server({ provider: "vercel" }), { prompt: "hola" });
    expect(res.statusCode).toBe(400);
    expect(saved).toEqual([]);
  });

  it("acepta el LLM simulado sin clave, y vercel cuando la clave está", async () => {
    const noKey = await server();
    expect((await put(noKey, { prompt: "hola", provider: "mock" })).statusCode).toBe(200);
    expect((await put(noKey, { prompt: "hola" })).statusCode).toBe(200);
    expect(saved).toHaveLength(2);
    await noKey.close();

    const withKey = await server({ vercelKeyConfigured: true });
    const res = await put(withKey, { prompt: "hola", provider: "vercel", model: "deepseek/barato" });
    expect(res.statusCode).toBe(200);
    expect(saved).toEqual([{ side: "red", body: { prompt: "hola", provider: "vercel", model: "deepseek/barato" } }]);
  });
});

describe("GET /api/matches/:id/transcript", () => {
  it("devuelve el JSONL tal cual", async () => {
    const res = await (await server()).inject({ method: "GET", url: API_ROUTES.transcript(ID) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toBe(RAW);
  });

  it("con ?format=text devuelve el texto para leer", async () => {
    const res = await (await server()).inject({ method: "GET", url: `${API_ROUTES.transcript(ID)}?format=text` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain("Rojo    dice: «¡Hola!»");
  });

  it("responde 400 con un id inválido y 404 si no hay transcripción", async () => {
    const s = await server();
    const bad = await s.inject({ method: "GET", url: API_ROUTES.transcript("no-es-un-id") });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "Id de pelea inválido", message: "Id de pelea inválido" });
    const upper = await s.inject({ method: "GET", url: API_ROUTES.transcript(ID.toUpperCase()) });
    expect(upper.statusCode).toBe(400);
    const missing = await s.inject({ method: "GET", url: API_ROUTES.transcript(randomUUID()) });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("No hay transcripción de esa pelea");
  });
});
