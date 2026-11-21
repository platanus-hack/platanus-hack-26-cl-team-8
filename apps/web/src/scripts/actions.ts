/**
 * Acciones de los agentes en palabras. El agente llama herramientas como
 * `attack({"reason":"..."})`; en pantalla se muestra un ícono y una frase corta, y la
 * llamada tal cual queda en el tooltip.
 */
import type { IconRef } from "./pixelicons";

export type ActionView = {
  /** Nombre de la herramienta ("attack"); "" si no se reconoce. */
  tool: string;
  /** Ícono de la herramienta; null si no se reconoce. */
  icon: IconRef | null;
  /** Frase para mostrar: "Ataca cuerpo a cuerpo". */
  label: string;
  /** Qué pasó al ejecutarla, según el agente ("golpe conectado"); puede venir vacío. */
  result: string;
  /** La llamada tal cual: `attack({"seconds":3}) → golpe conectado`. */
  raw: string;
};

/**
 * Las herramientas de packages/agent/src/tools.ts: frase e ícono de cada una. Una
 * herramienta nueva solo necesita su fila aquí. Las frases no nombran el arma, porque
 * depende del kit (espada o hacha).
 */
const TOOLS: Record<string, { label: string; icon: IconRef }> = {
  approach: { label: "Se acerca al rival", icon: { name: "forward" } },
  attack: { label: "Ataca cuerpo a cuerpo", icon: { name: "sword" } },
  retreat: { label: "Se aleja del rival", icon: { name: "back" } },
  shoot: { label: "Dispara con el arco", icon: { name: "bow" } },
  eat: { label: "Come para recuperarse", icon: { name: "steak" } },
  pearl: { label: "Lanza una perla", icon: { name: "pearl" } },
  build: { label: "Construye un muro", icon: { name: "tile", material: "wood" } },
  wait: { label: "Espera quieto", icon: { name: "pause" } },
};

const MAX_ARGS_LENGTH = 160;

function rawCall(tool: string, args: Record<string, unknown>, result: string): string {
  let argsText = "";
  try {
    const json = JSON.stringify(args);
    if (json !== undefined && json !== "{}") {
      argsText = json.length > MAX_ARGS_LENGTH ? `${json.slice(0, MAX_ARGS_LENGTH)}…` : json;
    }
  } catch {
    argsText = "…";
  }
  const call = `${tool}(${argsText})`;
  return result.trim() === "" ? call : `${call} → ${result}`;
}

export function describeAction(tool: string, args: Record<string, unknown>, result: string): ActionView {
  const known = TOOLS[tool];
  let label = known?.label ?? tool;
  const seconds = Number(args.seconds);
  if (tool === "attack" && Number.isFinite(seconds) && seconds > 0) label += ` durante ${seconds} s`;
  // La perla sirve para caerle encima al rival (por defecto) o para escapar de él.
  if (tool === "pearl" && args.target === "away") label += " para escapar";
  return {
    tool: known ? tool : "",
    icon: known?.icon ?? null,
    label,
    result: result.trim(),
    raw: rawCall(tool, args, result),
  };
}

/**
 * Lo mismo a partir del texto que guarda el servidor en `lastAction`
 * ("attack({...}) → golpe conectado"). Si no tiene esa forma, se muestra tal cual.
 */
export function parseAction(raw: string): ActionView {
  const text = raw.trim();
  const match = /^([a-z_]+)\((.*?)\)(?:\s*→\s*(.*))?$/s.exec(text);
  if (!match) return { tool: "", icon: null, label: text, result: "", raw: text };
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = match[2] ? JSON.parse(match[2]) : {};
    if (typeof parsed === "object" && parsed !== null) args = parsed as Record<string, unknown>;
  } catch {
    // Argumentos recortados o inválidos: basta con el nombre de la herramienta.
  }
  return { ...describeAction(match[1]!, args, match[3] ?? ""), raw: text };
}

/** Texto de una línea para el registro de eventos. */
export function actionLine(view: ActionView): string {
  return view.result === "" ? view.label : `${view.label}: ${view.result}`;
}
