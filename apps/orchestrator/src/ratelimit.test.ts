import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./ratelimit";

describe("createRateLimiter", () => {
  it("permite hasta el límite y luego bloquea", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => 0 });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("a")).toBe(false);
  });

  it("cuenta cada clave por separado", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(false);
  });

  it("vuelve a permitir cuando pasa la ventana", () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    expect(limiter.allow("a")).toBe(true);
    t = 999;
    expect(limiter.allow("a")).toBe(false);
    t = 1000;
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
  });

  it("prune borra solo las ventanas vencidas", () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, now: () => t });
    limiter.allow("vieja");
    t = 600;
    limiter.allow("nueva");
    t = 1100;
    limiter.prune();
    expect(limiter.size()).toBe(1);
    t = 1700;
    limiter.prune();
    expect(limiter.size()).toBe(0);
  });
});
