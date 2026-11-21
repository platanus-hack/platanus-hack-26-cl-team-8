import type { Bounds } from "./construction";
import { isBreakable, type BreakRule } from "./items";
import type { Vec3Like } from "./geometry";

export type WorldCell = { name: string; solid: boolean };
export type CellBox = [number, number, number, number, number, number];
type LabeledBox = [...CellBox, number];
export type SpatialRegion = [...CellBox, number, number];
export type RawSpatialSnapshot = {
  bounds: Bounds;
  coverage: { center: Vec3Like; radius: number };
  blocks: [number, number, number, string][];
  unknown: [number, number, number][];
  materials: Record<string, { solid: boolean; hazard: boolean }>;
  breakable: [number, number, number][];
};
export type SpatialSnapshot = ReturnType<typeof packWorld>;

/** Cajas exactas, sin llenar huecos ni mezclar materiales o permisos. Extremos inclusivos. */
function packCells(cells: [number, number, number, number][]): LabeledBox[] {
  const grid = new Map(cells.map(([x, y, z, value]) => [`${x},${y},${z}`, value]));
  const boxes: LabeledBox[] = [];
  const same = (x: number, y: number, z: number, value: number) => grid.get(`${x},${y},${z}`) === value;
  for (const [x, y, z, value] of [...cells].sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0])) {
    if (!same(x, y, z, value)) continue;
    let x1 = x, y1 = y, z1 = z;
    while (same(x1 + 1, y, z, value)) x1++;
    const rowMatches = (atY: number, atZ: number) => {
      for (let atX = x; atX <= x1; atX++) if (!same(atX, atY, atZ, value)) return false;
      return true;
    };
    while (rowMatches(y, z1 + 1)) z1++;
    const layerMatches = (atY: number) => {
      for (let atZ = z; atZ <= z1; atZ++) if (!rowMatches(atY, atZ)) return false;
      return true;
    };
    while (layerMatches(y1 + 1)) y1++;
    boxes.push([x, y, z, x1, y1, z1, value]);
    for (let atY = y; atY <= y1; atY++) for (let atZ = z; atZ <= z1; atZ++) for (let atX = x; atX <= x1; atX++) grid.delete(`${atX},${atY},${atZ}`);
  }
  return boxes;
}

/** Misma geometría y radio, con paleta de materiales y regiones homogéneas. */
export function packWorld(raw: RawSpatialSnapshot) {
  const palette = Object.entries(raw.materials).map(([name, info]) => ({ name, ...info }));
  const indices = new Map(palette.map((material, index) => [material.name, index]));
  const editable = new Set(raw.breakable.map((p) => p.join(",")));
  const cells: [number, number, number, number][] = raw.blocks.map(([x, y, z, name]) => [x, y, z, (indices.get(name) ?? 0) * 2 + Number(editable.has(`${x},${y},${z}`))]);
  const regions = packCells(cells).map(([x, y, z, x1, y1, z1, value]): SpatialRegion => [x, y, z, x1, y1, z1, Math.floor(value / 2), value % 2]);
  const unknown = packCells(raw.unknown.map(([x, y, z]) => [x, y, z, 0])).map(([x, y, z, x1, y1, z1]): CellBox => [x, y, z, x1, y1, z1]);
  return { format: "cuboids-v1" as const, bounds: raw.bounds, coverage: { center: raw.coverage.center, radius: raw.coverage.radius }, palette, regions, unknown };
}

/** Snapshot íntegro del volumen, incluidos piso, paredes y techo. El aire conocido es implícito. */
export function scanWorld(bounds: Bounds, read: (position: Vec3Like) => WorldCell | null, canModify: (position: Vec3Like) => boolean, coverage: { center: Vec3Like; radius: number }, breakRule: BreakRule = "placed") {
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
        if (canModify(position) && isBreakable(cell.name, breakRule)) breakable.push([x, y, z]);
      }
    }
  }
  return packWorld({ bounds, coverage, blocks, unknown, materials, breakable });
}

/**
 * Para colocar un bloque: la cara `aim` del bloque de apoyo `support` se alcanza si el rayo
 * no cruza OTRO bloque. El propio apoyo no tapa su cara: así se alcanza la cara lateral del
 * borde desde encima (el servidor acepta el clic; es lo que hace un jugador agachado al
 * tender un puente sobre el vacío).
 */
export function faceInSight(from: Vec3Like, aim: Vec3Like, support: Vec3Like, read: (position: Vec3Like) => WorldCell | null): boolean {
  return lineOfSight(from, aim, (p) => (p.x === support.x && p.y === support.y && p.z === support.z ? { name: "air", solid: false } : read(p)));
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
