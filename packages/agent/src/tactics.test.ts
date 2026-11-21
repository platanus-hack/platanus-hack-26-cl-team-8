import { describe, expect, it } from "vitest";
import { distanceXZ } from "./geometry";
import { keepDistanceTarget, orbitTarget, placeTarget, strafeTarget, type ArenaShape } from "./tactics";

const arena: ArenaShape = { center: { x: 0, y: 64, z: 0 }, radius: 12 };
const self = { x: -4, y: 65, z: 0 };
const rival = { x: 4, y: 65, z: 0 };

describe("strafeTarget", () => {
  it("da un paso perpendicular a la línea hacia el rival, sin acercarse", () => {
    const left = strafeTarget(self, rival, 1, arena);
    const right = strafeTarget(self, rival, -1, arena);
    expect(left.x).toBeCloseTo(-4);
    expect(right.x).toBeCloseTo(-4);
    expect(Math.sign(left.z)).toBe(-Math.sign(right.z));
    expect(Math.abs(left.z)).toBeCloseTo(3);
  });

  it("contra el muro esquiva hacia el otro lado", () => {
    const nearWall = { x: 0, y: 65, z: 10.2 };
    const opponent = { x: 6, y: 65, z: 10.2 };
    const target = strafeTarget(nearWall, opponent, 1, arena);
    expect(target.z).toBeLessThan(nearWall.z);
  });
});

describe("orbitTarget", () => {
  it("se mueve alrededor del rival conservando la distancia (entre 3 y 8)", () => {
    const target = orbitTarget(self, rival, 1, arena);
    expect(distanceXZ(target, rival)).toBeCloseTo(8, 0);
    expect(target.z).not.toBeCloseTo(0);
    const close = orbitTarget({ x: 3, y: 65, z: 0 }, rival, -1, arena);
    expect(distanceXZ(close, rival)).toBeCloseTo(3, 0);
  });
});

describe("keepDistanceTarget", () => {
  it("se acerca o se aleja hasta la distancia pedida, y null si ya está", () => {
    const closer = keepDistanceTarget(self, rival, 4, arena);
    expect(closer && distanceXZ(closer, rival)).toBeCloseTo(4);
    const farther = keepDistanceTarget({ x: 2, y: 65, z: 0 }, rival, 8, arena);
    expect(farther && farther.x).toBeLessThan(2);
    expect(keepDistanceTarget(self, rival, 8.5, arena)).toBeNull();
  });

  it("nunca sale de la arena", () => {
    const target = keepDistanceTarget({ x: -9, y: 65, z: 0 }, { x: -6, y: 65, z: 0 }, 15, arena);
    expect(target && distanceXZ(target, arena.center)).toBeLessThanOrEqual(10.5 + 1e-9);
  });
});

describe("placeTarget", () => {
  it("centro, esquina lejos del rival y detrás del rival", () => {
    expect(placeTarget("center", self, rival, arena)).toMatchObject({ x: 0, z: 0 });
    const corner = placeTarget("far_corner", self, rival, arena);
    expect(corner.x).toBeLessThan(0);
    const behind = placeTarget("behind_rival", self, rival, arena);
    expect(behind.x).toBeGreaterThan(rival.x);
    expect(placeTarget("behind_rival", self, null, arena)).toMatchObject({ x: 0, z: 0 });
  });
});
