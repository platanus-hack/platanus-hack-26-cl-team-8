import { describe, expect, it, vi } from "vitest";
import { ARENAS, kitForArena, KITS, type IslandsArena } from "@phack/protocol";
import { arenaBuildBounds, ConstructionPlan, inside, parseBlueprint, type ConstructionWorld, type PlannedBlock } from "./construction";
import { isBreakable, isBuildBlock } from "./items";

const bounds = { min: { x: -12, y: 65, z: -12 }, max: { x: 12, y: 70, z: 12 } };
const first = { x: 0, y: 65, z: 1, material: "oak_planks" };
const second = { x: 0, y: 66, z: 1, material: "red_wool" };

function world() {
  const cells = new Map<string, string>();
  const stock: Record<string, number> = { oak_planks: 20, red_wool: 20 };
  const key = (p: PlannedBlock) => `${p.x},${p.y},${p.z}`;
  const adapter: ConstructionWorld = {
    read: (p) => cells.get(`${p.x},${p.y},${p.z}`) ?? "air",
    occupied: () => false,
    count: (material) => stock[material] ?? 0,
    prepare: () => ({ status: "ready" }),
    place: vi.fn(async (cell) => { cells.set(key(cell), cell.material); stock[cell.material]!--; }),
  };
  return { cells, stock, adapter, key };
}

describe("planos libres", () => {
  it("admite geometría y materiales arbitrarios, y conserva el orden de apoyos", () => {
    const stairs = Array.from({ length: 5 }, (_, x) => ({ x, y: 65 + x, z: x, material: x % 2 ? "red_wool" : "oak_planks" }));
    expect(parseBlueprint(stairs, bounds)).toEqual(stairs);
    expect(parseBlueprint([{ ...first, material: "minecraft:oak_planks" }], bounds)).toEqual([first]);
  });

  it.each([
    undefined, [], [first, first], [{ ...first, x: 13 }], [{ ...first, y: 64 }],
    [{ ...first, z: NaN }], [{ ...first, x: "0" }], [{ ...first, x: 0.5 }],
    [{ ...first, material: "lava" }], [{ ...first, material: "bedrock" }], Array(513).fill(first),
  ])("rechaza el plano inválido completo: %j", (input) => {
    expect(typeof parseBlueprint(input, bounds)).toBe("string");
  });
});

describe("ejecución persistente", () => {
  it("coloca en orden y confirma cada material leyendo el mundo", async () => {
    const { adapter, stock } = world();
    const plan = new ConstructionPlan([first, second]);
    await plan.step(adapter, () => true);
    expect(plan.snapshot()).toMatchObject({ completed: 1, status: "active", remaining: [second] });
    await plan.step(adapter, () => true);
    expect(plan.snapshot()).toMatchObject({ completed: 2, status: "complete" });
    expect(stock).toEqual({ oak_planks: 19, red_wool: 19 });
  });

  it("no consume un bloque que ya estaba colocado", async () => {
    const { adapter, cells, key } = world();
    cells.set(key(first), first.material);
    const plan = new ConstructionPlan([first]);
    await plan.step(adapter, () => true);
    expect(adapter.place).not.toHaveBeenCalled();
    expect(plan.snapshot().status).toBe("complete");
  });

  it("espera mientras se acerca, y se puede pausar y retomar", async () => {
    const { adapter } = world();
    const plan = new ConstructionPlan([first]);
    adapter.prepare = () => ({ status: "moving", reason: "buscando ruta" });
    await plan.step(adapter, () => true);
    expect(plan.snapshot()).toMatchObject({ completed: 0, reason: "buscando ruta" });
    plan.pause();
    adapter.prepare = () => ({ status: "ready" });
    await plan.step(adapter, () => true);
    expect(adapter.place).not.toHaveBeenCalled();
    plan.resume();
    await plan.step(adapter, () => true);
    expect(plan.snapshot().status).toBe("complete");
  });

  it.each(["unknown", "occupied", "material", "support", "server"])("informa un obstáculo concreto y permite reintentar: %s", async (failure) => {
    const { adapter } = world();
    const good = { ...adapter };
    if (failure === "unknown") adapter.read = () => null;
    if (failure === "occupied") adapter.occupied = () => true;
    if (failure === "material") adapter.count = () => 0;
    if (failure === "support") adapter.prepare = () => ({ status: "blocked", reason: "falta apoyo" });
    if (failure === "server") adapter.place = async () => {};
    const plan = new ConstructionPlan([first]);
    await plan.step(adapter, () => true);
    expect(plan.snapshot()).toMatchObject({ status: "blocked", completed: 0, remaining: [first] });
    expect(plan.snapshot().reason).toBeTruthy();
    plan.resume();
    await plan.step(good, () => true);
    expect(plan.snapshot().status).toBe("complete");
  });

  it("un bloque de otro material no cuenta como éxito ni se reemplaza silenciosamente", async () => {
    const { adapter, cells, key } = world();
    cells.set(key(first), "obsidian");
    const plan = new ConstructionPlan([first]);
    await plan.step(adapter, () => true);
    expect(plan.snapshot().reason).toContain("obsidian");
    expect(adapter.place).not.toHaveBeenCalled();
  });

  it("serializa las colocaciones y una cancelación no inicia los pasos siguientes", async () => {
    const { adapter, cells, key } = world();
    let finish!: () => void;
    let active = true;
    adapter.place = vi.fn(() => new Promise<void>((resolve) => { finish = () => { cells.set(key(first), first.material); resolve(); }; }));
    const plan = new ConstructionPlan([first, second]);
    const running = plan.step(adapter, () => active);
    await plan.step(adapter, () => active);
    expect(adapter.place).toHaveBeenCalledTimes(1);
    active = false;
    plan.pause();
    finish();
    await running;
    expect(plan.snapshot().completed).toBe(0);
    active = true;
    plan.resume();
    await plan.step(adapter, () => active); // Reconoce el bloque que alcanzó a confirmar el servidor.
    expect(plan.snapshot()).toMatchObject({ completed: 1, remaining: [second] });
  });
});

describe("Chunk Battle: cruzar el hueco entre islas con build", () => {
  const arena = ARENAS["chunk-battle"] as IslandsArena;
  const [red, blue] = arena.islands;
  const y = arena.center.y;
  const z = 0;
  /** El puente: las celdas de vacío entre el borde de la isla roja y el de la azul, a la altura del suelo. */
  const bridge = Array.from({ length: blue.from.x - red.to.x - 1 }, (_, i) => ({ x: red.to.x + 1 + i, y, z, material: "cobblestone" }));

  it("el hueco es de 6 bloques y el plano del puente cabe en el volumen construible", () => {
    expect(bridge).toHaveLength(6);
    const bounds = arenaBuildBounds(arena);
    expect(parseBlueprint(bridge, bounds)).toEqual(bridge);
    // El kit clásico, ajustado al mapa, trae roca de sobra para el puente.
    const kit = kitForArena(KITS.classic, arena);
    const blocks = kit.items.filter((i) => isBuildBlock(i.item)).reduce((n, i) => n + i.count, 0);
    expect(blocks).toBeGreaterThanOrEqual(bridge.length);
    // Las dos islas y el hueco entero quedan dentro (también para pararse en el puente).
    expect(inside({ x: red.from.x, y: y + 1, z }, bounds) && inside({ x: blue.to.x, y: y + 1, z }, bounds)).toBe(true);
  });

  it("bloque a bloque, cada uno apoyado en el anterior y caminando sobre lo puesto, llega a la otra isla", async () => {
    const solid = new Set<string>();
    const k = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
    for (const island of [red, blue]) for (let x = island.from.x; x <= island.to.x; x += 1) solid.add(k({ x, y, z }));
    let stock = 32;
    // El cuerpo parte en el borde de su isla y avanza sobre el puente (alcance 4.5 como el real).
    let feetX = red.to.x;
    const adapter: ConstructionWorld = {
      read: (p) => (solid.has(k(p)) ? "cobblestone" : "air"),
      occupied: () => false,
      count: () => stock,
      prepare: (cell) => {
        const neighbours = [[1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]] as const;
        if (!neighbours.some(([dx, dy, dz]) => solid.has(k({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz })))) {
          return { status: "blocked", reason: "falta un bloque vecino de apoyo" };
        }
        if (Math.abs(cell.x - feetX) > 4.5) {
          // Se acerca por lo ya construido: el último bloque sólido hacia el rival.
          while (solid.has(k({ x: feetX + 1, y, z })) && Math.abs(cell.x - feetX) > 4.5) feetX += 1;
          return { status: "moving" };
        }
        return { status: "ready" };
      },
      place: async (cell) => {
        solid.add(k(cell));
        stock -= 1;
      },
    };
    const plan = new ConstructionPlan(bridge);
    for (let i = 0; i < 20 && plan.snapshot().status === "active"; i += 1) await plan.step(adapter, () => true);
    expect(plan.snapshot()).toMatchObject({ status: "complete", completed: 6 });
    for (let x = red.to.x; x <= blue.from.x; x += 1) expect(solid.has(k({ x, y, z }))).toBe(true);
    expect(stock).toBe(26);
  });

  it("en las islas se rompe el terreno, pero nunca la lista negra; nada administrativo se coloca", () => {
    for (const block of ["grass_block", "oak_log", "glass", "smooth_stone", "cobblestone"]) {
      expect(isBreakable(block, "terrain")).toBe(true);
    }
    // En Platanus el vidrio y el piso son la arena.
    expect(isBreakable("glass", "placed")).toBe(false);
    for (const block of [
      "barrier",
      "bedrock",
      "command_block",
      "chain_command_block",
      "repeating_command_block",
      "structure_block",
      "structure_void",
      "jigsaw",
      "light",
      "end_portal",
      "end_portal_frame",
      "end_gateway",
      "nether_portal",
      "reinforced_deepslate",
      "spawner",
    ]) {
      expect(isBreakable(block, "terrain")).toBe(false);
      expect(isBreakable(block, "placed")).toBe(false);
      expect(isBuildBlock(block)).toBe(false);
      expect(typeof parseBlueprint([{ x: 1000, y, z, material: block }], arenaBuildBounds(arena))).toBe("string");
    }
  });
});
