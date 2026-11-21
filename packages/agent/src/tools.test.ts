import { describe, expect, it } from "vitest";
import { MOCK_TOOL_NAMES } from "@phack/llm";
import { KIT_LIST, KITS, type Kit } from "@phack/protocol";
import {
  eatRefusal,
  isToolName,
  kitToolDefs,
  kitToolNames,
  parseToolArgs,
  refusalText,
  shootRefusal,
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

  it("pearl exige elegir dónde caer y build no tiene argumentos propios", () => {
    const pearl = TOOL_DEFS.find((def) => def.name === "pearl");
    expect(pearl?.parameters["required"]).toEqual(["target"]);
    const properties = pearl?.parameters["properties"] as Record<string, { enum?: string[] }>;
    expect(properties["target"]?.enum).toEqual(["rival", "away"]);

    const build = TOOL_DEFS.find((def) => def.name === "build");
    expect(Object.keys(build?.parameters["properties"] as Record<string, unknown>)).toEqual(["reason"]);
    expect(build?.description).toContain("muro de 3 de ancho y 2 de alto");
    expect(build?.description).toContain("Gasta hasta 6 bloques");
    expect(build?.description).toContain("Recarga de 4 segundos");
    expect(build?.description).toContain("rival a 4.5 bloques o más");
    expect(pearl?.description).toContain("Recarga de 5 segundos");
  });

  it("eat avisa que los corazones amarillos de la manzana dorada no se acumulan", () => {
    const eat = TOOL_DEFS.find((def) => def.name === "eat");
    expect(eat?.description).toContain("corazones amarillos, que no se acumulan");
    expect(eat?.description).toContain("no comas otra mientras tengas corazones amarillos");
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
  const base = ["approach", "attack", "retreat"];

  it("ofrece a cada kit solo lo que sus ítems permiten", () => {
    expect(kitToolNames(KITS.classic)).toEqual([...base, "shoot", "eat", "wait"]);
    expect(kitToolNames(KITS.archer)).toEqual([...base, "shoot", "eat", "wait"]);
    expect(kitToolNames(KITS.tank)).toEqual([...base, "eat", "wait"]);
    expect(kitToolNames(KITS.berserker)).toEqual([...base, "eat", "wait"]);
    expect(kitToolNames(KITS.ender)).toEqual([...base, "eat", "pearl", "wait"]);
    expect(kitToolNames(KITS.builder)).toEqual([...base, "shoot", "eat", "build", "wait"]);
  });

  it("no ofrece disparar si falta el arco o faltan las flechas", () => {
    const withoutArrows: Kit = { ...KITS.classic, items: KITS.classic.items.filter((i) => i.item !== "arrow") };
    const withoutBow: Kit = { ...KITS.classic, items: KITS.classic.items.filter((i) => i.item !== "bow") };
    expect(kitToolNames(withoutArrows)).not.toContain("shoot");
    expect(kitToolNames(withoutBow)).not.toContain("shoot");
  });

  it("un kit sin ítems igual puede moverse, pegar y esperar", () => {
    const empty: Kit = { ...KITS.classic, items: [] };
    expect(kitToolNames(empty)).toEqual([...base, "wait"]);
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

  it("el kit clásico no ve la perla ni el muro", () => {
    const names = kitToolDefs(KITS.classic).map((def) => def.name);
    expect(names).not.toContain("pearl");
    expect(names).not.toContain("build");
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
