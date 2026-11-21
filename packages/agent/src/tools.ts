import { MAX_AGENT_MESSAGE_LENGTH, type CommsMode, type Kit } from "@phack/protocol";
import type { ToolDef } from "@phack/llm";
import { cleanMessage } from "./comms";
import {
  ALWAYS_EDIBLE,
  isArrow,
  isBow,
  isBuildBlock,
  isDrinkPotion,
  isFoodName,
  isLavaBucket,
  isPearl,
  isShield,
  isSplashPotion,
  isWaterBucket,
} from "./items";
import { MOVE_PLACES, type MovePlace } from "./tactics";

export const TOOL_NAMES = [
  "approach",
  "attack",
  "retreat",
  "move",
  "shoot",
  "eat",
  "drink",
  "throw",
  "pearl",
  "build",
  "dig",
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
export const BUILD_SHAPES = ["wall", "tower", "box", "block"] as const;
export type BuildShape = (typeof BUILD_SHAPES)[number];

/** Dónde se vacía el cubo de agua: entre tú y el rival, o bajo tus pies. */
export const WATER_PLACES = ["between", "feet"] as const;
export type WaterPlace = (typeof WATER_PLACES)[number];

/** Lado (respecto del rival) donde "build" pone un bloque suelto. */
export const BLOCK_SIDES = ["front", "behind", "left", "right"] as const;
export type BlockSide = (typeof BLOCK_SIDES)[number];

/** Estilos de "move". */
export const MOVE_STYLES = ["strafe", "circle", "keep", "goto"] as const;
export type MoveStyle = (typeof MOVE_STYLES)[number];
/** Distancia por defecto (y límites) de move "keep". */
export const KEEP_DISTANCE_DEFAULT = 8;
export const KEEP_DISTANCE_MIN = 2;
export const KEEP_DISTANCE_MAX = 16;

/** A quién se arroja una poción. */
export const THROW_AT = ["rival", "self"] as const;
export type ThrowAt = (typeof THROW_AT)[number];
/** Más lejos que esto la poción arrojadiza no llega al rival. */
export const THROW_MAX_DISTANCE = 8;

/** Qué rompe "dig": lo que hay entre tú y el rival, o el bloque más cercano. */
export const DIG_TARGETS = ["between", "nearest"] as const;
export type DigTarget = (typeof DIG_TARGETS)[number];

/** Bloques que gasta encerrarse: 4 lados de 2 de alto, un apoyo y el techo. */
export const BOX_BLOCKS = 10;
/** Más que esto por bloque (con lo que se tiene en el inventario) no se intenta romper. */
export const DIG_MAX_SECONDS = 10;
/** Bloques que rompe como máximo una sola llamada a dig "between". */
export const DIG_MAX_BLOCKS = 6;

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
  // Moverse con táctica se puede siempre, igual que acercarse o alejarse.
  const names: ToolName[] = ["approach", "attack", "retreat", "move"];
  if (has(isBow) && has(isArrow)) names.push("shoot");
  if (has(isFoodName)) names.push("eat");
  if (has(isDrinkPotion)) names.push("drink");
  if (has(isSplashPotion)) names.push("throw");
  if (has(isPearl)) names.push("pearl");
  if (has(isBuildBlock)) names.push("build");
  // Romper bloques se puede siempre: a mano, aunque el kit no traiga herramientas.
  names.push("dig");
  if (has(isShield)) names.push("shield");
  if (has(isWaterBucket)) names.push("water");
  if (has(isLavaBucket)) names.push("lava");
  names.push("wait");
  return names;
}

const reasonProperty = {
  type: "string",
  description: "Opcional: lo que piensas al elegir esta acción. Texto libre; el público lo ve.",
};

/**
 * Argumento "seconds" de las herramientas que no terminan solas (ver OPEN_ENDED_TOOLS en
 * plan.ts). `what` dice qué se hace durante esos segundos.
 */
function secondsProperty(what: string): { type: string; description: string } {
  return {
    type: "number",
    description: `Opcional: cuántos segundos ${what}; al cumplirse empieza tu siguiente acción en cola o, si no hay, quedas en espera.`,
  };
}

function simpleTool(name: ToolName, description: string, seconds?: string): ToolDef {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: seconds ? { reason: reasonProperty, seconds: secondsProperty(seconds) } : { reason: reasonProperty },
      required: [],
    },
  };
}

/** Todas las herramientas que existen. Al LLM solo se le ofrecen las de su kit (kitToolDefs). */
export const TOOL_DEFS: ToolDef[] = [
  simpleTool("approach", "Camina hacia el rival hasta quedar a unos 2 bloques, sin atacar.", "caminar hacia el rival"),
  {
    name: "attack",
    description:
      "Ataque cuerpo a cuerpo: equipa tu arma (espada o hacha), persigue al rival y lo golpea respetando la recarga del arma. Sigue atacando hasta que elijas otra acción (o por 'seconds' segundos).",
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        seconds: secondsProperty("atacar"),
        weapon: {
          type: "string",
          description:
            "Opcional: id del arma de tu inventario con la que pegar (por ejemplo 'diamond_axe'). Si no lo dices, la mejor espada y si no hay, el hacha.",
        },
        guard: {
          type: "boolean",
          description:
            "Opcional, solo con escudo: true = entre golpe y golpe levantas el escudo y lo bajas justo para pegar (recibes menos daño, persigues más lento).",
        },
      },
      required: [],
    },
  },
  simpleTool("retreat", "Aléjate del rival manteniéndote dentro de la arena.", "alejarte del rival"),
  {
    name: "move",
    description:
      "Movimiento táctico (sigue hasta que elijas otra acción). style='strafe': esquivas de lado a lado frente al rival, difícil de acertar con flechas. style='circle': lo rodeas a la distancia en que estás (entre 3 y 8 bloques). style='keep': mantienes la distancia 'distance' (te acercas o te alejas, y esquivas de lado cuando ya estás). style='goto': vas a un lugar: place='center' (centro), 'far_corner' (la esquina más lejos del rival) o 'behind_rival' (al otro lado del rival).",
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        seconds: secondsProperty("moverte así"),
        style: { type: "string", enum: [...MOVE_STYLES], description: "Cómo moverte." },
        distance: {
          type: "number",
          description: `Solo con style='keep': a cuántos bloques del rival quedarte (${KEEP_DISTANCE_MIN} a ${KEEP_DISTANCE_MAX}; por defecto ${KEEP_DISTANCE_DEFAULT}).`,
        },
        place: { type: "string", enum: [...MOVE_PLACES], description: "Solo con style='goto': adónde ir." },
      },
      required: ["style"],
    },
  },
  simpleTool(
    "shoot",
    "Dispara con el arco: te detienes, apuntas, cargas cerca de 1 segundo y sueltas. Sigue disparando hasta que elijas otra acción. Necesita arco y flechas.",
    "disparar",
  ),
  {
    name: "eat",
    description: "Come para recuperar vida: filete (solo si tu barra de comida no está llena) o manzana dorada (siempre; da regeneración y 4 de vida extra en corazones amarillos, que no se acumulan: no comas otra mientras tengas corazones amarillos). Tarda cerca de 2 segundos y te deja quieto. Con 'food' eliges qué comer.",
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        food: {
          type: "string",
          description: "Opcional: id de la comida de tu inventario (por ejemplo 'cooked_beef' o 'golden_apple'). Si no lo dices, la primera que se pueda comer.",
        },
      },
      required: [],
    },
  },
  {
    name: "drink",
    description:
      "Bebe una poción de tu inventario (tarda cerca de 2 segundos y te deja quieto). 'potion' es el tipo (por ejemplo 'healing' o 'strength'); en la observación aparecen como 'potion:<tipo>'.",
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        potion: { type: "string", description: "Tipo de la poción a beber; si no lo dices, la primera que tengas." },
      },
      required: [],
    },
  },
  {
    name: "throw",
    description: `Arroja una poción arrojadiza: at='rival' (por defecto) a los pies del rival, si está a ${THROW_MAX_DISTANCE} bloques o menos; at='self' a tus propios pies (para curarte al instante). 'potion' es el tipo; en la observación aparecen como 'splash_potion:<tipo>'. Es instantáneo.`,
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        potion: { type: "string", description: "Tipo de la poción a arrojar; si no lo dices, la primera que tengas." },
        at: { type: "string", enum: [...THROW_AT], description: "'rival' = al rival; 'self' = a tus pies." },
      },
      required: [],
    },
  },
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
    description: `Coloca bloques. shape='wall' (por defecto): levanta un muro de 3 de ancho y 2 de alto entre tú y el rival; frena las flechas y lo obliga a rodearlo (útil para comer detrás); gasta hasta ${WALL_BLOCKS} bloques y solo funciona con el rival a ${BUILD_MIN_DISTANCE} bloques o más y contigo parado en el piso de la arena. shape='tower': saltas y pones bloques bajo tus pies hasta quedar ${TOWER_HEIGHT} bloques más arriba; cuerpo a cuerpo el rival ya no te alcanza (con arco sí), pero bajar te hace daño de caída salvo que vacíes agua bajo tus pies. shape='box': te encierras en una caja de bloques con techo (gasta hasta ${BOX_BLOCKS}); nada te alcanza hasta que el rival rompa un bloque, pero tú tampoco puedes atacar sin romper uno. shape='block': pones una columna de 2 bloques justo a tu lado, en el lado 'side' respecto del rival ('front' entre tú y él, 'behind', 'left' o 'right'), para tapar un paso o cubrirte de un lado. Tarda 1 a 4 segundos, te deja quieto y al terminar quedas en espera. Recarga de ${BUILD_COOLDOWN_MS / 1000} segundos.`,
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        shape: {
          type: "string",
          enum: [...BUILD_SHAPES],
          description: "'wall' = muro hacia el rival; 'tower' = torre bajo tus pies para subir; 'box' = encerrarte; 'block' = columna de 2 a tu lado.",
        },
        side: { type: "string", enum: [...BLOCK_SIDES], description: "Solo con shape='block': de qué lado ponerla (respecto del rival)." },
      },
      required: [],
    },
  },
  {
    name: "dig",
    description: `Rompe bloques que alguien colocó (muros, torres, cajas); nunca el piso, los muros de vidrio ni el techo de la arena. target='between' (por defecto): rompe los bloques que hay entre tú y el rival, hasta ${DIG_MAX_BLOCKS} seguidos, para abrirte paso o dejarlo sin cobertura. target='nearest': rompe solo el bloque más cercano a ti (para salir de una caja o bajar de una torre). Solo alcanza bloques a unos 4 bloques de distancia. Usa sola la mejor herramienta que tengas (tijeras para lana, hacha para madera, pico para piedra); a mano tarda más, y lo que tardaría más de ${DIG_MAX_SECONDS} segundos no se intenta. Lo que rompes cae al suelo y lo recoges al pasar encima. Te deja quieto mientras rompes.`,
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        target: {
          type: "string",
          enum: [...DIG_TARGETS],
          description: "'between' = lo que hay entre tú y el rival; 'nearest' = el bloque más cercano.",
        },
      },
      required: [],
    },
  },
  simpleTool(
    "shield",
    "Levanta el escudo (en tu mano secundaria) mirando al rival: bloquea por completo los golpes y las flechas que vienen de frente. Mientras lo tienes levantado te quedas quieto y no atacas. Sigue levantado hasta que elijas otra acción. Un hacha puede desactivarlo unos segundos.",
    "tener el escudo levantado",
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
  simpleTool("wait", "Quédate quieto mirando al rival.", "quedarte quieto"),
];

const sayProperty = {
  type: "string",
  description: `Opcional: texto libre para el otro agente (máximo ${MAX_AGENT_MESSAGE_LENGTH} caracteres). Le llega tal cual en su próxima observación; la acción se ejecuta igual.`,
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
  /** Para "dig". "target" de la perla y de dig comparten nombre: cada uno lee el suyo. */
  digTarget: DigTarget;
  /** "build" shape "block". */
  side: BlockSide;
  /** "move". */
  style: MoveStyle;
  distance: number;
  place: MovePlace;
  /** "attack": arma elegida (id) y si se cubre con el escudo entre golpes. */
  weapon: string | null;
  guard: boolean;
  /** "eat": comida elegida (id). */
  food: string | null;
  /** "drink" / "throw": tipo de poción elegido y a quién se arroja. */
  potion: string | null;
  at: ThrowAt;
  /** Modo "chat": lo que el agente le dice al rival, con limpieza técnica (cleanMessage); null si no dijo nada. */
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
  const rawShape = word("shape");
  const shape: BuildShape = rawShape === "tower" || rawShape === "box" ? rawShape : "wall";
  const digTarget: DigTarget = word("target") === "nearest" ? "nearest" : "between";
  const oneOf = <T extends string>(key: string, options: readonly T[], fallback: T): T => {
    const value = word(key);
    return (options as readonly string[]).includes(value) ? (value as T) : fallback;
  };
  const side = oneOf("side", BLOCK_SIDES, "front");
  const style = oneOf("style", MOVE_STYLES, "strafe");
  const place = oneOf("place", MOVE_PLACES, "center");
  const at = oneOf("at", THROW_AT, "rival");
  const rawDistance = source["distance"];
  const distanceNumber = typeof rawDistance === "string" ? Number(rawDistance) : rawDistance;
  const distance =
    typeof distanceNumber === "number" && Number.isFinite(distanceNumber)
      ? Math.min(KEEP_DISTANCE_MAX, Math.max(KEEP_DISTANCE_MIN, distanceNumber))
      : KEEP_DISTANCE_DEFAULT;
  // Ids: se aceptan con o sin "minecraft:" y se normalizan; vacío = que elija el cuerpo.
  const id = (key: string): string | null => {
    const value = word(key).replace(/^minecraft:/, "").replace(/^(splash_)?potion:/, "");
    return /^[a-z0-9_]+$/.test(value) ? value : null;
  };
  const weapon = id("weapon");
  const food = id("food");
  const potion = id("potion");
  const guard = source["guard"] === true || word("guard") === "true";
  const where: WaterPlace = word("where") === "feet" ? "feet" : "between";
  // Se entrega tal cual lo escribió (ver cleanMessage): solo se quita lo que no es texto.
  const say = cleanMessage(source["say"]);
  return { reason, seconds, target, shape, where, digTarget, side, style, distance, place, weapon, guard, food, potion, at, say };
}
