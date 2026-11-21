import { describe, expect, it } from "vitest";
import { KIT_LIST, KITS } from "@phack/protocol";
import { knowledgeFor, knowledgeSection, parseKnowledge, pvpKnowledge } from "./knowledge";
import { buildSystemPrompt } from "./prompt";
import { TOOL_NAMES } from "./tools";

const titles = (kit: (typeof KIT_LIST)[number]): string[] => knowledgeFor(kit).map((s) => s.title);

describe("conocimiento de PvP", () => {
  it("parte el documento en secciones con sus requisitos", () => {
    const sections = parseKnowledge(
      "<!--\ncabecera\n-->\n\n## General\n- uno\n- dos\n\n## Escudo\n<!-- requiere: shield, attack -->\n- tres\n",
    );
    expect(sections).toEqual([
      { title: "General", requires: [], lines: ["- uno", "- dos"] },
      { title: "Escudo", requires: ["shield", "attack"], lines: ["- tres"] },
    ]);
  });

  it("el documento real tiene secciones, viñetas y solo herramientas que existen", () => {
    const sections = pvpKnowledge();
    expect(sections.length).toBeGreaterThan(5);
    for (const section of sections) {
      expect(section.lines.length).toBeGreaterThan(0);
      for (const line of section.lines) expect(line.startsWith("- ")).toBe(true);
      for (const tool of section.requires) expect(TOOL_NAMES).toContain(tool);
    }
  });

  it("filtra las secciones según las herramientas del kit", () => {
    const tank = titles(KITS.tank);
    expect(tank).toContain("Escudo");
    expect(tank).not.toContain("Arco y flechas");
    expect(tank).not.toContain("Perlas de ender");

    const classic = titles(KITS.classic);
    expect(classic).toContain("Arco y flechas");
    expect(classic).toContain("Golpes críticos");
    expect(classic).not.toContain("Escudo");
    expect(classic).not.toContain("Lava");

    expect(titles(KITS.ender)).toContain("Perlas de ender");
  });

  it("va en el prompt antes de COMUNICACIÓN, sin líneas en blanco adentro", () => {
    for (const kit of KIT_LIST) {
      const prompt = buildSystemPrompt({
        side: "blue",
        username: "A",
        opponentUsername: "B",
        kit,
        strategy: "",
        tickMs: 1500,
        durationSeconds: 120,
        comms: "none",
      });
      const block = knowledgeSection(kit).join("\n");
      expect(prompt).toContain(`\n\n${block}\n\nCOMUNICACIÓN`);
      expect(block).toContain("no órdenes");
    }
  });
});
