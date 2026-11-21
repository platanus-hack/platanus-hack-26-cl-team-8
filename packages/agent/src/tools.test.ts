import { describe, expect, it } from "vitest";
import { MOCK_TOOL_NAMES } from "@phack/llm";
import { buildCustomKit, KIT_LIST, KITS, MAX_AGENT_MESSAGE_LENGTH, type Kit } from "@phack/protocol";
import { OPEN_ENDED_TOOLS } from "./plan";
import {
  eatRefusal,
  isToolName,
  kitToolDefs,
  kitToolNames,
  parseToolArgs,
  PEARL_MIN_HEALTH,
  pearlDamage,
  pearlMinHealth,
  refusalText,
  shootRefusal,
  SURRENDER_TOOL,
  TOOL_DEFS,
  TOOL_NAMES,
} from "./tools";

describe("TOOL_NAMES y TOOL_DEFS", () => {
  it("hay una definición por herramienta, en el mismo orden", () => {
    expect(TOOL_DEFS.map((def) => def.name)).toEqual([...TOOL_NAMES]);
  });

  it("el LLM de prueba conoce las mismas herramientas", () => {
    expect([...MOCK_TOOL_NAMES]).toEqual([...TOOL_NAMES]);
  });

  it("isToolName reconoce las herramientas nuevas y rechaza las que no existen", () => {
    expect(isToolName("pearl")).toBe(true);
    expect(isToolName("build")).toBe(true);
    expect(isToolName("tower")).toBe(false);
  });

  it("pearl exige destino y build permite planos arbitrarios sin formas fijas", () => {
    const pearl = TOOL_DEFS.find((def) => def.name === "pearl");
    expect(pearl?.parameters["required"]).toEqual(["target"]);
    const build = TOOL_DEFS.find((def) => def.name === "build");
    const props = build?.parameters["properties"] as Record<string, unknown>;
    expect(props).toHaveProperty("blocks");
    expect(props).not.toHaveProperty("shape");
    expect(props).not.toHaveProperty("side");
    expect(build?.parameters["required"]).toEqual([]); // {} continúa un plano existente.
  });

  it("eat y pearl no afirman datos que dependen del kit: esos van en TU KIT", () => {
    const eat = TOOL_DEFS.find((def) => def.name === "eat");
    expect(eat?.description).not.toMatch(/filete|manzana|corazones/i);
    expect(eat?.description).toContain("Con 'food' eliges cuál");
    const pearl = TOOL_DEFS.find((def) => def.name === "pearl");
    expect(pearl?.description).not.toContain("2.5");
    expect(pearl?.description).not.toContain("Tienes pocas");
  });

  it("la perla quita 5 al caer, menos lo que reducen Caída de pluma, Protección y Resistencia", () => {
    const kitWith = (boots: { id: string; level: number }[], effects: { id: string; level: number }[] = []) =>
      buildCustomKit({ items: [{ item: "iron_boots", enchantments: boots }, { item: "ender_pearl", count: 2 }], effects }).kit;
    expect(pearlDamage(kitWith([]))).toBe(5);
    expect(pearlMinHealth(kitWith([]))).toBe(5);
    expect(pearlDamage(kitWith([{ id: "feather_falling", level: 4 }]))).toBe(2.6);
    expect(pearlDamage(KITS.ender)).toBe(2.6);
    // Con poca reducción el límite de siempre (4) sigue mandando.
    expect(pearlMinHealth(KITS.ender)).toBe(PEARL_MIN_HEALTH);
    expect(pearlDamage(kitWith([{ id: "feather_falling", level: 4 }, { id: "protection", level: 4 }]))).toBe(1.8);
    expect(pearlDamage(kitWith([], [{ id: "resistance", level: 2 }]))).toBe(3);
    // Un encantamiento en un objeto que no es armadura no cuenta.
    const { kit: sword } = buildCustomKit({ items: [{ item: "iron_sword", enchantments: [{ id: "protection", level: 4 }] }] });
    expect(pearlDamage(sword)).toBe(5);
  });

  it("pearl explica que al escapar se pasa a comer si se puede", () => {
    const pearl = TOOL_DEFS.find((def) => def.name === "pearl");
    expect(pearl?.description).toContain("empiezas a comer de inmediato");
    expect(pearl?.description).not.toContain("buen momento para comer");
  });
});

describe("herramientas que no se pueden usar", () => {
  const classic = ["iron_sword", "bow", "cooked_beef", "arrow"];

  it("shootRefusal pide arco y flechas", () => {
    expect(shootRefusal(classic)).toBeNull();
    expect(shootRefusal(["iron_sword", "arrow"])).toBe("no puedes disparar: no tienes arco");
    expect(shootRefusal(["iron_sword", "bow"])).toBe("no puedes disparar: no te quedan flechas");
    expect(shootRefusal(["bow", "spectral_arrow"])).toBeNull();
  });

  it("eatRefusal pide comida y, para el filete, hambre", () => {
    expect(eatRefusal(classic, 17)).toBeNull();
    expect(eatRefusal(classic, 20)).toBe("no puedes comer: no tienes hambre (comida 20/20)");
    expect(eatRefusal(["iron_sword", "bow", "arrow"], 10)).toBe("no puedes comer: no tienes comida");
  });

  it("eatRefusal deja comer la manzana dorada con la barra llena", () => {
    expect(eatRefusal(["iron_sword", "golden_apple"], 20)).toBeNull();
    expect(eatRefusal(["cooked_beef", "golden_apple"], 20)).toBeNull();
  });

  it("eatRefusal acepta otra tabla de comidas (la del servidor)", () => {
    const isFood = (name: string): boolean => name === "rabbit_stew";
    expect(eatRefusal(["rabbit_stew"], 12)).toBe("no puedes comer: no tienes comida");
    expect(eatRefusal(["rabbit_stew"], 12, isFood)).toBeNull();
    expect(eatRefusal(["cooked_beef"], 12, isFood)).toBe("no puedes comer: no tienes comida");
  });

  it("refusalText conserva el motivo y dice qué acción sigue en curso", () => {
    // Un eat o un shoot que no se puede no deja al luchador en espera: sigue con lo que hacía.
    const text = refusalText(eatRefusal(classic, 20) ?? "", "attack");
    expect(text).toBe('no puedes comer: no tienes hambre (comida 20/20); sigues con "attack"');
    expect(refusalText("no puedes disparar: no tienes arco", "retreat")).toBe(
      'no puedes disparar: no tienes arco; sigues con "retreat"',
    );
  });
});

describe("kitToolNames", () => {
  const base = ["approach", "attack", "retreat", "move"];

  it("ofrece a cada kit solo lo que sus ítems permiten", () => {
    expect(kitToolNames(KITS.classic)).toEqual([...base, "shoot", "eat", "build", "dig", "wait"]);
    expect(kitToolNames(KITS.archer)).toEqual([...base, "shoot", "eat", "build", "dig", "wait"]);
    expect(kitToolNames(KITS.tank)).toEqual([...base, "eat", "build", "dig", "shield", "wait"]);
    expect(kitToolNames(KITS.berserker)).toEqual([...base, "eat", "build", "dig", "wait"]);
    expect(kitToolNames(KITS.ender)).toEqual([...base, "eat", "pearl", "build", "dig", "wait"]);
    expect(kitToolNames(KITS.builder)).toEqual([...base, "shoot", "eat", "build", "dig", "wait"]);
  });

  it("no ofrece disparar si falta el arco o faltan las flechas", () => {
    const withoutArrows: Kit = { ...KITS.classic, items: KITS.classic.items.filter((i) => i.item !== "arrow") };
    const withoutBow: Kit = { ...KITS.classic, items: KITS.classic.items.filter((i) => i.item !== "bow") };
    expect(kitToolNames(withoutArrows)).not.toContain("shoot");
    expect(kitToolNames(withoutBow)).not.toContain("shoot");
  });

  it("un kit sin ítems igual puede moverse, pegar, romper bloques a mano y esperar", () => {
    const empty: Kit = { ...KITS.classic, items: [] };
    expect(kitToolNames(empty)).toEqual([...base, "build", "dig", "wait"]);
  });

  it("respeta el orden de TOOL_NAMES", () => {
    for (const kit of KIT_LIST) {
      const names = kitToolNames(kit);
      expect(names).toEqual(TOOL_NAMES.filter((name) => names.includes(name)));
    }
  });
});

describe("kitToolDefs", () => {
  it("entrega las definiciones de las herramientas del kit y ninguna más", () => {
    for (const kit of KIT_LIST) {
      expect(kitToolDefs(kit).map((def) => def.name)).toEqual(kitToolNames(kit));
    }
  });

  it('las herramientas que no terminan solas aceptan "seconds"; las demás no', () => {
    for (const def of TOOL_DEFS) {
      const properties = (def.parameters as { properties: Record<string, { description?: string }> }).properties;
      if (OPEN_ENDED_TOOLS.includes(def.name)) {
        expect(properties.seconds?.description).toMatch(/^Opcional: cuántos segundos .+; al cumplirse empieza tu siguiente acción en cola/);
      } else {
        expect(properties).not.toHaveProperty("seconds");
      }
    }
  });

  it('"reason" es texto libre, sin pedir un estilo', () => {
    for (const def of TOOL_DEFS) {
      const properties = (def.parameters as { properties: Record<string, { description?: string }> }).properties;
      expect(properties.reason?.description).toBe("Opcional: texto libre con lo que piensas al decidir; el público lo ve.");
    }
  });

  it("el kit clásico puede construir con material recuperado pero no usar perlas", () => {
    const names = kitToolDefs(KITS.classic).map((def) => def.name);
    expect(names).not.toContain("pearl");
    expect(names).toContain("build");
  });
});

describe("parseToolArgs: target", () => {
  it("sin target (o con basura) apunta al rival", () => {
    expect(parseToolArgs({}).target).toBe("rival");
    expect(parseToolArgs(null).target).toBe("rival");
    expect(parseToolArgs({ target: 3 }).target).toBe("rival");
    expect(parseToolArgs({ target: "lejos" }).target).toBe("rival");
    expect(parseToolArgs({ target: "rival" }).target).toBe("rival");
  });

  it('acepta "away" con mayúsculas o espacios de más', () => {
    expect(parseToolArgs({ target: "away" }).target).toBe("away");
    expect(parseToolArgs({ target: " Away " }).target).toBe("away");
  });
});

describe("modo chat: argumento say", () => {
  it("solo se ofrece en modo chat, en todas las herramientas", () => {
    for (const def of kitToolDefs(KITS.classic, "none")) {
      expect((def.parameters as { properties: Record<string, unknown> }).properties).not.toHaveProperty("say");
    }
    for (const def of kitToolDefs(KITS.classic, "thoughts")) {
      expect((def.parameters as { properties: Record<string, unknown> }).properties).not.toHaveProperty("say");
    }
    const chat = kitToolDefs(KITS.ender, "chat");
    expect(chat.map((def) => def.name)).toEqual(kitToolNames(KITS.ender));
    for (const def of chat) {
      const properties = (def.parameters as { properties: Record<string, unknown> }).properties;
      expect(properties).toHaveProperty("say");
      expect(properties).toHaveProperty("reason");
    }
    // No toca las definiciones compartidas.
    expect((TOOL_DEFS[0]?.parameters as { properties: Record<string, unknown> }).properties).not.toHaveProperty("say");
  });

  it("parseToolArgs entrega lo que dice tal cual, con solo limpieza técnica", () => {
    expect(parseToolArgs({}).say).toBeNull();
    expect(parseToolArgs({ say: "   " }).say).toBeNull();
    expect(parseToolArgs({ say: 42 }).say).toBeNull();
    // Los saltos de línea y los espacios internos son del agente: no se tocan.
    expect(parseToolArgs({ say: "  hagamos\n una   tregua " }).say).toBe("hagamos\n una   tregua");
    expect(parseToolArgs({ say: "a".repeat(1000) }).say).toHaveLength(MAX_AGENT_MESSAGE_LENGTH);
  });

  it("la descripción de say explica los turnos para hablar, sin pedir un estilo", () => {
    const [def] = kitToolDefs(KITS.classic, "chat");
    const say = (def?.parameters as { properties: Record<string, { description: string }> }).properties["say"];
    expect(say?.description).toContain(String(MAX_AGENT_MESSAGE_LENGTH));
    expect(say?.description).toContain("tal cual");
    expect(say?.description).not.toContain("normalmente una frase");
    expect(say?.description).toContain("se pronuncia por turnos");
    expect(say?.description).toContain("reemplaza al que esperaba");
    expect(say?.description).not.toContain("sayCooldown");
    expect(say?.description).not.toContain("pausa");
  });
});

describe("escudo, agua y lava", () => {
  it("se ofrecen solo si el kit trae el ítem", () => {
    const { kit } = buildCustomKit({
      items: [{ item: "shield" }, { item: "water_bucket" }, { item: "lava_bucket" }, { item: "cobblestone", count: 128 }],
    });
    expect(kitToolNames(kit)).toEqual(["approach", "attack", "retreat", "move", "build", "dig", "shield", "water", "lava", "wait"]);
    for (const k of KIT_LIST) {
      for (const tool of ["water", "lava"] as const) expect(kitToolNames(k)).not.toContain(tool);
      // De los kits fijos, solo el Tanque trae escudo.
      expect(kitToolNames(k).includes("shield")).toBe(k.id === "tank");
    }
  });

  it("parseToolArgs conserva el plano y valida coordenadas libres sin inventarlas", () => {
    const blocks = [{ x: 1, y: 65, z: 2, material: "oak_planks" }];
    expect(parseToolArgs({ blocks }).blocks).toBe(blocks);
    expect(parseToolArgs({ position: { x: 2, y: 65, z: 3 } }).position).toEqual({ x: 2, y: 65, z: 3 });
    expect(parseToolArgs({ position: { x: "2", y: 65, z: 3 } }).positionInvalid).toBe(true);
    expect(parseToolArgs({ position: null }).positionInvalid).toBe(true);
    expect(parseToolArgs({}).positionInvalid).toBe(false);
    expect(parseToolArgs({ where: "feet" }).where).toBe("feet");
  });

});

describe("dig", () => {
  it("se ofrece siempre y elige entre lo que hay en medio y lo más cercano", () => {
    for (const kit of KIT_LIST) expect(kitToolNames(kit)).toContain("dig");
    const dig = TOOL_DEFS.find((def) => def.name === "dig");
    const properties = dig?.parameters["properties"] as Record<string, { enum?: string[] }>;
    expect(properties["target"]?.enum).toEqual(["between", "nearest"]);
    expect(dig?.description).toContain("nunca el piso ni la pared y el techo invisibles");
  });

  it("parseToolArgs: digTarget", () => {
    expect(parseToolArgs({}).digTarget).toBe("between");
    expect(parseToolArgs({ target: "nearest" }).digTarget).toBe("nearest");
    expect(parseToolArgs({ target: "away" }).digTarget).toBe("between");
  });
});

describe("move, pociones y elecciones", () => {
  it("move se ofrece siempre; drink y throw solo con pociones de su tipo", () => {
    for (const kit of KIT_LIST) expect(kitToolNames(kit)).toContain("move");
    const { kit } = buildCustomKit({
      items: [
        { item: "potion", potion: "healing", count: 2 },
        { item: "splash_potion", potion: "harming" },
      ],
    });
    expect(kitToolNames(kit)).toEqual(expect.arrayContaining(["drink", "throw"]));
    expect(kitToolNames(KITS.classic)).not.toContain("drink");
  });

  it("parseToolArgs: estilos, distancia, lugar, arma, comida, poción y escudo", () => {
    const def = parseToolArgs({});
    expect(def).toMatchObject({ style: "strafe", distance: 8, place: "center", weapon: null, guard: false, food: null, potion: null, at: "rival" });
    expect(parseToolArgs({ style: "keep", distance: 50 }).distance).toBe(16);
    expect(parseToolArgs({ style: "keep", distance: "3" }).distance).toBe(3);
    expect(parseToolArgs({ style: "volar" }).style).toBe("strafe");
    expect(parseToolArgs({ place: "far_corner" }).place).toBe("far_corner");
    expect(parseToolArgs({ weapon: "minecraft:Diamond_Axe" }).weapon).toBe("diamond_axe");
    expect(parseToolArgs({ weapon: "espada; rm -rf" }).weapon).toBeNull();
    expect(parseToolArgs({ food: "golden_apple" }).food).toBe("golden_apple");
    expect(parseToolArgs({ potion: "splash_potion:harming" }).potion).toBe("harming");
    expect(parseToolArgs({ guard: true }).guard).toBe(true);
    expect(parseToolArgs({ crit: true }).crit).toBe(true);
    expect(parseToolArgs({ crit: "true" }).crit).toBe(true);
    expect(parseToolArgs({}).crit).toBe(false);
    expect(parseToolArgs({ guard: "true" }).guard).toBe(true);
    expect(parseToolArgs({ at: "self" })).toMatchObject({ at: "self" });
  });

  it("move y dig comparten coordenadas absolutas con el mapa", () => {
    for (const name of ["move", "dig"]) {
      const tool = TOOL_DEFS.find((def) => def.name === name);
      expect(tool?.parameters["properties"]).toHaveProperty("position");
    }
  });
});


describe("modo por rondas: surrender", () => {
  it("solo se ofrece con rondas, a todos los kits, y no es una acción del cuerpo", () => {
    for (const kit of KIT_LIST) {
      expect(kitToolDefs(kit).map((def) => def.name)).not.toContain(SURRENDER_TOOL);
      expect(kitToolDefs(kit, "chat").map((def) => def.name)).not.toContain(SURRENDER_TOOL);
      expect(kitToolDefs(kit, "none", true).map((def) => def.name)).toContain(SURRENDER_TOOL);
    }
    expect(isToolName(SURRENDER_TOOL)).toBe(false);
    expect([...TOOL_NAMES]).not.toContain(SURRENDER_TOOL);
  });

  it("dice solo lo que pasa y acepta reason (y say en modo chat)", () => {
    const def = kitToolDefs(KITS.classic, "none", true).find((d) => d.name === SURRENDER_TOOL);
    expect(def?.description).toBe("Te rindes en esta ronda: la ronda termina y la gana el otro agente.");
    expect(Object.keys((def?.parameters as { properties: object }).properties)).toEqual(["reason"]);
    const chat = kitToolDefs(KITS.classic, "chat", true).find((d) => d.name === SURRENDER_TOOL);
    expect(Object.keys((chat?.parameters as { properties: object }).properties)).toEqual(["reason", "say"]);
  });
});
