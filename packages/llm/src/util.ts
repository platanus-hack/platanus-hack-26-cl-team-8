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
