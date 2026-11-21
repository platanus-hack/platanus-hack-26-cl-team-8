import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createFighter } from "@phack/agent";
import { loadEnv } from "@phack/env";
import { DEFAULT_MODELS, createLlmClient } from "@phack/llm";
import type { ServerDefaults } from "@phack/protocol";
import { applyWorldRules, buildArena } from "./arena";
import { Hub } from "./hub";
import { MatchManager } from "./match";
import { RconClient } from "./rcon";
import { buildServer } from "./server";
import { MatchStore, PromptStore } from "./store";
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
  await prompts.load();
  await history.load();

  const rcon = new RconClient({
    host: env.RCON_HOST,
    port: env.RCON_PORT,
    password: env.RCON_PASSWORD,
    log,
  });

  const hub = new Hub();
  const match = new MatchManager({
    env,
    rcon,
    hub,
    prompts,
    history,
    createFighter,
    createLlmClient,
    log,
  });
  hub.setProviders({ getState: () => match.getState(), getPrompts: () => prompts.get() });
  hub.start();

  // LLM_MODEL solo reemplaza el modelo por defecto del proveedor elegido en LLM_PROVIDER.
  const defaults: ServerDefaults = {
    provider: env.LLM_PROVIDER,
    models: { ...DEFAULT_MODELS, ...(env.LLM_MODEL ? { [env.LLM_PROVIDER]: env.LLM_MODEL } : {}) },
  };

  const app = await buildServer({ hub, match, prompts, history, defaults });
  await app.listen({ host: env.ORCHESTRATOR_HOST, port: env.ORCHESTRATOR_PORT });
  log("info", `API escuchando en ${env.ORCHESTRATOR_HOST}:${env.ORCHESTRATOR_PORT} (LLM por defecto: ${env.LLM_PROVIDER})`);

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
