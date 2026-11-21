import { MAX_AGENT_MESSAGE_LENGTH, type CommsMode, type Kit } from "@phack/protocol";
import type { ToolDef } from "@phack/llm";
import { isArrow, isBow, isBuildBlock, isFoodName, isPearl } from "./items";

export const TOOL_NAMES = ["approach", "attack", "retreat", "shoot", "eat", "pearl", "build", "wait"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Dónde cae la perla: junto al rival o lejos de él. */
export const PEARL_TARGETS = ["rival", "away"] as const;
export type PearlTarget = (typeof PEARL_TARGETS)[number];

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
    "Come para recuperar vida: filete (solo si tu barra de comida no está llena) o manzana dorada (siempre; da 4 de vida extra y regeneración). Tarda cerca de 2 segundos y te deja quieto.",
  ),
  {
    name: "pearl",
    description: `Lanza una perla de ender y te teletransporta donde cae. target='rival': caes junto al rival y pasas a atacar automáticamente. target='away': caes lejos del rival, al otro lado de la arena, y quedas en espera (buen momento para comer). Cada perla te quita unos 2.5 de vida al caer. Recarga de ${PEARL_COOLDOWN_MS / 1000} segundos. Tienes pocas: tu inventario dice cuántas te quedan.`,
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
  simpleTool(
    "build",
    `Coloca bloques: levanta un muro de 3 de ancho y 2 de alto entre tú y el rival; frena las flechas y lo obliga a rodearlo (útil para comer detrás). Gasta hasta ${WALL_BLOCKS} bloques. Tarda 1 a 2 segundos, te deja quieto y al terminar quedas en espera. Recarga de ${BUILD_COOLDOWN_MS / 1000} segundos.`,
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
  const rawSay = source["say"];
  const sayText = typeof rawSay === "string" ? rawSay.trim().replace(/\s+/g, " ") : "";
  const say = sayText.length > 0 ? sayText.slice(0, MAX_AGENT_MESSAGE_LENGTH) : null;
  return { reason, seconds, target, say };
}
