import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Side } from "@phack/protocol";
import { SIDE_LABEL } from "./result";
import { errorMessage, sleep as realSleep, type LogFn, type SleepFn } from "./util";

/**
 * Voz de los agentes: lo que un agente le dice al otro (modo "chat") se convierte en audio
 * con ElevenLabs, una voz por lado. request() no espera: devuelve un id al tiro y la síntesis
 * sigue en segundo plano; la web pide el audio con ese id (GET /api/speech/:id) y get()
 * espera lo que falte. Como la web muestra cada evento con el retraso del video (~1,5 s),
 * normalmente el audio ya está listo cuando aparece el mensaje.
 *
 * Nada de esto lanza hacia la pelea: un fallo deja esa frase sin audio y se registra.
 */

export const ELEVENLABS_API = "https://api.elevenlabs.io";

/** Los ids de audio son UUID en minúsculas (randomUUID). Cualquier otra cosa se rechaza. */
const SPEECH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSpeechId(id: string): boolean {
  return SPEECH_ID.test(id);
}

/** Límites del servicio. Los tests los achican; en producción valen los de por defecto. */
export type SpeechLimits = {
  /** Cuánto espera get() a una síntesis en curso. */
  waitMs: number;
  /** Tope de cada solicitud a ElevenLabs (incluye bajar el audio). */
  requestTimeoutMs: number;
  /** Pausa antes del único reintento tras un 429. */
  retryDelayMs: number;
  /** Solicitudes a ElevenLabs a la vez; las demás esperan su turno. */
  maxConcurrent: number;
  /** Ids recientes que se recuerdan en memoria. */
  maxIds: number;
  /** Pasado este tiempo se olvida un id. */
  idTtlMs: number;
  /** Archivos de audio que se guardan en disco, como máximo. */
  maxFiles: number;
  /** Pausa tras una clave inválida o sin créditos. */
  cooldownMs: number;
  /** Cada cuánto, como mucho, se vuelven a leer los créditos de la cuenta. */
  creditsRefreshMs: number;
  /** Una voz usada hace menos que esto se da por despierta: no se vuelve a calentar. */
  warmForMs: number;
};

export const DEFAULT_SPEECH_LIMITS: SpeechLimits = {
  waitMs: 8_000,
  requestTimeoutMs: 10_000,
  retryDelayMs: 500,
  maxConcurrent: 4,
  maxIds: 500,
  idTtlMs: 30 * 60_000,
  maxFiles: 1000,
  cooldownMs: 10 * 60_000,
  creditsRefreshMs: 10 * 60_000,
  warmForMs: 2 * 60_000,
};

/** Lo que se le pide a una voz para despertarla: lo más corto que igual produce audio. */
const WARM_TEXT = "Hola.";

export type SpeechConfig = {
  apiKey: string;
  voices: Record<Side, string>;
  model: string;
  /** Se deja entre 0.7 y 1.2 (lo que admite ElevenLabs). */
  speed: number;
  outputFormat: string;
  /** ISO 639-1; vacío = lo detecta el modelo. */
  language: string;
  /** Largo máximo del texto que se convierte en voz. */
  maxChars: number;
  /** Con menos créditos que esto en la cuenta, los agentes dejan de hablar. */
  minCreditsLeft: number;
};

/** Lo que se usa de `fetch`; así los tests nunca salen a la red. */
export type SpeechFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export type SpeechDeps = {
  config: SpeechConfig;
  dataDir: string;
  log: LogFn;
  fetch?: SpeechFetch;
  now?: () => number;
  sleep?: SleepFn;
  limits?: Partial<SpeechLimits>;
};

/** Una frase pedida: su id apunta a un archivo de la caché. */
type Line = {
  file: string;
  createdAt: number;
  /** Mientras se genera; null cuando ya terminó. */
  pending: Promise<Synthesis> | null;
  failed: boolean;
  /** Solo si no se pudo guardar en disco: el audio queda en memoria. */
  memory: Buffer | null;
  /** Tamaño del audio en bytes, cuando ya está (para calcular cuánto dura). */
  bytes: number | null;
};

type Synthesis = { audio: Buffer | null; saved: boolean };

/**
 * Hasta cuándo sirve generar una frase: pasado `at`, get() ya se rindió con quien la pedía y
 * nadie la va a oír. Un pedido igual que llega después lo corre más allá.
 */
type Deadline = { at: number };

/** Resultado de una solicitud a ElevenLabs. */
type Attempt = { audio: Buffer } | { retry: true } | { audio: null };

/**
 * Kbps de un formato "mp3_<frecuencia>_<kbps>" de ElevenLabs (bitrate constante); null si el
 * formato es otro y no se puede saber la duración por el tamaño.
 */
export function mp3Kbps(outputFormat: string): number | null {
  const match = /^mp3_\d+_(\d+)$/.exec(outputFormat.trim());
  const kbps = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(kbps) && kbps > 0 ? kbps : null;
}

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(1.2, Math.max(0.7, speed));
}

/**
 * Corta el texto en `max` puntos de código sin partir una palabra (si una sola palabra
 * pasa del largo, se corta igual). No toca el mensaje: es solo lo que se lee en voz alta.
 */
export function cutAtWord(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join("");
  if (/\s/.test(chars[max] ?? "")) return cut.trimEnd();
  const lastSpace = cut.search(/\s\S*$/);
  return lastSpace > 0 ? cut.slice(0, lastSpace).trimEnd() : cut;
}

/** Lo que trae ElevenLabs en un error: {"detail":{"type","code","message","status",...}}. */
function readErrorDetail(raw: string): { type: string; code: string; status: string; message: string } {
  const empty = { type: "", code: "", status: "", message: "" };
  try {
    const parsed: unknown = JSON.parse(raw);
    const detail = typeof parsed === "object" && parsed !== null ? (parsed as { detail?: unknown }).detail : null;
    if (typeof detail === "string") return { ...empty, message: detail };
    if (typeof detail !== "object" || detail === null) return empty;
    const field = (name: string): string => {
      const value = (detail as Record<string, unknown>)[name];
      return typeof value === "string" ? value : "";
    };
    return { type: field("type"), code: field("code"), status: field("status"), message: field("message") };
  } catch {
    return empty;
  }
}

const OUT_OF_CREDITS = ["insufficient_credits", "quota_exceeded"];
const BAD_VOICE = ["voice_not_found", "invalid_voice_id"];

export class SpeechService {
  private readonly limits: SpeechLimits;
  private readonly fetchFn: SpeechFetch;
  private readonly now: () => number;
  private readonly sleep: SleepFn;
  private readonly dir: string;
  private readonly lines = new Map<string, Line>();
  /** Síntesis en curso por clave de caché: dos pedidos iguales comparten una sola solicitud. */
  private readonly inFlight = new Map<string, { job: Promise<Synthesis>; deadline: Deadline }>();
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private cooldownUntil = 0;
  /** Voces que ElevenLabs rechazó (ya se avisó una vez). */
  private readonly badVoices = new Set<string>();
  /** Créditos usados y límite del período, según la última lectura (null = no se sabe). */
  private credits: { used: number; limit: number } | null = null;
  private creditsWarned = false;
  /**
   * Por qué falló la última lectura de créditos (null = funcionó). Se avisa una vez por cada
   * motivo, no cada creditsRefreshMs.
   */
  private creditsReadProblem: "denied" | "other" | null = null;
  /** Ya se avisó que ElevenLabs va atrasado (se vuelve a avisar tras una frase con audio). */
  private behindWarned = false;
  private lastCreditsCheck = Number.NEGATIVE_INFINITY;
  /** Cuándo respondió con audio cada voz por última vez (para saber si sigue despierta). */
  private readonly lastSpokeAt: Record<Side, number> = {
    red: Number.NEGATIVE_INFINITY,
    blue: Number.NEGATIVE_INFINITY,
  };
  private pruning = false;
  private pruneAgain = false;

  constructor(private readonly deps: SpeechDeps) {
    this.limits = { ...DEFAULT_SPEECH_LIMITS, ...deps.limits };
    this.fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
    this.dir = join(deps.dataDir, "speech");
  }

  /**
   * Despierta las dos voces antes de que hagan falta. La primera frase de una voz que lleva
   * un rato sin usarse tarda varios segundos (medido: 5 a 6 s, contra medio segundo las
   * siguientes) y llegaría tarde a la imagen. Se le pide una palabra a cada una y el audio
   * se descarta: cuesta un par de créditos por voz. No hace nada con las que se usaron
   * hace poco, ni espera la respuesta.
   */
  warm(): void {
    if (!this.available()) return;
    for (const side of ["red", "blue"] as const) {
      if (this.now() - this.lastSpokeAt[side] < this.limits.warmForMs) continue;
      // Se anota de inmediato: dos llamadas seguidas no la calientan dos veces.
      this.lastSpokeAt[side] = this.now();
      const deadline: Deadline = { at: this.now() + this.limits.requestTimeoutMs };
      void this.fetchAudio(side, this.deps.config.voices[side], WARM_TEXT, deadline).catch(() => {});
    }
  }

  /** Hay clave y una voz por lado (lo que dice ServerDefaults.voice.available). */
  configured(): boolean {
    const { apiKey, voices } = this.deps.config;
    return apiKey.trim() !== "" && voices.red.trim() !== "" && voices.blue.trim() !== "";
  }

  /**
   * Se puede hablar ahora: hay configuración, no hay pausa por una clave mala o sin créditos
   * y a la cuenta le quedan créditos. Se consulta con cada mensaje, así que de paso vuelve a
   * leer los créditos si la última lectura tiene más de creditsRefreshMs (sin esperarla).
   */
  available(): boolean {
    if (!this.configured()) return false;
    if (this.now() - this.lastCreditsCheck >= this.limits.creditsRefreshMs) void this.refreshCredits();
    return this.now() >= this.cooldownUntil && !this.shortOfCredits();
  }

  /** Al arrancar: lee los créditos en segundo plano. */
  start(): void {
    if (this.configured()) void this.refreshCredits();
  }

  /** Pide el audio de una frase. No espera ni lanza: el id, o null si no hay voz. */
  request(side: Side, text: string): string | null {
    if (!this.available()) return null;
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const { config } = this.deps;
    const spoken = cutAtWord(trimmed, config.maxChars);
    const voice = config.voices[side].trim();
    const key = this.cacheKey(voice, spoken);
    const id = randomUUID();
    const line: Line = {
      file: join(this.dir, `${key}.mp3`),
      createdAt: this.now(),
      pending: null,
      failed: false,
      memory: null,
      bytes: null,
    };
    const pending = this.synthesize(key, line.file, side, voice, spoken);
    line.pending = pending;
    void pending.then((result) => {
      line.pending = null;
      line.failed = result.audio === null;
      line.memory = result.audio && !result.saved ? result.audio : null;
      line.bytes = result.audio ? result.audio.length : null;
    });
    this.lines.set(id, line);
    this.forgetOldIds();
    return id;
  }

  /** El MP3 de esa frase; espera la síntesis en curso (con tope). null si no hay o falló. */
  async get(speechId: string): Promise<Buffer | null> {
    const line = this.lines.get(speechId);
    if (!line) return null;
    if (line.pending) {
      const result = await this.waitFor(line.pending);
      return result?.audio ?? null;
    }
    if (line.failed) return null;
    if (line.memory) return line.memory;
    try {
      return await readFile(line.file);
    } catch {
      return null;
    }
  }

  /**
   * Cuánto dura de verdad el audio de esa frase, en ms; espera a que esté listo (con el mismo
   * tope que get). Los mp3 de ElevenLabs son de bitrate constante: ms = bytes × 8 / kbps.
   * null si falló, si el id no existe o si el formato no es "mp3_<frecuencia>_<kbps>".
   */
  async durationMs(speechId: string): Promise<number | null> {
    const kbps = mp3Kbps(this.deps.config.outputFormat);
    const line = this.lines.get(speechId);
    if (kbps === null || !line) return null;
    if (line.pending) await this.waitFor(line.pending);
    if (line.failed || line.bytes === null) return null;
    return Math.round((line.bytes * 8) / kbps);
  }

  /** Lee los créditos de la cuenta. Un fallo no apaga la voz: solo se registra. */
  async refreshCredits(): Promise<void> {
    if (!this.configured()) return;
    this.lastCreditsCheck = this.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.limits.requestTimeoutMs);
    try {
      const res = await this.fetchFn(`${ELEVENLABS_API}/v1/user/subscription`, {
        method: "GET",
        headers: { "xi-api-key": this.deps.config.apiKey, Accept: "application/json" },
        signal: abort.signal,
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          // Pasa con una clave restringida que puede hablar pero no leer la cuenta: la voz
          // sigue, pero sin el tope de créditos. Si la clave es mala del todo, la síntesis
          // también lo dirá.
          this.creditsReadFailing(
            "denied",
            "error",
            `ElevenLabs no deja leer los créditos de la cuenta (HTTP ${res.status}): el tope VOICE_MIN_CREDITS_LEFT queda sin efecto. Dale a la clave permiso de lectura de "User" (User: Read)`,
          );
        } else {
          this.creditsReadFailing("other", "warn", `No se pudieron leer los créditos de ElevenLabs (HTTP ${res.status})`);
        }
        return;
      }
      const data = JSON.parse(await res.text()) as Record<string, unknown>;
      const used = data.character_count;
      const limit = data.character_limit;
      if (typeof used !== "number" || typeof limit !== "number" || !Number.isFinite(used) || !Number.isFinite(limit)) {
        this.creditsReadFailing("other", "warn", "ElevenLabs respondió los créditos en una forma que no se esperaba");
        return;
      }
      this.creditsReadProblem = null;
      this.credits = { used, limit };
      this.checkCredits();
    } catch (err) {
      this.creditsReadFailing("other", "warn", `No se pudieron leer los créditos de ElevenLabs: ${errorMessage(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- Partes internas ----------

  private cacheKey(voice: string, text: string): string {
    const { model, speed, outputFormat, language } = this.deps.config;
    return createHash("sha256")
      .update(JSON.stringify([model, voice, clampSpeed(speed), outputFormat, language.trim(), text]))
      .digest("hex");
  }

  private synthesize(key: string, file: string, side: Side, voice: string, text: string): Promise<Synthesis> {
    const until = this.now() + this.limits.waitMs;
    const running = this.inFlight.get(key);
    if (running) {
      running.deadline.at = Math.max(running.deadline.at, until);
      return running.job;
    }
    const deadline: Deadline = { at: until };
    const job = (async (): Promise<Synthesis> => {
      const cached = await this.readCached(file);
      if (cached) return { audio: cached, saved: true };
      const audio = await this.fetchAudio(side, voice, text, deadline);
      if (!audio) return { audio: null, saved: false };
      return { audio, saved: await this.save(file, audio) };
    })().catch((err: unknown): Synthesis => {
      this.say("error", `Falló la voz de una frase: ${errorMessage(err)}`);
      return { audio: null, saved: false };
    });
    this.inFlight.set(key, { job, deadline });
    void job.then(() => this.inFlight.delete(key));
    return job;
  }

  private async readCached(file: string): Promise<Buffer | null> {
    try {
      const audio = await readFile(file);
      if (audio.length === 0) return null;
      // Se usó recién: queda entre los últimos en salir al podar la carpeta.
      const now = new Date(this.now());
      utimes(file, now, now).catch(() => {});
      return audio;
    } catch {
      return null;
    }
  }

  private async save(file: string, audio: Buffer): Promise<boolean> {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, audio);
      await rename(tmp, file);
      void this.pruneFiles();
      return true;
    } catch (err) {
      // Si alcanzó a escribirse el temporal, no se deja botado: nadie más lo borraría.
      await rm(tmp, { force: true }).catch(() => {});
      this.say("warn", `No se pudo guardar un audio en ${this.dir}: ${errorMessage(err)}`);
      return false;
    }
  }

  /** Deja la carpeta en maxFiles archivos como mucho; salen primero los más viejos. */
  private async pruneFiles(): Promise<void> {
    if (this.pruning) {
      this.pruneAgain = true;
      return;
    }
    this.pruning = true;
    try {
      do {
        this.pruneAgain = false;
        const names = (await readdir(this.dir)).filter((name) => name.endsWith(".mp3"));
        if (names.length <= this.limits.maxFiles) continue;
        const files = await Promise.all(
          names.map(async (name) => {
            const path = join(this.dir, name);
            try {
              return { path, mtime: (await stat(path)).mtimeMs };
            } catch {
              return { path, mtime: 0 };
            }
          }),
        );
        files.sort((a, b) => a.mtime - b.mtime);
        for (const { path } of files.slice(0, files.length - this.limits.maxFiles)) {
          await unlink(path).catch(() => {});
        }
      } while (this.pruneAgain);
    } catch (err) {
      this.say("warn", `No se pudo podar la carpeta de audios: ${errorMessage(err)}`);
    } finally {
      this.pruning = false;
    }
  }

  /** Olvida los ids de más de idTtlMs y deja como mucho maxIds (los más nuevos). */
  private forgetOldIds(): void {
    const oldest = this.now() - this.limits.idTtlMs;
    for (const [id, line] of this.lines) {
      if (line.createdAt >= oldest && this.lines.size <= this.limits.maxIds) break;
      this.lines.delete(id);
    }
  }

  private async waitFor(pending: Promise<Synthesis>): Promise<Synthesis | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.limits.waitMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Turno para hablar con ElevenLabs: como mucho maxConcurrent a la vez. */
  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limits.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      // El turno pasa directo al siguiente: `active` no cambia.
      if (next) next();
      else this.active -= 1;
    }
  }

  private async fetchAudio(side: Side, voice: string, text: string, deadline: Deadline): Promise<Buffer | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.now() < this.cooldownUntil) return null;
      const result = await this.withSlot(() => {
        // Se vuelve a mirar al tocarle el turno: mientras esta frase esperaba, otra pudo dar
        // con una clave mala o sin créditos, o la espera pudo pasar del tiempo en que alguien
        // la iba a oír. En los dos casos no se le pide nada a ElevenLabs (ni se gastan créditos).
        if (this.now() < this.cooldownUntil) return Promise.resolve<Attempt>({ audio: null });
        if (this.now() >= deadline.at) {
          if (!this.behindWarned) {
            this.behindWarned = true;
            this.say("warn", "ElevenLabs va atrasado: las frases que esperaron demasiado su turno quedan sin voz");
          }
          return Promise.resolve<Attempt>({ audio: null });
        }
        return this.attempt(side, voice, text, attempt === 0);
      });
      if ("audio" in result) {
        if (result.audio) this.behindWarned = false;
        return result.audio;
      }
      await this.sleep(this.limits.retryDelayMs);
    }
    return null;
  }

  private async attempt(side: Side, voice: string, text: string, canRetry: boolean): Promise<Attempt> {
    const { config } = this.deps;
    const language = config.language.trim();
    const body = {
      text,
      model_id: config.model,
      ...(language ? { language_code: language } : {}),
      // style en 0 y sin "speaker boost": las dos cosas suman latencia.
      voice_settings: {
        speed: clampSpeed(config.speed),
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: false,
      },
    };
    const url = `${ELEVENLABS_API}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=${encodeURIComponent(config.outputFormat)}`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.limits.requestTimeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "xi-api-key": config.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (res.ok) {
        const audio = Buffer.from(await res.arrayBuffer());
        this.chargeCredits(res.headers.get("character-cost"));
        if (audio.length === 0) {
          this.say("warn", `ElevenLabs devolvió un audio vacío para ${SIDE_LABEL[side]}`);
          return { audio: null };
        }
        this.lastSpokeAt[side] = this.now();
        return { audio };
      }
      const detail = readErrorDetail(await res.text().catch(() => ""));
      return this.handleError(side, voice, res.status, detail, canRetry);
    } catch (err) {
      if (abort.signal.aborted) {
        this.say("warn", `ElevenLabs tardó más de ${this.limits.requestTimeoutMs / 1000} s: esa frase queda sin voz`);
      } else {
        this.say("warn", `No se pudo llegar a ElevenLabs: ${errorMessage(err)}`);
      }
      return { audio: null };
    } finally {
      clearTimeout(timer);
    }
  }

  private handleError(
    side: Side,
    voice: string,
    status: number,
    detail: ReturnType<typeof readErrorDetail>,
    canRetry: boolean,
  ): Attempt {
    const why = detail.message ? `: ${detail.message}` : "";
    if (status === 402 || OUT_OF_CREDITS.includes(detail.code) || OUT_OF_CREDITS.includes(detail.status)) {
      this.startCooldown(`La cuenta de ElevenLabs se quedó sin créditos (HTTP ${status})${why}`);
      return { audio: null };
    }
    if (status === 401) {
      this.startCooldown(`ElevenLabs rechazó la clave (HTTP 401)${why}. Revisa ELEVENLABS_API_KEY`);
      return { audio: null };
    }
    if (status === 404 || (status === 400 && BAD_VOICE.includes(detail.code))) {
      if (!this.badVoices.has(voice)) {
        this.badVoices.add(voice);
        const variable = side === "red" ? "ELEVENLABS_VOICE_RED" : "ELEVENLABS_VOICE_BLUE";
        this.say("error", `ElevenLabs no reconoce la voz de ${SIDE_LABEL[side]} ("${voice}")${why}. Revisa ${variable}`);
      }
      return { audio: null };
    }
    if (status === 429) {
      if (canRetry) return { retry: true };
      this.say("warn", `ElevenLabs está ocupado (HTTP 429${detail.code ? `, ${detail.code}` : ""}): esa frase queda sin voz`);
      return { audio: null };
    }
    this.say("warn", `ElevenLabs respondió HTTP ${status}${why}: esa frase queda sin voz`);
    return { audio: null };
  }

  /** Una lectura de créditos falló: se avisa solo si el motivo cambió desde la anterior. */
  private creditsReadFailing(problem: "denied" | "other", level: Parameters<LogFn>[0], text: string): void {
    if (this.creditsReadProblem === problem) return;
    this.creditsReadProblem = problem;
    this.say(level, text);
  }

  /** Clave mala o sin créditos: la voz se apaga un rato (se avisa una sola vez). */
  private startCooldown(reason: string): void {
    const inCooldown = this.now() < this.cooldownUntil;
    this.cooldownUntil = this.now() + this.limits.cooldownMs;
    if (!inCooldown) {
      this.say("error", `${reason}. La voz queda apagada por ${Math.round(this.limits.cooldownMs / 60_000)} minutos`);
    }
  }

  /** Suma lo que costó una frase a lo usado, para que el tope reaccione entre lecturas. */
  private chargeCredits(header: string | null): void {
    if (!this.credits || header === null) return;
    const cost = Number(header);
    if (!Number.isFinite(cost) || cost <= 0) return;
    this.credits.used += cost;
    this.checkCredits();
  }

  private shortOfCredits(): boolean {
    return this.credits !== null && this.credits.limit - this.credits.used < this.deps.config.minCreditsLeft;
  }

  private checkCredits(): void {
    if (!this.credits) return;
    const short = this.shortOfCredits();
    if (short && !this.creditsWarned) {
      const left = Math.max(0, this.credits.limit - this.credits.used);
      this.say(
        "warn",
        `A la cuenta de ElevenLabs le quedan ${left} créditos (menos de ${this.deps.config.minCreditsLeft}, VOICE_MIN_CREDITS_LEFT): los agentes dejan de hablar`,
      );
    }
    this.creditsWarned = short;
  }

  /** Registra sin dejar pasar nunca la clave, aunque venga en un mensaje de error. */
  private say(level: Parameters<LogFn>[0], text: string): void {
    const key = this.deps.config.apiKey.trim();
    this.deps.log(level, key ? text.split(key).join("***") : text);
  }
}
