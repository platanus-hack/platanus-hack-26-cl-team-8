#!/usr/bin/env node
// Levanta el stack completo en esta máquina, sin Docker: cada servicio de
// docker-compose.yml corre como un proceso nativo, con el log prefijado por su nombre.
//
//   minecraft     Paper sobre Java            127.0.0.1:25565 (+ RCON 25575)
//   mediamtx      RTMP -> HLS                 127.0.0.1:1935 / 127.0.0.1:8888
//   orchestrator  API + websocket + agentes   127.0.0.1:8787
//   camera        bot espectador + ffmpeg     publica en rtmp://127.0.0.1:1935/live/arena
//   web           astro dev (con proxy)       http://localhost:4321
//   tunnel        cloudflared (opcional)      conecta el sitio desplegado en Cloudflare
//
// Se lanza con scripts/local/dev.sh (que deja Node 22 en el PATH). Todo escucha solo
// en loopback: el servidor de Minecraft está en modo offline y la API no tiene auth.
//
// Las variables salen de `.env` (las del entorno del shell tienen prioridad).
// Ctrl+C apaga todo en orden (Minecraft guarda el mundo antes de salir).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TUNNEL_NAME = "phack2026-local";

// ---------- Entorno ----------

/** Lee KEY=VALUE de un archivo .env. Las líneas vacías o con valor vacío se ignoran. */
function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (value !== "") out[match[1]] = value;
  }
  return out;
}

const env = {
  // Valores por defecto para correr fuera de Docker.
  MC_HOST: "127.0.0.1",
  RCON_HOST: "127.0.0.1",
  ORCHESTRATOR_HOST: "127.0.0.1",
  DATA_DIR: resolve(ROOT, ".local/data"),
  RTMP_URL: "rtmp://127.0.0.1:1935/live/arena",
  MC_MEMORY: "1G",
  ASTRO_TELEMETRY_DISABLED: "1",
  ...parseEnvFile(resolve(ROOT, ".env")),
  ...process.env,
};

mkdirSync(env.DATA_DIR, { recursive: true });

// ---------- Servicios ----------

const SERVICES = {
  minecraft: {
    cmd: "bash",
    args: ["scripts/local/minecraft.sh"],
    // Paper guarda el mundo al recibir SIGTERM; puede tardar varios segundos.
    stopGraceMs: 40_000,
  },
  mediamtx: {
    cmd: "mediamtx",
    args: ["infra/mediamtx/mediamtx.yml"],
    // Mismo archivo que en Docker, pero escuchando solo en loopback y sin MoQ
    // (que abre otro puerto y escribe certificados en la carpeta actual).
    env: { MTX_RTMPADDRESS: "127.0.0.1:1935", MTX_HLSADDRESS: "127.0.0.1:8888", MTX_MOQ: "false" },
  },
  orchestrator: {
    cmd: "pnpm",
    args: ["--filter", "@phack/orchestrator", "start"],
  },
  camera: {
    cmd: "pnpm",
    args: ["--filter", "@phack/camera", "start"],
  },
  web: {
    cmd: "pnpm",
    args: ["--filter", "@phack/web", "dev", "--host", "127.0.0.1"],
  },
  tunnel: {
    optional: true,
    cmd: "pnpm",
    args: ["--filter", "@phack/web", "exec", "wrangler", "tunnel", "run", TUNNEL_NAME],
  },
};

const COLORS = { minecraft: 32, mediamtx: 35, orchestrator: 36, camera: 33, web: 34, tunnel: 90 };
const useColor = process.stdout.isTTY;

function selectServices(argv) {
  const all = Object.keys(SERVICES);
  const only = [];
  const skip = [];
  let tunnel = false;
  for (const arg of argv) {
    if (arg === "--tunnel") tunnel = true;
    else if (arg.startsWith("--only=")) only.push(...arg.slice(7).split(","));
    else if (arg.startsWith("--skip=")) skip.push(...arg.slice(7).split(","));
    else if (arg === "-h" || arg === "--help") {
      console.log(
        `Uso: bash scripts/local/dev.sh [servicios…] [--only=a,b] [--skip=a,b] [--tunnel]\nServicios: ${all.join(", ")}`,
      );
      process.exit(0);
    } else only.push(arg);
  }
  for (const name of [...only, ...skip]) {
    if (!all.includes(name)) {
      console.error(`Servicio desconocido: "${name}". Servicios: ${all.join(", ")}`);
      process.exit(2);
    }
  }
  const base = only.length > 0 ? only : all.filter((name) => !SERVICES[name].optional);
  const selected = new Set(base);
  if (tunnel) selected.add("tunnel");
  for (const name of skip) selected.delete(name);
  return all.filter((name) => selected.has(name));
}

function logLine(name, line) {
  const tag = `[${name}]`.padEnd(15);
  process.stdout.write(useColor ? `\x1b[${COLORS[name] ?? 0}m${tag}\x1b[0m${line}\n` : `${tag}${line}\n`);
}

const running = new Map();
let shuttingDown = false;

function start(name, attempt = 0) {
  const def = SERVICES[name];
  const startedAt = Date.now();
  // detached: cada servicio queda en su propio grupo de procesos, así el Ctrl+C de la
  // terminal no les llega directo y se pueden apagar enteros (pnpm -> node -> ffmpeg).
  const child = spawn(def.cmd, def.args, {
    cwd: ROOT,
    env: { ...env, ...def.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  running.set(name, child);

  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => logLine(name, line));
  }

  child.on("error", (err) => {
    logLine(name, `No se pudo lanzar "${def.cmd}": ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    running.delete(name);
    if (shuttingDown) {
      logLine(name, "detenido");
      return;
    }
    const uptime = Date.now() - startedAt;
    // Reinicio automático (equivale a `restart: unless-stopped` de compose), con tope
    // para no quedar en bucle si el servicio muere apenas arranca.
    const nextAttempt = uptime > 60_000 ? 0 : attempt + 1;
    if (nextAttempt > 5) {
      logLine(name, `terminó (${signal ?? `código ${code}`}) 6 veces seguidas: no se reinicia más.`);
      return;
    }
    const delay = Math.min(15_000, 2_000 * 2 ** Math.max(0, nextAttempt - 1));
    logLine(name, `terminó (${signal ?? `código ${code}`}); se reinicia en ${Math.round(delay / 1000)} s`);
    setTimeout(() => {
      if (!shuttingDown) start(name, nextAttempt);
    }, delay);
  });
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // El grupo ya no existe.
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nApagando… (Minecraft guarda el mundo antes de salir)");
  let maxGrace = 0;
  for (const [name, child] of running) {
    killGroup(child, "SIGTERM");
    maxGrace = Math.max(maxGrace, SERVICES[name].stopGraceMs ?? 10_000);
  }
  const deadline = Date.now() + maxGrace;
  const timer = setInterval(() => {
    if (running.size === 0) {
      clearInterval(timer);
      process.exit(0);
    }
    if (Date.now() > deadline) {
      for (const child of running.values()) killGroup(child, "SIGKILL");
      clearInterval(timer);
      process.exit(1);
    }
  }, 200);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const selected = selectServices(process.argv.slice(2));
console.log(`Servicios: ${selected.join(", ")}`);
if (selected.includes("web")) console.log("Sitio:     http://localhost:4321");
console.log(`LLM:       ${env.LLM_PROVIDER ?? "mock"}${env.LLM_MODEL ? ` (${env.LLM_MODEL})` : ""}`);
console.log("Ctrl+C para apagar todo.\n");
for (const name of selected) start(name);
