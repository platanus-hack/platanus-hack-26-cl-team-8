import type { ChatMessage, LlmResponse } from "@phack/llm";

/** Máximo de mensajes de historial (sin contar el system ni la observación nueva). */
export const MAX_HISTORY_MESSAGES = 12;

/**
 * Recorta el historial dejando como máximo `maxMessages` mensajes, botando
 * siempre desde el principio y por turnos completos: el resultado empieza en un
 * mensaje "user", de modo que nunca queda un mensaje "tool" sin su "assistant"
 * con la tool call correspondiente (los proveedores rechazan pares rotos).
 */
export function trimHistory(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  if (maxMessages <= 0) return [];
  let start = Math.max(0, messages.length - maxMessages);
  while (start < messages.length) {
    const message = messages[start];
    if (message && message.role === "user") break;
    start++;
  }
  return messages.slice(start);
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
  const turn: ChatMessage[] = [{ role: "user", content: observationJson }];
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
