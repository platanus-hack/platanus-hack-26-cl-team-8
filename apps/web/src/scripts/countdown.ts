/**
 * Cuenta regresiva antes de la pelea: "3", "2", "1" y "¡Pelea!" en grande sobre el video.
 * El servidor avisa a qué hora empieza la pelea (`countdownEndsAt`); el número sale, en
 * cada cuadro, de esa hora menos la del instante que se ve en pantalla (videoServerNow),
 * así va al paso de la imagen y del primer golpe.
 */
import { COUNTDOWN_SECONDS, type MatchState } from "@phack/protocol";
import { byId, el } from "./dom";
import { videoServerNow } from "./player";
import { playCount } from "./sound";

/** Cuánto se queda "¡Pelea!" en pantalla después de llegar a cero. */
const GO_MS = 800;
const GO_TEXT = "¡Pelea!";

let holder: HTMLElement | null = null;
let onZero: (() => void) | null = null;
/** Hora del servidor en que la cuenta llega a cero; null = no hay cuenta en pantalla. */
let endsAt: number | null = null;
/** Lo que está escrito ahora ("3", "¡Pelea!"): se anima y suena solo cuando cambia. */
let shown = "";
let frame: number | undefined;

function hide(): void {
  endsAt = null;
  shown = "";
  if (frame !== undefined) window.cancelAnimationFrame(frame);
  frame = undefined;
  if (holder && !holder.hidden) {
    holder.hidden = true;
    holder.replaceChildren();
  }
}

function render(): void {
  frame = undefined;
  if (!holder || endsAt === null) return;

  const remaining = endsAt - videoServerNow();
  if (remaining <= -GO_MS) {
    hide();
    return;
  }

  const counting = remaining > 0;
  // Nunca más que el número inicial, aunque el estado se haya aplicado antes que la imagen.
  const text = counting ? String(Math.min(COUNTDOWN_SECONDS, Math.ceil(remaining / 1000))) : GO_TEXT;
  if (text !== shown) {
    shown = text;
    // Un elemento nuevo por paso: así la animación de entrada parte de nuevo cada vez.
    holder.replaceChildren(el("span", "countdown__step", text));
    holder.dataset.step = counting ? "count" : "go";
    holder.hidden = false;
    if (counting) playCount();
    else onZero?.();
  }
  frame = window.requestAnimationFrame(render);
}

/**
 * `zero` se llama una vez cuando la cuenta llega a cero en pantalla: ahí suena el inicio
 * de la pelea (main.ts cuida que no suene dos veces).
 */
export function initCountdown(zero: () => void): void {
  holder = byId("countdown");
  onZero = zero;
}

/** Con cada estado de la pelea: parte, sigue o quita la cuenta regresiva. */
export function updateCountdown(state: Pick<MatchState, "phase" | "countdownEndsAt">): void {
  if (state.countdownEndsAt !== null) {
    endsAt = state.countdownEndsAt;
  } else if (state.phase !== "running") {
    // Sin cuenta y sin pelea: no ha partido, o se canceló o falló a medio contar.
    hide();
    return;
  } else if (endsAt !== null) {
    // La pelea ya empezó: si a la cuenta le faltaba, pasa directo a "¡Pelea!".
    endsAt = Math.min(endsAt, videoServerNow());
  }
  if (endsAt !== null && frame === undefined) frame = window.requestAnimationFrame(render);
}
