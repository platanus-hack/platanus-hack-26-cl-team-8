import { describe, expect, it } from "vitest";
import { buildCustomKit, KIT_LIST, kitItemTitle, KITS, type CommsMode, type Kit } from "@phack/protocol";
import { buildSystemPrompt } from "./prompt";
import { kitToolNames, TOOL_NAMES } from "./tools";

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
      "- Es texto libre: qué decir, cómo, en qué idioma y cuándo lo decides tú. El sistema lo entrega tal cual: no revisa, no corrige y no hace cumplir nada de lo que se digan.",
    );
    expect(chat).toContain('Tu "reason" es privado');
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
      "- shoot: disparar con el arco (necesita flechas); funciona mejor a más de 5 bloques.",
      "- eat: comer para recuperar hambre y vida; te deja quieto unos 2 segundos.",
      '- dig: romper bloques colocados; con target "between" los que hay entre tú y el rival, con target "nearest" el más cercano a ti.',
      "- wait: quedarte quieto.",
      'Todas aceptan un argumento opcional "reason" con lo que piensas al decidir: texto libre, el público lo ve en vivo.',
    ]);
  });

  it("no menciona herramientas que el kit no tiene", () => {
    const tank = promptFor(KITS.tank);
    for (const missing of ["shoot", "pearl", "build"]) {
      expect(tank).not.toContain(`- ${missing}:`);
    }
    expect(tank).not.toContain("pearlCooldown");
    expect(tank).not.toContain("buildCooldown");
    const berserker = section(promptFor(KITS.berserker), "HERRAMIENTAS").join("\n");
    expect(berserker).toContain("- attack: cuerpo a cuerpo con el hacha;");
  });

  it("describe en TU KIT los ítems con cantidades y encantamientos, y los efectos", () => {
    const classic = section(promptFor(KITS.classic), "TU KIT");
    expect(classic[0]).toBe("- Armadura puesta: Casco de hierro, Peto de hierro, Grebas de hierro, Botas de hierro.");
    expect(classic[1]).toBe("- Objetos: Espada de hierro, Arco, Filete x4, Flechas x16.");
    expect(classic.join("\n")).not.toContain("Efectos permanentes");

    const archer = section(promptFor(KITS.archer), "TU KIT").join("\n");
    expect(archer).toContain("Arco (Empuje I)");
    expect(archer).toContain("Flechas x32");
    // El arquero ya no tiene Velocidad I: el único kit con efecto es el berserker.
    expect(archer).not.toContain("Efectos permanentes");

    const berserker = section(promptFor(KITS.berserker), "TU KIT").join("\n");
    expect(berserker).toContain("- Efectos permanentes: Velocidad I (caminas más rápido");

    const ender = section(promptFor(KITS.ender), "TU KIT").join("\n");
    expect(ender).toContain("Botas de malla (Caída de pluma IV)");
    expect(ender).toContain("Perla de ender x4");

    const builder = section(promptFor(KITS.builder), "TU KIT").join("\n");
    expect(builder).toContain(titleOf(KITS.builder, "golden_apple"));
    expect(builder).toContain("Tablones de roble x16");
  });

  it("explica la mecánica de cada herramienta que depende del kit", () => {
    const usesItems = ["attack", "shoot", "eat", "pearl", "build"];
    for (const kit of KIT_LIST) {
      const lines = section(promptFor(kit), "TU KIT");
      for (const tool of kitToolNames(kit).filter((name) => usesItems.includes(name))) {
        expect(lines.filter((line) => line.startsWith(`- ${tool}: `))).toHaveLength(1);
      }
      // Y ninguna línea habla de una herramienta que no se ofrece.
      for (const tool of TOOL_NAMES.filter((name) => !kitToolNames(kit).includes(name))) {
        expect(lines.some((line) => line.startsWith(`- ${tool}:`))).toBe(false);
      }
    }
  });

  it("da los datos que el modelo no puede adivinar", () => {
    const berserker = section(promptFor(KITS.berserker), "TU KIT").join("\n");
    expect(berserker).toContain("- attack: tu arma por defecto es Hacha de diamante; da un golpe cada ~1.1 s.");
    const classic = section(promptFor(KITS.classic), "TU KIT").join("\n");
    expect(classic).toContain("- attack: tu arma por defecto es Espada de hierro; da un golpe cada ~0.7 s.");
    expect(classic).toContain("Filete x4 (solo se puede comer con la comida bajo 20");
    const ender = section(promptFor(KITS.ender), "TU KIT").join("\n");
    expect(ender).toContain("no se puede lanzar con 4 de vida o menos");
    expect(ender).toContain('Con target "away", al caer empiezas a comer solo si tienes comida y tu comida está bajo 20.');
    expect(ender).toContain("5 segundos de recarga");
    expect(ender).toContain('"pearlCooldown"');
    const builder = section(promptFor(KITS.builder), "TU KIT").join("\n");
    expect(builder).toContain(`${titleOf(KITS.builder, "golden_apple")} (se puede comer siempre`);
    expect(builder).toContain("cada muro gasta hasta 6");
    expect(builder).toContain("con el rival a 4.5 bloques o más y contigo parado en el piso de la arena");
    expect(builder).toContain("4 segundos de recarga");
    expect(builder).toContain('"buildCooldown"');
  });

  it("avisa que los corazones amarillos no se acumulan solo a quien lleva manzanas doradas", () => {
    const builder = section(promptFor(KITS.builder), "TU KIT").join("\n");
    expect(builder).toContain("corazones amarillos, que no se acumulan");
    expect(builder).toContain('no comas otra mientras la observación traiga "absorption"');
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
        { item: "red_wool", count: 128 },
        { item: "water_bucket" },
        { item: "lava_bucket" },
        { item: "shield" },
      ],
    });
    const prompt = promptFor(kit, "Intenta aguantar la mayor cantidad de tiempo");
    const tools = section(prompt, "HERRAMIENTAS").join("\n");
    for (const tool of ["build", "shield", "water", "lava"]) expect(tools).toContain(`- ${tool}:`);
    const mine = section(prompt, "TU KIT").join("\n");
    expect(mine).toContain("Lana roja (128 en total)");
    expect(mine).toContain("Una torre gasta 3");
    expect(mine).toContain("- shield: tu Escudo va en la mano secundaria");
    expect(mine).toContain("- water: tienes 1 Cubo de agua");
    expect(mine).toContain("- lava: tienes 1 Cubo de lava");
  });

  it("dice qué puede y qué no puede hacer el cuerpo", () => {
    const classic = section(promptFor(KITS.classic), "CAPACIDADES").join("\n");
    expect(classic).toContain("Puedes romper bloques que alguien colocó (dig)");
    expect(classic).toContain("no se rompen");
    expect(classic).toContain("no puedes fabricar (craftear)");
    expect(classic).toContain("No tienes bloques para colocar");
    expect(classic).toContain('"blocksBetween"');
    const builder = section(promptFor(KITS.builder), "CAPACIDADES").join("\n");
    expect(builder).toContain("Puedes colocar bloques (build)");
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
    expect(mine).toContain('Puedes elegir otra con "weapon": iron_sword');
    expect(mine).toContain("diamond_axe");
    expect(mine).toContain('Con "guard": true');
    expect(mine).toContain('Con "food" eliges cuál');
    expect(mine).toContain('- drink: tienes 1 de fuerza (potion "strength"');
    expect(mine).toContain('2 de curación (potion "healing"');
    expect(mine).toContain('1 de veneno (potion "poison"');
    const tank = section(promptFor(KITS.tank), "TU KIT").join("\n");
    expect(tank).toContain('Con "guard": true');
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
