import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolDef } from "@phack/llm";
import { jsonBytes, profileContext } from "./context-profile";

describe("perfil del contexto enviado", () => {
  it("separa observación actual, historial, instrucciones y herramientas", () => {
    const observation = { world: { regions: [[0, 64, 0, 12, 64, 12, 0, 0]] }, health: 20 };
    const messages: ChatMessage[] = [
      { role: "system", content: "Reglas y equipo" },
      { role: "user", content: '{"health":18}' },
      { role: "assistant", content: "sigo" },
      { role: "user", content: JSON.stringify(observation) },
    ];
    const tools: ToolDef[] = [{ name: "wait", description: "esperar", parameters: { type: "object" } }];
    const profile = profileContext(messages, tools);
    expect(profile.totalBytes).toBe(jsonBytes({ messages, tools }));
    expect(profile.historyBytes).toBe(jsonBytes(messages.slice(1, 3)));
    expect(profile.historyMessages).toBe(2);
    expect(profile.observationFields.world).toBe(jsonBytes(observation.world));
    expect(profile.observationFields.health).toBe(2);
    expect(profile).not.toHaveProperty("estimatedTokens");
  });

  it("tolera contexto vacío o un mensaje que no es JSON", () => {
    expect(profileContext([], []).observationBytes).toBe(0);
    expect(profileContext([{ role: "user", content: "hola" }], []).observationFields).toEqual({});
  });
});
