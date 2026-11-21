import { describe, expect, it, vi } from "vitest";
import { ARENAS, type BuiltArena } from "@phack/protocol";
import { buildArena, forceloadCommand, teleportCommand } from "./arena";
import {
  CLEAR_ABOVE_WALLS,
  FLOOR_BLOCK,
  LOGO_BLOCKS,
  MAX_FILL_VOLUME,
  WALL_BLOCK,
  floorBounds,
  loadLogo,
  logoRuns,
  parseLogo,
  platanusBuildCommands,
} from "./platanus";

const ARENA = ARENAS.platanus as BuiltArena;
const Y = ARENA.center.y;
const WALL_TOP = Y + ARENA.wallHeight;

/** Mundo de prueba: aplica los /fill en orden. Lo que no está en el mapa es aire (void). */
function simulate(commands: string[]): Map<string, string> {
  const world = new Map<string, string>();
  for (const command of commands) {
    const match = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\S+)$/.exec(command);
    if (!match) continue;
    const [x1, y1, z1, x2, y2, z2] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    const block = match[7]!;
    const volume = (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1) * (Math.abs(z2 - z1) + 1);
    expect(volume, command).toBeLessThanOrEqual(MAX_FILL_VOLUME);
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += 1)
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += 1)
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z += 1) {
          if (block === "minecraft:air") world.delete(`${x},${y},${z}`);
          else world.set(`${x},${y},${z}`, block);
        }
  }
  return world;
}

const blockAt = (world: Map<string, string>, x: number, y: number, z: number): string =>
  world.get(`${x},${y},${z}`) ?? "minecraft:air";

describe("logo de Platanus", () => {
  it("la grilla del repo es 41×41", () => {
    const grid = loadLogo();
    expect(grid).toHaveLength(41);
    for (const row of grid) expect(row).toHaveLength(41);
  });

  it("rechaza grillas mal formadas", () => {
    expect(() => parseLogo("YY\nYY")).toThrow();
    expect(() => parseLogo("Y.Y\nYXY\nY.Y")).toThrow("carácter inválido");
    expect(() => parseLogo("Y.Y\nYY\nY.Y")).toThrow("columnas");
  });

  it("agrupa tramos contiguos por fila", () => {
    expect(logoRuns(["YYC", ".CC", "..."], { x: 10, z: 0 })).toEqual([
      { z: -1, fromX: 9, toX: 10, block: LOGO_BLOCKS.Y },
      { z: -1, fromX: 11, toX: 11, block: LOGO_BLOCKS.C },
      { z: 0, fromX: 10, toX: 11, block: LOGO_BLOCKS.C },
    ]);
  });

  it("el piso construido reproduce la grilla (fila 0 al norte, columna 0 al oeste)", () => {
    const grid = loadLogo();
    const world = simulate(platanusBuildCommands(ARENA, grid));
    const half = (grid.length - 1) / 2;
    const toChar = Object.fromEntries([[FLOOR_BLOCK, "."], ...Object.entries(LOGO_BLOCKS).map(([ch, b]) => [b, ch])]);
    const rebuilt: string[] = [];
    for (let r = 0; r < grid.length; r += 1) {
      let row = "";
      for (let col = 0; col < grid.length; col += 1) {
        row += toChar[blockAt(world, ARENA.center.x - half + col, Y, ARENA.center.z - half + r)] ?? "?";
      }
      rebuilt.push(row);
    }
    expect(rebuilt).toEqual(grid);
    // Un /fill por tramo, sin dibujar el fondo celda por celda.
    const logoFills = platanusBuildCommands(ARENA, grid).filter((c) => /yellow_concrete|white_concrete/.test(c));
    expect(logoFills).toHaveLength(logoRuns(grid, ARENA.center).length);
    expect(logoFills.length).toBeLessThan(41 * 6);
  });
});

describe("Arena Platanus", () => {
  const commands = platanusBuildCommands(ARENA);
  const world = simulate(commands);
  const { minX, maxX, minZ, maxZ } = floorBounds(ARENA);

  it("el piso es un rectángulo completo más grande que el logo", () => {
    expect(maxX - minX + 1).toBe(57);
    expect(maxZ - minZ + 1).toBe(45);
    for (let x = minX - 1; x <= maxX + 1; x += 1)
      for (let z = minZ - 1; z <= maxZ + 1; z += 1) {
        const inside = x >= minX && x <= maxX && z >= minZ && z <= maxZ;
        expect(blockAt(world, x, Y, z) !== "minecraft:air", `${x},${z}`).toBe(inside);
      }
  });

  it("queda cerrada por vidrio sin huecos y abierta arriba (sin techo ni barrier)", () => {
    for (let y = Y + 1; y <= WALL_TOP; y += 1)
      for (let x = minX; x <= maxX; x += 1)
        for (let z = minZ; z <= maxZ; z += 1) {
          const border = x === minX || x === maxX || z === minZ || z === maxZ;
          expect(blockAt(world, x, y, z), `${x},${y},${z}`).toBe(border ? WALL_BLOCK : "minecraft:air");
        }
    for (const key of world.keys()) expect(Number(key.split(",")[1])).toBeLessThanOrEqual(WALL_TOP);
    expect(commands.join("\n")).not.toContain("barrier");
    expect(ARENA.wallHeight).toBeGreaterThanOrEqual(4);
  });

  it("limpia el interior primero y los restos de combate al final", () => {
    expect(commands[0]).toBe(`fill ${minX} ${Y + 1} ${minZ} ${maxX} ${WALL_TOP + CLEAR_ABOVE_WALLS} ${maxZ} minecraft:air`);
    const kills = commands.filter((c) => c.startsWith("kill "));
    expect(kills.map((c) => /type=minecraft:(\w+)/.exec(c)?.[1])).toEqual(["item", "arrow", "spectral_arrow", "experience_orb"]);
    for (const kill of kills) expect(kill).toContain(`x=${minX},`);
    expect(commands.filter((c) => c.startsWith("kill @e[type=!"))).toEqual([]);
  });

  it("los spawns están enfrentados sobre el piso, dentro de los muros", () => {
    const { red, blue } = ARENA.spawns;
    expect(red.x).toBe(ARENA.center.x - 16);
    expect(blue.x).toBe(ARENA.center.x + 16);
    expect(red.z).toBe(blue.z);
    for (const s of [red, blue]) {
      expect(s.x).toBeGreaterThan(minX);
      expect(s.x).toBeLessThan(maxX);
      expect(s.z).toBeGreaterThan(minZ);
      expect(s.z).toBeLessThan(maxZ);
      expect(s.y).toBe(Y + 1);
      expect(blockAt(world, s.x, Y, s.z)).not.toBe("minecraft:air");
      expect(blockAt(world, s.x, s.y, s.z)).toBe("minecraft:air");
      expect(blockAt(world, s.x, s.y + 1, s.z)).toBe("minecraft:air");
    }
    // Rojo mira al este (hacia el azul) y el azul al oeste.
    expect(red.yaw).toBe(-90);
    expect(blue.yaw).toBe(90);
    expect(teleportCommand("red", ARENA)).toBe("tp AgenteRojo -15.5 65 0.5 -90 0");
  });

  it("el círculo que usan los agentes cabe dentro de los muros", () => {
    expect(ARENA.radius).toBeLessThanOrEqual(Math.min(maxX - ARENA.center.x, maxZ - ARENA.center.z) - 1);
  });

  it("las cámaras quedan altas, en +Z (rojo a la izquierda) y fuera del piso", () => {
    for (const cam of [ARENA.camera, ARENA.cameraWide]) {
      expect(cam.x).toBe(ARENA.center.x);
      expect(cam.y).toBeGreaterThan(WALL_TOP + 10);
      expect(cam.z).toBeGreaterThan(ARENA.center.z);
    }
    expect(ARENA.cameraWide.y).toBeGreaterThan(ARENA.camera.y);
  });

  it("forceload cubre el piso y ambas cámaras", () => {
    const [x1, z1, x2, z2] = forceloadCommand(ARENA).split(" ").slice(2).map(Number) as [number, number, number, number];
    for (const p of [{ x: minX, z: minZ }, { x: maxX, z: maxZ }, ARENA.camera, ARENA.cameraWide]) {
      expect(p.x).toBeGreaterThanOrEqual(x1);
      expect(p.x).toBeLessThanOrEqual(x2);
      expect(p.z).toBeGreaterThanOrEqual(z1);
      expect(p.z).toBeLessThanOrEqual(z2);
    }
    // forceload acepta hasta 256 chunks por comando.
    const chunks = (Math.floor(x2 / 16) - Math.floor(x1 / 16) + 1) * (Math.floor(z2 / 16) - Math.floor(z1 / 16) + 1);
    expect(chunks).toBeLessThanOrEqual(256);
  });

  it("reconstruye entre peleas y reintenta el primer fill si el chunk no cargó", async () => {
    const send = vi.fn(async (_command: string) => "Successfully filled");
    send.mockResolvedValueOnce("").mockResolvedValueOnce("That position is not loaded");
    const sleep = vi.fn(async () => {});
    await buildArena({ send }, sleep, ARENA);
    await buildArena({ send }, sleep, ARENA);
    const sent = send.mock.calls.map(([c]) => c);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sent[0]).toBe(forceloadCommand(ARENA));
    expect(sent[1]).toBe(commands[0]);
    expect(sent[2]).toBe(commands[0]);
    expect(sent.filter((c) => c.startsWith("execute "))).toEqual([]);
    expect(sent.filter((c) => c === commands[1])).toHaveLength(2);
    expect(sent).toHaveLength(2 * (commands.length + 1) + 1);
  });
});
