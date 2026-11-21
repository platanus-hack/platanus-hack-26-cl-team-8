import { z } from "zod";
import { loadDotEnv } from "./dotenv";

export { applyDotEnv, findDotEnv, loadDotEnv, parseDotEnv } from "./dotenv";

/**
 * Única fuente de verdad de las variables de entorno del lado servidor.
 * Las apps de Node llaman a `loadEnv()` al arrancar. La web (Astro) NO usa esto:
 * lee sus `PUBLIC_*` con `import.meta.env`.
 */
const EnvSchema = z.object({
  // Servidor de Minecraft
  MC_HOST: z.string().default("127.0.0.1"),
  MC_PORT: z.coerce.number().int().default(25565),
  MC_VERSION: z.string().default("1.20.4"),
  RCON_HOST: z.string().default("127.0.0.1"),
  RCON_PORT: z.coerce.number().int().default(25575),
  RCON_PASSWORD: z.string().default("phack-rcon"),

  // LLM
  LLM_PROVIDER: z.enum(["mock", "vercel", "openai", "anthropic", "openrouter"]).default("mock"),
  LLM_MODEL: z.string().default(""),
  /** Vercel AI Gateway (proveedor "vercel"). */
  VERCEL_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  OPENROUTER_API_KEY: z.string().default(""),

  // Orquestador
  ORCHESTRATOR_PORT: z.coerce.number().int().default(8787),
  MATCH_DURATION_SECONDS: z.coerce.number().int().positive().default(180),
  AGENT_TICK_MS: z.coerce.number().int().positive().default(1500),
  DATA_DIR: z.string().default("./data"),

  // Cámara
  CAMERA_USERNAME: z.string().default("Camara"),
  CAMERA_WIDTH: z.coerce.number().int().default(1280),
  CAMERA_HEIGHT: z.coerce.number().int().default(720),
  CAMERA_FPS: z.coerce.number().int().default(30),
  RTMP_URL: z.string().default("rtmp://localhost:1935/live/arena"),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Sin argumentos: carga primero el `.env` de la raíz del repo (si existe) y luego lee
 * `process.env`. Así `pnpm dev` fuera de Docker usa el mismo `.env` que docker-compose.
 * Con `source` explícito no toca el disco (útil en tests).
 */
export function loadEnv(source?: Record<string, string | undefined>): Env {
  if (source === undefined) loadDotEnv();
  const parsed = EnvSchema.safeParse(source ?? process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Variables de entorno inválidas: ${issues}`);
  }
  return parsed.data;
}
