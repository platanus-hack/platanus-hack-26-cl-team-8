import { truncate } from "./util";

/** Ajustes de red. Es un objeto mutable para que los tests puedan acortar los tiempos. */
export const httpConfig = {
  /** Tiempo máximo por intento. */
  timeoutMs: 15_000,
  /** Reintentos ante 429 / 5xx / error de red. */
  retries: 1,
  /** Espera antes del reintento. */
  retryDelayMs: 600,
};

/** Error de un proveedor de LLM: incluye proveedor, status HTTP y cuerpo truncado. */
export class LlmError extends Error {
  readonly provider: string;
  /** null si no hubo respuesta HTTP (error de red o timeout). */
  readonly status: number | null;
  /** Cuerpo de la respuesta, truncado. */
  readonly body: string;

  constructor(provider: string, status: number | null, body: string, detail?: string) {
    const shortBody = truncate(body);
    const parts = [`[llm:${provider}]`];
    if (status !== null) parts.push(`HTTP ${status}`);
    if (detail) parts.push(detail);
    if (shortBody) parts.push(`- ${shortBody}`);
    super(parts.join(" "));
    this.name = "LlmError";
    this.provider = provider;
    this.status = status;
    this.body = shortBody;
  }
}

function abortError(provider: string): Error {
  const err = new Error(`[llm:${provider}] solicitud cancelada`);
  err.name = "AbortError";
  return err;
}

function sleep(ms: number, provider: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(provider));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(provider));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type PostJsonOptions = {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
};

type Outcome = { ok: true; data: unknown } | { ok: false; retryable: boolean; error: Error };

async function attempt(opts: PostJsonOptions): Promise<Outcome> {
  const { provider, signal } = opts;
  if (signal?.aborted) return { ok: false, retryable: false, error: abortError(provider) };

  // Se combina el timeout propio con la señal de quien llama en un solo controller.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, httpConfig.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, retryable, error: new LlmError(provider, res.status, text) };
    }
    try {
      return { ok: true, data: JSON.parse(text) as unknown };
    } catch {
      return {
        ok: false,
        retryable: false,
        error: new LlmError(provider, res.status, text, "la respuesta no es JSON válido"),
      };
    }
  } catch (err) {
    if (signal?.aborted) return { ok: false, retryable: false, error: abortError(provider) };
    if (timedOut) {
      return {
        ok: false,
        retryable: false,
        error: new LlmError(provider, null, "", `tiempo de espera agotado (${httpConfig.timeoutMs} ms)`),
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, retryable: true, error: new LlmError(provider, null, "", `error de red: ${message}`) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * POST con cuerpo JSON y respuesta JSON.
 * - Timeout por intento (httpConfig.timeoutMs) combinado con la señal de quien llama.
 * - Un reintento con espera ante 429, 5xx o error de red.
 * - Lanza LlmError (proveedor + status + cuerpo truncado) o un error con name "AbortError"
 *   si quien llama canceló.
 */
export async function postJson(opts: PostJsonOptions): Promise<unknown> {
  let lastError: Error = new LlmError(opts.provider, null, "", "sin intentos");
  for (let i = 0; i <= httpConfig.retries; i++) {
    if (i > 0) await sleep(httpConfig.retryDelayMs * i, opts.provider, opts.signal);
    const outcome = await attempt(opts);
    if (outcome.ok) return outcome.data;
    lastError = outcome.error;
    if (!outcome.retryable) break;
  }
  throw lastError;
}
