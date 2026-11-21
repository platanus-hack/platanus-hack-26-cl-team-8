import type { ToolDef } from "@phack/llm";

export const TOOL_NAMES = ["approach", "attack", "retreat", "shoot", "eat", "wait"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

const reasonProperty = {
  type: "string",
  description: "Explicación breve (una frase) de por qué eliges esta acción.",
};

function simpleTool(name: ToolName, description: string): ToolDef {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: { reason: reasonProperty },
      required: [],
    },
  };
}

export const TOOL_DEFS: ToolDef[] = [
  simpleTool("approach", "Camina hacia el rival hasta quedar a unos 2 bloques, sin atacar."),
  {
    name: "attack",
    description:
      "Ataque cuerpo a cuerpo: equipa la espada, persigue al rival y lo golpea respetando el tiempo de recarga. Sigue atacando hasta tu próxima decisión (o por 'seconds' segundos).",
    parameters: {
      type: "object",
      properties: {
        reason: reasonProperty,
        seconds: {
          type: "number",
          description: "Opcional: cuántos segundos atacar antes de quedar en espera.",
        },
      },
      required: [],
    },
  },
  simpleTool("retreat", "Aléjate del rival manteniéndote dentro de la arena."),
  simpleTool(
    "shoot",
    "Dispara con el arco: te detienes, apuntas, cargas cerca de 1 segundo y sueltas. Sigue disparando hasta tu próxima decisión. Necesita arco y flechas.",
  ),
  simpleTool(
    "eat",
    "Come lo que tengas en el inventario para recuperar hambre y vida. Tarda cerca de 2 segundos y te deja quieto.",
  ),
  simpleTool("wait", "Quédate quieto mirando al rival."),
];

export type ParsedToolArgs = { reason: string | null; seconds: number | null };

/** Extrae los argumentos conocidos tolerando cualquier basura que mande el LLM. */
export function parseToolArgs(args: Record<string, unknown> | null | undefined): ParsedToolArgs {
  const source = args ?? {};
  const rawReason = source["reason"];
  const reason = typeof rawReason === "string" && rawReason.trim().length > 0 ? rawReason.trim() : null;
  const rawSeconds = source["seconds"];
  const numeric = typeof rawSeconds === "string" ? Number(rawSeconds) : rawSeconds;
  const seconds =
    typeof numeric === "number" && Number.isFinite(numeric) && numeric > 0 ? Math.min(numeric, 60) : null;
  return { reason, seconds };
}
