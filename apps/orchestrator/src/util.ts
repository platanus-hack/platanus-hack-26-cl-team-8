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
 * La promesa original sigue viva; su rechazo se maneja aunque el plazo ya haya vencido.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
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
