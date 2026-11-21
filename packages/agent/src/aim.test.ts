import { describe, expect, it } from "vitest";
import { ARROW_GRAVITY, ARROW_SPEED, computeAim, estimateVelocity } from "./aim";

const zero = { x: 0, y: 0, z: 0 };

describe("computeAim", () => {
  it("sube la mira para compensar la gravedad", () => {
    const aim = computeAim({ from: zero, target: { x: 20, y: 0, z: 0 }, targetVelocity: zero });
    const time = 20 / ARROW_SPEED;
    expect(aim.x).toBeCloseTo(20);
    expect(aim.z).toBeCloseTo(0);
    expect(aim.y).toBeCloseTo(0.5 * ARROW_GRAVITY * time * time, 5);
    expect(aim.y).toBeGreaterThan(1);
  });

  it("casi no compensa a quemarropa", () => {
    const aim = computeAim({ from: zero, target: { x: 3, y: 0, z: 0 }, targetVelocity: zero });
    expect(aim.y).toBeLessThan(0.1);
  });

  it("adelanta el tiro cuando el rival se mueve", () => {
    const aim = computeAim({ from: zero, target: { x: 20, y: 0, z: 0 }, targetVelocity: { x: 0, y: 0, z: 5 } });
    expect(aim.z).toBeGreaterThan(1.5);
    expect(aim.z).toBeLessThan(2);
    expect(aim.x).toBeCloseTo(20);
  });

  it("ignora la velocidad vertical del rival", () => {
    const still = computeAim({ from: zero, target: { x: 10, y: 0, z: 0 }, targetVelocity: zero });
    const jumping = computeAim({ from: zero, target: { x: 10, y: 0, z: 0 }, targetVelocity: { x: 0, y: 8, z: 0 } });
    expect(jumping).toEqual(still);
  });
});

describe("estimateVelocity", () => {
  it("devuelve cero sin muestra previa", () => {
    expect(estimateVelocity(null, { x: 1, y: 0, z: 0, at: 1000 }, zero)).toEqual(zero);
  });

  it("promedia la velocidad nueva con la anterior", () => {
    const velocity = estimateVelocity({ x: 0, y: 0, z: 0, at: 1000 }, { x: 1, y: 0, z: 0, at: 1100 }, zero);
    expect(velocity.x).toBeCloseTo(5);
    expect(velocity.z).toBeCloseTo(0);
  });

  it("descarta muestras demasiado separadas", () => {
    expect(estimateVelocity({ x: 0, y: 0, z: 0, at: 0 }, { x: 9, y: 0, z: 0, at: 5000 }, { x: 3, y: 0, z: 0 })).toEqual(zero);
  });
});
