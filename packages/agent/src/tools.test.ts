import { describe, expect, it } from "vitest";
import { MOCK_TOOL_NAMES } from "@phack/llm";
import { KIT_LIST, KITS, type Kit } from "@phack/protocol";
import { isToolName, kitToolDefs, kitToolNames, parseToolArgs, TOOL_DEFS, TOOL_NAMES } from "./tools";

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
    expect(pearl?.description).toContain("Recarga de 5 segundos");
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

  it("parseToolArgs limpia y recorta lo que dice", () => {
    expect(parseToolArgs({}).say).toBeNull();
    expect(parseToolArgs({ say: "   " }).say).toBeNull();
    expect(parseToolArgs({ say: 42 }).say).toBeNull();
    expect(parseToolArgs({ say: "  hagamos\n una   tregua " }).say).toBe("hagamos una tregua");
    expect(parseToolArgs({ say: "a".repeat(1000) }).say).toHaveLength(240);
  });
});
