import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createFighter } from "@phack/agent";
import { loadEnv } from "@phack/env";
import { DEFAULT_MODELS, createLlmClient } from "@phack/llm";
import { buildBenchReport, type ServerDefaults } from "@phack/protocol";
import { applyWorldRules, buildArena } from "./arena";
import { FlagStore, withFlagOutcomes } from "./flags";
import { Hub } from "./hub";
import { MatchManager } from "./match";
import { ModelCatalog } from "./models";
import { RconClient } from "./rcon";
import { buildServer } from "./server";
import { SpeechService } from "./speech";
import { MatchStore, PromptStore, SettingsStore } from "./store";
import { TranscriptStore } from "./transcript";
import { errorMessage, sleep, type LogFn } from "./util";

const log: LogFn = (level, text) => {
  const line = `[orquestador] ${text}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

async function main(): Promise<void> {
  const env = loadEnv();
  const dataDir = resolve(env.DATA_DIR);

  try {
    await mkdir(dataDir, { recursive: true });
  } catch (err) {
    log("warn", `No se pudo crear la carpeta de datos ${dataDir}: ${errorMessage(err)}`);
  }

  const prompts = new PromptStore(dataDir, log);
  const history = new MatchStore(dataDir, log);
  const settings = new SettingsStore(dataDir, log);
  await prompts.load();
  await settings.load();
  await history.load();
  const flags = new FlagStore(dataDir, log);
  await flags.load();
  const transcripts = new TranscriptStore(dataDir, log);

  const rcon = new RconClient({
    host: env.RCON_HOST,
    port: env.RCON_PORT,
    password: env.RCON_PASSWORD,
    log,
  });

  // Voz de los agentes (ElevenLabs). Sin clave o sin las dos voces, los mensajes solo se leen.
  const speech = new SpeechService({
    config: {
      apiKey: env.ELEVENLABS_API_KEY,
      voices: { red: env.ELEVENLABS_VOICE_RED, blue: env.ELEVENLABS_VOICE_BLUE },
      model: env.ELEVENLABS_MODEL,
      speed: env.ELEVENLABS_SPEED,
      outputFormat: env.ELEVENLABS_OUTPUT_FORMAT,
      language: env.ELEVENLABS_LANGUAGE,
      maxChars: env.VOICE_MAX_CHARS,
      minCreditsLeft: env.VOICE_MIN_CREDITS_LEFT,
    },
    dataDir,
    log,
  });
  speech.start();

  // LLM_MODEL solo reemplaza el modelo por defecto del proveedor elegido en LLM_PROVIDER.
  const defaults: ServerDefaults = {
    provider: env.LLM_PROVIDER,
    models: { ...DEFAULT_MODELS, ...(env.LLM_MODEL ? { [env.LLM_PROVIDER]: env.LLM_MODEL } : {}) },
    matchDurationSeconds: env.MATCH_DURATION_SECONDS,
    voice: { available: speech.configured() },
  };

  // Modelos permitidos: el catálogo se baja en segundo plano; mientras tanto vale la lista fija.
  const models = new ModelCatalog({ defaultModel: defaults.models.vercel, log });
  models.start();

  const hub = new Hub();
  const match = new MatchManager({
    env,
    rcon,
    hub,
    prompts,
    settings,
    // Al guardar una pelea (y al llegar su explicación), sus prompts marcados reciben el resultado.
    history: withFlagOutcomes(history, flags, log),
    transcripts,
    createFighter,
    createLlmClient,
    models: {
      isAllowed: (id) => models.isAllowed(id),
      price: (id) => {
        const found = models.snapshot().models.find((model) => model.id === id);
        return found ? { input: found.inputPrice, output: found.outputPrice } : null;
      },
    },
    speech,
    log,
  });
  hub.setProviders({
    getState: () => match.getState(),
    getPrompts: () => prompts.get(),
    getSettings: () => settings.get(),
  });
  hub.start();

  const app = await buildServer({
    hub,
    match,
    prompts,
    settings,
    history,
    flags,
    transcripts,
    bench: { report: async () => buildBenchReport(await history.all()) },
    judge: async (id) => {
      const record = await history.find(id);
      return record ? match.judgeRecord(record) : null;
    },
    defaults,
    models,
    vercelKeyConfigured: env.VERCEL_API_KEY.trim() !== "",
    speech,
  });
  await app.listen({ host: env.ORCHESTRATOR_HOST, port: env.ORCHESTRATOR_PORT });
  log("info", `API escuchando en ${env.ORCHESTRATOR_HOST}:${env.ORCHESTRATOR_PORT} (LLM por defecto: ${env.LLM_PROVIDER})`);
  log("info", speech.configured() ? "Voz de los agentes: disponible (ElevenLabs)" : "Voz de los agentes: sin configurar (falta ELEVENLABS_API_KEY o una voz)");

  // ---------- Apagado ordenado ----------

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `Recibido ${signal}: apagando…`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    void (async () => {
      try {
        await match.shutdown();
        // Lo último de la pelea (su "end") queda escrito antes de salir.
        await transcripts.flush();
        models.stop();
        hub.close();
        await app.close();
        await rcon.close();
      } catch (err) {
        log("error", `Error durante el apagado: ${errorMessage(err)}`);
      }
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ---------- Mundo y arena (en segundo plano: la API ya responde) ----------

  void (async () => {
    while (!shuttingDown) {
      try {
        await rcon.waitUntilReady();
        await applyWorldRules(rcon);
        // No reconstruir encima de una pelea que alguien ya inició.
        if (!match.isActive()) await buildArena(rcon, sleep);
        log("info", "Arena lista");
        return;
      } catch (err) {
        if (shuttingDown) return;
        log("warn", `No se pudo preparar la arena, reintentando: ${errorMessage(err)}`);
        await sleep(5_000);
      }
    }
  })();
}

// Un error suelto de una librería (p. ej. un socket de bot) no debe botar el servidor.
process.on("unhandledRejection", (reason) => {
  log("error", `Promesa rechazada sin manejar: ${errorMessage(reason)}`);
});
process.on("uncaughtException", (err) => {
  log("error", `Excepción no capturada: ${errorMessage(err)}`);
});

main().catch((err) => {
  log("error", `No se pudo iniciar el orquestador: ${errorMessage(err)}`);
  process.exit(1);
});
