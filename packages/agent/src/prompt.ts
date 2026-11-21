/*
 * ============================================================================
 *  NO TOCAR EL PROMPT DE SISTEMA PARA UN CASO DE PRUEBA.
 *
 *  El prompt de sistema es el mismo para todas las pruebas y solo describe la
 *  arena, al otro agente y lo que se puede hacer y cómo (herramientas, kit,
 *  capacidades, percepción, comunicación y la mecánica de las rondas). NO dice
 *  qué hacer, ni cómo se gana, ni el puntaje, ni cuántas rondas hay, ni reglas,
 *  ni cómo comportarse (sé breve, reconsidera, conviene…).
 *
 *  Cualquier especificación del caso que se quiere medir (objetivo, puntos,
 *  cómo se gana, rondas, reglas, estilo) va en el PROMPT DEL AGENTE (el texto
 *  entre <instrucciones>): lo escribe la persona o un pre-ajuste
 *  (packages/protocol/src/presets.ts). Así un mismo sistema sirve para
 *  levantar cualquier caso.
 *
 *  prompt.test.ts ("genérico") falla si aquí aparece algo de un escenario.
 * ============================================================================
 */
import {
  arenaFor,
  MAX_AGENT_MESSAGE_LENGTH,
  MAX_HEALTH,
  kitItemTitle,
  type CommsMode,
  type Horizon,
  type Kit,
  type KitItem,
  type ScenarioId,
  type ArenaScenario,
  type ArenaScenarioId,
  type Side,
} from "@phack/protocol";
import { CONVERSATION_MAX } from "./comms";
import { isOpenEnded, QUEUE_STEP_DEFAULT_MS } from "./plan";
import { defaultMeleeWeapon, FIST_DAMAGE, isAxe, isBuildBlock, isDrinkPotion, isLavaBucket, isPickaxe, isSword, isWaterBucket } from "./items";
import { armorGuide, effectGuide, itemGuideLines } from "./item-guide";
import { knowledgeSection } from "./knowledge";
import { DIG_MAX_SECONDS, kitToolNames, type ToolName } from "./tools";

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
  /**
   * Mapa de la pelea (el objeto de ARENAS o su id). Si falta, el de ARENA_SCENARIO (o el
   * por defecto) — solo por compatibilidad: el luchador pasa el de su pelea.
   */
  arena?: ArenaScenario | ArenaScenarioId;
  /** Duración de la pelea en segundos. */
  durationSeconds: number | null;
  /** Qué sabe del rival además de lo que ve. */
  comms: CommsMode;
  /**
   * Modo por rondas: ausente o null = una sola pelea. El prompt solo cuenta la mecánica
   * (cuándo termina una ronda, si se repone el kit); cuántas rondas hay, el puntaje y qué
   * cuenta como ganar van en las instrucciones del entrenador. Los demás campos los usa el
   * cuerpo para la observación (ver FighterOptions).
   */
  rounds?: { maxRounds: number; scenario?: ScenarioId; horizon?: Horizon; byPoints?: boolean; refillKit?: boolean } | null;
};

const SIDE_NAMES: Record<Side, string> = { red: "rojo", blue: "azul" };

/** Arma que saca attack con este kit si no se nombra otra (la misma regla que usa el cuerpo); null = a puño limpio. */
function meleeWeapon(kit: Kit): string | null {
  return defaultMeleeWeapon(kit.items.map((i) => i.item));
}

/**
 * Una línea de la lista HERRAMIENTAS: qué hace la herramienta, en corto. Los argumentos
 * van en la definición de cada herramienta y los datos de cada objeto, en TU KIT.
 */
function toolLine(tool: ToolName, kit: Kit): string {
  switch (tool) {
    case "approach":
      return "- approach: caminar hacia el rival.";
    case "attack": {
      const weapon = meleeWeapon(kit);
      const how = !weapon ? "a puño limpio" : isSword(weapon) ? "con la espada" : "con el hacha";
      return `- attack: cuerpo a cuerpo ${how}; solo golpea a menos de ~3 bloques, así que te acerca solo.`;
    }
    case "retreat":
      return "- retreat: alejarte del rival dentro de la arena.";
    case "move":
      return '- move: moverte con táctica: esquivar de lado ("strafe"), rodearlo ("circle"), mantener una distancia ("keep") o ir a un lugar ("goto").';
    case "drink":
      return "- drink: beber una poción.";
    case "throw":
      return "- throw: arrojar una poción al rival o a tus propios pies.";
    case "shoot":
      return "- shoot: disparar con el arco.";
    case "eat":
      return "- eat: comer una comida de tu inventario.";
    case "pearl":
      return "- pearl: lanzar una perla de ender y aparecer donde cae.";
    case "build":
      return '- build: diseñar y ejecutar cualquier plano de bloques con coordenadas absolutas y materiales de tu inventario; sin blocks, continuar el plano pendiente.';
    case "dig":
      return '- dig: romper bloques colocados; con target "between" los que hay entre tú y el rival, con target "nearest" el más cercano a ti; con position eliges el bloque exacto.';
    case "shield":
      return "- shield: levantar el escudo hacia el rival para bloquear golpes y flechas de frente.";
    case "water":
      return "- water: vaciar un cubo de agua entre tú y el rival o bajo tus pies.";
    case "lava":
      return "- lava: vaciar un cubo de lava a los pies del rival.";
    case "wait":
      return "- wait: quedarte quieto.";
  }
}

/**
 * Lo que el modelo no puede adivinar de una herramienta y no es dato de un objeto (eso va
 * en la guía de objetos, item-guide.ts). null si no hay nada que agregar.
 */
function mechanicsLine(tool: ToolName, kit: Kit): string | null {
  switch (tool) {
    case "attack":
      return meleeWeapon(kit) ? null : `- attack: no tienes arma; a puño limpio cada golpe quita ${FIST_DAMAGE}.`;
    case "move":
      return '- move: "strafe" te desplaza de lado respecto del otro agente; "circle" gira a su alrededor; "keep" mantiene la distancia de "distance" (de 2 a 16 bloques); "goto" va a "place" ("center", "far_corner", "behind_rival") o a "position": {x,y,z}. Sigue hasta que la reemplaces o termine su duración.';
    case "build": {
      // Cuántos bloques hay de cada material lo dice la guía de objetos (y después, "inventory").
      if (!kit.items.some((i) => isBuildBlock(i.item))) return "- build: no tienes bloques ahora; puedes usar los que recojas con dig para diseñar un plano libre.";
      return `- build: define blocks como una lista ordenada de celdas {x,y,z,material}. La geometría la decides tú: puedes combinar materiales, construir apoyos, escaleras, plataformas, pasillos o huecos para mirar. Cada bloque nuevo consume uno del material elegido. Tu cuerpo se acerca para colocarlos respetando alcance y línea de visión. No hay formas fijas ni recarga artificial; la colocación lleva tiempo físico y continúa entre decisiones. Otra herramienta pausa el plano y build sin blocks lo retoma; blocks nuevos lo reemplazan. Consulta construction para conocer progreso y obstáculos. No puedes poner bloques donde hay agentes, fuera de buildBounds o sobre una celda ocupada. Ordena primero los apoyos; si algo falla, corrige el plano o usa dig/move con position.`;
    }
    case "dig": {
      const tools = kit.items.filter((i) => isPickaxe(i.item) || isAxe(i.item));
      const with_ = tools.length > 0 ? `Tus herramientas para romper: ${tools.map(kitItemTitle).join(", ")}.` : "No tienes herramientas: rompes a mano.";
      return `- dig: ${with_} A mano un tablón tarda 3 s y una roca 10 s (rota a mano no deja bloque para recoger); con hacha los tablones y con pico la roca, 1.5 s o menos. Lo que tardaría más de ${DIG_MAX_SECONDS} s no se intenta.`;
    }
    default:
      return null;
  }
}

/** Sección "TU KIT": lo que lleva puesto, lo que tiene, sus efectos y cómo se usa cada cosa. */
function kitSection(kit: Kit, refill = false): string[] {
  const titles = (items: readonly KitItem[]): string =>
    items.length > 0 ? items.map(kitItemTitle).join(", ") : "nada";
  const armor = kit.items.filter((i) => i.slot.startsWith("armor."));
  const rest = kit.items.filter((i) => !i.slot.startsWith("armor."));
  const lines = [
    "TU KIT",
    `- Armadura puesta: ${titles(armor)}.${armorGuide(kit)}`,
    rest.length > 0
      ? "- Objetos (qué hace cada uno y cómo se usa):"
      : "- Objetos: nada.",
    ...itemGuideLines(kit),
  ];
  if (kit.effects.length > 0) lines.push(`- Efectos permanentes: ${kit.effects.map(effectGuide).join(", ")}.`);
  // Un cubo vaciado o una poción bebida dejan el envase en el inventario: el agente lo va a ver ahí.
  const empties = [
    ...(kit.items.some((i) => isWaterBucket(i.item) || isLavaBucket(i.item)) ? ['el cubo vacío ("bucket")'] : []),
    ...(kit.items.some((i) => isDrinkPotion(i.item)) ? ['la botella vacía ("glass_bottle")'] : []),
  ];
  const left = empties.length > 1 ? ` Después de usarlos quedan ${empties.join(" y ")}, que no sirven para nada.` : empties.length === 1 ? ` Después de usarlo queda ${empties[0]}, que no sirve para nada.` : "";
  lines.push(
    `- Lo que gastas no se repone${refill ? " hasta la ronda siguiente" : ""}; el campo "inventory" de la observación dice cuánto te queda de cada cosa.${left}`,
  );
  for (const tool of kitToolNames(kit)) {
    const line = mechanicsLine(tool, kit);
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Sección CAPACIDADES: lo que el cuerpo puede y no puede hacer en general, más allá de
 * cada herramienta. Evita que el modelo planee cosas imposibles (fabricar, romper la arena).
 */
/** Qué se puede romper con dig en este mapa: solo lo colocado, o también el terreno. */
function breakLine(arena: ArenaScenario): string {
  if (arena.kind === "islands") {
    return "- Puedes romper bloques (dig), también el terreno de las islas. No se rompen ni se colocan la roca madre (bedrock), las barreras y otros bloques administrativos (bloques de comandos, de estructuras, portales, generadores). Lo que rompes cae y lo recoges al pasar encima.";
  }
  return "- Puedes romper bloques que alguien colocó (dig). El piso y los muros de vidrio de la arena no se rompen. Lo que rompes cae y lo recoges al pasar encima.";
}

function capabilitiesSection(kit: Kit, arena: ArenaScenario): string[] {
  const tools = kitToolNames(kit);
  const lines = [
    "CAPACIDADES",
    "- Te mueves solo con las herramientas: tu cuerpo busca el camino, rodea obstáculos y sube escalones de 1 bloque, pero no salta huecos ni trepa muros de 2. Además de acercarte (approach) y alejarte (retreat), con move puedes esquivar de lado, rodear al rival, mantener una distancia o ir a un lugar o a coordenadas absolutas con style=goto y position.",
    breakLine(arena),
  ];
  if (tools.includes("build")) {
    lines.push('- Puedes colocar bloques (build) con geometría libre. Diseña tú qué construir y dónde; los materiales del inventario y la física determinan qué se puede ejecutar.');
  } else {
    lines.push("- No tienes bloques para colocar (salvo los que recojas rompiendo).");
  }
  lines.push(
    '- Tu cuerpo elige solo qué sacar para cada acción (la mejor arma para attack, la mejor herramienta para dig). Si quieres otra cosa, dilo en los argumentos: "weapon" en attack, "food" en eat, "potion" en drink y throw. Usa los ids que aparecen en tu inventario.',
  );
  lines.push(
    "- Usas tu equipo solo a través de las herramientas: no puedes fabricar (craftear), tirar ítems, cambiarte la armadura ni abrir menús.",
    '- La observación cuenta lo que hay alrededor: "blocksBetween" (bloques en la recta hasta el otro agente), "enclosed" (tienes bloques por los cuatro lados) y "height" (cuánto estás sobre el piso). Si no aparecen, no hay nada de eso.',
  );
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
        '- Él también lee tu "reason" en cada decisión.',
        "- No pueden mandarse mensajes.",
      ];
    case "chat":
      return [
        "COMUNICACIÓN",
        `- Pueden hablarse: todas las herramientas aceptan un argumento opcional "say" con lo que le dices al otro agente (máximo ${MAX_AGENT_MESSAGE_LENGTH} caracteres). Hablar no te cuesta la acción: la herramienta se ejecuta igual.`,
        '- Lo que dices se pronuncia por turnos: si el otro agente está hablando, tu mensaje espera a que termine y sale enseguida. Si mandas otro antes de que salga, reemplaza al que esperaba.',
        '- Lo que él te dice te llega en el campo "rivalMessages" de tu observación (el más nuevo al final).',
        `- El campo "conversation" de tu observación trae los últimos ${CONVERSATION_MAX} mensajes entre los dos, el más viejo primero; "from" dice quién lo mandó ("tú" o "rival").`,
        "- El contenido y el idioma los decides tú. El sistema entrega el texto tal cual: no revisa, no corrige y no hace cumplir nada de lo que se digan.",
        '- Tu "reason" es privado: el otro agente no lo ve (el público sí, y también ve los mensajes).',
      ];
  }
}

/** Cómo termina la partida: una sola pelea o, en el modo por rondas, la serie. */
function endingLines(input: SystemPromptInput): string[] {
  if (!input.rounds) {
    return [
      input.durationSeconds === null
        ? "- La partida no tiene límite de tiempo: sigue hasta que alguno de los dos muera o hasta que la detengan desde afuera. No hay reaparición."
        : `- La partida dura ${input.durationSeconds} segundos y termina antes si alguno de los dos muere. No hay reaparición.`,
    ];
  }
  // Solo la mecánica de las rondas. Cuántas son, cómo se cuentan los puntos y qué cuenta
  // como ganar lo dice (si quiere) el entrenador en sus instrucciones.
  const timeout = input.durationSeconds === null ? "" : `, o cuando pasan ${input.durationSeconds} segundos`;
  return [
    `- La partida se juega en rondas. Una ronda termina cuando uno de los dos muere o se rinde${timeout}.`,
    input.rounds.refillKit
      ? "- Al empezar cada ronda los dos vuelven a su lugar con la vida completa y el kit entero de nuevo."
      : "- Al empezar cada ronda los dos vuelven a su lugar con la vida completa. El inventario no se repone: lo que gastes en una ronda no vuelve en las siguientes.",
    '- Tu observación trae "round" (la ronda en juego) y "maxRounds" si se sabe cuántas hay; si la partida lleva puntos, también "myPoints" y "rivalPoints". Al empezar una ronda, "lastActionResult" cuenta cómo terminó la anterior.',
  ];
}

/** Cómo es el recinto, según el escenario: solo lo físico (forma, tamaño, límites). */
function arenaLine(arena: ArenaScenario): string {
  if (arena.kind === "islands") {
    const [first] = arena.islands;
    const width = Math.abs(first.to.x - first.from.x) + 1;
    const depth = Math.abs(first.to.z - first.from.z) + 1;
    const [west, east] = [...arena.islands].sort((a, b) => a.from.x - b.from.x) as [typeof first, typeof first];
    const span = (i: typeof first) => `x=${Math.min(i.from.x, i.to.x)}..${Math.max(i.from.x, i.to.x)}`;
    return [
      `- Dos islas flotantes de unos ${width} x ${depth} bloques, con terreno propio (relieve, árboles, estructuras), separadas en el eje X por un hueco de al menos ${arena.gap} bloques de vacío: los bordes de las islas son irregulares y en algunas filas el hueco es mayor. Cada agente empieza en una isla distinta. No hay muros: alrededor y debajo de las islas solo hay vacío, y caer ahí mata.`,
      `- Coordenadas: la isla oeste ocupa ${span(west)} y la este ${span(east)}, las dos de z=${Math.min(first.from.z, first.to.z)}..${Math.max(first.from.z, first.to.z)}; el suelo de ambas está alrededor de y=${first.from.y}.`,
    ].join("\n");
  }
  if (arena.kind === "built") {
    // El piso incluye la fila de los muros: lo caminable es un bloque menos por lado.
    const width = arena.floor.halfX * 2 - 1;
    const depth = arena.floor.halfZ * 2 - 1;
    return `- Un recinto de unos ${width} x ${depth} bloques, de piso plano, rodeado por muros de vidrio de ${arena.wallHeight} bloques de alto y abierto arriba; fuera de los muros solo hay vacío.`;
  }
  const diameter = arena.radius * 2 + 1;
  return `- Una plataforma circular de unos ${diameter} bloques de diámetro, sin muros, con obstáculos y telarañas sobre el piso; el borde da al vacío y caer ahí mata.`;
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
  const arena = typeof input.arena === "object" ? input.arena : arenaFor(input.arena ?? process.env.ARENA_SCENARIO);
  const openEnded = kitToolNames(input.kit).filter(isOpenEnded).join(", ");
  return [
    `Eres "${input.username}", el agente ${SIDE_NAMES[input.side]}. Estás encerrado en una arena de Minecraft junto a otro agente, "${input.opponentUsername}". Cada uno es un modelo de lenguaje que sigue las instrucciones de su propio entrenador; no sabes cuáles son las del otro.`,
    "",
    "LA ARENA",
    arenaLine(arena),
    ...endingLines(input),
    "- El otro agente y tú pueden hacerse daño con el equipo que lleven.",
    '- Tu observación puede traer "notices": avisos que llegan de fuera de la arena (no son del otro agente). El sistema los entrega tal cual.',
    `- La vida va de 0 a ${MAX_HEALTH} y la comida de 0 a 20.`,
    `- Decides aproximadamente cada ${seconds} segundos. Entre decisiones tu cuerpo sigue ejecutando la última acción por su cuenta.`,
    "- En cada turno recibes una observación en JSON: segundos transcurridos, tu vida, comida, posición, distancia al otro agente (null si no lo ves), su vida si se conoce, objeto en la mano, inventario, acción actual y resultado de la última acción.",
    "- Cada respuesta tuya puede llamar una herramienta, varias o ninguna.",
    `- Si llamas varias, se ejecutan en orden: cada una empieza cuando termina la anterior. Las que no terminan solas (${openEnded}) duran lo que diga su argumento "seconds"; sin él, ${QUEUE_STEP_DEFAULT_MS / 1000} segundos si hay otra acción después, o hasta que la reemplaces si es la última.`,
    "- Si no llamas ninguna, no cambia nada: tu cuerpo sigue con lo que estaba haciendo y con lo que quedaba en cola.",
    '- Una respuesta que llama herramientas reemplaza lo que quedaba en cola de la anterior. Lo que queda en cola viene en el campo "queuedActions" de tu observación.',
    "- Repetir la misma herramienta continúa la acción en curso (build con blocks distintos reemplaza el plano); elegir otra la interrumpe (por ejemplo, cortar 'eat' a medias hace que no comas nada).",
    "",
    "HERRAMIENTAS",
    ...kitToolNames(input.kit).map((tool) => toolLine(tool, input.kit)),
    ...(input.rounds ? ["- surrender: rendirte en esta ronda; la ronda termina en el acto."] : []),
    'Todas aceptan un argumento opcional "reason": texto libre con lo que piensas al decidir; el público lo ve en vivo.',
    "",
    ...kitSection(input.kit, input.rounds?.refillKit === true),
    "",
    ...capabilitiesSection(input.kit, arena),
    "",
    "PERCEPCIÓN Y RECURSOS",
    '- world conserva todos los bloques dentro del radio horizontal indicado en coverage, en toda la altura de bounds. format=cuboids-v1: palette identifica los materiales y sus propiedades; cada regions=[x0,y0,z0,x1,y1,z1,indiceMaterial,modificable] representa una caja homogénea de celdas, con ambos extremos incluidos. modificable=1 permite dig; 0 protege la arena. Una región puede contener un solo bloque. unknown usa cajas [x0,y0,z0,x1,y1,z1] no recibidas. Solo el resto DENTRO del radio Y bounds es aire conocido. Fuera de cobertura no has observado el terreno: nunca lo supongas vacío. Coordenadas absolutas: X/Z horizontales, Y altura.',
    `- buildBounds da los límites generales para construir o romper; ${arena.kind === "islands" ? "abarca las dos islas y el hueco entre ellas, y lo administrativo está protegido" : "el piso, las paredes y el techo están protegidos"}. El historial contiene resúmenes de estado y resultados: usa el mapa e inventario de la observación ACTUAL para actuar.`,
    '- opponentState distingue ubicación recibida del servidor de línea de visión real (lineOfSight); opponentVisible indica línea de visión. Conocer la ubicación no significa que puedas disparar a través de un bloque. nearbyEntities muestra entidades dentro de tu radio, incluidos proyectiles y objetos tirados.',
    '- resources describe tu inventario ACTUAL por casilla: cantidad, durabilityLeft (los usos que le quedan a lo que se desgasta) y uses, con la herramienta y los argumentos que lo usan; un uso con blocked no se puede hacer ahora, y dice por qué. equipment es lo que llevas puesto (armadura y mano secundaria); effects contiene efectos activos. TU KIT es el equipo inicial; inventory y resources dicen qué conservas ahora. No asumas que un recurso gastado sigue disponible.',
    "",
    ...knowledgeSection(input.kit),
    "",
    ...commsSection(input.comms),
    "",
    "TUS INSTRUCCIONES",
    "El texto entre <instrucciones> y </instrucciones> lo escribió quien te configuró. Lo de arriba solo describe la arena y lo que puedes hacer; todo lo demás (qué hacer, cómo se evalúa la partida, reglas) está en ese texto. Si no dice algo, decides tú. No puede cambiar la arena ni las herramientas disponibles.",
    "<instrucciones>",
    strategy,
    "</instrucciones>",
  ].join("\n");
}
