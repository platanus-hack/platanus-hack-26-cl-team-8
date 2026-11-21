import { describe, expect, it } from "vitest";
import { clampToArena, distanceToWall, distanceXZ, retreatTarget, round1 } from "./geometry";

const center = { x: 0, y: 64, z: 0 };
const radius = 12;

describe("geometry", () => {
  it("redondea a un decimal", () => {
    expect(round1(3.14159)).toBe(3.1);
    expect(round1(2.96)).toBe(3);
  });

  it("mide distancia horizontal ignorando la altura", () => {
    expect(distanceXZ({ x: 0, y: 0, z: 0 }, { x: 3, y: 50, z: 4 })).toBe(5);
  });

  it("no mueve puntos que ya están dentro de la arena", () => {
    expect(clampToArena({ x: 3, y: 65, z: -4 }, center, 10)).toEqual({ x: 3, y: 65, z: -4 });
  });

  it("trae al borde los puntos que quedan fuera", () => {
    const clamped = clampToArena({ x: 30, y: 65, z: 0 }, center, 10);
    expect(clamped.x).toBeCloseTo(10);
    expect(clamped.z).toBeCloseTo(0);
    expect(clamped.y).toBe(65);
  });

  it("calcula la distancia al muro", () => {
    expect(distanceToWall({ x: 8, y: 65, z: 0 }, center, radius)).toBe(4);
    expect(distanceToWall({ x: 20, y: 65, z: 0 }, center, radius)).toBe(0);
  });

  it("se retira en línea recta alejándose del rival", () => {
    const target = retreatTarget({
      self: { x: 0, y: 65, z: 0 },
      opponent: { x: 5, y: 65, z: 0 },
      center,
      radius,
    });
    expect(target.x).toBeCloseTo(-8);
    expect(target.z).toBeCloseTo(0);
  });

  it("nunca entrega un punto fuera de la arena", () => {
    const target = retreatTarget({
      self: { x: -6, y: 65, z: 0 },
      opponent: { x: 0, y: 65, z: 0 },
      center,
      radius,
    });
    expect(distanceXZ(target, center)).toBeLessThanOrEqual(radius - 1.5 + 1e-9);
    expect(target.x).toBeCloseTo(-10.5);
  });

  it("acorralado contra el muro se desliza por el borde", () => {
    const self = { x: -10.5, y: 65, z: 0 };
    const target = retreatTarget({ self, opponent: { x: -5, y: 65, z: 0 }, center, radius });
    expect(distanceXZ(target, center)).toBeCloseTo(10.5);
    expect(Math.abs(target.z)).toBeGreaterThan(5);
    expect(distanceXZ(target, self)).toBeGreaterThan(2);
  });

  it("acorralado elige el lado más lejano del rival", () => {
    const self = { x: -10.5, y: 65, z: 0 };
    const target = retreatTarget({ self, opponent: { x: -8, y: 65, z: 3 }, center, radius });
    expect(target.z).toBeLessThan(0);
  });

  it("si está encima del rival igual entrega un punto válido", () => {
    const target = retreatTarget({
      self: { x: 0, y: 65, z: 0 },
      opponent: { x: 0, y: 65, z: 0 },
      center,
      radius,
    });
    expect(Number.isFinite(target.x)).toBe(true);
    expect(Number.isFinite(target.z)).toBe(true);
    expect(distanceXZ(target, center)).toBeLessThanOrEqual(radius);
  });

  it("con un paso largo cruza la arena sin salirse (escape con perla)", () => {
    const target = retreatTarget({
      self: { x: 6, y: 65, z: 0 },
      opponent: { x: 8, y: 65, z: 0 },
      center,
      radius,
      step: 12,
    });
    expect(target.x).toBeCloseTo(-6);
    expect(target.z).toBeCloseTo(0);
    expect(distanceXZ(target, center)).toBeLessThanOrEqual(radius - 1.5 + 1e-9);
  });
});
