import { describe, expect, it } from "vitest";
import { KIT_LIST, kitItemTitle, KITS, type Kit } from "@phack/protocol";
import { buildSystemPrompt } from "./prompt";
import { kitToolNames, TOOL_NAMES } from "./tools";

function promptFor(kit: Kit, strategy = "Pega fuerte y no retrocedas."): string {
  return buildSystemPrompt({
    side: "red",
    username: "AgenteRojo",
    opponentUsername: "AgenteAzul",
    kit,
    strategy,
    tickMs: 1500,
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
    expect(first).toContain('Eres "AgenteRojo", el luchador rojo');
    expect(first).toContain('Tu rival es "AgenteAzul".');
    expect(prompt).toContain("Decides aproximadamente cada 1.5 segundos");
  });

  it("deja la estrategia del usuario al final, entre etiquetas en líneas propias", () => {
    const lines = promptFor(KITS.classic, "  Dispara de lejos.  ").split("\n");
    expect(lines.slice(-3)).toEqual(["<estrategia>", "Dispara de lejos.", "</estrategia>"]);
    const empty = promptFor(KITS.classic, "   ").split("\n");
    expect(empty.slice(-3)).toEqual(["<estrategia>", "(sin estrategia: pelea como mejor te parezca)", "</estrategia>"]);
  });

  it("lista en HERRAMIENTAS exactamente las herramientas del kit", () => {
    for (const kit of KIT_LIST) {
      const lines = section(promptFor(kit), "HERRAMIENTAS");
      const listed = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2, line.indexOf(":")));
      expect(listed).toEqual(kitToolNames(kit));
    }
  });

  it("con el kit clásico ofrece las seis herramientas de siempre", () => {
    const lines = section(promptFor(KITS.classic), "HERRAMIENTAS");
    expect(lines).toEqual([
      "- approach: caminar hacia el rival.",
      "- attack: cuerpo a cuerpo con la espada; solo golpea a menos de ~3 bloques, así que te acerca solo.",
      "- retreat: alejarte del rival dentro de la arena.",
      "- shoot: disparar con el arco (necesita flechas); funciona mejor a más de 5 bloques.",
      "- eat: comer para recuperar hambre y vida; te deja quieto unos 2 segundos.",
      "- wait: quedarte quieto.",
      'Todas aceptan un argumento opcional "reason": una frase corta en español explicando tu decisión (el público la ve en vivo).',
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
    expect(berserker).toContain("- attack: tu arma es Hacha de diamante; da un golpe cada ~1.1 s.");
    const classic = section(promptFor(KITS.classic), "TU KIT").join("\n");
    expect(classic).toContain("- attack: tu arma es Espada de hierro; da un golpe cada ~0.7 s.");
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
});
