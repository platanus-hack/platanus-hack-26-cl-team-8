import type { TokenUsage } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Intenta sacar un objeto JSON de un texto: primero el texto completo y, si falla,
 * el tramo entre la primera "{" y la última "}". Devuelve null si no hay objeto.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const candidates = [text.trim()];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    if (candidate === "") continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // se prueba el siguiente candidato
    }
  }
  return null;
}

/**
 * Parseo tolerante de los argumentos de una tool call. Los proveedores a veces
 * devuelven un string JSON, a veces un objeto, a veces basura: nunca lanza.
 */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === "string") return extractJsonObject(raw) ?? {};
  return {};
}

/** Un contador de tokens válido (entero >= 0) o null. */
export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * Arma el consumo de tokens a partir de los campos crudos del proveedor. Si alguno
 * falta o no es un número válido devuelve undefined: mejor no informar que informar mal.
 */
export function toTokenUsage(input: unknown, output: unknown): TokenUsage | undefined {
  const inputTokens = tokenCount(input);
  const outputTokens = tokenCount(output);
  if (inputTokens === null || outputTokens === null) return undefined;
  return { inputTokens, outputTokens };
}
