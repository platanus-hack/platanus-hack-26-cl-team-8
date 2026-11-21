import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  DEFAULT_SETTINGS,
  buildBenchReport,
  syncMode,
  validateCustomKit,
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
import { MatchActiveError } from "./match";
import { UnknownPresetError } from "./presets";
import { applyModelPolicy, buildServer, parseRange, type ModelPolicy } from "./server";
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
  /** Audio de las frases; sin esto la ruta de audio siempre da 404. */
  speech?: { get(speechId: string): Promise<Buffer | null> };
};

/** Ajustes guardados por PUT /api/settings; cada servidor de prueba parte de los de por defecto. */
let settings: MatchSettings = { ...DEFAULT_SETTINGS, comms: "none", timer: true, timerSeconds: null, mode: "single", voice: false };

/** Lo que llegó a guardarse con PUT /api/prompts/:side. */
let saved: { side: Side; body: UpdatePromptBody }[] = [];
let presetCalls: { id: string; start: boolean }[] = [];
let archived = 0;

async function server(opts: ServerOptions = {}): Promise<FastifyInstance> {
  saved = [];
  settings = { ...DEFAULT_SETTINGS, comms: "none", timer: true, timerSeconds: null, mode: "single", voice: false };
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
    presets: {
      snapshot: () => ({ presets: [], suite: { running: false, queue: [], index: 0, done: 0, stoppedReason: null } }),
      run: async (id: string, start: boolean) => {
        presetCalls.push({ id, start });
        if (id === "nada") throw new UnknownPresetError(id);
        if (id === "ocupado") throw new MatchActiveError();
        return { presets: [], suite: { running: start, queue: [id], index: 0, done: 0, stoppedReason: null } };
      },
      stop: () => ({ presets: [], suite: { running: false, queue: [], index: 0, done: 0, stoppedReason: "detenida a mano" } }),
      isRunning: () => false,
    },
    archiveHistory: async () => {
      archived += 1;
      return "matches-x.jsonl";
    },
    bench: { report: async (options) => buildBenchReport(opts.history ?? [], 42, options) },
    judge: async (id) =>
      id === ID ? { ok: false as const, reason: "el juez necesita un LLM real", status: 400 as const } : id === JUDGED ? { ok: true as const, judgement: JUDGEMENT } : null,
    ...(opts.speech ? { speech: opts.speech } : {}),
    settings: {
      get: () => ({ ...settings }),
      update: async (change) => {
        settings = syncMode({ ...settings, ...change });
        return { ...settings };
      },
    },
  });
  return app;
}

const JUDGED = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const JUDGEMENT = {
  model: "juez",
  at: 1,
  red: { strategy: 1, adaptation: 1, coherence: 1, deception: 1, persuasion: 1, environment: 1, comment: "" },
  blue: { strategy: 2, adaptation: 2, coherence: 2, deception: 2, persuasion: 2, environment: 2, comment: "" },
  summary: "s",
};

describe("benchmarks: GET /api/bench y POST /api/matches/:id/judge", () => {
  it("el tablero se calcula con el historial", async () => {
    const s = await server();
    const res = await s.inject({ method: "GET", url: "/api/bench" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ generatedAt: 42, matches: 0, models: [], scenario: null, minMatches: 5 });
  });

  it("filtra por escenario y fija las partidas mínimas; rechaza valores que no son", async () => {
    const s = await server();
    const ok = await s.inject({ method: "GET", url: "/api/bench?scenario=dilemma&min=3" });
    expect(ok.json()).toMatchObject({ scenario: "dilemma", minMatches: 3 });
    expect((await s.inject({ method: "GET", url: "/api/bench?scenario=all" })).json().scenario).toBeNull();
    for (const query of ["scenario=batalla", "min=0", "min=2.5", "min=mucho"]) {
      expect((await s.inject({ method: "GET", url: `/api/bench?${query}` })).statusCode).toBe(400);
    }
  });

  it("el juez: 400 si no puede, 404 si la pelea no existe, la nota si califica", async () => {
    const s = await server();
    expect((await s.inject({ method: "POST", url: `/api/matches/${ID}/judge` })).statusCode).toBe(400);
    expect((await s.inject({ method: "POST", url: "/api/matches/11111111-2222-4333-8444-555555555555/judge" })).statusCode).toBe(404);
    expect((await s.inject({ method: "POST", url: "/api/matches/no-es-id/judge" })).statusCode).toBe(400);
    const ok = await s.inject({ method: "POST", url: `/api/matches/${JUDGED}/judge` });
    expect(ok.json()).toMatchObject({ summary: "s" });
  });
});

describe("PUT /api/settings", () => {
  const put = (s: FastifyInstance, payload: Record<string, unknown>) =>
    s.inject({ method: "PUT", url: "/api/settings", payload });

  it("cambia solo lo que viene: apagar el límite de tiempo no toca la comunicación", async () => {
    const s = await server();
    expect((await put(s, { comms: "chat" })).json()).toEqual({ ...DEFAULT_SETTINGS, comms: "chat", timer: true, timerSeconds: null, mode: "single", voice: false });
    expect((await put(s, { timer: false })).json()).toEqual({ ...DEFAULT_SETTINGS, comms: "chat", timer: false, timerSeconds: null, mode: "single", voice: false });
    expect((await put(s, { comms: "none", timer: true })).json()).toEqual({ ...DEFAULT_SETTINGS, comms: "none", timer: true, timerSeconds: null, mode: "single", voice: false });
  });

  it("acepta el modo de la partida y cambia solo eso", async () => {
    const s = await server();
    expect((await put(s, { timer: false })).json()).toEqual({ ...DEFAULT_SETTINGS, comms: "none", timer: false, timerSeconds: null, mode: "single", voice: false });
    // Un cliente de antes que solo manda el modo pide una serie de 5 rondas.
    expect((await put(s, { mode: "rounds" })).json()).toEqual({ ...DEFAULT_SETTINGS, comms: "none", timer: false, timerSeconds: null, mode: "rounds", rounds: 5, voice: false });
    expect((await put(s, { mode: "single" })).json()).toEqual({ ...DEFAULT_SETTINGS, comms: "none", timer: false, timerSeconds: null, mode: "single", voice: false });
    const bad = await put(s, { mode: "torneo" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("mode = single o rounds");
    expect((await s.inject({ method: "GET", url: "/api/settings" })).json()).toEqual({ ...DEFAULT_SETTINGS, comms: "none", timer: false, timerSeconds: null, mode: "single", voice: false });
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

  it("acepta la voz y cambia solo eso", async () => {
    const s = await server();
    expect((await put(s, { comms: "chat" })).json()).toMatchObject({ comms: "chat", voice: false });
    expect((await put(s, { voice: true })).json()).toEqual({ ...DEFAULT_SETTINGS, comms: "chat", timer: true, timerSeconds: null, mode: "single", voice: true });
    expect((await put(s, { timer: false })).json()).toMatchObject({ timer: false, voice: true });
    const bad = await put(s, { voice: "sí" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("voice = true o false");
    expect((await put(s, { voice: false })).json()).toMatchObject({ comms: "chat", voice: false });
  });

  it("rechaza un cuerpo vacío o con valores que no son", async () => {
    const s = await server();
    for (const payload of [{}, { timer: "no" }, { comms: "telepatía" }, { rounds: 0 }, { rounds: 11 }, { rounds: 2.5 }, { scenario: "batalla" }, { rules: { red: ["volar"] } }]) {
      const res = await put(s, payload);
      expect(res.statusCode).toBe(400);
    }
    expect((await s.inject({ method: "GET", url: "/api/settings" })).json()).toEqual({ ...DEFAULT_SETTINGS, comms: "none", timer: true, timerSeconds: null, mode: "single", voice: false });
  });

  it("guarda los ajustes de benchmark; las reglas de un lado no pisan las del otro", async () => {
    const s = await server();
    expect((await put(s, { scenario: "dilemma", rounds: 4, horizon: "unknown", judge: true })).json()).toMatchObject({
      scenario: "dilemma",
      rounds: 4,
      horizon: "unknown",
      judge: true,
    });
    await put(s, { rules: { red: ["no_lava"] } });
    expect((await put(s, { rules: { blue: ["no_bow", "no_pearl"] } })).json().rules).toEqual({ red: ["no_lava"], blue: ["no_bow", "no_pearl"] });
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

describe("PUT /api/prompts/:side con inventario armado en la web", () => {
  const put = (s: FastifyInstance, payload: Record<string, unknown>) =>
    s.inject({ method: "PUT", url: "/api/prompts/red", payload });
  const kit = validateCustomKit({
    items: [
      { slot: "armor.head", item: "diamond_helmet", count: 1 },
      { slot: "hotbar.0", item: "netherite_sword", count: 1, enchantments: [{ id: "sharpness", level: 3 }] },
      { slot: "hotbar.8", item: "arrow", count: 64 },
    ],
  }).kit;

  it("acepta un inventario válido con kit custom y lo pasa a guardar", async () => {
    const res = await put(await server(), { prompt: "hola", kit: "custom", customKit: kit });
    expect(res.statusCode).toBe(200);
    expect(saved[0]?.body.customKit).toEqual(kit);
  });

  it("rechaza uno inválido con 400 y el primer problema, sin guardar", async () => {
    const s = await server();
    const helmetInHotbar = { ...kit, items: [{ slot: "hotbar.3", item: "iron_helmet", count: 1, label: "Casco" }] };
    const res = await put(s, { prompt: "hola", kit: "custom", customKit: helmetInHotbar });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Inventario inválido: Casco de hierro: solo puede ir en la cabeza");
    const overStack = { ...kit, items: [{ slot: "hotbar.0", item: "bow", count: 3, label: "Arco" }] };
    expect((await put(s, { prompt: "hola", kit: "custom", customKit: overStack })).json().error).toBe(
      "Inventario inválido: Arco: la cantidad va de 1 a 1",
    );
    const malformed = await put(s, { prompt: "hola", kit: "custom", customKit: { items: "muchos" } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toContain("Inventario inválido");
    expect(saved).toEqual([]);
  });

  it("con un kit fijo el inventario se ignora", async () => {
    const res = await put(await server(), { prompt: "hola", kit: "archer", customKit: kit });
    expect(res.statusCode).toBe(200);
    expect(saved).toEqual([{ side: "red", body: { prompt: "hola", kit: "archer" } }]);
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
    settings: { ...DEFAULT_SETTINGS, comms: "none", timer: true, timerSeconds: null, mode: "single", voice: false },
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
    settings: { ...DEFAULT_SETTINGS, comms: "chat", timer: false, timerSeconds: null, mode: "single", voice: false },
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
      settings: { ...DEFAULT_SETTINGS, comms: "chat", timer: false, timerSeconds: null, mode: "single", voice: false },
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

describe("GET /api/speech/:id", () => {
  const SPEECH_ID = "3f0c2d4e-8a1b-4c5d-9e6f-a7b8c9d0e1f2";
  const MP3 = Buffer.from("ID3-audio-de-prueba");
  const speech = { get: async (id: string) => (id === SPEECH_ID ? MP3 : null) };

  it("entrega el audio con su tipo y caché larga", async () => {
    const s = await server({ speech });
    const res = await s.inject({ method: "GET", url: API_ROUTES.speech(SPEECH_ID) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mpeg");
    expect(res.headers["cache-control"]).toBe("public, max-age=3600, immutable");
    expect(res.rawPayload.equals(MP3)).toBe(true);
  });

  it("atiende un rango de bytes (Safari)", async () => {
    const s = await server({ speech });
    const res = await s.inject({ method: "GET", url: API_ROUTES.speech(SPEECH_ID), headers: { range: "bytes=0-1" } });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-1/${MP3.length}`);
    expect(res.rawPayload.toString()).toBe("ID");
    const out = await s.inject({ method: "GET", url: API_ROUTES.speech(SPEECH_ID), headers: { range: "bytes=999-" } });
    expect(out.statusCode).toBe(416);
  });

  it("400 con un id mal formado y 404 si no hay audio", async () => {
    const s = await server({ speech });
    for (const id of ["no-es-un-id", "..%2F..%2Fsettings", SPEECH_ID.toUpperCase()]) {
      const res = await s.inject({ method: "GET", url: API_ROUTES.speech(id) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Id de audio inválido");
    }
    const missing = await s.inject({ method: "GET", url: API_ROUTES.speech(randomUUID()) });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("No hay audio para esa frase");
  });

  it("sin servicio de voz siempre da 404", async () => {
    const s = await server();
    const res = await s.inject({ method: "GET", url: API_ROUTES.speech(SPEECH_ID) });
    expect(res.statusCode).toBe(404);
  });
});

describe("parseRange", () => {
  it("lee un rango simple y deja pasar lo que no atiende", () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=0-99", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("bytes=10-", 10)).toBe("invalid");
    expect(parseRange("bytes=4-2", 10)).toBe("invalid");
  });
});

describe("PUT /api/settings: rondas", () => {
  const put = (s: FastifyInstance, payload: Record<string, unknown>) => s.inject({ method: "PUT", url: "/api/settings", payload });

  it("1 es una pelea suelta y más de 1 una serie; el modo sale de ahí", async () => {
    const s = await server();
    expect((await put(s, { rounds: 3 })).json()).toMatchObject({ rounds: 3, mode: "rounds" });
    expect((await put(s, { rounds: 1 })).json()).toMatchObject({ rounds: 1, mode: "single" });
    // Con un número de rondas, el modo que venga no manda.
    expect((await put(s, { rounds: 4, mode: "single" })).json()).toMatchObject({ rounds: 4, mode: "rounds" });
    expect((await put(s, { mode: "single" })).json()).toMatchObject({ rounds: 1, mode: "single" });
  });
});

describe("pre-ajustes y borrar el historial", () => {
  it("POST /api/presets/:id carga o ejecuta; 404 si no existe, 409 si hay algo en curso", async () => {
    presetCalls = [];
    const s = await server();
    expect((await s.inject({ method: "POST", url: "/api/presets/dilema", payload: {} })).json().suite.running).toBe(false);
    expect((await s.inject({ method: "POST", url: "/api/presets/todos", payload: { start: true } })).json().suite.running).toBe(true);
    expect(presetCalls).toEqual([
      { id: "dilema", start: false },
      { id: "todos", start: true },
    ]);
    expect((await s.inject({ method: "POST", url: "/api/presets/nada" })).statusCode).toBe(404);
    expect((await s.inject({ method: "POST", url: "/api/presets/ocupado", payload: { start: true } })).statusCode).toBe(409);
    expect((await s.inject({ method: "POST", url: "/api/presets/dilema", payload: { start: "sí" } })).statusCode).toBe(400);
    expect((await s.inject({ method: "POST", url: "/api/presets/stop" })).json().suite.stoppedReason).toBe("detenida a mano");
    expect((await s.inject({ method: "GET", url: "/api/presets" })).statusCode).toBe(200);
  });

  it("DELETE /api/history exige confirm BORRAR", async () => {
    archived = 0;
    const s = await server();
    expect((await s.inject({ method: "DELETE", url: "/api/history", payload: {} })).statusCode).toBe(400);
    expect((await s.inject({ method: "DELETE", url: "/api/history", payload: { confirm: "borrar" } })).statusCode).toBe(400);
    const ok = await s.inject({ method: "DELETE", url: "/api/history", payload: { confirm: "BORRAR" } });
    expect(ok.json()).toEqual({ archived: "matches-x.jsonl" });
    expect(archived).toBe(1);
  });
});
