import { MAX_AGENT_MESSAGE_LENGTH, type CommsMode, type Kit } from "@phack/protocol";
import type { ToolDef } from "@phack/llm";
import { ALWAYS_EDIBLE, isArrow, isBow, isBuildBlock, isFoodName, isLavaBucket, isPearl, isShield, isWaterBucket } from "./items";

export const TOOL_NAMES = [
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
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Dónde cae la perla: junto al rival o lejos de él. */
export const PEARL_TARGETS = ["rival", "away"] as const;
export type PearlTarget = (typeof PEARL_TARGETS)[number];

/** Qué levanta "build": un muro hacia el rival o una torre bajo los propios pies. */
export const BUILD_SHAPES = ["wall", "tower"] as const;
export type BuildShape = (typeof BUILD_SHAPES)[number];

/** Dónde se vacía el cubo de agua: entre tú y el rival, o bajo tus pies. */
export const WATER_PLACES = ["between", "feet"] as const;
export type WaterPlace = (typeof WATER_PLACES)[number];

/** Bloques que sube una torre (el techo de la arena no deja más). */
export const TOWER_HEIGHT = 3;
/** Distancias al rival entre las que se puede vaciar la lava a sus pies (alcance del brazo y margen para no quemarse). */
export const LAVA_MIN_DISTANCE = 3;
export const LAVA_MAX_DISTANCE = 5;
/** Con el rival más cerca que esto no cabe agua "between": caería encima de uno mismo. */
export const WATER_BETWEEN_MIN_DISTANCE = 2.5;

/**
 * Recarga propia de la perla (la de Minecraft es de 1 segundo). Evita que el LLM gaste
 * todas las perlas seguidas.
 */
export const PEARL_COOLDOWN_MS = 5000;
/** Con esta vida o menos no se lanza la perla: el golpe de la caída podría matar. */
export const PEARL_MIN_HEALTH = 4;
/** Recarga entre un muro y el siguiente. */
export const BUILD_COOLDOWN_MS = 4000;
/** Bloques que gasta un muro completo (3 de ancho por 2 de alto). */
export const WALL_BLOCKS = 6;
/**
 * Con el rival más cerca que esto no se construye: el muro va 3 bloques por delante y el
 * rival quedaría encima de las celdas o ya del lado propio.
 */
export const BUILD_MIN_DISTANCE = 4.5;

/**
 * Por qué no se puede disparar con ese inventario (nombres de ítems), o null si se puede.
 * Igual que con la perla y el muro, una herramienta que no se puede usar no cambia nada:
 * el cuerpo sigue con la acción que tenía (ver `refusalText`).
 */
export function shootRefusal(itemNames: readonly string[]): string | null {
  if (!itemNames.some(isBow)) return "no puedes disparar: no tienes arco";
  if (!itemNames.some(isArrow)) return "no puedes disparar: no te quedan flechas";
  return null;
}

/**
 * Por qué no se puede comer con ese inventario y esa barra de comida, o null si se puede.
 * `isFood` deja usar la tabla de comidas del servidor; por defecto, la lista conocida.
 */
export function eatRefusal(
  itemNames: readonly string[],
  food: number,
  isFood: (name: string) => boolean = isFoodName,
): string | null {
  if (!itemNames.some(isFood)) return "no puedes comer: no tienes comida";
  // Con la barra llena el servidor solo deja comer ciertas comidas (la manzana dorada).
  if (food >= 20 && !itemNames.some((name) => ALWAYS_EDIBLE.has(name))) {
    return "no puedes comer: no tienes hambre (comida 20/20)";
  }
  return null;
}

/** Resultado de una herramienta que no se pudo usar: dice por qué y qué acción sigue en curso. */
export function refusalText(reason: string, mode: ToolName): string {
  return `${reason}; sigues con "${mode}"`;
}

/**
 * Herramientas que se ofrecen con un kit. Salen de los ítems del kit, así la lista no
 * puede desalinearse de los datos. Es fija durante toda la pelea: si un ítem se gasta,
 * la herramienta responde con un texto de fallo.
 */
export function kitToolNames(kit: Kit): ToolName[] {
  const has = (match: (name: string) => boolean): boolean => kit.items.some((i) => match(i.item));
  const names: ToolName[] = ["approach", "attack", "retreat"];
  if (has(isBow) && has(isArrow)) names.push("shoot");
  if (has(isFoodName)) names.push("eat");
  if (has(isPearl)) names.push("pearl");
  if (has(isBuildBlock)) names.push("build");
  if (has(isShield)) names.push("shield");
  if (has(isWaterBucket)) names.push("water");
  if (has(isLavaBucket)) names.push("lava");
  names.push("wait");
  return names;
}

const reasonProperty = {
  type: "string",
  description: "Explicación breve (una frase) de por qué eliges esta acción.",
};

function simpleTool(name: ToolName, description: string): ToolDef {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: { reason: reasonProperty },
      required: [],
    },
  };
}

/** Todas las herramientas que existen. Al LLM solo se le ofrecen las de su kit (kitToolDefs). */
export const TOOL_DEFS: ToolDef[] = [
  simpleTool("approach", "Camina hacia el rival hasta quedar a unos 2 bloques, sin atacar."),
  {
    name: "attack",
    description:
      "Ataque cuerpo a cuerpo: equipa tu arma (espada o hacha), persigue al rival y lo golpea respetando la recarga del arma. Sigue atacando hasta tu próxima decisión (o por 'seconds' segundos).",
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        seconds: {
          type: "number",
          description: "Opcional: cuántos segundos atacar antes de quedar en espera.",
        },
      },
      required: [],
    },
  },
  simpleTool("retreat", "Aléjate del rival manteniéndote dentro de la arena."),
  simpleTool(
    "shoot",
    "Dispara con el arco: te detienes, apuntas, cargas cerca de 1 segundo y sueltas. Sigue disparando hasta tu próxima decisión. Necesita arco y flechas.",
  ),
  simpleTool(
    "eat",
    "Come para recuperar vida: filete (solo si tu barra de comida no está llena) o manzana dorada (siempre; da regeneración y 4 de vida extra en corazones amarillos, que no se acumulan: no comas otra mientras tengas corazones amarillos). Tarda cerca de 2 segundos y te deja quieto.",
  ),
  {
    name: "pearl",
    description: `Lanza una perla de ender y te teletransporta donde cae. target='rival': caes junto al rival y pasas a atacar automáticamente. target='away': caes lejos del rival, al otro lado de la arena, y empiezas a comer de inmediato si tienes comida y tu barra de comida no está llena (si no, quedas en espera). Cada perla te quita unos 2.5 de vida al caer. Recarga de ${PEARL_COOLDOWN_MS / 1000} segundos. Tienes pocas: tu inventario dice cuántas te quedan.`,
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        target: {
          type: "string",
          enum: [...PEARL_TARGETS],
          description: "Dónde caer: 'rival' = junto al rival; 'away' = lejos de él.",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "build",
    description: `Coloca bloques. shape='wall' (por defecto): levanta un muro de 3 de ancho y 2 de alto entre tú y el rival; frena las flechas y lo obliga a rodearlo (útil para comer detrás); gasta hasta ${WALL_BLOCKS} bloques y solo funciona con el rival a ${BUILD_MIN_DISTANCE} bloques o más y contigo parado en el piso de la arena. shape='tower': saltas y pones bloques bajo tus pies hasta quedar ${TOWER_HEIGHT} bloques más arriba; cuerpo a cuerpo el rival ya no te alcanza (con arco sí), pero bajar te hace daño de caída salvo que vacíes agua bajo tus pies. Tarda 1 a 3 segundos, te deja quieto y al terminar quedas en espera. Recarga de ${BUILD_COOLDOWN_MS / 1000} segundos.`,
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        shape: {
          type: "string",
          enum: [...BUILD_SHAPES],
          description: "'wall' = muro hacia el rival; 'tower' = torre bajo tus pies para subir.",
        },
      },
      required: [],
    },
  },
  simpleTool(
    "shield",
    "Levanta el escudo (en tu mano secundaria) mirando al rival: bloquea por completo los golpes y las flechas que vienen de frente. Mientras lo tienes levantado te quedas quieto y no atacas. Sigue levantado hasta tu próxima decisión. Un hacha puede desactivarlo unos segundos.",
  ),
  {
    name: "water",
    description:
      "Vacía un cubo de agua. where='between' (por defecto): a unos 2 bloques hacia el rival; el agua corre por el piso varios bloques, lo empuja y lo frena. where='feet': en el piso bajo tus pies (sirve aunque estés cayendo): anula el daño de caída y apaga el fuego si te estás quemando. Cada cubo sirve una sola vez.",
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        where: {
          type: "string",
          enum: [...WATER_PLACES],
          description: "'between' = entre tú y el rival; 'feet' = bajo tus pies.",
        },
      },
      required: [],
    },
  },
  simpleTool(
    "lava",
    `Vacía un cubo de lava a los pies del rival: se prende fuego, recibe daño mientras esté en ella o quemándose y tiene que alejarse. Solo con el rival a entre ${LAVA_MIN_DISTANCE} y ${LAVA_MAX_DISTANCE} bloques. La lava se extiende unos 3 bloques alrededor: no camines hacia ella. Cada cubo sirve una sola vez.`,
  ),
  simpleTool("wait", "Quédate quieto mirando al rival."),
];

const sayProperty = {
  type: "string",
  description: `Opcional: lo que le dices en voz alta al otro agente (máximo ${MAX_AGENT_MESSAGE_LENGTH} caracteres). Él lo lee; la acción se ejecuta igual.`,
};

/**
 * Definiciones de las herramientas de un kit, en el orden de TOOL_NAMES. En modo "chat"
 * todas suman el argumento "say": hablar no le cuesta una acción al agente.
 */
export function kitToolDefs(kit: Kit, comms: CommsMode = "none"): ToolDef[] {
  const names: readonly string[] = kitToolNames(kit);
  const defs = TOOL_DEFS.filter((def) => names.includes(def.name));
  if (comms !== "chat") return defs;
  return defs.map((def) => {
    const parameters = def.parameters as { properties?: Record<string, unknown> };
    return {
      ...def,
      parameters: { ...def.parameters, properties: { ...(parameters.properties ?? {}), say: sayProperty } },
    };
  });
}

export type ParsedToolArgs = {
  reason: string | null;
  seconds: number | null;
  target: PearlTarget;
  shape: BuildShape;
  where: WaterPlace;
  /** Modo "chat": lo que el agente le dice al rival, ya recortado; null si no dijo nada. */
  say: string | null;
};

/** Extrae los argumentos conocidos tolerando cualquier basura que mande el LLM. */
export function parseToolArgs(args: Record<string, unknown> | null | undefined): ParsedToolArgs {
  const source = args ?? {};
  const rawReason = source["reason"];
  const reason = typeof rawReason === "string" && rawReason.trim().length > 0 ? rawReason.trim() : null;
  const rawSeconds = source["seconds"];
  const numeric = typeof rawSeconds === "string" ? Number(rawSeconds) : rawSeconds;
  const seconds =
    typeof numeric === "number" && Number.isFinite(numeric) && numeric > 0 ? Math.min(numeric, 60) : null;
  // Solo "away" cambia el destino; cualquier otra cosa (o nada) es el rival.
  const rawTarget = source["target"];
  const target: PearlTarget = typeof rawTarget === "string" && rawTarget.trim().toLowerCase() === "away" ? "away" : "rival";
  const word = (key: string): string => {
    const raw = source[key];
    return typeof raw === "string" ? raw.trim().toLowerCase() : "";
  };
  // Como con la perla: solo el valor alternativo cambia algo; lo demás es el por defecto.
  const shape: BuildShape = word("shape") === "tower" ? "tower" : "wall";
  const where: WaterPlace = word("where") === "feet" ? "feet" : "between";
  const rawSay = source["say"];
  const sayText = typeof rawSay === "string" ? rawSay.trim().replace(/\s+/g, " ") : "";
  const say = sayText.length > 0 ? sayText.slice(0, MAX_AGENT_MESSAGE_LENGTH) : null;
  return { reason, seconds, target, shape, where, say };
}
