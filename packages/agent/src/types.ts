import type { CommsMode, Kit, Side } from "@phack/protocol";
import type { LlmClient, TokenUsage } from "@phack/llm";
import type { Observation } from "./observation";

/** Una llamada al LLM que terminó con respuesta (las fallidas o cortadas no se informan). */
export type DecisionReport = {
  /** Lo que tardó la llamada al LLM, en ms (reloj de pared). */
  ms: number;
  /** Tokens de esa llamada; falta si el proveedor no los informó. */
  usage?: TokenUsage;
  /** La observación que recibió el LLM en esa llamada. */
  observation: Observation;
  /**
   * La respuesta tal cual llegó: el texto y TODAS las llamadas a herramientas, también las
   * que no se ejecutaron o nombran una herramienta que no existe.
   */
  response: { text: string; toolCalls: { name: string; args: Record<string, unknown> }[] };
};

export type FighterEvents = {
  /**
   * `heldItem`: nombre de Minecraft del ítem en la mano principal ("" = mano vacía).
   * `absorption`: corazones amarillos (de la manzana dorada) que le quedan, aparte de `health`.
   */
  onStatus(s: { connected: boolean; alive: boolean; health: number; absorption: number; food: number; heldItem: string }): void;
  onDecision(d: DecisionReport): void;
  onThought(text: string): void;
  onAction(tool: string, args: Record<string, unknown>, result: string): void;
  /**
   * `bySelf`: el daño se lo hizo el propio agente al caer de su perla de ender; no es
   * mérito del rival.
   */
  onDamageTaken(amount: number, health: number, bySelf: boolean): void;
  onDeath(): void;
  /** Modo "chat": el agente le dijo `text` al rival (con limpieza técnica, ver cleanMessage). */
  onMessage(text: string): void;
  onLog(level: "info" | "warn" | "error", text: string): void;
};

export type FighterOptions = {
  side: Side;
  username: string;
  opponentUsername: string;
  prompt: string;
  /** Kit con el que pelea (ya resuelto, también el personalizado): define las herramientas que se le ofrecen al LLM. */
  kit: Kit;
  /** Qué sabe del rival además de lo que ve (ver CommsMode). */
  comms: CommsMode;
  /** Duración de la pelea en segundos (contexto para el prompt). */
  durationSeconds: number | null;
  llm: LlmClient;
  mc: { host: string; port: number; version: string };
  tickMs: number;
  events: FighterEvents;
};

export interface Fighter {
  /** Prompt de sistema completo que recibe el LLM (el mundo + las instrucciones del usuario). */
  readonly systemPrompt: string;
  /** Resuelve cuando el bot aparece en el mundo; rechaza si falla la conexión o se agota el tiempo. */
  connect(): Promise<void>;
  /** Comienza el bucle percibir -> LLM -> actuar. */
  start(): void;
  /**
   * Le hace llegar algo del rival: su razonamiento (modo "thoughts") o un mensaje (modo
   * "chat"). Lo verá en su próxima observación. El orquestador decide cuándo llamarlo.
   */
  hear(kind: "thought" | "message", text: string): void;
  /** Detiene el bucle, cancela la llamada al LLM en curso y desconecta. Idempotente. */
  stop(): Promise<void>;
}
