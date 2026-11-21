import { wsUrl } from "./config";

export type SocketStatus = "connecting" | "open" | "closed";

type SocketHandlers = {
  onMessage(raw: string): void;
  onStatus(status: SocketStatus): void;
};

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

function createSocket(): WebSocket | null {
  try {
    return new WebSocket(wsUrl());
  } catch {
    return null;
  }
}

/**
 * Websocket de solo lectura (servidor -> cliente) con reconexión automática y
 * backoff exponencial. Nunca se rinde: la página puede quedar abierta horas.
 */
export function connectSocket(handlers: SocketHandlers): void {
  let attempt = 0;
  let timer: number | undefined;

  const schedule = (): void => {
    if (timer !== undefined) return;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) + Math.random() * 300;
    attempt += 1;
    timer = window.setTimeout(() => {
      timer = undefined;
      open();
    }, delay);
  };

  const open = (): void => {
    handlers.onStatus("connecting");
    const ws = createSocket();
    if (!ws) {
      handlers.onStatus("closed");
      schedule();
      return;
    }
    ws.addEventListener("open", () => {
      attempt = 0;
      handlers.onStatus("open");
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") handlers.onMessage(event.data);
    });
    ws.addEventListener("close", () => {
      handlers.onStatus("closed");
      schedule();
    });
    ws.addEventListener("error", () => {
      // Tras "error" siempre llega "close"; cerrar explícitamente lo apura.
      ws.close();
    });
  };

  open();
}
