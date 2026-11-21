import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, ToolDef } from "./types";
import { extractJsonObject, isRecord } from "./util";

/**
 * Proveedor "mock": determinista y sin red, para mostrar el sistema sin API keys.
 *
 * CONVENCIÓN con @phack/agent
 * - Tools que busca POR NOMBRE en la lista recibida: "approach", "attack", "retreat",
 *   "shoot", "eat", "pearl", "build", "wait" (las mismas de TOOL_NAMES del agente). Solo
 *   usa las que estén presentes; si la preferida falta, cae a la siguiente de su lista.
 *   Si no hay ninguna conocida, no llama tools.
 * - Observación: lee el ÚLTIMO mensaje con role "user" y espera un JSON (el mensaje
 *   completo, o el tramo entre la primera "{" y la última "}") con:
 *     distance:        number | null  bloques hasta el rival (null = no se ve)
 *     health:          number         vida propia, 0..20
 *     opponentHealth:  number | null  vida del rival, 0..20
 *     food:            number         barra de comida propia, 0..20
 *     inventory:       objeto         cantidad de cada ítem, por nombre de Minecraft
 *     currentAction:   string         herramienta que el cuerpo está ejecutando
 *     pearlCooldown:   number         segundos de recarga de la perla (falta = lista)
 *     buildCooldown:   number         segundos de recarga del muro (falta = listo)
 *     absorption:      number         corazones amarillos de la manzana dorada (falta = 0)
 *   Campos ausentes o inválidos se tratan como null (la vida y la comida propias como 20,
 *   las recargas y los corazones amarillos como 0 y el inventario como vacío).
 * - Argumentos: se envían solo los "required" del JSON Schema de la tool, con un valor
 *   por defecto (default, primer enum, minimum o 1 para números, "" para strings). La
 *   excepción es "pearl", que lleva el "target" que eligió la política ("rival" | "away").
 * - Herramientas de kit: solo se eligen si el inventario de la observación trae el ítem
 *   (perlas de ender, tablones) y no hay recarga pendiente. Con el kit clásico no cambia nada.
 *   Para ellas una manzana dorada solo cuenta como comida si no quedan corazones amarillos:
 *   no se acumulan, así que comer otra antes de perderlos la desperdicia.
 * - Tras una perla "away" el agente empieza a comer solo (si tiene hambre y comida). La
 *   política de siempre elige "eat" con poca vida y el rival lejos, que es como queda
 *   después de escapar, así que repite la acción en curso y no la corta.
 * - Estilo: si la estrategia del usuario contiene "defensiv", "mantén distancia",
 *   "usa el arco", "francotirador" o "arquer", pelea a distancia; si no, cuerpo a cuerpo.
 *   La estrategia es el texto entre <estrategia> y </estrategia> de los mensajes "system"
 *   (cada etiqueta sola en su línea, como la escribe el agente); el resto del system prompt
 *   (reglas, kit, herramientas) no cuenta, así un kit con arco no fuerza el estilo. Si no
 *   viene ese bloque, se revisa el texto completo.
 *   Así dos prompts distintos producen peleas distintas incluso sin LLM real.
 * - No informa `usage`: no hay tokens reales que contar.
 * - "Turno" = el mayor entre la cantidad de mensajes "assistant" del historial y el número
 *   de llamadas previas a ESTE cliente; se usa para alternar acciones. El contador propio
 *   existe porque el agente recorta el historial y la cuenta de mensajes se estanca.
 */

export const MOCK_TOOL_NAMES = [
  "approach",
  "attack",
  "retreat",
  "shoot",
  "eat",
  "pearl",
  "build",
  "shield",
  "water",
  "lava",
  "wait",
] as const;
export type MockToolName = (typeof MOCK_TOOL_NAMES)[number];

/** Distancia (bloques) a la que un golpe cuerpo a cuerpo alcanza. */
const MELEE_RANGE = 3.5;
/** Con esta vida o menos, se prioriza sobrevivir. */
const LOW_HEALTH = 6;
/** Bajo esta vida del rival, hasta el estilo defensivo remata cuerpo a cuerpo. */
const FINISH_HEALTH = 8;

/** El agente no deja lanzar la perla con esta vida o menos (la caída quita ~2.5). */
const PEARL_MIN_HEALTH = 4;
/** Con esta vida o menos y el rival encima, la perla se usa para escapar y comer. */
const PEARL_ESCAPE_HEALTH = 8;
/** Con más vida que esta y el rival lejos, la perla se usa para caerle encima. */
const PEARL_RIVAL_HEALTH = 8;
/** Distancia sobre la cual vale la pena gastar una perla para llegar al rival. */
const PEARL_RIVAL_DISTANCE = 8;
/** Bajo esta vida se levanta un muro para cubrirse (y se come detrás). */
const BUILD_HEALTH = 12;
/**
 * El muro se levanta con el rival a esta distancia: ni encima ni al otro lado de la arena.
 * El mínimo queda sobre el del agente, que rechaza "build" con el rival a menos de 4.5.
 */
const BUILD_MIN_DISTANCE = 5;
const BUILD_MAX_DISTANCE = 10;

/**
 * Frases (en minúsculas) que marcan un prompt "a distancia". Son frases específicas y no
 * palabras sueltas como "arco" o "distancia", para que una estrategia que solo las
 * menciona de pasada no cambie el estilo.
 */
const RANGED_STYLE = /defensiv|mant[eé]n(?:er|te)? (?:la |tu )?distancia|usar? (?:el |tu )?arco|francotirador|arquer/;

/**
 * Bloque de estrategia del system prompt del agente: de la primera línea que es solo
 * "<estrategia>" a la última que es solo "</estrategia>". Las menciones de las etiquetas
 * dentro de una frase (el agente explica el bloque antes de abrirlo) no cuentan.
 */
const STRATEGY_BLOCK = /^<estrategia>[ \t]*$([\s\S]*)^<\/estrategia>[ \t]*$/m;

export type MockObservation = {
  distance: number | null;
  health: number;
  opponentHealth: number | null;
  /** Barra de comida propia (20 si no viene). */
  food: number;
  /** Segundos de recarga pendientes; 0 = se puede usar. */
  pearlCooldown: number;
  buildCooldown: number;
  /** Corazones amarillos (vida extra de la manzana dorada); 0 = no tiene. */
  absorption: number;
  /** Cantidad de cada ítem, por nombre de Minecraft ({} si no viene). */
  inventory: Record<string, number>;
  /** Herramienta que el cuerpo está ejecutando (null si no viene). */
  currentAction: string | null;
};
export type MockStyle = "melee" | "ranged";
export type MockDecision = {
  preferences: MockToolName[];
  reason: string;
  /** Argumentos que la política fija para una tool, además de los obligatorios por defecto. */
  args?: Partial<Record<MockToolName, Record<string, unknown>>>;
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readInventory(value: unknown): Record<string, number> {
  const inventory: Record<string, number> = {};
  if (!isRecord(value)) return inventory;
  for (const [name, raw] of Object.entries(value)) {
    const count = num(raw);
    if (count !== null && count > 0) inventory[name] = count;
  }
  return inventory;
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
    food: num(obj.food) ?? 20,
    pearlCooldown: Math.max(0, num(obj.pearlCooldown) ?? 0),
    buildCooldown: Math.max(0, num(obj.buildCooldown) ?? 0),
    absorption: Math.max(0, num(obj.absorption) ?? 0),
    inventory: readInventory(obj.inventory),
    currentAction: typeof obj.currentAction === "string" ? obj.currentAction : null,
  };
}

export function readStyle(messages: ChatMessage[]): MockStyle {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const strategy = STRATEGY_BLOCK.exec(system)?.[1] ?? system;
  return RANGED_STYLE.test(strategy.toLowerCase()) ? "ranged" : "melee";
}

/** Política de siempre (la del kit clásico): solo mira distancia y vidas. */
function baseDecision(obs: MockObservation, style: MockStyle, turn: number): MockDecision {
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

/**
 * Uso de los ítems de kit (perlas y bloques). Devuelve null cuando no toca usarlos; todo
 * depende del inventario de la observación, así que sin esos ítems nunca decide nada.
 */
function kitDecision(obs: MockObservation): MockDecision | null {
  const { distance, health, opponentHealth } = obs;
  if (distance === null) return null;
  const d = distance.toFixed(1);
  const count = (name: string): number => obs.inventory[name] ?? 0;

  const losing = opponentHealth === null || opponentHealth > health;
  // El filete solo se puede comer con la barra de comida bajo 20; la manzana dorada, siempre,
  // pero sus corazones amarillos no se acumulan: mientras queden no vale la pena otra.
  const appleWorthIt = count("golden_apple") > 0 && obs.absorption === 0;
  const canEat = appleWorthIt || (obs.food < 20 && count("cooked_beef") > 0);
  const canPearl = count("ender_pearl") > 0 && obs.pearlCooldown === 0 && health > PEARL_MIN_HEALTH;

  if (canPearl && canEat && losing && health <= PEARL_ESCAPE_HEALTH && distance <= MELEE_RANGE + 2) {
    return {
      preferences: ["pearl"],
      args: { pearl: { target: "away" } },
      reason: `vida ${health} y rival a ${d}: escapo con una perla para comer`,
    };
  }
  // Con la vida al límite manda la política base: alejarse o comer.
  if (health <= LOW_HEALTH && losing) return null;

  if (obs.buildCooldown > 0 && health < BUILD_HEALTH && canEat && distance > MELEE_RANGE) {
    return { preferences: ["eat"], reason: `vida ${health} y muro recién puesto: como detrás` };
  }
  if (
    count("oak_planks") > 0 &&
    obs.buildCooldown === 0 &&
    health < BUILD_HEALTH &&
    distance >= BUILD_MIN_DISTANCE &&
    distance <= BUILD_MAX_DISTANCE
  ) {
    return { preferences: ["build"], reason: `vida ${health} y rival a ${d}: levanto un muro` };
  }
  if (canPearl && health > PEARL_RIVAL_HEALTH && distance > PEARL_RIVAL_DISTANCE) {
    return {
      preferences: ["pearl"],
      args: { pearl: { target: "rival" } },
      reason: `rival a ${d}: le caigo encima con una perla`,
    };
  }
  return null;
}

/** Política pura: observación + estilo + turno -> lista de tools preferidas, en orden. */
export function decide(obs: MockObservation, style: MockStyle, turn: number): MockDecision {
  // La perla y el muro son acciones de un solo uso que tardan: elegir otra tool las corta
  // a medias, así que se repiten (repetir = continuar) hasta que el cuerpo las termina.
  if (obs.currentAction === "pearl" || obs.currentAction === "build") {
    return { preferences: [obs.currentAction, "wait"], reason: `sigo con "${obs.currentAction}" hasta terminar` };
  }
  const base = baseDecision(obs, style, turn);
  const kit = kitDecision(obs);
  if (!kit) return base;
  // Si la tool de kit no está en la lista ofrecida, se cae a la política de siempre.
  const rest = base.preferences.filter((name) => !kit.preferences.includes(name));
  return { ...kit, preferences: [...kit.preferences, ...rest] };
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
      // `tool.name` salió de `order`, así que es uno de los nombres conocidos.
      const chosenArgs = decision.args?.[tool.name as MockToolName];
      return {
        text: `[mock] ${decision.reason}`,
        toolCalls: [{ id: `mock_${turn}`, name: tool.name, args: { ...buildArgs(tool), ...chosenArgs } }],
      };
    },
  };
}
