#!/usr/bin/env node
// Revisión previa para desarrollo local. Solo usa módulos de Node: se puede correr
// antes de instalar dependencias.
//
//   pnpm local:check        (o: node scripts/local-check.mjs)
//
// Revisa Node, pnpm y Docker, crea `.env` desde `.env.example` si falta, y avisa
// de puertos ocupados. Termina con código 1 si falta algo indispensable.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

let failures = 0;
const ok = (text) => console.log(`  OK     ${text}`);
const warn = (text) => console.log(`  AVISO  ${text}`);
const fail = (text) => {
  failures += 1;
  console.log(`  FALTA  ${text}`);
};

/** Corre un comando y devuelve su salida, o null si no existe o falla. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: isWindows });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ""}`.trim();
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

console.log("\nPrompt Arena: revisión para desarrollo local\n");

// ---------- Node ----------
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 22) ok(`Node ${process.versions.node}`);
else fail(`Node ${process.versions.node}: se necesita Node 22 o superior (lo exige mineflayer).`);

// ---------- pnpm ----------
const pnpmVersion = run("pnpm", ["--version"]);
if (pnpmVersion === null) {
  fail("pnpm no está instalado. Instálalo con: npm i -g pnpm@10");
} else if (Number(pnpmVersion.split(".")[0]) >= 10) {
  ok(`pnpm ${pnpmVersion}`);
} else {
  warn(`pnpm ${pnpmVersion}: el repo está pensado para pnpm 10 o superior (npm i -g pnpm@10).`);
}

// ---------- Docker ----------
const composeVersion = run("docker", ["compose", "version", "--short"]);
if (composeVersion === null) {
  fail("Docker con Compose v2 no está disponible (se usa para Minecraft, MediaMTX y la cámara).");
} else {
  ok(`Docker Compose ${composeVersion}`);
  if (run("docker", ["info", "--format", "{{.ServerVersion}}"]) === null) {
    warn("El daemon de Docker no responde: abre Docker Desktop o inicia el servicio antes de `pnpm local:infra`.");
  }
}

// ---------- .env ----------
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  ok(".env existe");
} else {
  try {
    copyFileSync(join(root, ".env.example"), envFile);
    ok(".env creado desde .env.example (modo mock: no necesita claves de LLM)");
  } catch (error) {
    fail(`No se pudo crear .env: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------- Dependencias ----------
if (existsSync(join(root, "apps", "orchestrator", "node_modules"))) {
  ok("Dependencias instaladas");
} else {
  warn("Faltan dependencias: corre `pnpm local:install`.");
}

// ---------- Puertos ----------
const appPorts = [
  [4321, "web (astro dev)"],
  [8787, "orquestador"],
];
const infraPorts = [
  [25565, "Minecraft"],
  [25575, "RCON"],
  [8888, "HLS de MediaMTX"],
  [1935, "RTMP de MediaMTX"],
];

for (const [port, label] of appPorts) {
  if (await portFree(port)) ok(`Puerto ${port} libre (${label})`);
  else warn(`Puerto ${port} ocupado (${label}): ¿ya está corriendo \`pnpm dev\`? Si es otro programa, ciérralo.`);
}
for (const [port, label] of infraPorts) {
  if (await portFree(port)) ok(`Puerto ${port} libre (${label})`);
  else warn(`Puerto ${port} ocupado (${label}): normal si ya corriste \`pnpm local:infra\`; si no, otro programa lo usa.`);
}

console.log("");
if (failures > 0) {
  console.log(`Faltan ${failures} requisito(s). Corrígelos y vuelve a correr \`pnpm local:check\`.\n`);
  process.exit(1);
}

console.log("Siguientes pasos:");
console.log("  pnpm local:install   # dependencias (sin la cámara, que solo corre en Docker)");
console.log("  pnpm local:infra     # Minecraft + MediaMTX en Docker");
console.log("  pnpm dev             # orquestador + web  ->  http://localhost:4321");
console.log("  pnpm local:camera    # opcional: video de la pelea\n");
