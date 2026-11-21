#!/usr/bin/env node
// Prueba de la voz de los agentes (ElevenLabs), a mano, una vez puesta la clave.
//
//   node scripts/voice-check.mjs        (Node 22; sin dependencias)
//
// Lee el `.env` de la raíz del repo (las variables ya definidas en el entorno ganan), dice
// una frase corta en español con la voz de cada lado y muestra el tiempo al primer byte,
// el total, los bytes recibidos, lo que costó (`character-cost`) y los créditos que quedan.
// Usa los mismos ajustes que el orquestador. Nunca imprime la clave. Cada prueba gasta
// unos pocos créditos. Termina con código 1 si algo falla.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.elevenlabs.io";
const SENTENCE = "Hola, soy tu rival. Prepárate, que esta pelea no la vas a ganar.";
const TIMEOUT_MS = 20_000;

/** Mismo formato que libs/env/src/dotenv.ts: `CLAVE=valor`, `#` comenta, comillas opcionales. */
function readDotEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    const first = value.charAt(0);
    if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = readDotEnv(join(root, ".env"));
/** Primero el entorno real, después el `.env`; vacío cuenta como no puesto. */
const setting = (name, fallback = "") => {
  const value = (process.env[name] ?? "").trim() || (fileEnv[name] ?? "").trim();
  return value || fallback;
};

const key = setting("ELEVENLABS_API_KEY");
const voices = { rojo: setting("ELEVENLABS_VOICE_RED"), azul: setting("ELEVENLABS_VOICE_BLUE") };
const model = setting("ELEVENLABS_MODEL", "eleven_flash_v2_5");
const rawSpeed = Number(setting("ELEVENLABS_SPEED", "1.1"));
const speed = Number.isFinite(rawSpeed) ? Math.min(1.2, Math.max(0.7, rawSpeed)) : 1;
const format = setting("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_64");
const language = setting("ELEVENLABS_LANGUAGE");
const minLeft = Number(setting("VOICE_MIN_CREDITS_LEFT", "5000"));

/** Un texto de la API sin la clave, por si viniera dentro. */
const clean = (text) => (key ? String(text).split(key).join("***") : String(text));

/** Lo que trae ElevenLabs en un error: {"detail":{"type","code","message","status"}}. */
function describeError(status, raw) {
  let detail = {};
  try {
    const parsed = JSON.parse(raw);
    detail = typeof parsed.detail === "object" && parsed.detail !== null ? parsed.detail : { message: parsed.detail };
  } catch {
    detail = {};
  }
  const code = detail.code || detail.status || detail.type || "";
  const message = detail.message ? `: ${clean(detail.message)}` : "";
  if (status === 402 || code === "insufficient_credits" || code === "quota_exceeded") {
    return `la cuenta no tiene créditos (HTTP ${status})${message}`;
  }
  if (status === 401) return `ElevenLabs rechazó la clave (HTTP 401)${message}. Revisa ELEVENLABS_API_KEY`;
  if (status === 404 || code === "voice_not_found" || code === "invalid_voice_id") {
    return `ElevenLabs no reconoce esa voz (HTTP ${status})${message}`;
  }
  if (status === 429) return `ElevenLabs está ocupado (HTTP 429${code ? `, ${code}` : ""})${message}. Prueba en un rato`;
  return `ElevenLabs respondió HTTP ${status}${code ? ` (${code})` : ""}${message}`;
}

async function credits() {
  const res = await fetch(`${API}/v1/user/subscription`, {
    headers: { "xi-api-key": key, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  if (res.status === 401 || res.status === 403) {
    // La voz pudo andar igual: pasa con una clave restringida sin permiso para leer la cuenta.
    return {
      error: `ElevenLabs no deja leer la cuenta (HTTP ${res.status}). Dale a la clave permiso de lectura de "User" (User: Read): sin él, el orquestador no puede aplicar VOICE_MIN_CREDITS_LEFT`,
    };
  }
  if (!res.ok) return { error: describeError(res.status, raw) };
  const data = JSON.parse(raw);
  return {
    used: data.character_count,
    limit: data.character_limit,
    reset: data.next_character_count_reset_unix,
  };
}

async function speak(side, voice) {
  const body = {
    text: SENTENCE,
    model_id: model,
    ...(language ? { language_code: language } : {}),
    voice_settings: { speed, stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: false },
  };
  const url = `${API}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=${encodeURIComponent(format)}`;
  const started = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    console.log(`  FALLA  ${side}: ${describeError(res.status, await res.text())}`);
    return false;
  }
  let firstByte = null;
  let bytes = 0;
  for await (const chunk of res.body) {
    if (firstByte === null) firstByte = performance.now() - started;
    bytes += chunk.length;
  }
  const total = performance.now() - started;
  const cost = res.headers.get("character-cost") ?? "no vino";
  const ms = (value) => (value === null ? "-" : `${Math.round(value)} ms`);
  console.log(
    `  OK     ${side}: primer byte ${ms(firstByte)}, total ${ms(total)}, ${bytes} bytes, costo ${cost}`,
  );
  if (bytes === 0) {
    console.log(`  FALLA  ${side}: el audio llegó vacío`);
    return false;
  }
  return true;
}

async function main() {
  console.log("Voz de los agentes (ElevenLabs)");
  if (!key) {
    console.log("  FALTA  ELEVENLABS_API_KEY: ponla en el .env de la raíz (ver .env.example).");
    process.exit(1);
  }
  console.log(`  Modelo ${model}, velocidad ${speed}, formato ${format}, idioma ${language || "automático"}`);
  let failures = 0;
  for (const [side, voice] of Object.entries(voices)) {
    if (!voice) {
      const name = side === "rojo" ? "ELEVENLABS_VOICE_RED" : "ELEVENLABS_VOICE_BLUE";
      console.log(`  FALTA  ${name}: el id de la voz del lado ${side} (su página en la app de ElevenLabs).`);
      failures += 1;
      continue;
    }
    try {
      if (!(await speak(`${side} (voz ${voice})`, voice))) failures += 1;
    } catch (err) {
      console.log(`  FALLA  ${side}: no se pudo llegar a ElevenLabs: ${clean(err?.message ?? err)}`);
      failures += 1;
    }
  }
  try {
    const c = await credits();
    if (c.error) {
      console.log(`  AVISO  No se pudieron leer los créditos: ${c.error}`);
    } else {
      const left = c.limit - c.used;
      const reset = Number.isFinite(c.reset) ? new Date(c.reset * 1000).toLocaleString("es-CL") : "?";
      console.log(`  Créditos: quedan ${left} de ${c.limit} (se renuevan el ${reset})`);
      if (Number.isFinite(minLeft) && left < minLeft) {
        console.log(`  AVISO  Quedan menos de ${minLeft} (VOICE_MIN_CREDITS_LEFT): el orquestador no hablará.`);
      }
    }
  } catch (err) {
    console.log(`  AVISO  No se pudieron leer los créditos: ${clean(err?.message ?? err)}`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main();
