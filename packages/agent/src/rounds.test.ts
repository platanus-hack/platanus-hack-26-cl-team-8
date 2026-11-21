import { describe, expect, it } from "vitest";
import { ActionPlan } from "./plan";
import { RoundGate, seriesObservation } from "./rounds";

describe("RoundGate", () => {
  it("una respuesta que llega en pausa no se ejecuta", () => {
    const gate = new RoundGate();
    const ticket = gate.ticket();
    expect(gate.accepts(ticket)).toBe(true);
    gate.pause(new ActionPlan());
    expect(gate.isPaused).toBe(true);
    expect(gate.accepts(ticket)).toBe(false);
    expect(gate.accepts(gate.ticket())).toBe(false);
  });

  it("una respuesta pedida antes de la pausa tampoco se ejecuta después de reanudar", () => {
    const gate = new RoundGate();
    const before = gate.ticket();
    gate.pause(new ActionPlan());
    gate.resume();
    expect(gate.isPaused).toBe(false);
    expect(gate.accepts(before)).toBe(false);
    expect(gate.accepts(gate.ticket())).toBe(true);
  });

  it("al pausar, la cola queda vacía", () => {
    const plan = new ActionPlan();
    plan.replace([
      { name: "attack", args: {} },
      { name: "eat", args: {} },
    ]);
    expect(plan.hasNext()).toBe(true);
    new RoundGate().pause(plan);
    expect(plan.hasNext()).toBe(false);
    expect(plan.pending()).toEqual([]);
  });
});

describe("seriesObservation", () => {
  it("nombra los campos como los ve el LLM", () => {
    expect(seriesObservation({ round: 2, won: 1, lost: 0, drawn: 0, maxRounds: 5 })).toEqual({
      round: 2,
      maxRounds: 5,
      roundsWon: 1,
      roundsLost: 0,
      roundsDrawn: 0,
    });
  });
});
