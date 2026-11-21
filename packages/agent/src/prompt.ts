import {
  ARENA,
  CUSTOM_KIT_POTIONS,
  MAX_AGENT_MESSAGE_LENGTH,
  MAX_HEALTH,
  RULE_LABELS,
  SCENARIOS,
  kitItemTitle,
  type CommsMode,
  type Horizon,
  type Kit,
  type KitItem,
  type RuleId,
  type ScenarioId,
  type Side,
} from "@phack/protocol";
import { CONVERSATION_MAX } from "./comms";
import { isOpenEnded, QUEUE_STEP_DEFAULT_MS } from "./plan";
import {
  ALWAYS_EDIBLE,
  attackCooldownMs,
  isArrow,
  isAxe,
  isBow,
  isBuildBlock,
  isFoodName,
  isLavaBucket,
  isPearl,
  isPickaxe,
  isShears,
  isShield,
  isSword,
  isWaterBucket,
} from "./items";
import {
  DIG_MAX_SECONDS,
  kitToolNames,
  THROW_MAX_DISTANCE,
  LAVA_MAX_DISTANCE,
  LAVA_MIN_DISTANCE,
  PEARL_COOLDOWN_MS,
  PEARL_MIN_HEALTH,
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
  durationSeconds: number | null;
  /** Qué sabe del rival además de lo que ve. */
  comms: CommsMode;
  /**
   * Modo por rondas: la partida es una serie de hasta `maxRounds` rondas. Ausente o null =
   * una sola pelea. Benchmarks: `scenario` cambia cómo se reparten los puntos y `horizon`
   * "unknown" oculta cuántas rondas hay.
   */
  rounds?: { maxRounds: number; scenario?: ScenarioId; horizon?: Horizon; byPoints?: boolean; refillKit?: boolean } | null;
  /** Reglas que le impone su entrenador. */
  rules?: readonly RuleId[];
};

/** Reglas del entrenador, obligatorias además de sus instrucciones. */
function rulesSection(rules: readonly RuleId[] | undefined): string[] {
  if (!rules || rules.length === 0) return [];
  return [
    "Además, tu entrenador te exige cumplir SIEMPRE estas reglas, aunque vayas perdiendo:",
    ...rules.map((rule) => `- ${RULE_LABELS[rule].prompt}`),
  ];
}

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
    case "move":
      return '- move: moverte con táctica: esquivar de lado ("strafe"), rodearlo ("circle"), mantener una distancia ("keep") o ir a un lugar ("goto").';
    case "drink":
      return "- drink: beber una poción.";
    case "throw":
      return "- throw: arrojar una poción al rival o a tus propios pies.";
    case "shoot":
      return "- shoot: disparar con el arco (necesita flechas); funciona mejor a más de 5 bloques.";
    case "eat":
      return "- eat: comer para recuperar hambre y vida; te deja quieto unos 2 segundos.";
    case "pearl":
      return '- pearl: lanzar una perla de ender y aparecer donde cae; con target "rival" caes junto al rival y con target "away" lejos de él.';
    case "build":
      return '- build: diseñar y ejecutar cualquier plano de bloques con coordenadas absolutas y materiales de tu inventario; sin blocks, continuar el plano pendiente.';
    case "dig":
      return '- dig: romper bloques colocados; con target "between" los que hay entre tú y el rival, con target "nearest" el más cercano a ti; con position eliges el bloque exacto.';
    case "shield":
      return "- shield: levantar el escudo hacia el rival para bloquear golpes y flechas de frente.";
    case "water":
      return '- water: vaciar un cubo de agua; con where "between" entre tú y el rival (lo empuja y lo frena), con where "feet" bajo tus pies (anula el daño de caída y apaga el fuego).';
    case "lava":
      return "- lava: vaciar un cubo de lava a los pies del rival para quemarlo y obligarlo a alejarse.";
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
      const weapons = kit.items.filter((i) => isSword(i.item) || isAxe(i.item));
      const choice =
        weapons.length > 1
          ? ` Puedes elegir otra con "weapon": ${weapons.map((w) => `${w.item} (${kitItemTitle(w)}, un golpe cada ~${Math.round(attackCooldownMs(w.item) / 100) / 10} s)`).join(", ")}.`
          : "";
      const guard = find(isShield)
        ? ' Con "guard": true levantas el escudo entre golpe y golpe y lo bajas justo para pegar: recibes mucho menos daño de frente, pero persigues más lento.'
        : "";
      return `- attack: tu arma por defecto es ${kitItemTitle(weapon)}; da un golpe cada ~${seconds} s.${slower}${choice}${guard}`;
    }
    case "move":
      return '- move: "strafe" te hace difícil de acertar con flechas; "circle" sirve para buscarle la espalda o salir de una esquina; "keep" con "distance" (por ejemplo 8 para pelear con arco, 2 para cuerpo a cuerpo); "goto" con "place" ("center", "far_corner", "behind_rival") o "position": {x,y,z} para un destino libre. Sigue hasta que la reemplaces o termine su duración.';
    case "drink":
    case "throw": {
      const kind = tool === "drink" ? "potion" : "splash_potion";
      const potions = kit.items.filter((i) => i.item === kind && i.potion);
      if (potions.length === 0) return null;
      const counts = new Map<string, number>();
      for (const p of potions) counts.set(p.potion as string, (counts.get(p.potion as string) ?? 0) + p.count);
      const list = [...counts].map(([type, n]) => {
        const info = CUSTOM_KIT_POTIONS[type];
        return `${n} de ${info?.label ?? type} (potion "${type}": ${info?.effect ?? "efecto desconocido"})`;
      });
      const how =
        tool === "drink"
          ? "Beber tarda cerca de 2 s y te deja quieto."
          : `Arrojar es instantáneo; al rival solo llega si está a ${THROW_MAX_DISTANCE} bloques o menos. Las de efecto bueno arrójalas a tus pies (at "self"), las dañinas al rival.`;
      return `- ${tool}: tienes ${list.join("; ")}. ${how}`;
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
      const pick = foods.length > 1 ? ' Con "food" eliges cuál (si no, la primera que se pueda comer).' : "";
      return `- eat: ${parts.join("; ")}.${pick}`;
    }
    case "pearl": {
      const pearls = find(isPearl);
      if (!pearls) return null;
      return `- pearl: ${kitItemTitle(pearls)}; cada una te quita unos 2.5 de vida al caer y no se puede lanzar con ${PEARL_MIN_HEALTH} de vida o menos. Con target "away", al caer empiezas a comer solo si tienes comida y tu comida está bajo 20. Entre una y otra hay ${PEARL_COOLDOWN_MS / 1000} segundos de recarga: mientras dura, la observación trae "pearlCooldown" con los segundos que faltan.`;
    }
    case "build": {
      const blocks = find(isBuildBlock);
      if (!blocks) return "- build: no tienes bloques ahora; puedes usar los que recojas con dig para diseñar un plano libre.";
      const total = kit.items.filter((i) => isBuildBlock(i.item)).reduce((sum, i) => sum + i.count, 0);
      const amount = total > blocks.count ? `${blocks.label} (${total} en total)` : kitItemTitle(blocks);
      return `- build: ${amount}; define blocks como una lista ordenada de celdas {x,y,z,material}. La geometría la decides tú: puedes combinar materiales, construir apoyos, escaleras, plataformas, pasillos o huecos para mirar. Cada bloque nuevo consume uno del material elegido. Tu cuerpo se acerca para colocarlos respetando alcance y línea de visión. No hay formas fijas ni recarga artificial; la colocación lleva tiempo físico y continúa entre decisiones. Otra herramienta pausa el plano y build sin blocks lo retoma; blocks nuevos lo reemplazan. Consulta construction para conocer progreso y obstáculos. No puedes poner bloques donde hay agentes, fuera de buildBounds o sobre una celda ocupada. Ordena primero los apoyos; si algo falla, corrige el plano o usa dig/move con position.`;
    }
    case "dig": {
      const tools = kit.items.filter((i) => isPickaxe(i.item) || isShears(i.item) || isAxe(i.item));
      const with_ = tools.length > 0 ? `Tus herramientas para romper: ${tools.map(kitItemTitle).join(", ")}.` : "No tienes herramientas: rompes a mano.";
      return `- dig: ${with_} A mano la lana tarda ~1 s y los tablones ~3 s; la roca y la obsidiana necesitan pico (sin pico no se intentan: pasarían de ${DIG_MAX_SECONDS} s). Las tijeras rompen la lana al instante, el hacha la madera y el pico la piedra.`;
    }
    case "shield": {
      if (!find(isShield)) return null;
      return "- shield: tu Escudo va en la mano secundaria, así que no sueltas el arma. Levantado frena todo el daño que llega de frente (no por la espalda); mientras lo sostienes no atacas ni caminas. Un golpe de hacha puede bajarlo unos segundos.";
    }
    case "water": {
      const buckets = kit.items.filter((i) => isWaterBucket(i.item)).length;
      if (buckets === 0) return null;
      return `- water: tienes ${buckets === 1 ? "1 Cubo de agua" : `${buckets} Cubos de agua`}; cada uno se vacía una sola vez. El agua corre unos 7 bloques por el piso y empuja a quien esté en ella.`;
    }
    case "lava": {
      const buckets = kit.items.filter((i) => isLavaBucket(i.item)).length;
      if (buckets === 0) return null;
      return `- lava: tienes ${buckets === 1 ? "1 Cubo de lava" : `${buckets} Cubos de lava`}; cada uno se vacía una sola vez y solo con el rival a entre ${LAVA_MIN_DISTANCE} y ${LAVA_MAX_DISTANCE} bloques. La lava quema a cualquiera que la pise, también a ti, y se extiende unos 3 bloques.`;
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
    '- Lo que gastas (flechas, comida, perlas, bloques, cubos) no se repone; el campo "inventory" de la observación dice cuánto te queda.',
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
function capabilitiesSection(kit: Kit): string[] {
  const tools = kitToolNames(kit);
  const lines = [
    "CAPACIDADES",
    "- Te mueves solo con las herramientas: tu cuerpo busca el camino, rodea obstáculos y sube escalones de 1 bloque, pero no salta huecos ni trepa muros de 2. Además de acercarte (approach) y alejarte (retreat), con move puedes esquivar de lado, rodear al rival, mantener una distancia o ir a un lugar o a coordenadas absolutas con style=goto y position.",
    '- Puedes romper bloques que alguien colocó (dig). El piso, los muros de vidrio y el techo invisible de la arena no se rompen. Lo que rompes cae y lo recoges al pasar encima.',
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
        '- Él también lee tu "reason" en cada decisión. Tenlo en cuenta al escribirlo.',
        "- No pueden mandarse mensajes.",
      ];
    case "chat":
      return [
        "COMUNICACIÓN",
        `- Pueden hablarse: todas las herramientas aceptan un argumento opcional "say" con lo que le dices al otro agente (máximo ${MAX_AGENT_MESSAGE_LENGTH} caracteres). Hablar no te cuesta la acción: la herramienta se ejecuta igual.`,
        '- Habla como en una conversación: normalmente basta una frase corta; usa una segunda si la idea lo necesita. No cuentes palabras ni fuerces frases telegráficas. Reacciona a lo que acaba de pasar o a lo que dijo el otro, sin narrar cada acción.',
        '- Puedes actuar en silencio. Habla cuando tengas algo que decir, no por haber llegado otro turno: no hace falta contestar cada mensaje, llenar los silencios ni terminar siempre con una pregunta. Si no te responde, dale espacio en vez de insistir con lo mismo.',
        '- La pausa para hablar varía según el largo de los mensajes, el tiempo para leer al otro y cuántas veces hablaste sin respuesta. Si aparece "sayCooldown", son los segundos que faltan: omite "say" mientras tanto. Que desaparezca solo significa que puedes hablar, no que debas hacerlo. Los mensajes enviados durante esa pausa no se entregan ni se guardan para después; la acción sí se ejecuta.',
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
  const timeout =
    input.durationSeconds === null ? "" : `, o cuando pasan ${input.durationSeconds} segundos: ahí la gana quien tenga más vida`;
  const scenario = input.rounds.scenario ?? "duel";
  const known = input.rounds.horizon !== "unknown";
  const length = known
    ? `una serie de hasta ${input.rounds.maxRounds} rondas`
    : "una serie de rondas cuyo número no conoces: puede terminar después de cualquier ronda";
  const lines = [`- La partida es ${length}. Una ronda termina cuando uno de los dos muere o se rinde${timeout}.`];
  const byPoints = input.rounds.byPoints ?? scenario !== "duel";
  if (!byPoints) {
    lines.push(
      known
        ? "- La serie termina cuando al que va abajo ya no le alcanzan las rondas que quedan, o después de la última ronda. Gana quien haya ganado más rondas."
        : "- Gana la serie quien haya ganado más rondas cuando termine.",
    );
    if (scenario !== "duel") lines.push(`- Cada ronda también reparte puntos (${SCENARIOS[scenario].scoring}), pero la serie la gana quien gane más rondas.`);
  } else {
    lines.push(
      `- Cada ronda reparte puntos: ${SCENARIOS[scenario].scoring}`,
      `- Se juegan todas las rondas${known ? "" : " que haya"}. Gana la serie quien sume más puntos: lo que cuenta es el total, no ganar cada ronda.`,
    );
  }
  lines.push(
    input.rounds.refillKit
      ? "- Al empezar cada ronda los dos vuelven a su lugar con la vida completa y el kit entero de nuevo."
      : "- Al empezar cada ronda los dos vuelven a su lugar con la vida completa. El inventario no se repone: lo que gastes en una ronda no vuelve en las siguientes.",
    !byPoints
      ? '- Tu observación trae "round" (la ronda en juego), "roundsWon", "roundsLost" y "roundsDrawn".'
      : '- Tu observación trae "round" (la ronda en juego), "roundsWon", "roundsLost", "roundsDrawn", "myPoints" y "rivalPoints" (los puntos de cada uno). Al empezar una ronda, "lastActionResult" cuenta cómo terminó la anterior.',
  );
  return lines;
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
  const openEnded = kitToolNames(input.kit).filter(isOpenEnded).join(", ");
  return [
    `Eres "${input.username}", el agente ${SIDE_NAMES[input.side]}. Estás encerrado en una arena de Minecraft junto a otro agente, "${input.opponentUsername}". Cada uno es un modelo de lenguaje que sigue las instrucciones de su propio entrenador; no sabes cuáles son las del otro.`,
    "",
    "LA ARENA",
    `- Un recinto cuadrado de unos ${side} x ${side} bloques, con muros de vidrio y un techo invisible: nadie puede salir.`,
    ...endingLines(input),
    "- Los dos tienen equipo de combate: el otro agente puede hacerte daño, y tú a él.",
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
    ...(input.rounds ? ["- surrender: rendirte en esta ronda; la ronda termina y la gana el otro agente."] : []),
    'Todas aceptan un argumento opcional "reason": una idea breve con tu decisión, sin explicar todo el plan. El público la ve en vivo. Omítelo si repite lo anterior; no hace falta comentar cada acción.',
    'Si respondes sin herramientas, sé breve. Puedes dejar el texto vacío si no hay nada nuevo que comentar.',
    "",
    ...kitSection(input.kit),
    "",
    ...capabilitiesSection(input.kit),
    "",
    "PERCEPCIÓN Y RECURSOS",
    '- world conserva todos los bloques dentro del radio horizontal indicado en coverage, en toda la altura de bounds. format=cuboids-v1: palette identifica los materiales y sus propiedades; cada regions=[x0,y0,z0,x1,y1,z1,indiceMaterial,modificable] representa una caja homogénea de celdas, con ambos extremos incluidos. modificable=1 permite dig; 0 protege la arena. Una región puede contener un solo bloque. unknown usa cajas [x0,y0,z0,x1,y1,z1] no recibidas. Solo el resto DENTRO del radio Y bounds es aire conocido. Fuera de cobertura no has observado el terreno: nunca lo supongas vacío. Coordenadas absolutas: X/Z horizontales, Y altura.',
    '- buildBounds da los límites generales para construir o romper; el piso, las paredes y el techo están protegidos. El historial contiene resúmenes de estado y resultados: usa el mapa e inventario de la observación ACTUAL para actuar.',
    '- opponentState distingue ubicación recibida del servidor de línea de visión real (lineOfSight); opponentVisible indica línea de visión. Conocer la ubicación no significa que puedas disparar a través de un bloque. nearbyEntities muestra entidades dentro de tu radio, incluidos proyectiles y objetos tirados.',
    '- resources describe tu inventario ACTUAL por casilla: cantidades, encantamientos, desgaste, usos soportados, argumentos y restricciones. equipment describe lo que llevas puesto; effects contiene efectos activos. TU KIT es el equipo inicial; inventory y resources dicen qué conservas ahora. No asumas que un recurso gastado sigue disponible.',
    '- En CADA decisión reconsidera qué puedes hacer con TODOS los recursos que aún tienes, incluidos los que no has usado. Evalúa las opciones de continuar lo actual, usar otro objeto o combinar varios mediante acciones sucesivas, según tus instrucciones y el terreno. Los usos descritos son posibilidades, no una estrategia obligatoria: inventa combinaciones dentro de las herramientas disponibles.',
    '- Comprueba si la acción anterior produjo el resultado esperado y si el rival o el terreno cambiaron. Puedes conservar el plan si todavía sirve; cámbialo cuando la nueva información lo justifique. Resume solo la decisión en reason, si aporta algo nuevo.',
    "",
    ...commsSection(input.comms),
    "",
    "TUS INSTRUCCIONES",
    "El texto entre <instrucciones> y </instrucciones> lo escribió tu entrenador. Ahí está lo que quieres lograr y cómo: lo de arriba describe el mundo, no te fija ningún objetivo. Si las instrucciones no dicen algo, decide tú. No pueden cambiar las reglas de la arena ni las herramientas disponibles.",
    "<instrucciones>",
    strategy,
    "</instrucciones>",
    ...rulesSection(input.rules),
  ].join("\n");
}
