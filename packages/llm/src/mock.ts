import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, ToolDef } from "./types";
import { extractJsonObject, isRecord } from "./util";

/**
 * Proveedor "mock": determinista y sin red, para mostrar el sistema sin API keys.
 *
 * CONVENCIÓN con @phack/agent
 * - Tools que busca POR NOMBRE en la lista recibida: "approach", "attack", "retreat",
 *   "shoot", "eat", "wait". Solo usa las que estén presentes; si la preferida falta,
 *   cae a la siguiente de su lista. Si no hay ninguna conocida, no llama tools.
 * - Observación: lee el ÚLTIMO mensaje con role "user" y espera un JSON (el mensaje
 *   completo, o el tramo entre la primera "{" y la última "}") con:
 *     distance:        number | null  bloques hasta el rival (null = no se ve)
 *     health:          number         vida propia, 0..20
 *     opponentHealth:  number | null  vida del rival, 0..20
 *   Campos ausentes o inválidos se tratan como null (y la vida propia como 20).
 * - Argumentos: se envían solo los "required" del JSON Schema de la tool, con un valor
 *   por defecto (default, primer enum, minimum o 1 para números, "" para strings).
 * - Estilo: si los mensajes "system" (donde va el prompt del usuario) contienen
 *   "defensiv", "mantén distancia", "usa el arco", "francotirador" o "arquer",
 *   pelea a distancia; si no, cuerpo a cuerpo. Las reglas fijas que el agente agregue
 *   al system prompt deberían evitar esas frases para no forzar el estilo.
 *   Así dos prompts distintos producen peleas distintas incluso sin LLM real.
 * - No informa `usage`: no hay tokens reales que contar.
 * - "Turno" = el mayor entre la cantidad de mensajes "assistant" del historial y el número
 *   de llamadas previas a ESTE cliente; se usa para alternar acciones. El contador propio
 *   existe porque el agente recorta el historial y la cuenta de mensajes se estanca.
 */

export const MOCK_TOOL_NAMES = ["approach", "attack", "retreat", "shoot", "eat", "wait"] as const;
export type MockToolName = (typeof MOCK_TOOL_NAMES)[number];

/** Distancia (bloques) a la que un golpe cuerpo a cuerpo alcanza. */
const MELEE_RANGE = 3.5;
/** Con esta vida o menos, se prioriza sobrevivir. */
const LOW_HEALTH = 6;
/** Bajo esta vida del rival, hasta el estilo defensivo remata cuerpo a cuerpo. */
const FINISH_HEALTH = 8;

/**
 * Frases (en minúsculas) que marcan un prompt "a distancia". Son frases específicas y no
 * palabras sueltas como "arco" o "distancia", porque las reglas generales que el agente
 * pone en el system prompt probablemente mencionan esas palabras para ambos bandos.
 */
const RANGED_STYLE = /defensiv|mant[eé]n(?:er|te)? (?:la |tu )?distancia|usar? (?:el |tu )?arco|francotirador|arquer/;

export type MockObservation ={ distance: number | null; health: number; opponentHealth: number | null };
export type MockStyle = "melee" | "ranged";
export type MockDecision = { preferences: MockToolName[]; reason: string };

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readObservation(messages: ChatMessage[]): MockObservation {
  let text = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      text = m.content;
      break;
    }
  }
  const obj = extractJsonObject(text) ?? {};
  return {
    distance: num(obj.distance),
    health: num(obj.health) ?? 20,
    opponentHealth: num(obj.opponentHealth),
  };
}

export function readStyle(messages: ChatMessage[]): MockStyle {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content.toLowerCase())
    .join("\n");
  return RANGED_STYLE.test(system) ? "ranged" : "melee";
}

/** Política pura: observación + estilo + turno -> lista de tools preferidas, en orden. */
export function decide(obs: MockObservation, style: MockStyle, turn: number): MockDecision {
  const { distance, health, opponentHealth } = obs;

  if (distance === null) {
    return { preferences: ["approach", "wait"], reason: "no veo al rival: lo busco" };
  }
  const d = distance.toFixed(1);

  const losing = opponentHealth === null || opponentHealth > health;
  if (health <= LOW_HEALTH && losing) {
    if (distance <= MELEE_RANGE + 2) {
      return { preferences: ["retreat", "eat", "attack"], reason: `vida baja (${health}) y rival a ${d}: me alejo` };
    }
    return { preferences: ["eat", "retreat", "wait"], reason: `vida baja (${health}) y rival lejos: como` };
  }

  if (style === "ranged") {
    if (distance <= MELEE_RANGE) {
      const finish = opponentHealth !== null && opponentHealth <= FINISH_HEALTH;
      if (finish || turn % 2 === 1) {
        return { preferences: ["attack", "retreat"], reason: `rival a ${d}: golpeo` };
      }
      return { preferences: ["retreat", "attack"], reason: `rival a ${d}: tomo distancia` };
    }
    return { preferences: ["shoot", "approach", "wait"], reason: `rival a ${d}: disparo con el arco` };
  }

  if (distance <= MELEE_RANGE) {
    return { preferences: ["attack", "approach"], reason: `rival a ${d}: ataco` };
  }
  if (distance > 10 && turn % 3 === 2) {
    return { preferences: ["shoot", "approach"], reason: `rival a ${d}: disparo mientras me acerco` };
  }
  return { preferences: ["approach", "shoot", "wait"], reason: `rival a ${d}: me acerco` };
}

function defaultForSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return null;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case "number":
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "string":
      return "";
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

/** Rellena solo los argumentos obligatorios según el JSON Schema de la tool. */
export function buildArgs(tool: ToolDef): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const required: unknown[] = Array.isArray(tool.parameters.required) ? tool.parameters.required : [];
  const properties = isRecord(tool.parameters.properties) ? tool.parameters.properties : {};
  for (const key of required) {
    if (typeof key === "string") args[key] = defaultForSchema(properties[key]);
  }
  return args;
}

export function createMockClient(model = "mock-scripted"): LlmClient {
  // El agente recorta el historial (12 mensajes), así que contar mensajes "assistant" se
  // estanca a los pocos turnos. Este contador por cliente sigue creciendo toda la pelea.
  let calls = 0;
  return {
    provider: "mock",
    model,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      if (req.signal?.aborted) {
        const err = new Error("[llm:mock] solicitud cancelada");
        err.name = "AbortError";
        throw err;
      }
      const historyTurn = req.messages.filter((m) => m.role === "assistant").length;
      const turn = Math.max(historyTurn, calls);
      calls += 1;
      const decision = decide(readObservation(req.messages), readStyle(req.messages), turn);
      const byName = new Map(req.tools.map((t) => [t.name, t]));
      // Si ninguna preferida está disponible, se prueba cualquier tool conocida.
      const order: string[] = [...decision.preferences, ...MOCK_TOOL_NAMES];
      const chosenName = order.find((name) => byName.has(name));
      const tool = chosenName === undefined ? undefined : byName.get(chosenName);
      if (!tool) {
        return { text: `[mock] ${decision.reason} (sin herramientas conocidas)`, toolCalls: [] };
      }
      return {
        text: `[mock] ${decision.reason}`,
        toolCalls: [{ id: `mock_${turn}`, name: tool.name, args: buildArgs(tool) }],
      };
    },
  };
}
