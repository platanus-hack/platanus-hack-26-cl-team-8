import { describe, expect, it } from "vitest";
import { buildObservation, summarizeInventory, type ObservationInput } from "./observation";

const base: ObservationInput = {
  now: 12_400,
  startedAt: 2_000,
  self: {
    position: { x: -8.04, y: 65, z: 0.26 },
    health: 17.5,
    food: 20,
    heldItem: "iron_sword",
    inventory: [
      { name: "iron_sword", count: 1 },
      { name: "arrow", count: 10 },
      { name: "arrow", count: 6 },
    ],
  },
  opponent: { position: { x: -4.04, y: 65, z: 3.26 }, health: 12.34 },
  arena: { center: { x: 0, y: 64, z: 0 }, radius: 12 },
  currentAction: "attack",
  lastActionResult: "atacando",
};

describe("buildObservation", () => {
  it("incluye los campos del contrato con el rival visible", () => {
    const obs = buildObservation(base);
    expect(obs.distance).toBe(5);
    expect(obs.health).toBe(17.5);
    expect(obs.opponentHealth).toBe(12.3);
    expect(obs.opponentVisible).toBe(true);
    expect(obs.opponentRelative).toEqual({ x: 4, y: 0, z: 3 });
    expect(obs.secondsElapsed).toBe(10);
    expect(obs.heldItem).toBe("iron_sword");
    expect(obs.inventory).toEqual({ iron_sword: 1, arrow: 16 });
    expect(obs.currentAction).toBe("attack");
  });

  it("usa null cuando el rival no está a la vista", () => {
    const obs = buildObservation({ ...base, opponent: null });
    expect(obs.distance).toBeNull();
    expect(obs.opponentHealth).toBeNull();
    expect(obs.opponentRelative).toBeNull();
    expect(obs.opponentVisible).toBe(false);
  });

  it("usa null si se ve al rival pero no se conoce su vida", () => {
    const obs = buildObservation({ ...base, opponent: { position: { x: 0, y: 65, z: 0 }, health: null } });
    expect(obs.distance).not.toBeNull();
    expect(obs.opponentHealth).toBeNull();
  });

  it("sobrevive a JSON.stringify con las claves que usa el LLM de prueba", () => {
    const parsed = JSON.parse(JSON.stringify(buildObservation(base))) as Record<string, unknown>;
    expect(typeof parsed["distance"]).toBe("number");
    expect(typeof parsed["health"]).toBe("number");
    expect(typeof parsed["opponentHealth"]).toBe("number");
  });
});

describe("summarizeInventory", () => {
  it("suma las pilas del mismo ítem", () => {
    expect(summarizeInventory([{ name: "bread", count: 2 }, { name: "bread", count: 3 }])).toEqual({ bread: 5 });
    expect(summarizeInventory([])).toEqual({});
  });
});
