import type { CommsMode, Horizon, Kit, RuleId, ScenarioId, Side } from "@phack/protocol";
import type { LlmClient, TokenUsage } from "@phack/llm";
import type { Observation } from "./observation";
import type { ContextProfile } from "./context-profile";
import type { SeriesView } from "./rounds";

/** Una llamada al LLM que terminó con respuesta (las fallidas o cortadas no se informan). */
export type DecisionReport = {
  /** Lo que tardó la llamada al LLM, en ms (reloj de pared). */
  ms: number;
  /** Tokens de esa llamada; falta si el proveedor no los informó. */
  usage?: TokenUsage;
  /** Tamaño del contexto enviado; los tokens reales siguen viniendo en usage. */
  contextProfile?: ContextProfile;
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
  /**
   * Una llamada a herramienta empezó (o no se pudo usar) y este es su resultado. Con varias
   * llamadas en una respuesta, las que esperaban en cola avisan cuando les toca.
   */
  onAction(tool: string, args: Record<string, unknown>, result: string): void;
  /**
   * `bySelf`: el daño se lo hizo el propio agente al caer de su perla de ender; no es
   * mérito del rival.
   */
  onDamageTaken(amount: number, health: number, bySelf: boolean): void;
  onDeath(): void;
  /** Modo "chat": el agente le dijo `text` al rival (con limpieza técnica, ver cleanMessage). */
  onMessage(text: string): void;
  /** Modo por rondas: el agente se rindió en la ronda en juego (llamó a "surrender"). */
  onSurrender(): void;
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
  /**
   * Modo por rondas: la partida es una serie de hasta `maxRounds` rondas (se ofrece
   * "surrender" y la observación trae cómo va la serie). null = una sola pelea.
   */
  rounds: { maxRounds: number; scenario?: ScenarioId; horizon?: Horizon } | null;
  /** Benchmarks: reglas que le impone su entrenador (van al prompt). */
  rules?: readonly RuleId[];
  llm: LlmClient;
  mc: { host: string; port: number; version: string };
  tickMs: number;
  /** Radio horizontal de observación en bloques (16 por defecto). */
  observationRadius?: number;
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
  /**
   * Modo por rondas: deja de decidir y de actuar hasta `resume`. Corta la llamada al LLM
   * en curso (su respuesta no se ejecuta), vacía la cola y deja el cuerpo en espera.
   * `note` queda como resultado de la última acción.
   */
  pause(note: string): void;
  /**
   * Modo por rondas: vuelve a decidir, con la serie al día. `note` llega como
   * "lastActionResult" en la próxima observación.
   */
  resume(series: SeriesView, note: string): void;
  /** Detiene el bucle, cancela la llamada al LLM en curso y desconecta. Idempotente. */
  stop(): Promise<void>;
}
