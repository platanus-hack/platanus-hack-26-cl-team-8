export type LogLevel = "info" | "warn" | "error";

/** Log para humanos (en español), una línea por evento, con hora ISO. */
export function log(level: LogLevel, text: string): void {
  const line = `${new Date().toISOString()} [camara] ${level.toUpperCase()} ${text}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Error irrecuperable: el proceso debe terminar con código distinto de cero
 * para que Docker reinicie el contenedor.
 */
export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}
