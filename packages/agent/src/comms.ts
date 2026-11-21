import { MAX_AGENT_MESSAGE_LENGTH } from "@phack/protocol";

/**
 * Lo que se dicen los agentes (modo "chat") y lo que uno lee del otro (modo "thoughts").
 * El sistema solo hace limpieza técnica: no corrige, no resume, no filtra por contenido y
 * no descarta repetidos. Los turnos para hablar los ordena el orquestador (ver apps/orchestrator/src/conversation.ts).
 */

/** Máximo de razonamientos o mensajes del rival que se juntan entre dos decisiones. */
export const INBOX_MAX = 12;
/** Mensajes de la conversación (de los dos lados) que se repiten en cada observación. */
export const CONVERSATION_MAX = 12;

/** Caracteres de control salvo el salto de línea (incluye DEL y los C1). */
const CONTROL_EXCEPT_NEWLINE = /(?!\n)\p{Cc}/gu;

/**
 * Limpieza técnica de un texto entre agentes: unifica los saltos de línea, cambia los
 * tabuladores por espacios, quita los demás caracteres de control (deja "\n"), recorta
 * los espacios de los extremos y corta en MAX_AGENT_MESSAGE_LENGTH caracteres (contados
 * por punto de código, así un emoji no queda partido). El resto queda tal cual: espacios
 * internos, saltos de línea, idioma, mayúsculas. null si no es texto o queda vacío.
 */
export function cleanMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\r\n/g, "\n").replace(/\t/g, " ").replace(CONTROL_EXCEPT_NEWLINE, "").trim();
  const chars = Array.from(text);
  const cut = chars.length > MAX_AGENT_MESSAGE_LENGTH ? chars.slice(0, MAX_AGENT_MESSAGE_LENGTH).join("") : text;
  return cut.length > 0 ? cut : null;
}

/** Un mensaje de la conversación: "tú" es el propio agente. */
export type ConversationLine = { from: "tú" | "rival"; text: string };

/** Lo que va en una observación, con la marca para confirmarlo después (ver CommsInbox.confirm). */
export type InboxSnapshot = {
  rivalThoughts: string[];
  rivalMessages: string[];
  conversation: ConversationLine[];
  /** Hasta qué línea de la bandeja vio el LLM. */
  upTo: number;
};

type Pending = { seq: number; text: string };

/**
 * Bandeja de lo que llega del rival y memoria de la conversación. Una línea sale de la
 * bandeja solo cuando el LLM que la vio respondió (confirm): si esa llamada falla o se
 * corta, la línea vuelve a ir en la próxima observación y no se pierde.
 */
export class CommsInbox {
  private seq = 0;
  private thoughts: Pending[] = [];
  private messages: Pending[] = [];
  private conversation: ConversationLine[] = [];

  /** Llega algo del rival. Devuelve false si después de limpiarlo no queda nada. */
  hear(kind: "thought" | "message", raw: unknown): boolean {
    const text = cleanMessage(raw);
    if (text === null) return false;
    this.seq += 1;
    const box = kind === "thought" ? this.thoughts : this.messages;
    box.push({ seq: this.seq, text });
    // Si el agente se demora en decidir, se queda con lo más nuevo.
    if (box.length > INBOX_MAX) box.splice(0, box.length - INBOX_MAX);
    if (kind === "message") this.remember({ from: "rival", text });
    return true;
  }

  /** El propio agente le dijo esto al rival (ya limpio): entra a la conversación. */
  said(text: string): void {
    this.remember({ from: "tú", text });
  }

  /** Copia para la observación. Nada sale de la bandeja hasta confirm(upTo). */
  snapshot(): InboxSnapshot {
    return {
      rivalThoughts: this.thoughts.map((line) => line.text),
      rivalMessages: this.messages.map((line) => line.text),
      conversation: this.conversation.map((line) => ({ ...line })),
      upTo: this.seq,
    };
  }

  /** El LLM que vio la bandeja hasta `upTo` respondió: esas líneas ya no se repiten. */
  confirm(upTo: number): void {
    this.thoughts = this.thoughts.filter((line) => line.seq > upTo);
    this.messages = this.messages.filter((line) => line.seq > upTo);
  }

  private remember(line: ConversationLine): void {
    this.conversation.push(line);
    if (this.conversation.length > CONVERSATION_MAX) {
      this.conversation.splice(0, this.conversation.length - CONVERSATION_MAX);
    }
  }
}
