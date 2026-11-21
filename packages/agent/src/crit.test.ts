import { describe, expect, it } from "vitest";
import { CRIT_JUMP_LEAD_MS, CRIT_MAX_WAIT_MS, critStep, type CritInput } from "./crit";

const base: CritInput = { now: 10_000, readyAt: 10_000, dist: 2.5, reach: 3.2, onGround: true, vy: 0, inWater: false, lastJumpAt: 0 };

describe("critStep", () => {
  it("salta un poco antes de que el arma recargue, no antes", () => {
    expect(critStep({ ...base, readyAt: base.now + CRIT_JUMP_LEAD_MS })).toEqual({ action: "jump" });
    expect(critStep({ ...base, readyAt: base.now + CRIT_JUMP_LEAD_MS + 100 })).toEqual({ action: "wait" });
  });

  it("en el aire pega solo cayendo y con el arma lista", () => {
    expect(critStep({ ...base, onGround: false, vy: 0.2 })).toEqual({ action: "wait" });
    expect(critStep({ ...base, onGround: false, vy: -0.1 })).toEqual({ action: "hit", crit: true });
    expect(critStep({ ...base, onGround: false, vy: -0.1, readyAt: base.now + 50 })).toEqual({ action: "wait" });
    expect(critStep({ ...base, onGround: false, vy: -0.1, dist: 4 })).toEqual({ action: "wait" });
  });

  it("no vuelve a saltar mientras dura el salto anterior", () => {
    expect(critStep({ ...base, lastJumpAt: base.now - 100 })).toEqual({ action: "wait" });
  });

  it("si la caída no llega a tiempo, pega normal para no perder el ritmo", () => {
    expect(critStep({ ...base, readyAt: base.now - CRIT_MAX_WAIT_MS, lastJumpAt: base.now - 100 })).toEqual({ action: "hit", crit: false });
  });

  it("en el agua no salta: pega normal", () => {
    expect(critStep({ ...base, inWater: true })).toEqual({ action: "hit", crit: false });
    expect(critStep({ ...base, inWater: true, readyAt: base.now + 100 })).toEqual({ action: "wait" });
  });

  it("con el rival lejos no salta", () => {
    expect(critStep({ ...base, dist: 6 })).toEqual({ action: "wait" });
  });
});
