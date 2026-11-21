import { truncate } from "./util";

/** Ajustes de red. Es un objeto mutable para que los tests puedan acortar los tiempos. */
export const httpConfig = {
  /** Incluye respuestas con planos de cientos de bloques; el caller puede abortar antes. */
  timeoutMs: 60_000,
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
  /**
   * true si es un fallo pasajero de infraestructura (429, 408, 5xx, red, timeout) y no
   * culpa del pedido: vale la pena reintentar. Si no se indica, se deduce del status.
   */
  readonly retryable: boolean;

  constructor(provider: string, status: number | null, body: string, detail?: string, retryable?: boolean) {
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
    this.retryable = retryable ?? isRetryableStatus(status);
  }
}

/** 429, 408, 5xx o sin respuesta HTTP (red / timeout) = fallo pasajero. */
export function isRetryableStatus(status: number | null): boolean {
  return status === null || status === 408 || status === 429 || status >= 500;
}
