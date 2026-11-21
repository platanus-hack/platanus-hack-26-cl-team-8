import type { Side } from "@phack/protocol";

/**
 * Turnos para hablar en el modo "chat". Los agentes piensan rápido y sin esperar a nadie,
 * pero lo que se dicen sale como en una conversación: una frase a la vez. Esta clase lleva
 * quién tiene la palabra; vive en el orquestador porque es el único que ve a los dos lados
 * y sabe cuánto dura de verdad cada audio.
 *
 * - Cada lado tiene como mucho UNA frase esperando. Si manda otra antes de que salga la
 *   primera, la nueva la reemplaza (el agente cambió lo que quería decir).
 * - Con la palabra libre y la pausa ya cumplida, una frase sale en el acto. Si no, espera a
 *   que termine la que suena más una pausa corta, como entre personas.
 * - Si los dos tienen una frase esperando cuando se libera la palabra, sale primero la del
 *   lado que no habló último.
 * - Una frase que esperó más de STALE_MS cuando le toca ya no viene al caso: se descarta.
 * - Lo que dura una frase se estima por su largo (estimateSpeechMs). Si al soltarla llega la
 *   duración real del audio, el final se corrige con ella, antes o después.
 *
 * El reloj, los temporizadores y el azar se reciben de afuera: los tests no esperan de verdad.
 */

/** Pausa al cambiar de quien habla: lo que tarda alguien en contestar. */
export const TURN_GAP_MS = 250;
/** Variación de esa pausa (se suma entre 0 y esto), para que no suene a metrónomo. */
export const TURN_GAP_JITTER_MS = 150;
/** Pausa entre dos frases seguidas del mismo lado: una respiración entre frase y frase. */
export const SAME_SPEAKER_GAP_MS = 500;
/** Una frase que esperó más que esto cuando le toca ya quedó vieja: no sale. */
export const STALE_MS = 10_000;
/**
 * Lo que dura la voz por carácter a velocidad 1.0. Medido con las voces reales: una frase de
 * 64 caracteres en español dura 2,69 s a velocidad 1.1, unos 46 ms por carácter a 1.0.
 */
export const SPEECH_MS_PER_CHAR = 46;
/** Ni la frase más corta ocupa menos que esto. */
export const MIN_SPEECH_MS = 500;

/**
 * Cuánto ocupa la palabra una frase dicha a `speed` (la velocidad de la voz, 1 = normal).
 * Es lo que ordena la conversación cuando no hay audio y mientras no llega su duración real.
 */
export function estimateSpeechMs(text: string, speed: number): number {
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const chars = Array.from(text.trim()).length;
  return Math.max(MIN_SPEECH_MS, Math.round((chars * SPEECH_MS_PER_CHAR) / rate));
}

export type ConversationClock = {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Entre 0 y 1. */
  random(): number;
};

export const REAL_CLOCK: ConversationClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

/**
 * Se llama al soltar una frase (empieza a sonar). Puede devolver la duración real de su
 * audio en ms, cuando se sepa; null o nada = vale la estimación.
 */
export type ReleaseFn = (side: Side, text: string) => Promise<number | null> | void;

export type ConversationOptions = {
  /** Velocidad de la voz (1 = normal). */
  speed: number;
  onRelease: ReleaseFn;
  clock?: ConversationClock;
};

type Waiting = { text: string; since: number };

/** La última frase que salió: tiene la palabra hasta `endsAt`. */
type Floor = {
  side: Side;
  /** Cambia con cada frase: una duración real que llega tarde solo corrige a la suya. */
  id: number;
  releasedAt: number;
  endsAt: number;
  /** Pausa para que conteste el otro lado; el azar se toma al soltar la frase, no al consultar. */
  turnGap: number;
};

export class Conversation {
  private readonly clock: ConversationClock;
  private readonly waiting: Record<Side, Waiting | null> = { red: null, blue: null };
  private floor: Floor | null = null;
  private nextId = 0;
  private timer: unknown = null;

  constructor(private readonly opts: ConversationOptions) {
    this.clock = opts.clock ?? REAL_CLOCK;
  }

  /** El agente de `side` quiere decir esto. Reemplaza lo que ese lado tenía esperando. */
  say(side: Side, text: string): void {
    this.waiting[side] = { text, since: this.clock.now() };
    this.schedule();
  }

  /** Borra lo que esperaba y corta los temporizadores. La palabra queda libre. */
  clear(): void {
    this.waiting.red = null;
    this.waiting.blue = null;
    this.floor = null;
    this.cancelTimer();
  }

  // ---------- Partes internas ----------

  /** Quién habla después: si esperan los dos, el que no habló último. */
  private nextSide(): Side | null {
    const { red, blue } = this.waiting;
    if (red && blue) {
      if (this.floor) return this.floor.side === "red" ? "blue" : "red";
      return red.since <= blue.since ? "red" : "blue";
    }
    if (red) return "red";
    if (blue) return "blue";
    return null;
  }

  /** Desde cuándo puede hablar `side`: el final de la última frase más la pausa que toque. */
  private readyAt(side: Side): number {
    const floor = this.floor;
    if (!floor) return Number.NEGATIVE_INFINITY;
    return floor.endsAt + (floor.side === side ? SAME_SPEAKER_GAP_MS : floor.turnGap);
  }

  /** Suelta ahora lo que toca, o deja un temporizador para cuando toque. */
  private schedule(): void {
    this.cancelTimer();
    const side = this.nextSide();
    if (!side) return;
    const delay = this.readyAt(side) - this.clock.now();
    if (delay <= 0) {
      this.release(side);
      return;
    }
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      this.schedule();
    }, delay);
  }

  private release(side: Side): void {
    const line = this.waiting[side];
    this.waiting[side] = null;
    if (!line) return;
    const now = this.clock.now();
    if (now - line.since > STALE_MS) {
      // Ya no viene al caso; quizás el otro lado sí tiene algo que decir.
      this.schedule();
      return;
    }
    this.nextId += 1;
    const floor: Floor = {
      side,
      id: this.nextId,
      releasedAt: now,
      endsAt: now + estimateSpeechMs(line.text, this.opts.speed),
      turnGap: TURN_GAP_MS + this.clock.random() * TURN_GAP_JITTER_MS,
    };
    this.floor = floor;
    let real: unknown;
    try {
      real = this.opts.onRelease(side, line.text);
    } catch {
      real = undefined;
    }
    if (real instanceof Promise) {
      (real as Promise<number | null>).then(
        (ms) => this.correct(floor.id, ms),
        () => {},
      );
    }
    this.schedule();
  }

  /** Llegó lo que dura de verdad el audio: si esa frase sigue siendo la última, manda eso. */
  private correct(id: number, ms: number | null): void {
    const floor = this.floor;
    if (!floor || floor.id !== id) return;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
    floor.endsAt = floor.releasedAt + ms;
    this.schedule();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimer(this.timer);
    this.timer = null;
  }
}
