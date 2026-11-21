import { describe, expect, it } from "vitest";
import { lineOfSight, scanWorld } from "./spatial";

const bounds = { min: { x: -30, y: 64, z: -30 }, max: { x: 30, y: 71, z: 30 } };
const air = { name: "air", solid: false };

describe("observación espacial por radio", () => {
  it("incluye la altura completa y el borde del radio sin leer el resto del mapa", () => {
    const read: { x: number; y: number; z: number }[] = [];
    const snapshot = scanWorld(bounds, (p) => { read.push(p); return { name: p.y === 64 ? "smooth_stone" : "air", solid: p.y === 64 }; }, () => false, { center: { x: 0, y: 65, z: 0 }, radius: 16 });
    expect(read.some((p) => p.x === 16 && p.z === 0 && p.y === 71)).toBe(true);
    expect(read.every((p) => Math.hypot(p.x, p.z) <= 16)).toBe(true);
    expect(snapshot.bounds).toEqual({ min: { x: -16, y: 64, z: -16 }, max: { x: 16, y: 71, z: 16 } });
    expect(snapshot.coverage.radius).toBe(16);
    expect(snapshot.encoding).toContain("fuera de cobertura no se ha observado");
  });

  it("el radio se mueve con el agente y queda recortado por la arena", () => {
    const snapshot = scanWorld(bounds, () => air, () => false, { center: { x: 28, y: 68, z: 28 }, radius: 16 });
    expect(snapshot.bounds.min.x).toBe(12);
    expect(snapshot.bounds.max.x).toBe(30);
    expect(snapshot.coverage.center).toEqual({ x: 28, y: 68, z: 28 });
  });

  it("distingue desconocido, aire, peligros y bloques protegidos por posición", () => {
    const local = { min: { x: 0, y: 64, z: 0 }, max: { x: 4, y: 64, z: 0 } };
    const cells = [null, air, { name: "lava", solid: false }, { name: "oak_planks", solid: true }, { name: "oak_planks", solid: true }];
    const snapshot = scanWorld(local, (p) => cells[p.x] ?? null, (p) => p.x === 4, { center: { x: 0, y: 65, z: 0 }, radius: 16 });
    expect(snapshot.unknown).toEqual([[0, 64, 0]]);
    expect(snapshot.blocks).toEqual([[2, 64, 0, "lava"], [3, 64, 0, "oak_planks"], [4, 64, 0, "oak_planks"]]);
    expect(snapshot.materials.lava).toEqual({ solid: false, hazard: true });
    expect(snapshot.breakable).toEqual([[4, 64, 0]]);
  });

  it("la ubicación de una entidad no implica línea de visión a través de obstáculos", () => {
    const from = { x: 0.5, y: 66.5, z: 0.5 }, to = { x: 8.5, y: 66.5, z: 0.5 };
    expect(lineOfSight(from, to, () => air)).toBe(true);
    expect(lineOfSight(from, to, (p) => p.x === 4 ? { name: "oak_planks", solid: true } : air)).toBe(false);
    expect(lineOfSight(from, to, (p) => p.x === 4 ? null : air)).toBe(false);
  });
});
