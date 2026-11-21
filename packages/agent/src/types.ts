import type { KitId, Side } from "@phack/protocol";
import type { LlmClient, TokenUsage } from "@phack/llm";

/** Una llamada al LLM que terminó con respuesta (las fallidas o cortadas no se informan). */
export type DecisionReport = {
  /** Lo que tardó la llamada al LLM, en ms (reloj de pared). */
  ms: number;
  /** Tokens de esa llamada; falta si el proveedor no los informó. */
  usage?: TokenUsage;
};

export type FighterEvents = {
  /** `heldItem`: nombre de Minecraft del ítem en la mano principal ("" = mano vacía). */
  onStatus(s: { connected: boolean; alive: boolean; health: number; food: number; heldItem: string }): void;
  onDecision(d: DecisionReport): void;
  onThought(text: string): void;
  onAction(tool: string, args: Record<string, unknown>, result: string): void;
  /**
   * `bySelf`: el daño se lo hizo el propio agente al caer de su perla de ender; no es
   * mérito del rival.
   */
  onDamageTaken(amount: number, health: number, bySelf: boolean): void;
  onDeath(): void;
  onLog(level: "info" | "warn" | "error", text: string): void;
};

export type FighterOptions = {
  side: Side;
  username: string;
  opponentUsername: string;
  prompt: string;
  /** Kit con el que pelea: define las herramientas que se le ofrecen al LLM. */
  kit: KitId;
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
