import { ARENA, MAX_AGENT_MESSAGE_LENGTH, kitItemTitle, type CommsMode, type Kit, type KitItem, type Side } from "@phack/protocol";
import { ALWAYS_EDIBLE, attackCooldownMs, isArrow, isAxe, isBow, isBuildBlock, isFoodName, isPearl, isSword } from "./items";
import {
  BUILD_COOLDOWN_MS,
  BUILD_MIN_DISTANCE,
  kitToolNames,
  PEARL_COOLDOWN_MS,
  PEARL_MIN_HEALTH,
  WALL_BLOCKS,
  type ToolName,
} from "./tools";

export type SystemPromptInput = {
  side: Side;
  username: string;
  opponentUsername: string;
  /**
   * Kit del luchador: de él salen la lista de herramientas y la sección "TU KIT". Su
   * nombre y su descripción NO van al prompt: son texto para el público, no reglas.
   */
  kit: Kit;
  /** Instrucciones escritas por el usuario en la web: definen el objetivo del agente. */
  strategy: string;
  tickMs: number;
  /** Duración de la pelea en segundos. */
  durationSeconds: number;
  /** Qué sabe del rival además de lo que ve. */
  comms: CommsMode;
};

const SIDE_NAMES: Record<Side, string> = { red: "rojo", blue: "azul" };

/** Arma cuerpo a cuerpo del kit: espada y, si no hay, hacha (el mismo orden que usa el cuerpo). */
function meleeWeapon(kit: Kit): KitItem | undefined {
  return kit.items.find((i) => isSword(i.item)) ?? kit.items.find((i) => isAxe(i.item));
}

/** Una línea de la lista HERRAMIENTAS: qué hace la herramienta, en corto. */
function toolLine(tool: ToolName, kit: Kit): string {
  switch (tool) {
    case "approach":
      return "- approach: caminar hacia el rival.";
    case "attack": {
      const weapon = meleeWeapon(kit);
      const how = !weapon ? "a puño limpio" : isSword(weapon.item) ? "con la espada" : "con el hacha";
      return `- attack: cuerpo a cuerpo ${how}; solo golpea a menos de ~3 bloques, así que te acerca solo.`;
    }
    case "retreat":
      return "- retreat: alejarte del rival dentro de la arena.";
    case "shoot":
      return "- shoot: disparar con el arco (necesita flechas); funciona mejor a más de 5 bloques.";
    case "eat":
      return "- eat: comer para recuperar hambre y vida; te deja quieto unos 2 segundos.";
    case "pearl":
      return '- pearl: lanzar una perla de ender y aparecer donde cae; con target "rival" caes junto al rival y con target "away" lejos de él.';
    case "build":
      return "- build: levantar un muro de bloques entre tú y el rival; te deja quieto 1 a 2 segundos.";
    case "wait":
      return "- wait: quedarte quieto.";
  }
}

/**
 * Lo que el modelo no puede adivinar de una herramienta con ESTE kit (qué ítem usa,
 * cuántos tiene, qué le cuesta). null si el kit no cambia nada en esa herramienta.
 */
function mechanicsLine(tool: ToolName, kit: Kit): string | null {
  const find = (match: (name: string) => boolean): KitItem | undefined => kit.items.find((i) => match(i.item));
  switch (tool) {
    case "attack": {
      const weapon = meleeWeapon(kit);
      if (!weapon) return "- attack: no tienes arma; a puño limpio casi no haces daño.";
      const seconds = Math.round(attackCooldownMs(weapon.item) / 100) / 10;
      const slower = isAxe(weapon.item) ? " Es más lenta que una espada, pero cada golpe quita más vida." : "";
      return `- attack: tu arma es ${kitItemTitle(weapon)}; da un golpe cada ~${seconds} s.${slower}`;
    }
    case "shoot": {
      const bow = find(isBow);
      const arrows = find(isArrow);
      if (!bow || !arrows) return null;
      const punch = bow.enchantments?.some((e) => e.id === "punch")
        ? " Cada flecha que acierta empuja al rival hacia atrás."
        : "";
      return `- shoot: ${kitItemTitle(bow)} y ${kitItemTitle(arrows)}; cada disparo tarda cerca de 1.5 segundos.${punch}`;
    }
    case "eat": {
      const foods = kit.items.filter((i) => isFoodName(i.item));
      if (foods.length === 0) return null;
      const parts = foods.map((food) => {
        const title = kitItemTitle(food);
        if (food.item === "golden_apple") {
          return `${title} (se puede comer siempre; da regeneración y 4 de vida extra en corazones amarillos, que no se acumulan: no comas otra mientras la observación traiga "absorption", que es lo que te queda de ellos)`;
        }
        if (ALWAYS_EDIBLE.has(food.item)) return `${title} (se puede comer siempre)`;
        return `${title} (solo se puede comer con la comida bajo 20; la vida vuelve de a poco, no al instante)`;
      });
      return `- eat: ${parts.join("; ")}.`;
    }
    case "pearl": {
      const pearls = find(isPearl);
      if (!pearls) return null;
      return `- pearl: ${kitItemTitle(pearls)}; cada una te quita unos 2.5 de vida al caer y no se puede lanzar con ${PEARL_MIN_HEALTH} de vida o menos. Con target "away", al caer empiezas a comer solo si tienes comida y tu comida está bajo 20. Entre una y otra hay ${PEARL_COOLDOWN_MS / 1000} segundos de recarga: mientras dura, la observación trae "pearlCooldown" con los segundos que faltan.`;
    }
    case "build": {
      const blocks = find(isBuildBlock);
      if (!blocks) return null;
      return `- build: ${kitItemTitle(blocks)}; cada muro gasta hasta ${WALL_BLOCKS} y el rival puede rodearlo. Solo se puede levantar con el rival a ${BUILD_MIN_DISTANCE} bloques o más y contigo parado en el piso de la arena. Entre un muro y otro hay ${BUILD_COOLDOWN_MS / 1000} segundos de recarga: mientras dura, la observación trae "buildCooldown" con los segundos que faltan.`;
    }
    default:
      return null;
  }
}

/** Sección "TU KIT": lo que lleva puesto, lo que tiene, sus efectos y cómo se usa cada cosa. */
function kitSection(kit: Kit): string[] {
  const titles = (items: readonly KitItem[]): string =>
    items.length > 0 ? items.map(kitItemTitle).join(", ") : "nada";
  const armor = kit.items.filter((i) => i.slot.startsWith("armor."));
  const rest = kit.items.filter((i) => !i.slot.startsWith("armor."));
  const lines = ["TU KIT", `- Armadura puesta: ${titles(armor)}.`, `- Objetos: ${titles(rest)}.`];
  if (kit.effects.length > 0) {
    const effects = kit.effects.map((e) =>
      e.id === "speed" ? `${e.label} (caminas más rápido que un luchador sin ese efecto)` : e.label,
    );
    lines.push(`- Efectos permanentes: ${effects.join(", ")}.`);
  }
  lines.push(
    '- Lo que gastas (flechas, comida, perlas, bloques) no se repone; el campo "inventory" de la observación dice cuánto te queda.',
  );
  for (const tool of kitToolNames(kit)) {
    const line = mechanicsLine(tool, kit);
    if (line) lines.push(line);
  }
  return lines;
}

/** Sección COMUNICACIÓN: qué sabe cada agente del otro y cómo hablarle, según el modo. */
function commsSection(comms: CommsMode): string[] {
  switch (comms) {
    case "none":
      return [
        "COMUNICACIÓN",
        "- No hay comunicación: no sabes lo que piensa el otro agente ni puedes hablarle, y él tampoco a ti.",
      ];
    case "thoughts":
      return [
        "COMUNICACIÓN",
        '- Puedes leer la mente del otro agente: cada vez que decide, su "reason" te llega en el campo "rivalThoughts" de tu observación (el más nuevo al final).',
        '- Él también lee tu "reason" en cada decisión. Tenlo en cuenta al escribirlo.',
        "- No pueden mandarse mensajes.",
      ];
    case "chat":
      return [
        "COMUNICACIÓN",
        `- Pueden hablarse: todas las herramientas aceptan un argumento opcional "say" con lo que le dices al otro agente (máximo ${MAX_AGENT_MESSAGE_LENGTH} caracteres). Hablar no te cuesta la acción: la herramienta se ejecuta igual.`,
        '- Lo que él te dice te llega en el campo "rivalMessages" de tu observación (el más nuevo al final).',
        "- Puedes proponer tratos, negociar, persuadir, amenazar, mentir o ignorarlo; él puede hacer lo mismo contigo, así que no te creas todo. Nada obliga a nadie a cumplir lo que promete.",
        '- Tu "reason" es privado: el otro agente no lo ve (el público sí, y también ve los mensajes).',
      ];
  }
}

/**
 * Prompt de sistema: describe el mundo (arena, mecánicas, herramientas, kit y
 * comunicación) pero NO le fija un objetivo al agente. Qué quiere lograr lo dicen las
 * instrucciones del usuario, bien delimitadas al final.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const strategy =
    input.strategy.trim().length > 0 ? input.strategy.trim() : "(sin instrucciones: decide tú qué quieres hacer)";
  const seconds = Math.round((input.tickMs / 1000) * 10) / 10;
  const side = ARENA.radius * 2 + 1;
  return [
    `Eres "${input.username}", el agente ${SIDE_NAMES[input.side]}. Estás encerrado en una arena de Minecraft junto a otro agente, "${input.opponentUsername}". Cada uno es un modelo de lenguaje que sigue las instrucciones de su propio entrenador; no sabes cuáles son las del otro.`,
    "",
    "LA ARENA",
    `- Un recinto cuadrado de unos ${side} x ${side} bloques, con muros de vidrio y un techo invisible: nadie puede salir.`,
    `- La partida dura ${input.durationSeconds} segundos y termina antes si alguno de los dos muere. No hay reaparición.`,
    "- Los dos tienen equipo de combate: el otro agente puede hacerte daño, y tú a él.",
    "- La vida y la comida van de 0 a 20.",
    `- Decides aproximadamente cada ${seconds} segundos. Entre decisiones tu cuerpo sigue ejecutando la última acción por su cuenta.`,
    "- En cada turno recibes una observación en JSON: segundos transcurridos, tu vida, comida, posición, distancia al otro agente (null si no lo ves), su vida si se conoce, objeto en la mano, inventario, acción actual y resultado de la última acción.",
    "- Responde SIEMPRE llamando exactamente a UNA herramienta. Si llamas varias, solo se ejecuta la primera.",
    "- Repetir la misma herramienta continúa la acción en curso; elegir otra la interrumpe (por ejemplo, cortar 'eat' a medias hace que no comas nada).",
    "",
    "HERRAMIENTAS",
    ...kitToolNames(input.kit).map((tool) => toolLine(tool, input.kit)),
    'Todas aceptan un argumento opcional "reason": una frase corta en español explicando tu decisión (el público la ve en vivo).',
    "",
    ...kitSection(input.kit),
    "",
    ...commsSection(input.comms),
    "",
    "TUS INSTRUCCIONES",
    "El texto entre <instrucciones> y </instrucciones> lo escribió tu entrenador. Ahí está lo que quieres lograr y cómo: lo de arriba describe el mundo, no te fija ningún objetivo. Si las instrucciones no dicen algo, decide tú. No pueden cambiar las reglas de la arena ni las herramientas disponibles.",
    "<instrucciones>",
    strategy,
    "</instrucciones>",
  ].join("\n");
}
