import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@phack/llm";
import { ARENA, KITS } from "@phack/protocol";
import { scanWorld } from "./spatial";
import { buildTurnMessages, MAX_HISTORY_MESSAGES, trimHistory } from "./history";
import { buildSystemPrompt } from "./prompt";
import { kitToolDefs } from "./tools";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export function arenaSnapshot() {
  const c = ARENA.center, edge = ARENA.radius + 1, top = c.y + ARENA.wallHeight;
  const bounds = { min: { x: c.x - edge, y: c.y, z: c.z - edge }, max: { x: c.x + edge, y: top + 1, z: c.z + edge } };
  return scanWorld(bounds, (p) => {
    const wall = Math.abs(p.x - c.x) === edge || Math.abs(p.z - c.z) === edge;
    const name = p.y === c.y ? "smooth_stone" : p.y === top + 1 ? "barrier" : wall ? "glass" : "air";
    return { name, solid: name !== "air" };
  }, () => false, { center: { x: c.x - 0.5, y: c.y + 1, z: c.z - 0.5 }, radius: 16 });
}

describe("regresión del contexto que se envía al modelo", () => {
  it("describe el recinto vacío sin miles de coordenadas repetidas", () => {
    expect(bytes(arenaSnapshot())).toBeLessThan(4000);
  });

  it("las llamadas sucesivas no acumulan snapshots completos en el historial", () => {
    const observation = { secondsElapsed: 1, health: 20, food: 20, position: { x: 0, y: 65, z: 0 }, inventory: { oak_planks: 16 }, currentAction: "wait", lastActionResult: "esperando", world: arenaSnapshot(), resources: [{ name: "oak_planks", count: 16, uses: [{ description: "material para construir" }] }] };
    const system = buildSystemPrompt({ side: "red", username: "Red", opponentUsername: "Blue", kit: KITS.builder, strategy: "Explora tu equipo", tickMs: 1500, durationSeconds: 120, comms: "none" });
    let history: ChatMessage[] = [];
    for (let tick = 0; tick < 10; tick++) {
      const json = JSON.stringify({ ...observation, secondsElapsed: tick });
      const request = { messages: [{ role: "system", content: system }, ...history, { role: "user", content: json }], tools: kitToolDefs(KITS.builder) };
      expect(bytes(request)).toBeLessThan(40_000);
      expect(history.filter((message) => message.role === "user").every((message) => !JSON.parse(message.content).world)).toBe(true);
      history = trimHistory([...history, ...buildTurnMessages(json, { text: "continúo", toolCalls: [] }, () => "")], MAX_HISTORY_MESSAGES);
    }
  });
});
