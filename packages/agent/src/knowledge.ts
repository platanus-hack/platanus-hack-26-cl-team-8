import { readFileSync } from "node:fs";
import type { Kit } from "@phack/protocol";
import { kitToolNames } from "./tools";

/**
 * Conocimiento de PvP que va en el prompt de sistema. El texto vive en knowledge/pvp.md
 * (un documento que se edita como tal); aquí se lee y se filtra según el kit, para que un
 * agente sin escudo no cargue la sección del escudo.
 */
export type KnowledgeSection = {
  title: string;
  /** Herramientas que activan la sección (basta una). Vacío = llega siempre. */
  requires: string[];
  lines: string[];
};

const REQUIRES = /^<!--\s*requiere:\s*(.+?)\s*-->$/;

/** Parte el markdown en secciones "## Título"; ignora el comentario de cabecera. */
export function parseKnowledge(markdown: string): KnowledgeSection[] {
  const withoutHeader = markdown.replace(/^\s*<!--[\s\S]*?-->/, "");
  const sections: KnowledgeSection[] = [];
  let current: KnowledgeSection | null = null;
  for (const raw of withoutHeader.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      current = { title: line.slice(3).trim(), requires: [], lines: [] };
      sections.push(current);
      continue;
    }
    if (!current || line.trim() === "") continue;
    const requires = REQUIRES.exec(line.trim());
    if (requires) {
      current.requires = (requires[1] as string).split(",").map((tool) => tool.trim()).filter(Boolean);
      continue;
    }
    current.lines.push(line);
  }
  return sections;
}

let cached: KnowledgeSection[] | null = null;

/** Secciones de knowledge/pvp.md, leídas una sola vez. */
export function pvpKnowledge(): KnowledgeSection[] {
  cached ??= parseKnowledge(readFileSync(new URL("./knowledge/pvp.md", import.meta.url), "utf8"));
  return cached;
}

/** Secciones que le sirven a este kit: las generales y las de herramientas que tiene. */
export function knowledgeFor(kit: Kit, sections: readonly KnowledgeSection[] = pvpKnowledge()): KnowledgeSection[] {
  const tools = new Set<string>(kitToolNames(kit));
  return sections.filter((s) => s.requires.length === 0 || s.requires.some((tool) => tools.has(tool)));
}

/** Líneas de la sección CONOCIMIENTO DE PVP del prompt (sin líneas en blanco). */
export function knowledgeSection(kit: Kit): string[] {
  const sections = knowledgeFor(kit);
  if (sections.length === 0) return [];
  return [
    "CONOCIMIENTO DE PVP",
    "Lo que sigue es saber de combate de Minecraft, adaptado a tus herramientas. Son principios y datos para decidir mejor, no órdenes: tus instrucciones mandan sobre cómo usarlos.",
    ...sections.flatMap((s) => [`[${s.title}]`, ...s.lines]),
  ];
}
