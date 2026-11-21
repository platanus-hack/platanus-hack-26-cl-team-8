import { describe, expect, it } from "vitest";
import { orbitPosition, pickAimTarget, smoothToward } from "./director";

const center = { x: 0, y: 64, z: 0 };

describe("pickAimTarget", () => {
  it("mira al centro si no hay peleadores", () => {
    expect(pickAimTarget([], center)).toEqual(center);
  });

  it("mira al punto medio entre los dos peleadores", () => {
    const target = pickAimTarget(
      [
        { x: -8, y: 65, z: 2 },
        { x: 4, y: 67, z: -6 },
      ],
      center,
    );
    expect(target).toEqual({ x: -2, y: 66, z: -2 });
  });

  it("con un solo peleador mira entre él y el centro", () => {
    expect(pickAimTarget([{ x: 8, y: 66, z: 4 }], center)).toEqual({ x: 4, y: 65, z: 2 });
  });
});

describe("smoothToward", () => {
  it("se acerca al objetivo sin pasarse", () => {
    const next = smoothToward({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0.1, 0.5);
    expect(next.x).toBeGreaterThan(0);
    expect(next.x).toBeLessThan(10);
  });

  it("salta directo al objetivo si tau es 0", () => {
    expect(smoothToward({ x: 0, y: 0, z: 0 }, { x: 10, y: 5, z: 1 }, 0.1, 0)).toEqual({ x: 10, y: 5, z: 1 });
  });
});

describe("orbitPosition", () => {
  const base = { x: 0, y: 78, z: -18 };

  it("queda fija si el periodo es 0", () => {
    expect(orbitPosition(base, center, 123, 0)).toEqual(base);
  });

  it("parte desde la posición base", () => {
    const pos = orbitPosition(base, center, 0, 60);
    expect(pos.x).toBeCloseTo(0, 6);
    expect(pos.y).toBe(78);
    expect(pos.z).toBeCloseTo(-18, 6);
  });

  it("a media vuelta queda al lado opuesto, misma altura y radio", () => {
    const pos = orbitPosition(base, center, 30, 60);
    expect(pos.x).toBeCloseTo(0, 6);
    expect(pos.y).toBe(78);
    expect(pos.z).toBeCloseTo(18, 6);
  });
});
