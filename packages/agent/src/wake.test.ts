import { describe, expect, it } from "vitest";
import { HearWake } from "./wake";

describe("HearWake", () => {
  it("un mensaje mientras el bucle duerme lo despierta ya", () => {
    const wake = new HearWake();
    expect(wake.heard()).toBe(true);
    wake.beginDecision();
    wake.endDecision();
    expect(wake.heard()).toBe(true);
  });

  it("un mensaje durante una decisión no despierta nada, pero la siguiente empieza sin dormir", () => {
    const wake = new HearWake();
    wake.beginDecision();
    expect(wake.heard()).toBe(false);
    expect(wake.heard()).toBe(false);
    // Varios mensajes en la misma decisión piden una sola decisión más.
    expect(wake.endDecision()).toBe(true);
    wake.beginDecision();
    expect(wake.endDecision()).toBe(false);
  });

  it("lo que llegó antes de empezar una decisión ya entra en ella", () => {
    const wake = new HearWake();
    wake.beginDecision();
    wake.heard();
    wake.endDecision();
    wake.beginDecision();
    expect(wake.endDecision()).toBe(false);
  });
});
