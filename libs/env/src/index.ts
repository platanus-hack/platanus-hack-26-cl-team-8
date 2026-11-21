import { z } from "zod";
import { loadDotEnv } from "./dotenv";

export { applyDotEnv, findDotEnv, loadDotEnv, parseDotEnv } from "./dotenv";

/**
 * Única fuente de verdad de las variables de entorno del lado servidor.
 * Las apps de Node llaman a `loadEnv()` al arrancar. La web (Astro) NO usa esto:
 * lee sus `PUBLIC_*` con `import.meta.env`.
 */
/** Un número opcional: vacío (p. ej. `ELEVENLABS_SPEED=` en el .env) cuenta como no puesto. */
function optionalNumber<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema);
}

/** Un texto con valor por defecto: vacío (p. ej. `ELEVENLABS_MODEL=` en el .env) cuenta como no puesto. */
function textOr(fallback: string) {
  return z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.string().default(fallback));
}

const EnvSchema = z.object({
  // Servidor de Minecraft
  MC_HOST: z.string().default("127.0.0.1"),
  MC_PORT: z.coerce.number().int().default(25565),
  MC_VERSION: z.string().default("1.20.4"),
  RCON_HOST: z.string().default("127.0.0.1"),
  RCON_PORT: z.coerce.number().int().default(25575),
  RCON_PASSWORD: z.string().default("phack-rcon"),
  /**
   * Escenario de la arena (= nombre del mundo del servidor). Los valores válidos son los de
   * ARENA_SCENARIOS en @phack/protocol; este paquete no depende de él, por eso se repiten.
   */
  ARENA_SCENARIO: z.enum(["platanus", "pizza-spleef-2"]).default("platanus"),

  // LLM
  /** "vercel" = Vercel AI Gateway; "mock" = LLM simulado, sin red ni costo. */
  LLM_PROVIDER: z.enum(["mock", "vercel"]).default("mock"),
  LLM_MODEL: z.string().default(""),
  /** Vercel AI Gateway (proveedor "vercel"). */
  VERCEL_API_KEY: z.string().default(""),

  // Orquestador
  /** Interfaz donde escucha la API. En Docker debe ser 0.0.0.0; en local conviene 127.0.0.1. */
  ORCHESTRATOR_HOST: z.string().default("0.0.0.0"),
  ORCHESTRATOR_PORT: z.coerce.number().int().default(8787),
  MATCH_DURATION_SECONDS: z.coerce.number().int().positive().default(180),
  /**
   * Tope de seguridad para las peleas SIN límite de tiempo: pasado este tiempo el servidor
   * la detiene (sin ganador), para que una pelea olvidada no gaste tokens toda la noche.
   * 0 = sin tope.
   */
  MATCH_MAX_SECONDS: z.coerce.number().int().min(0).default(1800),
  AGENT_TICK_MS: z.coerce.number().int().positive().default(1500),
  AGENT_OBSERVATION_RADIUS: z.coerce.number().int().min(8).max(64).default(16),
  DATA_DIR: z.string().default("./data"),

  // Voz de los agentes (ElevenLabs). Sin clave o sin las dos voces, los mensajes solo se leen.
  ELEVENLABS_API_KEY: z.string().default(""),
  /** Id de la voz de cada lado (la página de la voz en la app de ElevenLabs). */
  ELEVENLABS_VOICE_RED: z.string().default(""),
  ELEVENLABS_VOICE_BLUE: z.string().default(""),
  ELEVENLABS_MODEL: textOr("eleven_flash_v2_5"),
  /** Velocidad del habla; donde se usa se deja entre 0.7 y 1.2. */
  ELEVENLABS_SPEED: optionalNumber(z.coerce.number().default(1.1)),
  ELEVENLABS_OUTPUT_FORMAT: textOr("mp3_44100_64"),
  /** Idioma ISO 639-1 (p. ej. "es"). Vacío = lo detecta el modelo: los agentes eligen su idioma. */
  ELEVENLABS_LANGUAGE: z.string().default(""),
  /** Largo máximo del texto que se convierte en voz; el mensaje se corta en una palabra. */
  VOICE_MAX_CHARS: optionalNumber(z.coerce.number().int().positive().default(300)),
  /** Con menos créditos que esto en la cuenta, los agentes dejan de hablar. */
  VOICE_MIN_CREDITS_LEFT: optionalNumber(z.coerce.number().int().min(0).default(5000)),

  // Cámara
  CAMERA_USERNAME: z.string().default("Camara"),
  CAMERA_WIDTH: z.coerce.number().int().default(1280),
  CAMERA_HEIGHT: z.coerce.number().int().default(720),
  CAMERA_FPS: z.coerce.number().int().default(30),
  RTMP_URL: z.string().default("rtmp://localhost:1935/live/arena"),
});

export type Env = z.infer<typeof EnvSchema>;

/** Proveedores que existieron y se quitaron: un `.env` viejo todavía puede nombrarlos. */
const REMOVED_PROVIDERS = ["openai", "anthropic", "openrouter"];

/**
 * Deja un `.env` de antes en la forma de hoy, sin tocar el original:
 * - "gateway" era Vercel AI Gateway con otro nombre: ahora es "vercel", y su clave
 *   (AI_GATEWAY_API_KEY) vale como VERCEL_API_KEY si esta no está.
 * - Los demás proveedores quitados no tienen reemplazo automático: el error dice qué poner.
 */
function withLegacyNames(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const env = { ...source };
  const provider = (env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "gateway") env.LLM_PROVIDER = "vercel";
  if (REMOVED_PROVIDERS.includes(provider)) {
    throw new Error(
      `Variables de entorno inválidas: LLM_PROVIDER="${provider}" ya no existe. Usa "vercel" (Vercel AI Gateway, con su clave en VERCEL_API_KEY) o "mock" (LLM simulado).`,
    );
  }
  if (!(env.VERCEL_API_KEY ?? "").trim() && (env.AI_GATEWAY_API_KEY ?? "").trim()) {
    env.VERCEL_API_KEY = env.AI_GATEWAY_API_KEY;
  }
  return env;
}

function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

/**
 * Sin argumentos: carga primero el `.env` de la raíz del repo (si existe) y luego lee
 * `process.env`. Así `pnpm dev` fuera de Docker usa el mismo `.env` que docker-compose.
 * Con `source` explícito no toca el disco (útil en tests).
 */
export function loadEnv(source?: Record<string, string | undefined>): Env {
  if (source === undefined) loadDotEnv();
  const parsed = EnvSchema.safeParse(withLegacyNames(source ?? process.env));
  if (!parsed.success) throw new Error(`Variables de entorno inválidas: ${issuesText(parsed.error)}`);
  return parsed.data;
}

/**
 * Igual que `loadEnv`, pero solo lee y valida las variables pedidas. Para procesos que
 * usan una parte (la cámara no habla con ningún LLM): un valor malo en una variable que
 * no les toca no les impide arrancar.
 */
export function loadEnvKeys<K extends keyof Env>(
  keys: readonly K[],
  source?: Record<string, string | undefined>,
): Pick<Env, K> {
  if (source === undefined) loadDotEnv();
  const mask = Object.fromEntries(keys.map((key) => [key, true])) as { [key in keyof Env]?: true };
  const parsed = EnvSchema.pick(mask).safeParse(source ?? process.env);
  if (!parsed.success) throw new Error(`Variables de entorno inválidas: ${issuesText(parsed.error)}`);
  return parsed.data as Pick<Env, K>;
}
