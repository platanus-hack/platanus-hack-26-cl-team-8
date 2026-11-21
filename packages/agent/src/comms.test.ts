import { describe, expect, it } from "vitest";
import { MAX_AGENT_MESSAGE_LENGTH } from "@phack/protocol";
import { CONVERSATION_MAX, CommsInbox, INBOX_MAX, cleanMessage } from "./comms";

describe("cleanMessage", () => {
  it("lo que no es texto o queda vacío es null", () => {
    expect(cleanMessage(undefined)).toBeNull();
    expect(cleanMessage(42)).toBeNull();
    expect(cleanMessage({ text: "hola" })).toBeNull();
    expect(cleanMessage("")).toBeNull();
    expect(cleanMessage(" \n\t\r\n ")).toBeNull();
    expect(cleanMessage("\u0000\u0007")).toBeNull();
  });

  it("solo hace limpieza técnica: deja saltos de línea, espacios internos, idioma y signos", () => {
    expect(cleanMessage("  hola\r\n  ¿tregua?\t sí  ")).toBe("hola\n  ¿tregua?  sí");
    expect(cleanMessage("a\u0000b\u001bc\u007fd\u0085e\rf")).toBe("abcdef");
    expect(cleanMessage("NO TE CREO. I'm lying. 我在撒谎 🤝")).toBe("NO TE CREO. I'm lying. 我在撒谎 🤝");
    expect(cleanMessage('"entre comillas"')).toBe('"entre comillas"');
    // Los caracteres de formato (p. ej. el que une emojis) no son de control.
    expect(cleanMessage("👩‍👩‍👧")).toBe("👩‍👩‍👧");
  });

  it("corta en MAX_AGENT_MESSAGE_LENGTH puntos de código sin partir un emoji", () => {
    expect(cleanMessage("a".repeat(MAX_AGENT_MESSAGE_LENGTH + 50))).toHaveLength(MAX_AGENT_MESSAGE_LENGTH);
    const emojis = cleanMessage("😀".repeat(MAX_AGENT_MESSAGE_LENGTH + 1)) ?? "";
    expect(Array.from(emojis)).toHaveLength(MAX_AGENT_MESSAGE_LENGTH);
    expect(emojis.length).toBe(MAX_AGENT_MESSAGE_LENGTH * 2);
    expect(emojis.endsWith("😀")).toBe(true);
    // Un mensaje ya limpio pasa igual: nunca se corta dos veces.
    expect(cleanMessage(emojis)).toBe(emojis);
  });
});

describe("CommsInbox", () => {
  it("las líneas no salen hasta que el LLM que las vio responde", () => {
    const inbox = new CommsInbox();
    inbox.hear("message", "¿tregua?");
    const first = inbox.snapshot();
    expect(first.rivalMessages).toEqual(["¿tregua?"]);
    // La llamada falló: no se confirma, y la próxima observación la trae de nuevo.
    const retry = inbox.snapshot();
    expect(retry.rivalMessages).toEqual(["¿tregua?"]);

    // Llega otra mientras el LLM piensa: queda para la siguiente.
    inbox.hear("message", "¿hola?");
    inbox.confirm(retry.upTo);
    expect(inbox.snapshot().rivalMessages).toEqual(["¿hola?"]);
  });

  it("dos mensajes iguales seguidos llegan los dos", () => {
    const inbox = new CommsInbox();
    expect(inbox.hear("message", "ríndete")).toBe(true);
    expect(inbox.hear("message", "ríndete")).toBe(true);
    const snap = inbox.snapshot();
    expect(snap.rivalMessages).toEqual(["ríndete", "ríndete"]);
    expect(snap.conversation).toEqual([
      { from: "rival", text: "ríndete" },
      { from: "rival", text: "ríndete" },
    ]);
  });

  it("guarda lo más nuevo si se acumulan demasiadas", () => {
    const inbox = new CommsInbox();
    for (let i = 0; i < INBOX_MAX + 3; i++) inbox.hear("thought", `idea ${i}`);
    const { rivalThoughts } = inbox.snapshot();
    expect(rivalThoughts).toHaveLength(INBOX_MAX);
    expect(rivalThoughts[0]).toBe("idea 3");
    expect(rivalThoughts.at(-1)).toBe(`idea ${INBOX_MAX + 2}`);
  });

  it("la conversación lleva los dos lados, la más vieja primero, y no se vacía al confirmar", () => {
    const inbox = new CommsInbox();
    inbox.hear("message", "hola");
    inbox.said("chao");
    inbox.hear("thought", "un razonamiento no es un mensaje");
    inbox.confirm(inbox.snapshot().upTo);
    const snap = inbox.snapshot();
    expect(snap.rivalMessages).toEqual([]);
    expect(snap.rivalThoughts).toEqual([]);
    expect(snap.conversation).toEqual([
      { from: "rival", text: "hola" },
      { from: "tú", text: "chao" },
    ]);

    for (let i = 0; i < CONVERSATION_MAX; i++) inbox.said(`línea ${i}`);
    const full = inbox.snapshot().conversation;
    expect(full).toHaveLength(CONVERSATION_MAX);
    expect(full[0]).toEqual({ from: "tú", text: "línea 0" });
  });

  it("lo que llega pasa por cleanMessage y lo vacío se ignora", () => {
    const inbox = new CommsInbox();
    expect(inbox.hear("message", "   ")).toBe(false);
    expect(inbox.hear("message", "  dos\r\nlíneas ")).toBe(true);
    expect(inbox.snapshot().rivalMessages).toEqual(["dos\nlíneas"]);
  });
});
