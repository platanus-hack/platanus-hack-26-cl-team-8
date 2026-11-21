/**
 * Sonidos de la pelea, sintetizados con Web Audio (no hay archivos de audio):
 * golpe, caída, cuenta regresiva, inicio y fin. Parte en silencio: el navegador solo deja sonar después
 * de un gesto del usuario, que es el clic en el botón de sonido. El mismo botón manda
 * sobre las voces de los agentes (voice.ts), que suenan por este mismo contexto de audio:
 * así basta con que el gesto lo desbloquee una vez (Safari en iPhone no deja sonar un
 * <audio> nuevo fuera de un gesto, pero sí un contexto ya desbloqueado).
 */
import { byId } from "./dom";

const STORAGE_KEY = "arena-sonido";

let enabled = false;
let context: AudioContext | null = null;
/** La voz de los agentes está encendida en los ajustes: la ayuda del botón la nombra. */
let voiceHint = false;
let renderButton: (() => void) | null = null;
const listeners: ((on: boolean) => void)[] = [];

/** Si el sonido de la página está encendido (lo decide el botón). */
export function isSoundOn(): boolean {
  return enabled;
}

/** Avisa cada vez que el botón enciende o apaga el sonido. */
export function onSoundChange(listener: (on: boolean) => void): void {
  listeners.push(listener);
}

/** Con la voz encendida en los ajustes, la ayuda del botón dice que también trae las voces. */
export function setVoiceHint(on: boolean): void {
  if (voiceHint === on) return;
  voiceHint = on;
  renderButton?.();
}

/**
 * El contexto de audio de la página, aunque siga suspendido (sirve para decodificar las
 * voces mientras tanto). null con el sonido apagado o si el navegador no tiene Web Audio.
 */
export function soundContext(): AudioContext | null {
  if (!enabled) return null;
  try {
    context ??= new AudioContext();
    return context;
  } catch {
    return null;
  }
}

/** El contexto listo para sonar ahora mismo, o null. */
export function runningContext(): AudioContext | null {
  const ctx = soundContext();
  if (!ctx) return null;
  // Sin un gesto previo el navegador lo deja suspendido: se pide reanudar y ese sonido
  // se omite (si se encolara, sonarían todos juntos al primer clic).
  if (ctx.state !== "running") {
    ctx.resume().catch(() => {});
    return null;
  }
  return ctx;
}

/** Una nota: onda, frecuencia inicial y final (Hz), duración (s), volumen y cuándo empieza (s). */
function tone(type: OscillatorType, from: number, to: number, seconds: number, volume: number, delay = 0): void {
  const ctx = runningContext();
  if (!ctx) return;
  const start = ctx.currentTime + delay;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(from, start);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + seconds);
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + seconds);
}

/** Golpe: un "tuc" grave y corto. */
export function playHit(): void {
  tone("square", 220, 70, 0.11, 0.16);
  tone("triangle", 120, 50, 0.14, 0.2);
}

/** Un agente le habla al otro: dos notas cortas, más graves para Rojo y más agudas para Azul. */
export function playMessage(side: "red" | "blue"): void {
  const pitch = side === "red" ? 392 : 523;
  tone("square", pitch, pitch, 0.045, 0.07);
  tone("square", pitch * 1.19, pitch * 1.19, 0.06, 0.07, 0.07);
}

/** Caída de un agente: cuatro notas que bajan. */
export function playKnockout(): void {
  [440, 330, 247, 147].forEach((frequency, index) => {
    tone("square", frequency, frequency * 0.94, 0.16, 0.14, index * 0.14);
  });
}

/** Cuenta regresiva: un "bip" corto por cada número. */
export function playCount(): void {
  tone("square", 440, 440, 0.09, 0.1);
}

/** Empieza la pelea: dos notas que suben. */
export function playStart(): void {
  tone("square", 330, 330, 0.12, 0.12);
  tone("square", 660, 660, 0.22, 0.12, 0.13);
}

/** Termina la pelea sin caída (tiempo, empate, detenida): una campana. */
export function playEnd(): void {
  tone("triangle", 523, 520, 0.6, 0.18);
}

export function initSound(): void {
  const button = byId<HTMLButtonElement>("btn-sound");
  const render = (): void => {
    button.setAttribute("aria-pressed", String(enabled));
    if (voiceHint) {
      button.dataset.tip = enabled
        ? "Sonido activado: golpes, caídas, campana y las voces de los agentes. Haz clic para apagarlo."
        : "Sonido apagado. Haz clic para oír los golpes, la campana y las voces de los agentes.";
      return;
    }
    button.dataset.tip = enabled
      ? "Sonido activado: golpes, caídas y campana. Haz clic para apagarlo."
      : "Sonido apagado. Haz clic para oír los golpes y la campana.";
  };
  renderButton = render;

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Sin acceso al almacenamiento: parte en silencio.
  }
  // Aunque estuviera activado, el audio recién arranca con el primer gesto en la página.
  enabled = stored === "1";
  render();

  // Ese primer gesto puede ser cualquiera, no solo el botón: Safari solo deja reanudar el
  // contexto dentro de un gesto, así que se reanuda en cada uno mientras siga suspendido.
  const unlock = (): void => {
    if (enabled && context?.state !== "running") runningContext();
  };
  for (const type of ["click", "touchend", "keydown"]) {
    document.addEventListener(type, unlock, { capture: true, passive: true });
  }

  button.addEventListener("click", () => {
    enabled = !enabled;
    render();
    try {
      window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // Solo no se recuerda la preferencia.
    }
    for (const listener of listeners) listener(enabled);
    // Confirmación audible de que quedó activado (el contexto tarda un instante en partir).
    if (enabled) {
      runningContext();
      window.setTimeout(playStart, 80);
    }
  });
}
