import { describe, expect, it } from "vitest";
import { createLlmClient } from "@phack/llm";
import { buildCustomKit, KIT_LIST, kitItemTitle, KITS, MAX_ROUNDS, type CommsMode, type Kit } from "@phack/protocol";
import { buildSystemPrompt } from "./prompt";
import { kitToolDefs, kitToolNames, TOOL_NAMES } from "./tools";

function promptFor(kit: Kit, strategy = "Pega fuerte y no retrocedas.", comms: CommsMode = "none"): string {
  return buildSystemPrompt({
    side: "red",
    username: "AgenteRojo",
    opponentUsername: "AgenteAzul",
    kit,
    strategy,
    tickMs: 1500,
    durationSeconds: 120,
    comms,
  });
}

/** Texto con que el prompt nombra un ítem del kit ("Manzana dorada x2"), sin fijar aquí la cantidad. */
function titleOf(kit: Kit, itemId: string): string {
  const found = kit.items.find((i) => i.item === itemId);
  if (!found) throw new Error(`El kit ${kit.id} no tiene ${itemId}`);
  return kitItemTitle(found);
}

/** Líneas entre un título de sección y la siguiente línea en blanco. */
function section(prompt: string, title: string): string[] {
  const lines = prompt.split("\n");
  const start = lines.indexOf(title);
  if (start === -1) return [];
  const end = lines.indexOf("", start);
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

describe("buildSystemPrompt", () => {
  it("presenta al luchador, a su rival y el ritmo de decisión", () => {
    const prompt = promptFor(KITS.classic);
    const first = prompt.split("\n")[0] ?? "";
    expect(first).toContain('Eres "AgenteRojo", el agente rojo');
    expect(first).toContain('junto a otro agente, "AgenteAzul"');
    expect(prompt).toContain("Decides aproximadamente cada 1.5 segundos");
    expect(prompt).toContain("La partida dura 120 segundos");
  });

  it("dice que una respuesta puede llamar una herramienta, varias o ninguna", () => {
    const prompt = promptFor(KITS.classic);
    expect(prompt).not.toContain("exactamente a UNA herramienta");
    expect(prompt).not.toContain("solo se ejecuta la primera");
    expect(prompt).not.toContain("una frase corta en español");
    const lines = prompt.split("\n");
    const first = lines.indexOf("- Cada respuesta tuya puede llamar una herramienta, varias o ninguna.");
    expect(first).toBeGreaterThan(-1);
    expect(lines.slice(first + 1, first + 4)).toEqual([
      '- Si llamas varias, se ejecutan en orden: cada una empieza cuando termina la anterior. Las que no terminan solas (approach, attack, retreat, move, shoot, wait) duran lo que diga su argumento "seconds"; sin él, 2 segundos si hay otra acción después, o hasta que la reemplaces si es la última.',
      "- Si no llamas ninguna, no cambia nada: tu cuerpo sigue con lo que estaba haciendo y con lo que quedaba en cola.",
      '- Una respuesta que llama herramientas reemplaza lo que quedaba en cola de la anterior. Lo que queda en cola viene en el campo "queuedActions" de tu observación.',
    ]);
    expect(prompt).toContain("- Repetir la misma herramienta continúa la acción en curso");
  });

  it("la lista de las que no terminan solas sale del kit", () => {
    const { kit } = buildCustomKit({ items: [{ item: "iron_sword" }, { item: "shield" }] });
    expect(promptFor(kit)).toContain("Las que no terminan solas (approach, attack, retreat, move, shield, wait)");
  });

  it("no le dice cuándo llamar varias, ninguna ni en qué idioma pensar", () => {
    const prompt = promptFor(KITS.classic);
    const world = prompt.slice(0, prompt.indexOf("TUS INSTRUCCIONES"));
    expect(world).not.toMatch(/en español/i);
    expect(world).not.toMatch(/conviene|te recomendamos|deberías/i);
  });

  it("no le fija un objetivo: ni ganar, ni matar, ni sobrevivir", () => {
    const prompt = promptFor(KITS.classic);
    const world = prompt.slice(0, prompt.indexOf("TUS INSTRUCCIONES"));
    expect(world).not.toMatch(/\bgana/i);
    expect(world).not.toMatch(/\bmata/i);
    expect(world).not.toMatch(/sobreviv/i);
    expect(prompt).toContain("no te fija ningún objetivo");
  });

  it("deja las instrucciones del usuario al final, entre etiquetas en líneas propias", () => {
    const lines = promptFor(KITS.classic, "  Dispara de lejos.  ").split("\n");
    expect(lines.slice(-3)).toEqual(["<instrucciones>", "Dispara de lejos.", "</instrucciones>"]);
    const empty = promptFor(KITS.classic, "   ").split("\n");
    expect(empty.slice(-3)).toEqual([
      "<instrucciones>",
      "(sin instrucciones: decide tú qué quieres hacer)",
      "</instrucciones>",
    ]);
  });

  it("explica la comunicación según el modo", () => {
    const none = section(promptFor(KITS.classic, "x", "none"), "COMUNICACIÓN").join("\n");
    expect(none).toContain("No hay comunicación");
    expect(none).not.toContain("rivalThoughts");
    expect(none).not.toContain('"say"');

    const thoughts = section(promptFor(KITS.classic, "x", "thoughts"), "COMUNICACIÓN").join("\n");
    expect(thoughts).toContain('"rivalThoughts"');
    expect(thoughts).toContain('Él también lee tu "reason"');
    expect(thoughts).toContain("No pueden mandarse mensajes");

    const chat = section(promptFor(KITS.classic, "x", "chat"), "COMUNICACIÓN").join("\n");
    expect(chat).toContain('"say"');
    expect(chat).toContain('"rivalMessages"');
    expect(chat).toContain('"conversation"');
    expect(chat).toContain(
      "- El contenido y el idioma los decides tú. El sistema entrega el texto tal cual: no revisa, no corrige y no hace cumplir nada de lo que se digan.",
    );
    expect(chat).toContain('Tu "reason" es privado');
    expect(chat).toContain("normalmente basta una frase corta");
    expect(chat).toContain("Puedes actuar en silencio");
    expect(chat).toContain("no por haber llegado otro turno");
    expect(chat).toContain(
      "- Lo que dices se pronuncia por turnos: si el otro agente está hablando, tu mensaje espera a que termine y sale enseguida. Si mandas otro antes de que salga, reemplaza al que esperaba.",
    );
    expect(chat).not.toContain("sayCooldown");
    expect(chat).not.toContain("no se entregan");
  });

  it("en modo chat describe la mecánica sin aconsejar qué decir ni si creerle", () => {
    const chat = section(promptFor(KITS.classic, "x", "chat"), "COMUNICACIÓN").join("\n");
    for (const advice of ["tratos", "negociar", "persuadir", "amenazar", "mentir", "no te creas", "Nada obliga"]) {
      expect(chat).not.toContain(advice);
    }
  });

  it("con un kit personalizado describe lo que se pidió", () => {
    const { kit } = buildCustomKit({
      items: [
        { item: "netherite_sword", enchantments: [{ id: "sharpness", level: 3 }] },
        { item: "diamond_chestplate" },
        { item: "golden_apple", count: 5 },
      ],
      effects: [{ id: "strength", level: 1 }],
    });
    const lines = section(promptFor(kit), "TU KIT").join("\n");
    expect(lines).toContain("Armadura puesta: Peto de diamante.");
    expect(lines).toContain("Espada de netherita (Filo III)");
    expect(lines).toContain("Manzana dorada x5");
    expect(lines).toContain("Efectos permanentes: Fuerza I");
    expect(section(promptFor(kit), "HERRAMIENTAS").join("\n")).not.toContain("- shoot:");
  });

  it("lista en HERRAMIENTAS exactamente las herramientas del kit", () => {
    for (const kit of KIT_LIST) {
      const lines = section(promptFor(kit), "HERRAMIENTAS");
      const listed = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2, line.indexOf(":")));
      expect(listed).toEqual(kitToolNames(kit));
    }
  });

  it("con el kit clásico ofrece las de siempre más romper bloques", () => {
    const lines = section(promptFor(KITS.classic), "HERRAMIENTAS");
    expect(lines).toEqual([
      "- approach: caminar hacia el rival.",
      "- attack: cuerpo a cuerpo con la espada; solo golpea a menos de ~3 bloques, así que te acerca solo.",
      "- retreat: alejarte del rival dentro de la arena.",
      '- move: moverte con táctica: esquivar de lado ("strafe"), rodearlo ("circle"), mantener una distancia ("keep") o ir a un lugar ("goto").',
      "- shoot: disparar con el arco.",
      "- eat: comer una comida de tu inventario.",
      '- build: diseñar y ejecutar cualquier plano de bloques con coordenadas absolutas y materiales de tu inventario; sin blocks, continuar el plano pendiente.',
      '- dig: romper bloques colocados; con target "between" los que hay entre tú y el rival, con target "nearest" el más cercano a ti; con position eliges el bloque exacto.',
      "- wait: quedarte quieto.",
      'Todas aceptan un argumento opcional "reason": una idea breve con tu decisión, sin explicar todo el plan. El público la ve en vivo. Omítelo si repite lo anterior; no hace falta comentar cada acción.',
      "Si respondes sin herramientas, sé breve. Puedes dejar el texto vacío si no hay nada nuevo que comentar.",
    ]);
  });

  it("no menciona herramientas que el kit no tiene", () => {
    const tank = promptFor(KITS.tank);
    for (const missing of ["shoot", "pearl"]) {
      expect(tank).not.toContain(`- ${missing}:`);
    }
    expect(tank).not.toContain("pearlCooldown");
    expect(tank).not.toContain("buildCooldown");
    const berserker = section(promptFor(KITS.berserker), "HERRAMIENTAS").join("\n");
    expect(berserker).toContain("- attack: cuerpo a cuerpo con el hacha;");
  });

  it("describe en TU KIT los ítems con cantidades y encantamientos, y los efectos", () => {
    const classic = section(promptFor(KITS.classic), "TU KIT");
    expect(classic[0]).toMatch(/^- Armadura puesta: Casco de hierro, Peto de hierro, Grebas de hierro, Botas de hierro\. Reduce el daño/);
    expect(classic[1]).toMatch(/^- Objetos \(qué hace cada uno/);
    expect(classic.slice(2, 6).map((line) => line.slice(4, line.indexOf(". Qué hace")))).toEqual([
      "Espada de hierro",
      "Arco",
      "Filete x4",
      "Flechas x16",
    ]);
    expect(classic.join("\n")).not.toContain("Efectos permanentes");

    const archer = section(promptFor(KITS.archer), "TU KIT").join("\n");
    expect(archer).toContain("Arco (Empuje I)");
    expect(archer).toContain("Flechas x32");
    // El arquero ya no tiene Velocidad I: el único kit con efecto es el berserker.
    expect(archer).not.toContain("Efectos permanentes");

    const berserker = section(promptFor(KITS.berserker), "TU KIT").join("\n");
    expect(berserker).toContain("- Efectos permanentes: Velocidad I (caminas un 20% más rápido).");

    const ender = section(promptFor(KITS.ender), "TU KIT").join("\n");
    expect(ender).toContain("Botas de malla (Caída de pluma IV)");
    expect(ender).toContain("Perla de ender x4");

    const builder = section(promptFor(KITS.builder), "TU KIT").join("\n");
    expect(builder).toContain(titleOf(KITS.builder, "golden_apple"));
    expect(builder).toContain("Tablones de roble x16");
  });

  it("los datos de un objeto van una sola vez, en su guía, y no en una línea aparte de su herramienta", () => {
    const usesItems = ["shoot", "eat", "drink", "throw", "pearl", "shield", "water", "lava"];
    const { kit: full } = buildCustomKit({
      items: [
        { item: "iron_sword" },
        { item: "shield" },
        { item: "bow" },
        { item: "arrow", count: 8 },
        { item: "bread" },
        { item: "ender_pearl" },
        { item: "water_bucket" },
        { item: "lava_bucket" },
        { item: "potion", potion: "strength" },
        { item: "splash_potion", potion: "harming" },
      ],
    });
    for (const kit of [...KIT_LIST, full]) {
      const lines = section(promptFor(kit), "TU KIT");
      const objects = lines.filter((line) => line.startsWith("  - "));
      for (const tool of kitToolNames(kit).filter((name) => usesItems.includes(name))) {
        expect(objects.some((line) => line.includes(`Cómo usarlo: ${tool}`))).toBe(true);
        expect(lines.some((line) => line.startsWith(`- ${tool}:`))).toBe(false);
      }
      // Fuera de la guía solo queda lo que no es de un objeto.
      const rest = lines.filter((line) => /^- [a-z]+: /.test(line)).map((line) => line.slice(2, line.indexOf(":")));
      const unarmed = !kit.items.some((i) => /_(sword|axe)$/.test(i.item));
      expect(rest).toEqual([...(unarmed ? ["attack"] : []), "move", "build", "dig"]);
    }
    expect(kitToolNames(full)).toEqual(expect.arrayContaining(usesItems));
  });

  it("explica qué hace cada objeto, cómo se usa y cuándo sirve", () => {
    for (const kit of KIT_LIST.filter((k) => k.items.length > 0)) {
      const objects = section(promptFor(kit), "TU KIT").filter((line) => line.startsWith("  - "));
      expect(objects.length).toBeGreaterThan(0);
      for (const line of objects) {
        expect(line).toContain("Qué hace:");
        expect(line).toContain("Cómo usarlo:");
        expect(line).toContain("Situaciones comunes:");
      }
    }
    const archer = section(promptFor(KITS.archer), "TU KIT").join("\n");
    expect(archer).toContain("Empuje: cada flecha que acierta empuja al rival hacia atrás.");
    const ender = section(promptFor(KITS.ender), "TU KIT").join("\n");
    expect(ender).toContain('pearl con "target": "rival"');
    expect(ender).toContain("Caída de pluma: reduce un 48% el daño de caída, también el de una perla.");
    const { kit } = buildCustomKit({
      items: [
        { item: "cooked_beef", count: 2 },
        { item: "bread", count: 2 },
        { item: "splash_potion", potion: "harming" },
        { item: "splash_potion", potion: "healing", count: 2 },
      ],
    });
    const mine = section(promptFor(kit), "TU KIT").join("\n");
    expect(mine).toContain('eat con "food": "bread"');
    expect(mine).toContain('throw con "potion": "harming" y "at": "rival"');
    expect(mine).toContain('throw con "potion": "healing" y "at": "self"');
  });

  it("da los datos que el modelo no puede adivinar, en números", () => {
    const berserker = section(promptFor(KITS.berserker), "TU KIT").join("\n");
    expect(berserker).toContain(
      "Hacha de diamante. Qué hace: arma cuerpo a cuerpo: quita 9 por golpe (13.5 si es crítico) antes de la armadura del rival; un golpe cada 1.05 s; un golpe suyo deja sin escudo al rival 5 s",
    );
    const classic = section(promptFor(KITS.classic), "TU KIT").join("\n");
    expect(classic).toContain("Espada de hierro. Qué hace: arma cuerpo a cuerpo: quita 6 por golpe (9 si es crítico) antes de la armadura del rival; un golpe cada 0.65 s.");
    expect(classic).toContain("Cómo usarlo: attack; es el arma que saca si no nombras otra.");
    expect(classic).toContain("Arco. Qué hace: ataque a distancia: cada flecha quita de 6 a 10 antes de la armadura del rival; un disparo cada ~1.35 s; necesita flechas.");
    expect(classic).toContain("Filete x4. Qué hace: recupera 8 de comida (de 20)");
    expect(classic).toContain("Cómo usarlo: eat; tarda 1.8 s y te deja quieto; solo con la comida bajo 20.");
    const ender = section(promptFor(KITS.ender), "TU KIT").join("\n");
    // Con Caída de pluma IV la perla quita 5 x (1 - 0.48).
    expect(ender).toContain("cada caída te quita 2.6 de vida");
    expect(ender).toContain("entre una y otra pasan 5 s");
    expect(ender).toContain('"pearlCooldown"');
    expect(ender).toContain("no se lanza con 4 de vida o menos, a más de 1.5 bloques sobre el piso, ni hacia un rival a menos de 4 bloques");
    const builder = section(promptFor(KITS.builder), "TU KIT").join("\n");
    expect(builder).toContain(`${titleOf(KITS.builder, "golden_apple")}. Qué hace: recupera 4 de comida, da Regeneración II por 5 s (unos 4 de vida) y 4 de vida extra`);
    expect(builder).toContain("se puede comer aunque la comida esté llena");
    expect(builder).toContain("define blocks como una lista ordenada");
    expect(builder).toContain("No hay formas fijas ni recarga artificial");
    expect(builder).toContain("construction");
  });

  it("la armadura dice cuánto reduce y qué no reduce", () => {
    const armor = (kit: Kit): string => section(promptFor(kit), "TU KIT")[0] ?? "";
    expect(armor(KITS.classic)).toContain("15 puntos de armadura: a un golpe de 6 le quita cerca de un 48%");
    expect(armor(KITS.archer)).toContain("12 puntos de armadura: a un golpe de 6 le quita cerca de un 36%");
    // Peto y grebas de diamante suman dureza: detienen más de lo que dicen sus puntos solos.
    expect(armor(KITS.tank)).toContain("18 puntos de armadura: a un golpe de 6 le quita cerca de un 64%");
    for (const kit of KIT_LIST.filter((k) => k.items.length > 0)) {
      expect(armor(kit)).toContain("no reduce caídas, pociones ni el fuego que ya llevas encima");
      expect(armor(kit)).not.toMatch(/golpes, flechas y caídas/);
    }
  });

  it("la perla quita lo que corresponde a la armadura del kit, y el cuerpo no la lanza si lo mataría", () => {
    const { kit } = buildCustomKit({ items: [{ item: "iron_sword" }, { item: "iron_boots" }, { item: "ender_pearl", count: 3 }] });
    const mine = section(promptFor(kit), "TU KIT").join("\n");
    expect(mine).toContain("cada caída te quita 5 de vida");
    expect(mine).toContain("no se lanza con 5 de vida o menos");
    expect(promptFor(kit)).not.toContain("2.5 de vida");
  });

  it("un encantamiento que no hace nada en ese objeto se dice, no se inventa su efecto", () => {
    const { kit } = buildCustomKit({
      items: [
        { item: "diamond_sword", enchantments: [{ id: "sharpness", level: 3 }, { id: "power", level: 2 }] },
        { item: "bow", enchantments: [{ id: "power", level: 2 }, { id: "protection", level: 1 }] },
        { item: "arrow", count: 4 },
      ],
      effects: [{ id: "strength", level: 1 }],
    });
    const mine = section(promptFor(kit), "TU KIT").join("\n");
    // 7 de la espada + 3 de Fuerza I = 10, más 2 de Filo III; el crítico multiplica solo los 10.
    expect(mine).toContain("quita 12 por golpe (17 si es crítico)");
    expect(mine).toContain("Filo: suma 2 al daño de cada golpe (ya contado).");
    expect(mine).toContain("Poder: en este objeto no hace nada.");
    expect(mine).toContain("cada flecha quita de 11 a 17");
    expect(mine).toContain("Poder: suma un 75% al daño de cada flecha (ya contado).");
    expect(mine).toContain("Protección: en este objeto no hace nada.");
    expect(mine).toContain("Fuerza I (tus golpes quitan 3 más (ya contado en tus armas))");
  });

  it("no nombra una herramienta que el kit no ofrece", () => {
    const { kit } = buildCustomKit({ items: [{ item: "stone_sword" }, { item: "bow" }] });
    expect(kitToolNames(kit)).not.toContain("shoot");
    const mine = section(promptFor(kit), "TU KIT").join("\n");
    expect(mine).toContain("Cómo usarlo: tu kit no trae flechas, así que shoot no se te ofrece.");
    expect(mine).not.toContain("Cómo usarlo: shoot");
  });

  it("el arma por defecto es la misma que saca el cuerpo: la espada de mejor material", () => {
    const { kit } = buildCustomKit({ items: [{ item: "iron_sword" }, { item: "diamond_sword" }, { item: "netherite_axe" }] });
    const lines = section(promptFor(kit), "TU KIT");
    const line = (title: string): string => lines.find((l) => l.startsWith(`  - ${title}.`)) ?? "";
    expect(line("Espada de diamante")).toContain("es el arma que saca si no nombras otra");
    expect(line("Espada de hierro")).toContain('Cómo usarlo: attack con "weapon": "iron_sword".');
    expect(line("Hacha de netherita")).toContain('Cómo usarlo: attack con "weapon": "netherite_axe"');
  });

  it("avisa que los corazones amarillos no se acumulan solo a quien lleva manzanas doradas", () => {
    const builder = section(promptFor(KITS.builder), "TU KIT").join("\n");
    expect(builder).toContain("los corazones amarillos no se acumulan (otra manzana solo los renueva)");
    expect(builder).toContain('mientras te quedan, la observación trae "absorption"');
    // Describe, no ordena.
    expect(builder).not.toContain("no comas");
    for (const kit of KIT_LIST.filter((k) => !k.items.some((i) => i.item === "golden_apple"))) {
      expect(promptFor(kit)).not.toContain("absorption");
    }
  });

  it("no incluye el nombre ni la descripción del kit", () => {
    for (const kit of KIT_LIST) {
      const prompt = promptFor(kit);
      expect(prompt).not.toContain(kit.name);
      expect(prompt).not.toContain(kit.description);
    }
  });

  it("explica para qué sirve cada ítem del kit personalizado de supervivencia", () => {
    const { kit } = buildCustomKit({
      items: [
        { item: "diamond_helmet" },
        { item: "diamond_chestplate" },
        { item: "diamond_leggings" },
        { item: "diamond_boots" },
        { item: "cobblestone", count: 128 },
        { item: "water_bucket" },
        { item: "lava_bucket" },
        { item: "shield" },
      ],
    });
    const prompt = promptFor(kit, "Intenta aguantar la mayor cantidad de tiempo");
    const tools = section(prompt, "HERRAMIENTAS").join("\n");
    for (const tool of ["build", "shield", "water", "lava"]) expect(tools).toContain(`- ${tool}:`);
    const mine = section(prompt, "TU KIT").join("\n");
    // Dos stacks del mismo material se cuentan juntos, una sola vez.
    expect(mine).toContain("  - Roca x128. Qué hace: bloques para construir");
    expect(mine).not.toContain("en total");
    expect(mine).toContain("define blocks como una lista ordenada");
    expect(mine).toContain("Escudo. Qué hace: levantado bloquea todo el daño de golpes y flechas que llega de frente");
    expect(mine).toContain("va en la mano secundaria, así que no sueltas el arma");
    expect(mine).toContain('water con "where": "between" (a 2 bloques hacia el rival; no con él a menos de 2.5) o "feet"');
    expect(mine).toContain("lava: cae a los pies del rival, solo si está a entre 3 y 5 bloques; cada cubo se vacía una sola vez");
    expect(mine).toContain('Después de usarlo queda el cubo vacío ("bucket"), que no sirve para nada.');
    expect(mine).toContain("- attack: no tienes arma; a puño limpio cada golpe quita 1.");
  });

  it("dice qué puede y qué no puede hacer el cuerpo", () => {
    const classic = section(promptFor(KITS.classic), "CAPACIDADES").join("\n");
    expect(classic).toContain("Puedes romper bloques que alguien colocó (dig)");
    expect(classic).toContain("no se rompen");
    expect(classic).toContain("no puedes fabricar (craftear)");
    expect(classic).toContain("geometría libre");
    expect(classic).toContain('"blocksBetween"');
    const builder = section(promptFor(KITS.builder), "CAPACIDADES").join("\n");
    expect(builder).toContain("Puedes colocar bloques (build)");
  });

  it("reconsidera los recursos en cada turno y explica la cobertura espacial sin imponer una estrategia", () => {
    const perception = section(promptFor(KITS.builder), "PERCEPCIÓN Y RECURSOS").join("\n");
    expect(perception).toContain("En CADA decisión reconsidera");
    expect(perception).toContain("TODOS los recursos que aún tienes");
    expect(perception).toContain("combinar varios mediante acciones sucesivas");
    expect(perception).toContain("no una estrategia obligatoria");
    expect(perception).toContain("Fuera de cobertura no has observado el terreno");
    expect(perception).toContain("lineOfSight");
    expect(perception).toContain("resources dicen qué conservas ahora");
    expect(perception).toContain("un uso con blocked no se puede hacer ahora");
  });

  it("explica cómo elegir arma, comida y pociones, y el escudo entre golpes", () => {
    const { kit } = buildCustomKit({
      items: [
        { item: "iron_sword" },
        { item: "diamond_axe" },
        { item: "shield" },
        { item: "cooked_beef", count: 4 },
        { item: "golden_apple", count: 2 },
        { item: "potion", potion: "strength" },
        { item: "splash_potion", potion: "healing", count: 2 },
        { item: "splash_potion", potion: "poison" },
      ],
    });
    const mine = section(promptFor(kit), "TU KIT").join("\n");
    expect(mine).toContain('es el arma que saca si no nombras otra ("weapon": "iron_sword" la elige igual)');
    expect(mine).toContain('attack con "weapon": "diamond_axe"');
    expect(mine).toContain('attack con "guard": true lo levanta entre golpe y golpe');
    expect(mine).toContain('eat con "food": "cooked_beef" (sin "food", la primera que se pueda comer)');
    expect(mine).toContain('eat con "food": "golden_apple"; tarda');
    expect(mine).toContain('Poción de fuerza. Qué hace: tus golpes quitan 3 más durante 3 min. Cómo usarlo: drink con "potion": "strength"; tarda 1.8 s');
    // El nombre de la poción ya trae su tipo: no se repite ("x2 de curación").
    expect(mine).toContain('Poción arrojadiza de curación x2. Qué hace: cura 4 de vida al instante. Cómo usarlo: throw con "potion": "healing" y "at": "self"');
    expect(mine).toContain('Poción arrojadiza de veneno. Qué hace: al rival: quita 1 de vida cada 1.25 s');
    expect(mine).toContain('Después de usarlo queda la botella vacía ("glass_bottle")');
    const tank = section(promptFor(KITS.tank), "TU KIT").join("\n");
    expect(tank).toContain('attack con "guard": true');
    expect(section(promptFor(KITS.classic), "CAPACIDADES").join("\n")).toContain('"weapon" en attack');
  });
});

describe("buildSystemPrompt: límite de tiempo", () => {
  const base = {
    side: "red" as const,
    username: "AgenteRojo",
    opponentUsername: "AgenteAzul",
    kit: KITS.classic,
    strategy: "",
    tickMs: 1500,
    comms: "none" as const,
  };

  it("con límite dice cuánto dura la partida", () => {
    expect(buildSystemPrompt({ ...base, durationSeconds: 120 })).toContain("La partida dura 120 segundos");
  });

  it("sin límite no nombra ninguna duración y dice cómo termina", () => {
    const prompt = buildSystemPrompt({ ...base, durationSeconds: null });
    expect(prompt).toContain("La partida no tiene límite de tiempo");
    expect(prompt).not.toContain("La partida dura");
  });
});

describe("buildSystemPrompt: modo por rondas", () => {
  const base = {
    side: "red" as const,
    username: "AgenteRojo",
    opponentUsername: "AgenteAzul",
    kit: KITS.classic,
    strategy: "Pega fuerte y no retrocedas.",
    tickMs: 1500,
    comms: "none" as const,
  };
  const SERIES_LINES = [
    "- La serie termina cuando al que va abajo ya no le alcanzan las rondas que quedan, o después de la última ronda. Gana quien haya ganado más rondas.",
    "- Al empezar cada ronda los dos vuelven a su lugar con la vida completa. El inventario no se repone: lo que gastes en una ronda no vuelve en las siguientes.",
    '- Tu observación trae "round" (la ronda en juego), "roundsWon", "roundsLost" y "roundsDrawn".',
  ];
  const SURRENDER_LINE = "- surrender: rendirte en esta ronda; la ronda termina y la gana el otro agente.";

  it("con límite de tiempo cambia cómo termina la partida por la serie, y nada más", () => {
    const single = buildSystemPrompt({ ...base, durationSeconds: 120 }).split("\n");
    const rounds = buildSystemPrompt({ ...base, durationSeconds: 120, rounds: { maxRounds: MAX_ROUNDS } }).split("\n");
    const ending = "- La partida dura 120 segundos y termina antes si alguno de los dos muere. No hay reaparición.";
    const at = single.indexOf(ending);
    expect(at).toBeGreaterThan(-1);
    expect(rounds.slice(at, at + 4)).toEqual([
      `- La partida es una serie de hasta ${MAX_ROUNDS} rondas. Una ronda termina cuando uno de los dos muere o se rinde, o cuando pasan 120 segundos: ahí la gana quien tenga más vida.`,
      ...SERIES_LINES,
    ]);
    expect(rounds.join("\n")).not.toContain("No hay reaparición");
    // Lo demás queda igual: solo cambian esa línea y la herramienta surrender.
    const expected = [...single];
    expected.splice(at, 1, ...rounds.slice(at, at + 4));
    const tools = section(rounds.join("\n"), "HERRAMIENTAS");
    expect(tools).toContain(SURRENDER_LINE);
    expect(rounds.filter((line) => line !== SURRENDER_LINE)).toEqual(expected);
  });

  it("sin límite de tiempo no nombra ninguna duración", () => {
    const prompt = buildSystemPrompt({ ...base, durationSeconds: null, rounds: { maxRounds: MAX_ROUNDS } });
    expect(prompt).toContain(
      `- La partida es una serie de hasta ${MAX_ROUNDS} rondas. Una ronda termina cuando uno de los dos muere o se rinde.\n`,
    );
    for (const line of SERIES_LINES) expect(prompt).toContain(line);
    expect(prompt).not.toContain("segundos: ahí la gana");
    expect(prompt).not.toContain("La partida no tiene límite de tiempo");
  });

  it("en una sola pelea no habla de rondas ni de rendirse", () => {
    for (const durationSeconds of [120, null]) {
      const prompt = buildSystemPrompt({ ...base, durationSeconds });
      expect(prompt).toBe(buildSystemPrompt({ ...base, durationSeconds, rounds: null }));
      expect(prompt).not.toMatch(/ronda|surrender|rind/i);
      expect(prompt).toContain("No hay reaparición");
    }
  });

  it("solo cuenta la mecánica: no aconseja cuándo rendirse ni cómo gastar", () => {
    const single = buildSystemPrompt({ ...base, durationSeconds: 120 }).split("\n");
    const added = buildSystemPrompt({ ...base, durationSeconds: 120, rounds: { maxRounds: MAX_ROUNDS } })
      .split("\n")
      .filter((line) => !single.includes(line))
      .join("\n");
    expect(added).not.toMatch(/conviene|te recomendamos|deberías|guarda|ahorra|mejor/i);
  });

  it("las líneas nuevas no cambian el estilo que elige el LLM de prueba", async () => {
    const mock = createLlmClient({ provider: "mock", apiKeys: {} });
    const pick = async (rounds: { maxRounds: number } | null): Promise<string | undefined> => {
      const system = buildSystemPrompt({ ...base, durationSeconds: 120, rounds });
      const observation = { distance: 9, health: 20, opponentHealth: 20, inventory: { iron_sword: 1, bow: 1, arrow: 16 } };
      const response = await mock.complete({
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(observation) },
        ],
        tools: kitToolDefs(KITS.classic, "none", rounds !== null),
      });
      return response.toolCalls[0]?.name;
    };
    expect(await pick(null)).toBe("approach");
    expect(await pick({ maxRounds: MAX_ROUNDS })).toBe("approach");
  });
});

describe("buildSystemPrompt: benchmarks (escenario, horizonte y reglas)", () => {
  const base = {
    side: "red" as const,
    username: "AgenteRojo",
    opponentUsername: "AgenteAzul",
    kit: KITS.classic,
    strategy: "Gana la serie.",
    tickMs: 1500,
    durationSeconds: 60,
    comms: "chat" as const,
  };

  it("un escenario con puntos dice cómo se reparten y que gana el total", () => {
    const prompt = buildSystemPrompt({ ...base, rounds: { maxRounds: 4, scenario: "dilemma" } });
    expect(prompt).toContain("una serie de hasta 4 rondas");
    expect(prompt).toContain("Si ninguno ataca: 3 puntos cada uno");
    expect(prompt).toContain("Gana la serie quien sume más puntos");
    expect(prompt).toContain('"myPoints" y "rivalPoints"');
    expect(prompt).not.toContain("Gana quien haya ganado más rondas");
  });

  it("configurable: un escenario por rondas ganadas y el kit que se repone", () => {
    const prompt = buildSystemPrompt({ ...base, rounds: { maxRounds: 3, scenario: "dilemma", byPoints: false, refillKit: true } });
    expect(prompt).toContain("Gana quien haya ganado más rondas");
    expect(prompt).toContain("pero la serie la gana quien gane más rondas");
    expect(prompt).toContain("el kit entero de nuevo");
    expect(prompt).not.toContain("El inventario no se repone");
    // TU KIT no contradice a la serie: lo gastado vuelve con la ronda.
    expect(prompt).toContain("- Lo que gastas no se repone hasta la ronda siguiente;");
    expect(buildSystemPrompt({ ...base, rounds: { maxRounds: 3 } })).toContain("- Lo que gastas no se repone; el campo");
  });

  it("con horizonte desconocido no dice cuántas rondas hay", () => {
    const prompt = buildSystemPrompt({ ...base, rounds: { maxRounds: 4, horizon: "unknown" } });
    expect(prompt).toContain("cuyo número no conoces");
    expect(prompt).not.toContain("hasta 4 rondas");
  });

  it("las reglas del entrenador van después de sus instrucciones", () => {
    const prompt = buildSystemPrompt({ ...base, rules: ["no_lava", "no_first_strike"] });
    expect(prompt).toContain("Nunca uses la herramienta lava.");
    expect(prompt.indexOf("Nunca uses la herramienta lava.")).toBeGreaterThan(prompt.indexOf("</instrucciones>"));
    expect(buildSystemPrompt(base)).not.toContain("tu entrenador te exige");
  });
});
