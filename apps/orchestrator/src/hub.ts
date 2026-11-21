import type { ArenaEvent, MatchSettings, MatchState, PromptsResponse } from "@phack/protocol";

/**
 * Subconjunto estructural del WebSocket de "ws" que usa el hub
 * (así no dependemos directamente del paquete "ws").
 */
export type SocketLike = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  terminate(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

/** Lo que el resto del orquestador necesita para emitir eventos. */
export type EventSink = {
  broadcast(event: ArenaEvent): void;
  /** Pide un broadcast de "state" respetando el throttle (~4/s). */
  markStateDirty(): void;
  /** Envía "state" de inmediato (cambios de fase). */
  flushState(): void;
};

export type HubProviders = {
  getState(): MatchState;
  getPrompts(): PromptsResponse;
  /** Ajustes pendientes; opcional para no romper a quien no los usa. */
  getSettings?(): MatchSettings;
};

const WS_OPEN = 1;
const STATE_INTERVAL_MS = 250;
const HEARTBEAT_MS = 30_000;
/** Un cliente que acumula más que esto está muerto o demasiado lento: se corta. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export class Hub implements EventSink {
  private readonly clients = new Map<SocketLike, { alive: boolean }>();
  private providers: HubProviders | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStateAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  setProviders(providers: HubProviders): void {
    this.providers = providers;
  }

  start(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.checkClients(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** Registra un cliente y le manda el estado y los prompts actuales. */
  add(socket: SocketLike): void {
    const meta = { alive: true };
    this.clients.set(socket, meta);
    socket.on("pong", () => {
      meta.alive = true;
    });
    socket.on("close", () => {
      this.clients.delete(socket);
    });
    socket.on("error", () => {
      this.clients.delete(socket);
      try {
        socket.terminate();
      } catch {
        // ya estaba cerrado
      }
    });
    if (this.providers) {
      const at = Date.now();
      this.sendTo(socket, JSON.stringify({ type: "state", at, state: this.providers.getState() } satisfies ArenaEvent));
      this.sendTo(
        socket,
        JSON.stringify({ type: "prompts", at, prompts: this.providers.getPrompts() } satisfies ArenaEvent),
      );
      if (this.providers.getSettings) {
        this.sendTo(
          socket,
          JSON.stringify({ type: "settings", at, settings: this.providers.getSettings() } satisfies ArenaEvent),
        );
      }
    }
  }

  broadcast(event: ArenaEvent): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(event);
    for (const socket of this.clients.keys()) this.sendTo(socket, payload);
  }

  markStateDirty(): void {
    if (this.stateTimer) return;
    const wait = STATE_INTERVAL_MS - (Date.now() - this.lastStateAt);
    if (wait <= 0) {
      this.flushState();
      return;
    }
    this.stateTimer = setTimeout(() => this.flushState(), wait);
  }

  flushState(): void {
    if (this.stateTimer) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    this.lastStateAt = Date.now();
    if (!this.providers) return;
    this.broadcast({ type: "state", at: this.lastStateAt, state: this.providers.getState() });
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    for (const socket of this.clients.keys()) {
      try {
        socket.terminate();
      } catch {
        // ignorar
      }
    }
    this.clients.clear();
  }

  private sendTo(socket: SocketLike, payload: string): void {
    if (socket.readyState !== WS_OPEN) return;
    try {
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.clients.delete(socket);
        socket.terminate();
        return;
      }
      socket.send(payload);
    } catch {
      this.clients.delete(socket);
    }
  }

  /** Heartbeat: quien no respondió el ping anterior se desconecta. */
  private checkClients(): void {
    for (const [socket, meta] of this.clients) {
      try {
        if (!meta.alive) {
          this.clients.delete(socket);
          socket.terminate();
          continue;
        }
        meta.alive = false;
        socket.ping();
      } catch {
        this.clients.delete(socket);
      }
    }
  }
}
