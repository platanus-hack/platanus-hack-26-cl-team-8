import { describe, expect, it } from "vitest";
import { lineOfSight, scanWorld, packWorld, type SpatialSnapshot, type RawSpatialSnapshot } from "./spatial";

const bounds = { min: { x: -30, y: 64, z: -30 }, max: { x: 30, y: 71, z: 30 } };
const air = { name: "air", solid: false };

function expand(snapshot: SpatialSnapshot) {
  const blocks: [number, number, number, string][] = [];
  const breakable: [number, number, number][] = [];
  const unknown: [number, number, number][] = [];
  for (const [x0, y0, z0, x1, y1, z1, index, editable] of snapshot.regions) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      blocks.push([x, y, z, snapshot.palette[index]!.name]);
      if (editable) breakable.push([x, y, z]);
    }
  }
  for (const [x0, y0, z0, x1, y1, z1] of snapshot.unknown) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) unknown.push([x, y, z]);
  }
  return { blocks, breakable, unknown };
}

describe("observación espacial por radio", () => {
  it("incluye la altura completa y el borde del radio sin leer el resto del mapa", () => {
    const read: { x: number; y: number; z: number }[] = [];
    const snapshot = scanWorld(bounds, (p) => { read.push(p); return { name: p.y === 64 ? "smooth_stone" : "air", solid: p.y === 64 }; }, () => false, { center: { x: 0, y: 65, z: 0 }, radius: 16 });
    expect(read.some((p) => p.x === 16 && p.z === 0 && p.y === 71)).toBe(true);
    expect(read.every((p) => Math.hypot(p.x, p.z) <= 16)).toBe(true);
    expect(snapshot.bounds).toEqual({ min: { x: -16, y: 64, z: -16 }, max: { x: 16, y: 71, z: 16 } });
    expect(snapshot.coverage.radius).toBe(16);
    expect(snapshot.format).toBe("cuboids-v1");
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
    expect(expand(snapshot).unknown).toEqual([[0, 64, 0]]);
    expect(expand(snapshot).blocks).toEqual([[2, 64, 0, "lava"], [3, 64, 0, "oak_planks"], [4, 64, 0, "oak_planks"]]);
    expect(snapshot.palette).toContainEqual({ name: "lava", solid: false, hazard: true });
    expect(expand(snapshot).breakable).toEqual([[4, 64, 0]]);
  });

  it("la compresión conserva cada celda, hueco, material y permiso en terrenos variados", () => {
    for (let seed = 0; seed < 20; seed++) {
      const raw: RawSpatialSnapshot = { bounds, coverage: { center: { x: 0, y: 65, z: 0 }, radius: 16 }, blocks: [], unknown: [], breakable: [], materials: { stone: { solid: true, hazard: false }, water: { solid: false, hazard: false } } };
      for (let y = 64; y < 68; y++) for (let z = -3; z <= 3; z++) for (let x = -3; x <= 3; x++) {
        const n = Math.abs(x * 13 + y * 17 + z * 7 + seed * 11) % 7;
        if (n === 0) raw.unknown.push([x, y, z]);
        if (n <= 1) continue;
        raw.blocks.push([x, y, z, n === 2 ? "water" : "stone"]);
        if (n % 2) raw.breakable.push([x, y, z]);
      }
      const expanded = expand(packWorld(raw));
      const ordered = (cells: unknown[][]) => cells.map((cell) => JSON.stringify(cell)).sort();
      expect(ordered(expanded.blocks)).toEqual(ordered(raw.blocks));
      expect(ordered(expanded.unknown)).toEqual(ordered(raw.unknown));
      expect(ordered(expanded.breakable)).toEqual(ordered(raw.breakable));
    }
  });

  it("la ubicación de una entidad no implica línea de visión a través de obstáculos", () => {
    const from = { x: 0.5, y: 66.5, z: 0.5 }, to = { x: 8.5, y: 66.5, z: 0.5 };
    expect(lineOfSight(from, to, () => air)).toBe(true);
    expect(lineOfSight(from, to, (p) => p.x === 4 ? { name: "oak_planks", solid: true } : air)).toBe(false);
    expect(lineOfSight(from, to, (p) => p.x === 4 ? null : air)).toBe(false);
  });
});
