import { describe, expect, it } from "vitest";
import {
  ARROW_GRAVITY,
  ARROW_SPEED,
  computeAim,
  estimateVelocity,
  PEARL_LAUNCH_HEIGHT,
  PEARL_MAX_PITCH,
  PEARL_MIN_PITCH,
  pearlPitch,
  pearlRange,
} from "./aim";

const zero = { x: 0, y: 0, z: 0 };
const degrees = (value: number): number => (value * Math.PI) / 180;

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

  it("descarta el salto de un teletransporte (perla de ender)", () => {
    const before = { x: 0, y: 65, z: 0, at: 1000 };
    const after = { x: 9, y: 65, z: 0, at: 1100 };
    expect(estimateVelocity(before, after, { x: 4, y: 0, z: 0 })).toEqual(zero);
  });
});

describe("pearlRange", () => {
  // Valores de referencia de simular la perla tick a tick (1.5 b/tick, gravedad 0.03, roce 0.99).
  it("coincide con los alcances conocidos desde el suelo plano", () => {
    expect(Math.abs(pearlRange(degrees(-20), PEARL_LAUNCH_HEIGHT) - 3.96)).toBeLessThan(0.15);
    expect(Math.abs(pearlRange(degrees(-10), PEARL_LAUNCH_HEIGHT) - 7.03)).toBeLessThan(0.15);
    expect(Math.abs(pearlRange(0, PEARL_LAUNCH_HEIGHT) - 15.31)).toBeLessThan(0.15);
  });

  it("llega más lejos cuanto más alto se apunta", () => {
    const angles = [-60, -40, -20, -10, -4, 0, 3, 6];
    const ranges = angles.map((angle) => pearlRange(degrees(angle), PEARL_LAUNCH_HEIGHT));
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!).toBeGreaterThan(ranges[i - 1]!);
    }
  });

  it("llega más lejos si se lanza desde más alto", () => {
    expect(pearlRange(degrees(-10), 3)).toBeGreaterThan(pearlRange(degrees(-10), PEARL_LAUNCH_HEIGHT));
  });
});

describe("pearlPitch", () => {
  it("entrega el ángulo que hace caer la perla a la distancia pedida", () => {
    for (const distance of [3, 4, 6, 8, 11, 14, 18]) {
      const pitch = pearlPitch(distance, PEARL_LAUNCH_HEIGHT);
      expect(pearlRange(pitch, PEARL_LAUNCH_HEIGHT)).toBeCloseTo(distance, 2);
    }
  });

  it("apunta hacia abajo para distancias cortas y casi horizontal para las largas", () => {
    const near = pearlPitch(4, PEARL_LAUNCH_HEIGHT);
    const mid = pearlPitch(8, PEARL_LAUNCH_HEIGHT);
    const far = pearlPitch(15.31, PEARL_LAUNCH_HEIGHT);
    expect(near).toBeLessThan(mid);
    expect(mid).toBeLessThan(far);
    expect(Math.abs(near - degrees(-20))).toBeLessThan(degrees(1.5));
    expect(Math.abs(far)).toBeLessThan(degrees(0.5));
  });

  it("no apunta a los pies del rival: eso se quedaría corto", () => {
    // Mirar directo a un punto del suelo a 8 bloques es bajar la vista unos 10.8°.
    const direct = -Math.atan2(PEARL_LAUNCH_HEIGHT, 8);
    expect(pearlPitch(8, PEARL_LAUNCH_HEIGHT)).toBeGreaterThan(direct);
  });

  it("nunca sale de los límites de lanzamiento", () => {
    expect(pearlPitch(60, PEARL_LAUNCH_HEIGHT)).toBe(PEARL_MAX_PITCH);
    expect(pearlPitch(0, PEARL_LAUNCH_HEIGHT)).toBe(PEARL_MIN_PITCH);
    for (const distance of [0.2, 1, 5, 12, 21, 30, 100]) {
      const pitch = pearlPitch(distance, PEARL_LAUNCH_HEIGHT);
      expect(pitch).toBeGreaterThanOrEqual(PEARL_MIN_PITCH);
      expect(pitch).toBeLessThanOrEqual(PEARL_MAX_PITCH);
    }
  });
});
