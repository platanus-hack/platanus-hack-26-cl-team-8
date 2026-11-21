import { truncate } from "./util";

/** Ajustes de red. Es un objeto mutable para que los tests puedan acortar los tiempos. */
export const httpConfig = {
  /** Tiempo máximo por intento. */
  timeoutMs: 15_000,
  /** Reintentos ante 429 / 5xx / error de red. */
  retries: 1,
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
