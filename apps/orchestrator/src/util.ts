export type LogLevel = "info" | "warn" | "error";
export type LogFn = (level: LogLevel, text: string) => void;
export type SleepFn = (ms: number) => Promise<void>;

export const sleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

/**
 * Rechaza con `message` si `promise` no termina en `ms`.
 * La promesa original sigue viva; se le cuelga un catch para no dejar rechazos sin manejar.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  promise.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Corta en `max` puntos de código (no unidades UTF-16): nunca parte un emoji, y no agrega nada. */
export function cutCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}
