/**
 * Voz de los agentes. Con el ajuste "Voz de los agentes" encendido, cada mensaje del modo
 * "chat" trae un `speechId` y el servidor entrega su audio en API_ROUTES.speech (lo genera
 * con ElevenLabs, con una voz por lado). La página lo pide apenas llega el evento
 * (preloadSpeech, desde receiveEvent en main.ts) y lo reproduce cuando aparece su globo
 * (playSpeech, desde handleEvent). Entre una cosa y otra pasa el atraso del video, así que
 * casi siempre el audio ya está listo cuando se ve el mensaje.
 *
 * Ritmo, por lado: una frase a la vez. Si el lado sigue hablando cuando le toca la
 * siguiente, esa espera a que termine; si se juntan varias esperando, solo queda la más
 * nueva; y una frase que partiría más de MAX_LAG_MS después de aparecer su globo se salta,
 * para que la voz nunca quede atrás de la imagen. Los dos lados sí pueden hablar a la vez.
 * Una frase sin audio (404, sin red) se salta sin avisar.
 *
 * Solo suena con el sonido de la página encendido (sound.ts) y por su mismo contexto de
 * audio, el que desbloquea el gesto del usuario: un <audio> nuevo por frase, lanzado desde
 * un temporizador, Safari en iPhone lo bloquea cada vez. Todo se corta y se vacía al
 * apagarlo, al partir una pelea nueva y al terminar la pelea (stopSpeech). Cada audio se
 * suelta en cuanto sonó o se saltó.
 *
 * En la maqueta (?mock) no hay servidor ni clave: habla el sintetizador del navegador
 * (speechSynthesis) con el texto que guardó mock.ts, con las mismas reglas.
 */
import { API_ROUTES, SIDES, type Side } from "@phack/protocol";
import { MOCK, apiUrl } from "./config";
import { el } from "./dom";
import { pixelIcon } from "./icons";
import { isSoundOn, onSoundChange, runningContext, soundContext } from "./sound";

/** Una frase que partiría más tarde que esto desde que apareció su globo, se salta. */
const MAX_LAG_MS = 2500;
/** Audios pedidos que aún no suenan; pasado este número se sueltan los más viejos. */
const MAX_CLIPS = 12;
/** Tope de una frase: si el navegador nunca avisa que terminó, el lado no queda mudo para siempre. */
const MAX_LINE_MS = 30_000;
/** Maqueta: velocidad y tono de cada lado (Rojo más grave, Azul más agudo). */
const MOCK_RATE = 1.1;
const MOCK_PITCH: Record<Side, number> = { red: 0.85, blue: 1.2 };

/** Lo que se reproduce: el audio del servidor (ya decodificado) o, en la maqueta, el texto. */
type Source = { kind: "audio"; buffer: AudioBuffer } | { kind: "text"; text: string };

type Clip = {
  /** null si no hay audio (404, sin red, no se pudo decodificar, o se soltó antes de llegar). */
  ready: Promise<Source | null>;
  controller: AbortController;
};

type Line = {
  side: Side;
  speechId: string;
  /** Cuándo apareció su globo (performance.now()). */
  shownAt: number;
  bubble: HTMLElement | null;
  /** La marca "hablando" puesta en el globo mientras suena. */
  mark: HTMLElement | null;
};

type Voice = {
  /** La frase que se está cargando o sonando. */
  busy: Line | null;
  /** Corta lo que suena; null mientras se carga. */
  stop: (() => void) | null;
  /** La siguiente frase, esperando a que termine la actual. */
  waiting: Line | null;
};

const clips = new Map<string, Clip>();
const voices: Record<Side, Voice> = {
  red: { busy: null, stop: null, waiting: null },
  blue: { busy: null, stop: null, waiting: null },
};
/** Sube con cada stopSpeech: lo que venía en camino desde antes ya no suena. */
let epoch = 0;

// ---------- Audios ----------

function release(speechId: string): void {
  const clip = clips.get(speechId);
  if (!clip) return;
  clips.delete(speechId);
  clip.controller.abort();
}

async function fetchAudio(speechId: string, clip: Clip): Promise<Source | null> {
  try {
    const ctx = soundContext();
    if (!ctx) return null;
    // La ruta espera a que el audio esté listo.
    const response = await fetch(apiUrl(API_ROUTES.speech(encodeURIComponent(speechId))), {
      signal: clip.controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.arrayBuffer();
    if (clip.controller.signal.aborted) return null;
    // Se decodifica al llegar (un contexto suspendido también sirve): al aparecer el globo
    // solo falta darle play.
    const buffer = await ctx.decodeAudioData(data);
    if (clip.controller.signal.aborted) return null;
    return { kind: "audio", buffer };
  } catch {
    return null;
  }
}

/** Maqueta: el "audio" es el texto que mock.ts guardó para ese speechId. */
async function mockText(speechId: string): Promise<Source | null> {
  try {
    const { mockSpeechText } = await import("./mock");
    const text = mockSpeechText(speechId);
    return text ? { kind: "text", text } : null;
  } catch {
    return null;
  }
}

function inUse(speechId: string): boolean {
  return SIDES.some((side) => voices[side].busy?.speechId === speechId || voices[side].waiting?.speechId === speechId);
}

/** El audio de una frase: lo pide si nadie lo había pedido. */
function clipFor(speechId: string): Clip {
  const known = clips.get(speechId);
  if (known) return known;
  const clip: Clip = { ready: Promise.resolve(null), controller: new AbortController() };
  clip.ready = MOCK ? mockText(speechId) : fetchAudio(speechId, clip);
  clips.set(speechId, clip);
  // Pedidos que nunca llegaron a sonar (no debería pasar): se sueltan los más viejos.
  for (const id of clips.keys()) {
    if (clips.size <= MAX_CLIPS) break;
    if (!inUse(id)) release(id);
  }
  return clip;
}

/** Espera la promesa a lo más `ms`; si no alcanza, null. */
function within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  if (ms <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

// ---------- Reproducción ----------

/** El sintetizador de voz del navegador (maqueta); null si no tiene. */
function synth(): SpeechSynthesis | null {
  return "speechSynthesis" in window ? window.speechSynthesis : null;
}

/** Maqueta: una voz en español si el navegador tiene; con dos, una por lado. */
function mockVoice(speaker: SpeechSynthesis, side: Side): SpeechSynthesisVoice | null {
  const spanish = speaker.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith("es"));
  return (side === "blue" ? spanish[1] : undefined) ?? spanish[0] ?? null;
}

/** Hace sonar `source` y llama a `done` al terminar (o al fallar). Devuelve cómo cortarlo sin avisar. */
function play(source: Source, side: Side, done: () => void): () => void {
  let over = false;
  let guard = 0;
  const end = (): void => {
    if (over) return;
    over = true;
    window.clearTimeout(guard);
    done();
  };
  guard = window.setTimeout(end, MAX_LINE_MS);

  if (source.kind === "audio") {
    // Sin un gesto previo en la página el contexto sigue suspendido: se pide reanudar y la
    // frase se salta (si esperara, sonaría tarde).
    const ctx = runningContext();
    if (!ctx) {
      window.setTimeout(end, 0);
      return () => {
        over = true;
        window.clearTimeout(guard);
      };
    }
    const node = ctx.createBufferSource();
    node.buffer = source.buffer;
    node.connect(ctx.destination);
    node.addEventListener("ended", end);
    node.start();
    // Si se pasa del tope, se corta de verdad: no debe seguir sonando encima de la frase que viene.
    window.clearTimeout(guard);
    guard = window.setTimeout(() => {
      try {
        node.stop();
      } catch {
        // Ya había terminado.
      }
      end();
    }, MAX_LINE_MS);
    return () => {
      over = true;
      window.clearTimeout(guard);
      node.removeEventListener("ended", end);
      try {
        node.stop();
      } catch {
        // Ya había terminado.
      }
      node.disconnect();
    };
  }

  const speaker = synth();
  if (!speaker) {
    window.setTimeout(end, 0);
    return () => {
      over = true;
      window.clearTimeout(guard);
    };
  }
  const utterance = new SpeechSynthesisUtterance(source.text);
  const voice = mockVoice(speaker, side);
  utterance.voice = voice;
  utterance.lang = voice?.lang ?? "es-ES";
  utterance.rate = MOCK_RATE;
  utterance.pitch = MOCK_PITCH[side];
  utterance.addEventListener("end", end);
  utterance.addEventListener("error", end);
  speaker.speak(utterance);
  // Igual que con el audio: pasado el tope se corta, no solo se da por terminada.
  window.clearTimeout(guard);
  guard = window.setTimeout(() => {
    speaker.cancel();
    end();
  }, MAX_LINE_MS);
  return () => {
    over = true;
    window.clearTimeout(guard);
    // La referencia a `utterance` la mantiene viva: sin ella el navegador puede perder su "end".
    utterance.removeEventListener("end", end);
    speaker.cancel();
  };
}

function markSpeaking(line: Line): void {
  if (!line.bubble) return;
  line.bubble.classList.add("thought--speaking");
  const mark = el("span", "thought__voice");
  mark.append(pixelIcon({ name: "speaking" }));
  line.bubble.append(mark);
  line.mark = mark;
}

function unmarkSpeaking(line: Line): void {
  line.bubble?.classList.remove("thought--speaking");
  line.mark?.remove();
  line.mark = null;
}

function late(line: Line): boolean {
  return performance.now() - line.shownAt > MAX_LAG_MS;
}

/** Empieza una frase en su lado; si su audio no llega a tiempo, se salta y pasa a la siguiente. */
async function start(line: Line): Promise<void> {
  const voice = voices[line.side];
  const mine = epoch;
  voice.busy = line;
  const ready = clips.get(line.speechId)?.ready ?? Promise.resolve(null);
  const source = await within(ready, MAX_LAG_MS - (performance.now() - line.shownAt));
  // Mientras se esperaba, stopSpeech vació todo.
  if (mine !== epoch || voice.busy !== line) return;
  if (!source || late(line)) {
    finish(line);
    return;
  }
  voice.stop = play(source, line.side, () => finish(line));
  markSpeaking(line);
}

/** La frase terminó (o se saltó): se suelta su audio y, si hay otra esperando, le toca. */
function finish(line: Line): void {
  const voice = voices[line.side];
  if (voice.busy !== line) return;
  voice.busy = null;
  voice.stop = null;
  unmarkSpeaking(line);
  release(line.speechId);
  const next = voice.waiting;
  voice.waiting = null;
  if (!next) return;
  if (late(next)) release(next.speechId);
  else void start(next);
}

// ---------- Entradas del módulo ----------

/** Llegó un mensaje con voz (aún sin mostrarse): se pide su audio de inmediato. */
export function preloadSpeech(speechId: string): void {
  if (!isSoundOn()) return;
  clipFor(speechId);
}

/** Apareció el globo de un mensaje con voz: suena ahora o, si su lado sigue hablando, después. */
export function playSpeech(side: Side, speechId: string, bubble?: HTMLElement | null): void {
  if (!isSoundOn()) {
    release(speechId);
    return;
  }
  // Si llegó con el sonido apagado no se pidió: se pide ahora.
  clipFor(speechId);
  const line: Line = { side, speechId, shownAt: performance.now(), bubble: bubble ?? null, mark: null };
  const voice = voices[side];
  if (voice.busy) {
    // Solo espera la más nueva.
    if (voice.waiting) release(voice.waiting.speechId);
    voice.waiting = line;
    return;
  }
  void start(line);
}

/** Corta lo que suena y suelta todo: pelea nueva, fin de la pelea o sonido apagado. */
export function stopSpeech(): void {
  epoch += 1;
  for (const side of SIDES) {
    const voice = voices[side];
    voice.stop?.();
    if (voice.busy) unmarkSpeaking(voice.busy);
    voice.busy = null;
    voice.stop = null;
    voice.waiting = null;
  }
  for (const id of [...clips.keys()]) release(id);
  if (MOCK) synth()?.cancel();
}

export function initVoice(): void {
  onSoundChange((on) => {
    if (!on) stopSpeech();
  });
  // El navegador carga sus voces de a poco: pedirlas una vez las deja listas para después.
  if (MOCK) synth()?.getVoices();
}
