import type { Bounds } from "./construction";
import { isBreakable } from "./items";
import type { Vec3Like } from "./geometry";

export type WorldCell = { name: string; solid: boolean };
export type SpatialSnapshot = ReturnType<typeof scanWorld>;

/** Snapshot íntegro del volumen, incluidos piso, paredes y techo. El aire conocido es implícito. */
export function scanWorld(bounds: Bounds, read: (position: Vec3Like) => WorldCell | null, canModify: (position: Vec3Like) => boolean, coverage: { center: Vec3Like; radius: number }) {
  bounds = {
    min: { x: Math.max(bounds.min.x, Math.ceil(coverage.center.x - coverage.radius)), y: bounds.min.y, z: Math.max(bounds.min.z, Math.ceil(coverage.center.z - coverage.radius)) },
    max: { x: Math.min(bounds.max.x, Math.floor(coverage.center.x + coverage.radius)), y: bounds.max.y, z: Math.min(bounds.max.z, Math.floor(coverage.center.z + coverage.radius)) },
  };
  const blocks: [number, number, number, string][] = [];
  const unknown: [number, number, number][] = [];
  const materials: Record<string, { solid: boolean; hazard: boolean }> = {};
  const breakable: [number, number, number][] = [];
  for (let y = bounds.min.y; y <= bounds.max.y; y++) {
    for (let z = bounds.min.z; z <= bounds.max.z; z++) {
      for (let x = bounds.min.x; x <= bounds.max.x; x++) {
        const position = { x, y, z };
        if (Math.hypot(x - coverage.center.x, z - coverage.center.z) > coverage.radius) continue;
        const cell = read(position);
        if (!cell) { unknown.push([x, y, z]); continue; }
        if (["air", "cave_air", "void_air"].includes(cell.name)) continue;
        blocks.push([x, y, z, cell.name]);
        materials[cell.name] = { solid: cell.solid, hazard: ["lava", "fire", "cobweb"].includes(cell.name) };
        if (canModify(position) && isBreakable(cell.name)) breakable.push([x, y, z]);
      }
    }
  }
  return { bounds, coverage: { ...coverage, shape: "horizontal cylinder; toda la altura de bounds" }, encoding: "blocks=[x,y,z,material]; unknown=[x,y,z]; solo las demás celdas DENTRO del radio y bounds son aire conocido; fuera de cobertura no se ha observado", blocks, unknown, materials, breakable };
}

/** Línea de visión hasta el objetivo; desconocido no se considera transparente. */
export function lineOfSight(from: Vec3Like, to: Vec3Like, read: (position: Vec3Like) => WorldCell | null): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const steps = Math.max(1, Math.ceil(length * 8));
  for (let i = 1; i < steps; i++) {
    const k = i / steps;
    const cell = read({ x: Math.floor(from.x + (to.x - from.x) * k), y: Math.floor(from.y + (to.y - from.y) * k), z: Math.floor(from.z + (to.z - from.z) * k) });
    if (!cell || cell.solid) return false;
  }
  return true;
}
