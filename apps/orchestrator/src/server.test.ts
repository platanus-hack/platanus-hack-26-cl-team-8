import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  type AgentStatus,
  type MatchRecord,
  type MatchState,
  type Provider,
  type ServerDefaults,
  type Side,
  type UpdatePromptBody,
  type MatchSettings,
} from "@phack/protocol";
import { FlagStore } from "./flags";
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

let flagDir: string | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  if (flagDir) await rm(flagDir, { recursive: true, force: true });
  flagDir = null;
});

type ServerOptions = {
  provider?: Provider;
  vercelKeyConfigured?: boolean;
  /** Estado de la pelea en vivo. */
  state?: MatchState;
  /** Peleas en el historial reciente. */
  history?: MatchRecord[];
  /** Prompts marcados; sin esto las rutas de marcas no existen. */
  flags?: FlagStore;
};

/** Ajustes guardados por PUT /api/settings; cada servidor de prueba parte de los de por defecto. */
let settings: MatchSettings = { comms: "none", timer: true, timerSeconds: null, mode: "single" };

/** Lo que llegó a guardarse con PUT /api/prompts/:side. */
let saved: { side: Side; body: UpdatePromptBody }[] = [];

async function server(opts: ServerOptions = {}): Promise<FastifyInstance> {
  saved = [];
  settings = { comms: "none", timer: true, timerSeconds: null, mode: "single" };
  app = await buildServer({
    hub: new Hub(),
    match: {
      getState: () => structuredClone(opts.state ?? ({} as MatchState)),
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
    history: { latest: () => structuredClone(opts.history ?? []) },
    flags: opts.flags,
    transcripts: { read: async (id) => (id === ID ? RAW : null) },
    defaults: { provider: opts.provider ?? "mock", models: {} } as unknown as ServerDefaults,
    models: { isAllowed: () => true, snapshot: () => ({ models: [], source: "fallback", updatedAt: null }) },
    vercelKeyConfigured: opts.vercelKeyConfigured ?? false,
    settings: {
      get: () => ({ ...settings }),
      update: async (change) => {
        settings = { ...settings, ...change };
        return { ...settings };
      },
    },
  });
  return app;
}

describe("PUT /api/settings", () => {
  const put = (s: FastifyInstance, payload: Record<string, unknown>) =>
    s.inject({ method: "PUT", url: "/api/settings", payload });

  it("cambia solo lo que viene: apagar el límite de tiempo no toca la comunicación", async () => {
    const s = await server();
    expect((await put(s, { comms: "chat" })).json()).toEqual({ comms: "chat", timer: true, timerSeconds: null, mode: "single" });
    expect((await put(s, { timer: false })).json()).toEqual({ comms: "chat", timer: false, timerSeconds: null, mode: "single" });
    expect((await put(s, { comms: "none", timer: true })).json()).toEqual({ comms: "none", timer: true, timerSeconds: null, mode: "single" });
  });

  it("acepta el modo de la partida y cambia solo eso", async () => {
    const s = await server();
    expect((await put(s, { timer: false })).json()).toEqual({ comms: "none", timer: false, timerSeconds: null, mode: "single" });
    expect((await put(s, { mode: "rounds" })).json()).toEqual({ comms: "none", timer: false, timerSeconds: null, mode: "rounds" });
    expect((await put(s, { mode: "single" })).json()).toEqual({ comms: "none", timer: false, timerSeconds: null, mode: "single" });
    const bad = await put(s, { mode: "torneo" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("mode = single o rounds");
    expect((await s.inject({ method: "GET", url: "/api/settings" })).json()).toEqual({ comms: "none", timer: false, timerSeconds: null, mode: "single" });
  });

  it("guarda la duración elegida y la suelta con null", async () => {
    const s = await server();
    expect((await put(s, { timerSeconds: 5400 })).json()).toMatchObject({ timer: true, timerSeconds: 5400 });
    // Apagar el límite no borra la duración: queda para cuando se vuelva a encender.
    expect((await put(s, { timer: false })).json()).toMatchObject({ timer: false, timerSeconds: 5400 });
    expect((await put(s, { timerSeconds: null })).json()).toMatchObject({ timerSeconds: null });
  });

  it("rechaza una duración fuera de rango o que no es un entero", async () => {
    const s = await server();
    for (const timerSeconds of [59, 4 * 60 * 60 + 1, 90.5, "120", -1]) {
      const res = await put(s, { timerSeconds });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("timerSeconds entre 60 y 14400");
    }
  });

  it("rechaza un cuerpo vacío o con valores que no son", async () => {
    const s = await server();
    for (const payload of [{}, { timer: "no" }, { comms: "telepatía" }]) {
      const res = await put(s, payload);
      expect(res.statusCode).toBe(400);
    }
    expect((await s.inject({ method: "GET", url: "/api/settings" })).json()).toEqual({ comms: "none", timer: true, timerSeconds: null, mode: "single" });
  });
});

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

// ---------- Prompts marcados ----------

function agentStatus(side: Side): AgentStatus {
  return {
    side,
    username: side,
    connected: true,
    alive: true,
    health: 20,
    food: 20,
    damageDealt: 0,
    decisions: 0,
    lastThought: "",
    lastAction: "",
    heldItem: "",
    tokensIn: 0,
    tokensOut: 0,
    avgDecisionMs: 0,
  };
}

function matchRecord(id: string): MatchRecord {
  return {
    id,
    startedAt: 1000,
    endedAt: 5000,
    durationMs: 4000,
    configs: { red: { side: "red", prompt: "ataca" }, blue: { side: "blue", prompt: "defiende" } },
    final: { red: agentStatus("red"), blue: agentStatus("blue") },
    settings: { comms: "none", timer: true, timerSeconds: null, mode: "single" },
    series: null,
    result: { winner: "blue", reason: "kill" },
  };
}

function liveState(id: string): MatchState {
  return {
    id,
    phase: "running",
    startedAt: 1000,
    endsAt: 61_000,
    countdownEndsAt: null,
    agents: { red: agentStatus("red"), blue: agentStatus("blue") },
    configs: { red: { side: "red", prompt: "en vivo rojo" }, blue: { side: "blue", prompt: "en vivo azul" } },
    settings: { comms: "chat", timer: false, timerSeconds: null, mode: "single" },
    series: null,
    result: null,
  };
}

async function newFlags(): Promise<FlagStore> {
  flagDir = await mkdtemp(join(tmpdir(), "phack-server-flags-"));
  return new FlagStore(flagDir, () => {});
}

describe("rutas de prompts marcados", () => {
  const put = (s: FastifyInstance, id: string, side: string, payload: unknown) =>
    s.inject({ method: "PUT", url: `/api/matches/${id}/flags/${side}`, payload: payload as Record<string, unknown> });

  it("marca la pelea en vivo, sin resultado todavía", async () => {
    const id = randomUUID();
    const s = await server({ state: liveState(id), flags: await newFlags() });
    const res = await put(s, id, "blue", { tags: ["Defensa"], note: "  aguantó  " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      matchId: id,
      side: "blue",
      tags: ["defensa"],
      note: "aguantó",
      config: { side: "blue", prompt: "en vivo azul" },
      rival: { side: "red", prompt: "en vivo rojo" },
      settings: { comms: "chat", timer: false, timerSeconds: null, mode: "single" },
      outcome: null,
    });
    const list = await s.inject({ method: "GET", url: API_ROUTES.flags });
    expect(list.json()).toHaveLength(1);
  });

  it("marca una pelea del historial con su resultado; un cuerpo vacío también vale", async () => {
    const id = randomUUID();
    const s = await server({ history: [matchRecord(id)], flags: await newFlags() });
    const res = await s.inject({ method: "PUT", url: API_ROUTES.flag(id, "red") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tags: [],
      note: "",
      config: { prompt: "ataca" },
      rival: { prompt: "defiende" },
      outcome: { durationMs: 4000, result: { winner: "blue", reason: "kill" } },
    });
  });

  it("edita una marca aunque su pelea ya no esté en el historial", async () => {
    const id = randomUUID();
    const flags = await newFlags();
    const first = await server({ history: [matchRecord(id)], flags });
    const created = (await put(first, id, "red", { tags: ["a"] })).json();
    await first.close();

    const later = await server({ flags });
    const res = await put(later, id, "red", { tags: ["b", "c"], note: "otra vez" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tags: ["b", "c"], note: "otra vez", flaggedAt: created.flaggedAt });
    expect(res.json().outcome).toEqual(created.outcome);
  });

  it("responde 404 si la pelea no está ni en vivo ni en el historial", async () => {
    const s = await server({ state: liveState(randomUUID()), flags: await newFlags() });
    const res = await put(s, randomUUID(), "red", { tags: [] });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Esa pelea ya no está en el historial: no se puede marcar");
  });

  it("responde 400 con un id, un lado o un cuerpo inválidos", async () => {
    const id = randomUUID();
    const s = await server({ history: [matchRecord(id)], flags: await newFlags() });
    const badId = await put(s, "no-es-un-id", "red", {});
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error).toBe("Id de pelea inválido");
    const badSide = await put(s, id, "verde", {});
    expect(badSide.statusCode).toBe(400);
    expect(badSide.json().error).toBe("Lado inválido: usa 'red' o 'blue'");
    for (const payload of [{ tags: "a" }, { note: 5 }, { note: "x".repeat(501) }, { tags: Array(33).fill("a") }]) {
      const res = await put(s, id, "red", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Cuerpo inválido: se espera un JSON { tags, note } con hasta 8 etiquetas");
    }
    const delBad = await s.inject({ method: "DELETE", url: API_ROUTES.flag("no-es-un-id", "red") });
    expect(delBad.statusCode).toBe(400);
    const delSide = await s.inject({ method: "DELETE", url: `/api/matches/${id}/flags/verde` });
    expect(delSide.statusCode).toBe(400);
    expect((await s.inject({ method: "GET", url: API_ROUTES.flags })).json()).toEqual([]);
  });

  it("DELETE quita la marca y responde ok aunque no hubiera nada", async () => {
    const id = randomUUID();
    const s = await server({ history: [matchRecord(id)], flags: await newFlags() });
    await put(s, id, "red", {});
    await put(s, id, "blue", {});
    const del = await s.inject({ method: "DELETE", url: API_ROUTES.flag(id, "red") });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect((await s.inject({ method: "DELETE", url: API_ROUTES.flag(id, "red") })).json()).toEqual({ ok: true });
    const list = (await s.inject({ method: "GET", url: API_ROUTES.flags })).json();
    expect(list.map((f: { side: string }) => f.side)).toEqual(["blue"]);
  });

  it("sin el almacén de marcas las rutas no existen", async () => {
    const res = await (await server()).inject({ method: "GET", url: API_ROUTES.flags });
    expect(res.statusCode).toBe(404);
  });
});
