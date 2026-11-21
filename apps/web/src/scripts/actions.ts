/**
 * Acciones de los agentes en palabras. El agente llama herramientas como
 * `attack({"reason":"..."})`; en pantalla se muestra un ícono y una frase corta, y la
 * llamada tal cual queda en el tooltip.
 */

export type ActionView = {
  /** Nombre de la herramienta ("attack"), para elegir el ícono; "" si no se reconoce. */
  tool: string;
  /** Frase para mostrar: "Ataca con la espada". */
  label: string;
  /** Qué pasó al ejecutarla, según el agente ("golpe conectado"); puede venir vacío. */
  result: string;
  /** La llamada tal cual: `attack({"seconds":3}) → golpe conectado`. */
  raw: string;
};

/** Las herramientas de packages/agent/src/tools.ts. */
const LABELS: Record<string, string> = {
  approach: "Se acerca al rival",
  attack: "Ataca con la espada",
  retreat: "Se aleja del rival",
  shoot: "Dispara con el arco",
  eat: "Come para recuperarse",
  wait: "Espera quieto",
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
  const known = LABELS[tool];
  let label = known ?? tool;
  const seconds = Number(args.seconds);
  if (tool === "attack" && Number.isFinite(seconds) && seconds > 0) label += ` durante ${seconds} s`;
  return { tool: known ? tool : "", label, result: result.trim(), raw: rawCall(tool, args, result) };
}

/**
 * Lo mismo a partir del texto que guarda el servidor en `lastAction`
 * ("attack({...}) → golpe conectado"). Si no tiene esa forma, se muestra tal cual.
 */
export function parseAction(raw: string): ActionView {
  const text = raw.trim();
  const match = /^([a-z_]+)\((.*?)\)(?:\s*→\s*(.*))?$/s.exec(text);
  if (!match) return { tool: "", label: text, result: "", raw: text };
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
