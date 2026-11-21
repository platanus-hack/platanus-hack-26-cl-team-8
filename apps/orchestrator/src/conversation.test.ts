import { describe, expect, it } from "vitest";
import type { Side } from "@phack/protocol";
import {
  Conversation,
  MIN_SPEECH_MS,
  SAME_SPEAKER_GAP_MS,
  STALE_MS,
  TURN_GAP_JITTER_MS,
  TURN_GAP_MS,
  estimateSpeechMs,
  type ReleaseFn,
} from "./conversation";
import { manualClock } from "./test-clock";

/** Una conversación a velocidad 1 que anota cada frase que sale y cuándo. */
function setup(opts: { random?: number; onRelease?: ReleaseFn } = {}) {
  const clock = manualClock(opts.random ?? 0);
  const released: { side: Side; text: string; at: number }[] = [];
  const conversation = new Conversation({
    speed: 1,
    clock,
    onRelease: (side, text) => {
      released.push({ side, text, at: clock.now() });
      return opts.onRelease?.(side, text);
    },
  });
  return { clock, released, conversation };
}

/** Un texto que dura exactamente `ms` a velocidad 1 (`ms` múltiplo de 46). */
function lasting(ms: number): string {
  if (ms % 46 !== 0) throw new Error(`${ms} no es múltiplo de 46`);
  return "a".repeat(ms / 46);
}

describe("estimateSpeechMs", () => {
  it("46 ms por carácter a velocidad 1, dividido por la velocidad, nunca menos del mínimo", () => {
    expect(estimateSpeechMs("a".repeat(100), 1)).toBe(4600);
    expect(estimateSpeechMs("a".repeat(100), 1.15)).toBe(4000);
    // La frase medida: 64 caracteres a velocidad 1.1 duraron 2,69 s.
    expect(estimateSpeechMs("x".repeat(64), 1.1)).toBeCloseTo(2690, -2);
    expect(estimateSpeechMs("Sí.", 1)).toBe(MIN_SPEECH_MS);
    expect(estimateSpeechMs("😀".repeat(20), 1)).toBe(920);
    expect(estimateSpeechMs("a".repeat(100), Number.NaN)).toBe(4600);
  });
});

describe("Conversation", () => {
  it("con la palabra libre la frase sale en el acto", () => {
    const { released, conversation, clock } = setup();
    conversation.say("red", "Hola.");
    expect(released).toEqual([{ side: "red", text: "Hola.", at: 0 }]);
    expect(clock.timers()).toBe(0);
  });

  it("la respuesta espera a que termine la frase más la pausa de cambio de turno", () => {
    const { released, conversation, clock } = setup({ random: 1 });
    conversation.say("red", lasting(2300));
    clock.advance(300);
    conversation.say("blue", "¿Qué?");
    expect(released).toHaveLength(1);
    const replyAt = 2300 + TURN_GAP_MS + TURN_GAP_JITTER_MS;
    clock.advance(replyAt - 300 - 1);
    expect(released).toHaveLength(1);
    clock.advance(1);
    expect(released[1]).toEqual({ side: "blue", text: "¿Qué?", at: replyAt });
  });

  it("la pausa de cambio de turno varía con el azar, tomado al soltar la frase", () => {
    const { released, conversation, clock } = setup({ random: 0 });
    conversation.say("red", lasting(920));
    conversation.say("blue", "Ya.");
    clock.advance(920 + TURN_GAP_MS);
    expect(released.map((line) => line.at)).toEqual([0, 920 + TURN_GAP_MS]);
  });

  it("el mismo lado sigue hablando tras su propia pausa", () => {
    const { released, conversation, clock } = setup();
    conversation.say("red", lasting(920));
    conversation.say("red", "Y otra cosa.");
    clock.advance(920 + SAME_SPEAKER_GAP_MS - 1);
    expect(released).toHaveLength(1);
    clock.advance(1);
    expect(released[1]).toMatchObject({ side: "red", text: "Y otra cosa.", at: 920 + SAME_SPEAKER_GAP_MS });
  });

  it("una frase libre después de la pausa sale en el acto; antes de que pase, espera", () => {
    const { released, conversation, clock } = setup();
    conversation.say("red", lasting(920));
    clock.advance(1100);
    conversation.say("red", "Todavía no.");
    expect(released).toHaveLength(1);
    clock.advance(400);
    expect(released).toHaveLength(2);
    clock.advance(5000);
    conversation.say("blue", "Ahora.");
    expect(released[2]).toMatchObject({ side: "blue", at: 6500 });
  });

  it("una frase nueva reemplaza a la que esperaba del mismo lado", () => {
    const { released, conversation, clock } = setup();
    conversation.say("red", lasting(920));
    conversation.say("blue", "Primera idea.");
    conversation.say("blue", "Mejor esta.");
    clock.advance(10_000);
    expect(released.map((line) => line.text)).toEqual([lasting(920), "Mejor esta."]);
  });

  it("si esperan los dos, sale primero el que no habló último, y se van turnando", () => {
    const { released, conversation, clock } = setup();
    conversation.say("red", lasting(920));
    conversation.say("red", "Rojo otra vez.");
    conversation.say("blue", "Azul.");
    clock.advance(920 + TURN_GAP_MS);
    expect(released.map((line) => line.side)).toEqual(["red", "blue"]);
    conversation.say("blue", "Azul otra vez.");
    clock.advance(10_000);
    expect(released.map((line) => line.text)).toEqual([lasting(920), "Azul.", "Rojo otra vez.", "Azul otra vez."]);
  });

  it("la duración real del audio acorta la palabra", async () => {
    const { released, conversation, clock } = setup({ onRelease: async (side) => (side === "red" ? 800 : null) });
    conversation.say("red", lasting(2990));
    conversation.say("blue", "Te escucho.");
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(800 + TURN_GAP_MS);
    expect(released[1]).toMatchObject({ side: "blue", at: 800 + TURN_GAP_MS });
  });

  it("la duración real del audio alarga la palabra, aunque llegue tarde", async () => {
    let resolve: (ms: number) => void = () => {};
    const { released, conversation, clock } = setup({
      onRelease: (side) => (side === "red" ? new Promise<number>((r) => (resolve = r)) : undefined),
    });
    conversation.say("red", lasting(920));
    clock.advance(500);
    resolve(4000);
    await Promise.resolve();
    conversation.say("blue", "¿Terminaste?");
    clock.advance(1000);
    expect(released).toHaveLength(1);
    clock.advance(4000 + TURN_GAP_MS - 1500);
    expect(released[1]).toMatchObject({ side: "blue", at: 4000 + TURN_GAP_MS });
  });

  it("una duración real que llega después de la frase siguiente no mueve nada", async () => {
    let resolve: (ms: number) => void = () => {};
    const { released, conversation, clock } = setup({
      onRelease: (_side, text) => (text === "uno" ? new Promise<number>((r) => (resolve = r)) : undefined),
    });
    conversation.say("red", "uno");
    clock.advance(MIN_SPEECH_MS + TURN_GAP_MS);
    conversation.say("blue", "dos");
    conversation.say("red", "tres");
    resolve(60_000);
    await Promise.resolve();
    clock.advance(MIN_SPEECH_MS + TURN_GAP_MS);
    expect(released.map((line) => line.text)).toEqual(["uno", "dos", "tres"]);
  });

  it("una frase que esperó más de 10 s cuando le toca se descarta", () => {
    const { released, conversation, clock } = setup({ onRelease: () => {} });
    conversation.say("red", lasting(12_006));
    conversation.say("blue", "Esto ya no viene al caso.");
    clock.advance(STALE_MS + 1000);
    conversation.say("red", "Sigo yo.");
    clock.advance(10_000);
    expect(released.map((line) => line.text)).toEqual([lasting(12_006), "Sigo yo."]);
  });

  it("clear() corta los temporizadores, borra lo que esperaba y no suelta nada más", async () => {
    let resolve: (ms: number) => void = () => {};
    const { released, conversation, clock } = setup({ onRelease: () => new Promise<number>((r) => (resolve = r)) });
    conversation.say("red", lasting(920));
    conversation.say("blue", "No alcanzo.");
    conversation.say("red", "Yo tampoco.");
    expect(clock.timers()).toBe(1);
    conversation.clear();
    expect(clock.timers()).toBe(0);
    resolve(100);
    await Promise.resolve();
    clock.advance(60_000);
    expect(released).toHaveLength(1);
    expect(clock.timers()).toBe(0);
    // Después de clear la palabra queda libre (la ronda siguiente parte de cero).
    conversation.say("blue", "Nueva ronda.");
    expect(released[1]).toMatchObject({ side: "blue", text: "Nueva ronda.", at: 60_000 });
  });

  it("un error al soltar una frase no traba la conversación", () => {
    const { released, conversation, clock } = setup({
      onRelease: () => {
        throw new Error("falló");
      },
    });
    conversation.say("red", "uno");
    conversation.say("blue", "dos");
    clock.advance(MIN_SPEECH_MS + TURN_GAP_MS);
    expect(released.map((line) => line.text)).toEqual(["uno", "dos"]);
  });
});
