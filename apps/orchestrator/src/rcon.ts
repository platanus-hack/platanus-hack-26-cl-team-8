import { createRequire } from "node:module";
import type { Rcon as RconConnection } from "rcon-client";
import { errorMessage, sleep, withTimeout, type LogFn } from "./util";

// "rcon-client" es CommonJS: se carga con createRequire para no depender de la
// detección de exports nombrados de Node; los tipos vienen del import type.
const nodeRequire = createRequire(import.meta.url);
const { Rcon } = nodeRequire("rcon-client") as typeof import("rcon-client");

/** Lo mínimo que necesitan la arena y la pelea (fácil de falsear en tests). */
export type RconLike = {
  send(command: string): Promise<string>;
};

export type RconClientOptions = {
  host: string;
  port: number;
  password: string;
  log: LogFn;
};

const CONNECT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Cliente RCON con conexión perezosa, reconexión automática y cola de comandos
 * (se ejecutan estrictamente de a uno y en orden).
 */
export class RconClient implements RconLike {
  private conn: RconConnection | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly opts: RconClientOptions) {}

  send(command: string): Promise<string> {
    const run = this.tail.then(() => this.exec(command));
    this.tail = run.catch(() => {});
    return run;
  }

  /** Reintenta hasta que el servidor de Minecraft acepte RCON (o se cierre el cliente). */
  async waitUntilReady(retryMs = 3_000): Promise<void> {
    let attempt = 0;
    while (!this.closed) {
      attempt += 1;
      try {
        await this.send("list");
        this.opts.log("info", "RCON conectado al servidor de Minecraft");
        return;
      } catch (err) {
        if (attempt === 1 || attempt % 10 === 0) {
          this.opts.log("warn", `Esperando al servidor de Minecraft (RCON): ${errorMessage(err)}`);
        }
        await sleep(retryMs);
      }
    }
    throw new Error("Cliente RCON cerrado");
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.drop();
  }

  private async exec(command: string): Promise<string> {
    if (this.closed) throw new Error("Cliente RCON cerrado");
    try {
      return await this.sendOnce(command);
    } catch (firstErr) {
      // La conexión pudo haberse caído (reinicio del servidor): se reconecta y reintenta una vez.
      await this.drop();
      if (this.closed) throw firstErr;
      try {
        return await this.sendOnce(command);
      } catch (err) {
        await this.drop();
        throw new Error(`RCON falló al ejecutar "${command}": ${errorMessage(err)}`);
      }
    }
  }

  private async sendOnce(command: string): Promise<string> {
    const conn = await this.ensure();
    return withTimeout(conn.send(command), COMMAND_TIMEOUT_MS, "RCON no respondió a tiempo");
  }

  private async ensure(): Promise<RconConnection> {
    if (this.conn) return this.conn;
    const conn = new Rcon({
      host: this.opts.host,
      port: this.opts.port,
      password: this.opts.password,
      timeout: CONNECT_TIMEOUT_MS,
    });
    conn.on("error", () => {
      if (this.conn === conn) this.conn = null;
    });
    conn.on("end", () => {
      if (this.conn === conn) this.conn = null;
    });
    try {
      await withTimeout(conn.connect(), CONNECT_TIMEOUT_MS + 1_000, "RCON no logró conectarse a tiempo");
    } catch (err) {
      conn.end().catch(() => {});
      throw err;
    }
    this.conn = conn;
    return conn;
  }

  private async drop(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    if (!conn) return;
    try {
      await withTimeout(conn.end(), 2_000, "RCON no cerró a tiempo");
    } catch {
      // ya estaba cerrada
    }
  }
}
