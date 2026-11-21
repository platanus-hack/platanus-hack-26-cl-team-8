import type { Side } from "@phack/protocol";
import type { LlmClient } from "@phack/llm";

export type FighterEvents = {
  onStatus(s: { connected: boolean; alive: boolean; health: number; food: number }): void;
  onThought(text: string): void;
  onAction(tool: string, args: Record<string, unknown>, result: string): void;
  onDamageTaken(amount: number, health: number): void;
  onDeath(): void;
  onLog(level: "info" | "warn" | "error", text: string): void;
};

export type FighterOptions = {
  side: Side;
  username: string;
  opponentUsername: string;
  prompt: string;
  llm: LlmClient;
  mc: { host: string; port: number; version: string };
  tickMs: number;
  events: FighterEvents;
};

export interface Fighter {
  /** Resuelve cuando el bot aparece en el mundo; rechaza si falla la conexión o se agota el tiempo. */
  connect(): Promise<void>;
  /** Comienza el bucle percibir -> LLM -> actuar. */
  start(): void;
  /** Detiene el bucle, cancela la llamada al LLM en curso y desconecta. Idempotente. */
  stop(): Promise<void>;
}
