import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ARENAS, ISLAND_STRUCTURE_SIZE, type IslandsArena } from "@phack/protocol";
import {
  CORE_LAYERS,
  ISLAND_CLEANUP_BLOCKS,
  MAX_FILL_VOLUME,
  boxVolume,
  chunkBattleBuildCommands,
  chunkBattleLayout,
  chunkBattleStructures,
  islandBox,
  islandToWorld,
  loadChunkBattleMetadata,
  parseChunkBattleMetadata,
  placeTemplateFailed,
  randomChunkBattleSeed,
  splitBox,
  templateAnchor,
  type Box,
} from "./chunkbattle";

const ARENA = ARENAS["chunk-battle"] as IslandsArena;
const [RED, BLUE] = ARENA.islands;
const META = loadChunkBattleMetadata();
const DATAPACK = new URL("../../../infra/minecraft/datapacks/phack-chunkbattle/", import.meta.url);

const FILL = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (minecraft:[a-z_]+)( replace minecraft:[a-z_]+)?$/;
const PLACE = /^place template (phack:[a-z_/0-9]+) (-?\d+) (-?\d+) (-?\d+)( none| 180)?$/;

const inside = (p: { x: number; z: number }, r: { minX: number; maxX: number; minZ: number; maxZ: number }) =>
  p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;

describe("geometría de Chunk Battle", () => {
  it("dos islas alineadas en x, roja al oeste, con 6 bloques de vacío entre superficies", () => {
    expect(RED.side).toBe("red");
    expect(BLUE.side).toBe("blue");
    expect(RED.to.x).toBeLessThan(BLUE.from.x);
    expect(BLUE.from.x - RED.to.x - 1).toBe(ARENA.gap);
    expect(ARENA.gap).toBe(6);
    // Superficies de 20×20 (núcleo de 16×16 + cornisa), misma franja en z.
    for (const island of ARENA.islands) {
      expect(island.to.x - island.from.x + 1).toBe(20);
      expect(island.to.z - island.from.z + 1).toBe(20);
      expect(island.core.maxX - island.core.minX + 1).toBe(16);
      expect(island.core.maxZ - island.core.minZ + 1).toBe(16);
      expect(island.from.z).toBe(RED.from.z);
    }
    // El centro del conjunto cae en el hueco.
    expect(ARENA.center.x).toBeGreaterThan(RED.to.x);
    expect(ARENA.center.x).toBeLessThan(BLUE.from.x);
  });

  it("las cámaras miran desde +Z, centradas, y la general va más alta", () => {
    for (const cam of [ARENA.camera, ARENA.cameraWide]) {
      expect(cam.x).toBe(ARENA.center.x);
      expect(cam.z).toBeGreaterThan(BLUE.to.z);
      expect(cam.y).toBeGreaterThan(ARENA.center.y + 10);
    }
    expect(ARENA.cameraWide.y).toBeGreaterThan(ARENA.camera.y);
    // Con el FOV horizontal de Minecraft en 16:9 (~100°) ambas cámaras ven las dos islas enteras.
    for (const cam of [ARENA.camera, ARENA.cameraWide]) {
      const distance = Math.hypot(cam.y - ARENA.center.y, cam.z - ARENA.center.z);
      const halfWidth = distance * Math.tan((50 * Math.PI) / 180);
      expect(halfWidth).toBeGreaterThan(Math.max(ARENA.center.x - RED.from.x, BLUE.to.x + 1 - ARENA.center.x));
    }
  });

  it("la isla girada 180° ocupa la misma caja que dice el contrato", () => {
    const last = { x: ISLAND_STRUCTURE_SIZE.x - 1, y: 0, z: ISLAND_STRUCTURE_SIZE.z - 1 };
    expect(islandToWorld(RED, { x: 0, y: 0, z: 0 })).toEqual(RED.origin);
    expect(templateAnchor(RED)).toEqual(RED.origin);
    // Gira en torno al punto de colocación: el ancla es la esquina máxima.
    expect(templateAnchor(BLUE)).toEqual({ x: BLUE.origin.x + last.x, y: BLUE.origin.y, z: BLUE.origin.z + last.z });
    expect(islandToWorld(BLUE, last)).toEqual(BLUE.origin);
    // La cornisa relativa 1..20 cae en la superficie declarada, con o sin giro.
    for (const island of ARENA.islands) {
      for (const rel of [{ x: 1, y: 0, z: 1 }, { x: 20, y: 0, z: 20 }]) {
        expect(inside(islandToWorld(island, rel), { minX: island.from.x, maxX: island.to.x, minZ: island.from.z, maxZ: island.to.z })).toBe(true);
      }
    }
  });

  it("la zona que se limpia contiene ambas islas y las cámaras quedan fuera de ella", () => {
    const clear = ARENA.clearBox;
    for (const island of ARENA.islands) {
      const box = islandBox(island);
      for (const p of [box.from, box.to]) {
        expect(p.x).toBeGreaterThanOrEqual(clear.from.x);
        expect(p.x).toBeLessThanOrEqual(clear.to.x);
        expect(p.z).toBeGreaterThanOrEqual(clear.from.z);
        expect(p.z).toBeLessThanOrEqual(clear.to.z);
      }
      expect(clear.from.y).toBe(island.origin.y - 1);
      expect(clear.to.y).toBeGreaterThan(box.to.y);
    }
    expect(ARENA.camera.z).toBeGreaterThan(clear.to.z);
  });
});

describe("datapack de Chunk Battle", () => {
  it("trae todas las estructuras que usa el escenario (sin chuk_spawner)", () => {
    const ids = chunkBattleStructures();
    expect(META.themes).toHaveLength(10);
    expect(META.layers).toHaveLength(25);
    expect(ids.some((id) => id.includes("spawner"))).toBe(false);
    for (const id of ids) {
      const path = id.replace(/^phack:/, "data/phack/structures/") + ".nbt";
      expect(existsSync(new URL(path, DATAPACK)), path).toBe(true);
    }
  });

  it("es un datapack de 1.20.4 (pack_format 26)", () => {
    const mcmeta = JSON.parse(readFileSync(new URL("pack.mcmeta", DATAPACK), "utf8")) as { pack: { pack_format: number } };
    expect(mcmeta.pack.pack_format).toBe(26);
  });

  it("cada tema tiene su spawn sobre la superficie del núcleo, con cielo abierto", () => {
    for (const theme of META.themes) {
      expect(theme.spawn.x).toBeGreaterThanOrEqual(META.core.min);
      expect(theme.spawn.x).toBeLessThanOrEqual(META.core.max);
      expect(theme.spawn.z).toBeGreaterThanOrEqual(META.core.min);
      expect(theme.spawn.z).toBeLessThanOrEqual(META.core.max);
      // Suelo entre la última capa (31) y unos pocos bloques de relieve encima.
      expect(theme.spawn.y).toBeGreaterThanOrEqual(META.core.top);
      expect(theme.spawn.y).toBeLessThanOrEqual(META.core.top + 3);
      expect(theme.spawn.openSky).toBe(true);
    }
  });

  it("rechaza metadatos que no calzan con el contrato", () => {
    const raw = JSON.parse(readFileSync(new URL("structures.json", DATAPACK), "utf8")) as Record<string, unknown>;
    expect(() => parseChunkBattleMetadata({ ...raw, size: [16, 48, 16] })).toThrow("22×48×22");
    expect(() => parseChunkBattleMetadata({ ...raw, core: { min: 3, max: 18, top: 20 } })).toThrow("32 capas");
    expect(() => parseChunkBattleMetadata({ ...raw, themes: [] })).toThrow();
  });
});

describe("islas por semilla", () => {
  it("la misma semilla da siempre las mismas islas, capas y spawns", () => {
    expect(chunkBattleLayout(ARENA, 42)).toEqual(chunkBattleLayout(ARENA, 42));
    expect(chunkBattleBuildCommands(ARENA, chunkBattleLayout(ARENA, 42))).toEqual(
      chunkBattleBuildCommands(ARENA, chunkBattleLayout(ARENA, 42)),
    );
  });

  it("semillas distintas reparten temas distintos y nunca el mismo en ambas islas", () => {
    const pairs = new Set<string>();
    const used = new Set<string>();
    for (let seed = 0; seed < 200; seed += 1) {
      const layout = chunkBattleLayout(ARENA, seed);
      expect(layout.red.theme.name).not.toBe(layout.blue.theme.name);
      pairs.add(`${layout.red.theme.name}/${layout.blue.theme.name}`);
      used.add(layout.red.theme.name);
      used.add(layout.blue.theme.name);
    }
    expect(used.size).toBe(META.themes.length);
    expect(pairs.size).toBeGreaterThan(40);
  });

  it("cada núcleo lleva 32 capas válidas", () => {
    const layout = chunkBattleLayout(ARENA, 7);
    const valid = new Set(META.layers.map((layer) => layer.id));
    for (const island of [layout.red, layout.blue]) {
      expect(island.layers).toHaveLength(CORE_LAYERS);
      for (const id of island.layers) expect(valid.has(id)).toBe(true);
    }
    expect(layout.red.layers).not.toEqual(layout.blue.layers);
  });

  it("los spawns caen en el núcleo de su isla, sobre el suelo, mirándose", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const { red, blue } = chunkBattleLayout(ARENA, seed);
      expect(inside(red.spawn, RED.core)).toBe(true);
      expect(inside(blue.spawn, BLUE.core)).toBe(true);
      expect(red.spawn.y).toBe(RED.origin.y + red.theme.spawn.y + 1);
      expect(blue.spawn.y).toBe(BLUE.origin.y + blue.theme.spawn.y + 1);
      expect(red.spawn.yaw).toBe(-90);
      expect(blue.spawn.yaw).toBe(90);
    }
  });

  it("rechaza semillas no enteras y sortea semillas de 31 bits", () => {
    expect(() => chunkBattleLayout(ARENA, 1.5)).toThrow("Semilla inválida");
    expect(randomChunkBattleSeed(() => 0)).toBe(0);
    expect(randomChunkBattleSeed(() => 0.999999999)).toBeLessThan(2 ** 31);
  });
});

describe("construcción de Chunk Battle", () => {
  const layout = chunkBattleLayout(ARENA, 1234);
  const commands = chunkBattleBuildCommands(ARENA, layout);

  it("solo usa fill, kill y place template con sintaxis de 1.20.4, sin pasar el límite de /fill", () => {
    for (const command of commands) {
      if (command.startsWith("kill ")) {
        expect(command).toMatch(/^kill @e\[type=!minecraft:player,x=-?\d+,y=-?\d+,z=-?\d+,dx=\d+,dy=\d+,dz=\d+\]$/);
        continue;
      }
      const fill = FILL.exec(command);
      if (fill) {
        const [x1, y1, z1, x2, y2, z2] = fill.slice(1, 7).map(Number) as [number, number, number, number, number, number];
        expect(boxVolume({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 } }), command).toBeLessThanOrEqual(MAX_FILL_VOLUME);
        continue;
      }
      expect(command, command).toMatch(PLACE);
    }
  });

  it("empieza limpiando a aire todo el volumen (el primer comando es un /fill)", () => {
    expect(commands[0]).toMatch(/^fill .* minecraft:air$/);
    const clears = commands.filter((c) => /^fill .* minecraft:air$/.test(c)).map((c) => FILL.exec(c)!);
    const total = clears.reduce((sum, m) => {
      const [x1, y1, z1, x2, y2, z2] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
      return sum + boxVolume({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 } });
    }, 0);
    expect(total).toBe(boxVolume(ARENA.clearBox));
    expect(commands.filter((c) => c.startsWith("kill "))).toHaveLength(2);
  });

  it("cada isla: piso de bedrock, 32 capas en el núcleo, el tema girado y limpieza de bloques prohibidos", () => {
    for (const island of [layout.red, layout.blue]) {
      const { core, origin } = island.island;
      expect(commands).toContain(`fill ${core.minX} ${origin.y - 1} ${core.minZ} ${core.maxX} ${origin.y - 1} ${core.maxZ} minecraft:bedrock`);
      island.layers.forEach((id, dy) => {
        expect(commands).toContain(`place template ${id} ${core.minX} ${origin.y + dy} ${core.minZ}`);
      });
      const anchor = templateAnchor(island.island);
      const themeCommand = `place template ${island.theme.id} ${anchor.x} ${anchor.y} ${anchor.z} ${island.island.rotation}`;
      expect(commands).toContain(themeCommand);
      // El tema va después de sus capas (sus structure_void dejan ver el mineral).
      expect(commands.indexOf(themeCommand)).toBeGreaterThan(commands.indexOf(`place template ${island.layers.at(-1)} ${core.minX} ${origin.y + CORE_LAYERS - 1} ${core.minZ}`));
      const box = islandBox(island.island);
      for (const block of ISLAND_CLEANUP_BLOCKS) {
        const cleanup = `fill ${box.from.x} ${box.from.y} ${box.from.z} ${box.to.x} ${box.to.y} ${box.to.z} minecraft:air replace ${block}`;
        expect(commands.indexOf(cleanup)).toBeGreaterThan(commands.indexOf(themeCommand));
      }
    }
    expect(ISLAND_CLEANUP_BLOCKS).toEqual(expect.arrayContaining(["minecraft:command_block", "minecraft:structure_block", "minecraft:spawner", "minecraft:barrier"]));
  });

  it("reconoce cuándo un place template falló", () => {
    // Respuestas reales de Paper 1.20.4.
    expect(placeTemplateFailed('Loaded template "phack:layer/1" at 979, 32, -8')).toBe(false);
    expect(placeTemplateFailed('There is no template with id "phack:chunk/nope"')).toBe(true);
    expect(placeTemplateFailed("Unknown or incomplete command, see below for error")).toBe(true);
  });
});

describe("splitBox", () => {
  const cells = (boxes: Box[]) => {
    const seen = new Map<string, number>();
    for (const { from, to } of boxes)
      for (let x = from.x; x <= to.x; x += 1)
        for (let y = from.y; y <= to.y; y += 1)
          for (let z = from.z; z <= to.z; z += 1) seen.set(`${x},${y},${z}`, (seen.get(`${x},${y},${z}`) ?? 0) + 1);
    return seen;
  };

  it("cubre la caja exacta, sin solapar ni pasar el máximo", () => {
    const box: Box = { from: { x: -3, y: 0, z: -2 }, to: { x: 9, y: 4, z: 3 } };
    for (const max of [30, 31, 64, 1000]) {
      const parts = splitBox(box, max);
      for (const part of parts) expect(boxVolume(part)).toBeLessThanOrEqual(max);
      const seen = cells(parts);
      expect(seen.size).toBe(boxVolume(box));
      expect([...seen.values()].every((n) => n === 1)).toBe(true);
    }
  });

  it("acepta esquinas en cualquier orden y falla si una fila no cabe", () => {
    expect(splitBox({ from: { x: 2, y: 2, z: 2 }, to: { x: 0, y: 0, z: 0 } }, 1000)).toEqual([
      { from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 2, z: 2 } },
    ]);
    expect(() => splitBox({ from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 9 } }, 5)).toThrow("no cabe");
  });
});
