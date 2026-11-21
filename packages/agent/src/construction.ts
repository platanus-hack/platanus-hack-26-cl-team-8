import { isBuildBlock } from "./items";
import type { Vec3Like } from "./geometry";

export type Bounds = { min: Vec3Like; max: Vec3Like };
export type PlannedBlock = Vec3Like & { material: string };
export const MAX_PLAN_BLOCKS = 512;

export function inside(position: Vec3Like, bounds: Bounds): boolean {
  return (["x", "y", "z"] as const).every((axis) => position[axis] >= bounds.min[axis] && position[axis] <= bounds.max[axis]);
}

/** Un plano inválido se rechaza entero; nunca se adivinan coordenadas o materiales. */
export function parseBlueprint(value: unknown, bounds: Bounds): PlannedBlock[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAN_BLOCKS) {
    return `blocks debe contener entre 1 y ${MAX_PLAN_BLOCKS} bloques`;
  }
  const cells = new Set<string>();
  const result: PlannedBlock[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return "cada bloque necesita x, y, z y material";
    const cell = raw as Record<string, unknown>;
    if (![cell.x, cell.y, cell.z].every((n) => typeof n === "number" && Number.isSafeInteger(n))) {
      return "las coordenadas de los bloques deben ser números enteros absolutos";
    }
    const material = typeof cell.material === "string" ? cell.material.replace(/^minecraft:/, "") : "";
    if (!isBuildBlock(material)) return `material de construcción no admitido: ${material || "(vacío)"}`;
    const block = { x: cell.x as number, y: cell.y as number, z: cell.z as number, material };
    if (!inside(block, bounds)) return `bloque fuera del volumen construible: ${block.x},${block.y},${block.z}`;
    const key = `${block.x},${block.y},${block.z}`;
    if (cells.has(key)) return `celda repetida en el plano: ${key}`;
    cells.add(key);
    result.push(block);
  }
  return result;
}

export interface ConstructionWorld {
  read(position: Vec3Like): string | null;
  occupied(position: Vec3Like): boolean;
  count(material: string): number;
  prepare(block: PlannedBlock): { status: "ready" | "moving" | "blocked"; reason?: string };
  place(block: PlannedBlock): Promise<void>;
}

/** El plano persiste entre turnos; cada paso confirma el resultado leyendo el mundo. */
export class ConstructionPlan {
  private completed = 0;
  private state: "active" | "paused" | "blocked" | "complete" = "active";
  private reason: string | null = null;
  private busy = false;

  constructor(readonly blocks: PlannedBlock[]) {}

  snapshot() {
    return { status: this.state, completed: this.completed, total: this.blocks.length, reason: this.reason, remaining: this.blocks.slice(this.completed) };
  }

  pause(): void {
    if (this.state === "active") this.state = "paused";
  }

  resume(): void {
    if (this.state !== "complete") {
      this.state = "active";
      this.reason = null;
    }
  }

  private block(reason: string): void {
    this.state = "blocked";
    this.reason = reason;
  }

  async step(world: ConstructionWorld, active: () => boolean): Promise<void> {
    if (this.busy || this.state !== "active" || !active()) return;
    const cell = this.blocks[this.completed];
    if (!cell) { this.state = "complete"; return; }
    const current = world.read(cell);
    if (current === null) { this.block("celda desconocida: el chunk no está cargado"); return; }
    if (current !== cell.material) {
      if (!["air", "cave_air", "void_air"].includes(current)) { this.block(`celda ocupada por ${current}; usa dig o cambia el plano`); return; }
      if (world.occupied(cell)) { this.block("un agente ocupa la celda"); return; }
      if (world.count(cell.material) < 1) { this.block(`no te queda ${cell.material}`); return; }
      const preparation = world.prepare(cell);
      this.reason = preparation.reason ?? null;
      if (preparation.status === "blocked") { this.block(this.reason ?? "no se puede alcanzar esta celda"); return; }
      if (preparation.status === "moving") return;
      this.busy = true;
      try {
        await world.place(cell);
        if (!active()) return;
        if (world.read(cell) !== cell.material) { this.block("el servidor no confirmó el bloque; revisa el terreno y reintenta"); return; }
      } catch (error) {
        if (active()) this.block(`no se pudo colocar el bloque: ${error instanceof Error ? error.message : String(error)}`);
        return;
      } finally {
        this.busy = false;
      }
    }
    if (!active()) return;
    this.completed++;
    this.reason = null;
    if (this.completed === this.blocks.length) this.state = "complete";
  }
}
