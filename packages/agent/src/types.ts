import type { Side } from "@phack/protocol";
import type { LlmClient, TokenUsage } from "@phack/llm";

import type { LlmErrorReport } from "./decision";

/**
 * Una llamada al LLM que terminó con respuesta (las fallidas se informan con onLlmError;
 * las cortadas por stop no se informan). Se emite después de ejecutar la acción.
 */
export type DecisionReport = {
  /** Lo que tardó la llamada al LLM, en ms (reloj de pared). */
  ms: number;
  /** Tokens de esa llamada; falta si el proveedor no los informó. */
  usage?: TokenUsage;
  /** Costo real en USD informado por el proveedor; falta si no lo informó. */
  costUsd?: number;
  /**
   * Latencia de la decisión: desde que el agente arma la observación hasta que entrega
   * la acción válida (ya aplicada al cuerpo). Falta si la decisión fue inválida.
   */
  decisionMs?: number;
  /** true si no hubo acción válida (sin tool, tool desconocida o argumentos inválidos). */
  invalid?: boolean;
};

export type { LlmErrorReport };

export type FighterEvents = {
  /** `heldItem`: nombre de Minecraft del ítem en la mano principal ("" = mano vacía). */
  onStatus(s: { connected: boolean; alive: boolean; health: number; food: number; heldItem: string }): void;
  onDecision(d: DecisionReport): void;
  /** Falló una llamada al LLM (no se informa si la cortó stop). El agente mantiene la acción actual. */
  onLlmError?(e: LlmErrorReport): void;
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
