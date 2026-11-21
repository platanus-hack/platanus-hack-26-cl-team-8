import type { ChatMessage, LlmResponse } from "@phack/llm";

/** Máximo de mensajes de historial (sin contar el system ni la observación nueva). */
export const MAX_HISTORY_MESSAGES = 12;
export const MAX_HISTORY_BYTES = 6000;

/** La foto actual va completa; las anteriores conservan evolución y resultados, no el mapa. */
export function summarizeObservation(json: string): string {
  let observation: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json;
    observation = parsed as Record<string, unknown>;
  } catch { return json; }
  const summary: Record<string, unknown> = {};
  for (const key of ["secondsElapsed", "health", "food", "position", "opponentRelative", "opponentHealth", "inventory", "currentAction", "lastActionResult", "queuedActions", "rivalMessages", "rivalThoughts"]) {
    if (observation[key] !== undefined) summary[key] = observation[key];
  }
  const construction = observation.construction;
  if (construction && typeof construction === "object") {
    const plan = construction as Record<string, unknown>;
    summary.construction = { status: plan.status, completed: plan.completed, total: plan.total, reason: plan.reason };
  }
  return JSON.stringify(summary);
}

/**
 * Recorta el historial dejando como máximo `maxMessages` mensajes, botando
 * siempre desde el principio y por turnos completos: el resultado empieza en un
 * mensaje "user", de modo que nunca queda un mensaje "tool" sin su "assistant"
 * con la tool call correspondiente (los proveedores rechazan pares rotos).
 */
export function trimHistory(messages: ChatMessage[], maxMessages: number, maxBytes = MAX_HISTORY_BYTES): ChatMessage[] {
  if (maxMessages <= 0) return [];
  let start = Math.max(0, messages.length - maxMessages);
  while (start < messages.length) {
    const message = messages[start];
    if (message && message.role === "user") break;
    start++;
  }
  let result = messages.slice(start);
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && result.length > 0) {
    let next = 1;
    while (next < result.length && result[next]?.role !== "user") next++;
    result = result.slice(next);
  }
  return result;
}

/**
 * Mensajes que deja un turno completo: observación, respuesta del asistente y un
 * mensaje "tool" por cada tool call (todas deben tener respuesta).
 * `resultFor` entrega el resultado de cada tool call según su posición.
 */
export function buildTurnMessages(
  observationJson: string,
  response: LlmResponse,
  resultFor: (index: number) => string,
): ChatMessage[] {
  const turn: ChatMessage[] = [{ role: "user", content: summarizeObservation(observationJson) }];
  if (response.toolCalls.length === 0) {
    turn.push({ role: "assistant", content: response.text });
    return turn;
  }
  turn.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
  response.toolCalls.forEach((call, index) => {
    turn.push({ role: "tool", toolCallId: call.id, name: call.name, content: resultFor(index) });
  });
  return turn;
}
