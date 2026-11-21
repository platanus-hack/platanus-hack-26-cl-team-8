import { describe, expect, it, vi } from "vitest";
import { ARENAS, FLOOR_LOGO_PALETTE, FLOOR_LOGO_ROWS, type BuiltArena } from "@phack/protocol";
import { buildArena, forceloadCommand, teleportCommand } from "./arena";
import {
  CLEAR_ABOVE_WALLS,
  FLOOR_BLOCK,
  SPAWN_MARKS,
  WALL_BLOCK,
  floorBounds,
  logoRuns,
  platanusBuildCommands,
  surroundBounds,
} from "./platanus";

/** Límite de bloques de un /fill en 1.20.4. */
const MAX_FILL_VOLUME = 32_768;

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

describe("logo del piso", () => {
  it("agrupa tramos contiguos por fila y deja el piso donde no hay letra con bloque", () => {
    expect(logoRuns({ x: 10, z: 0 }, ["YY.", " yy", "   "])).toEqual([
      { z: -1, fromX: 9, toX: 10, block: "minecraft:gold_block" },
      { z: -1, fromX: 11, toX: 11, block: "minecraft:black_concrete" },
      { z: 0, fromX: 10, toX: 11, block: "minecraft:yellow_concrete" },
    ]);
  });

  it("el piso construido reproduce el dibujo (fila 0 al norte, columna 0 al oeste)", () => {
    const world = simulate(platanusBuildCommands(ARENA));
    const half = (FLOOR_LOGO_ROWS.length - 1) / 2;
    const toChar = Object.fromEntries([
      [FLOOR_BLOCK, " "],
      ...Object.entries(FLOOR_LOGO_PALETTE).map(([ch, entry]) => [`minecraft:${entry.block}`, ch]),
    ]);
    const rebuilt: string[] = [];
    for (let r = 0; r < FLOOR_LOGO_ROWS.length; r += 1) {
      let row = "";
      for (let col = 0; col < FLOOR_LOGO_ROWS.length; col += 1) {
        row += toChar[blockAt(world, ARENA.center.x - half + col, Y, ARENA.center.z - half + r)] ?? "?";
      }
      rebuilt.push(row);
    }
    expect(rebuilt).toEqual([...FLOOR_LOGO_ROWS]);
  });

  it("cabe entre las dos marcas de spawn, sin taparlas", () => {
    const half = (FLOOR_LOGO_ROWS.length - 1) / 2;
    expect(ARENA.spawns.red.x).toBeLessThan(ARENA.center.x - half);
    expect(ARENA.spawns.blue.x).toBeGreaterThan(ARENA.center.x + half);
  });
});

describe("Arena Platanus", () => {
  const commands = platanusBuildCommands(ARENA);
  const world = simulate(commands);
  const { minX, maxX, minZ, maxZ } = floorBounds(ARENA);

  it("tiene el tamaño de la arena original: piso de 27×27 y 25×25 caminables", () => {
    expect(maxX - minX + 1).toBe(27);
    expect(maxZ - minZ + 1).toBe(27);
    expect(ARENA.radius).toBe(12);
    for (let x = minX - 1; x <= maxX + 1; x += 1)
      for (let z = minZ - 1; z <= maxZ + 1; z += 1) {
        const inside = x >= minX && x <= maxX && z >= minZ && z <= maxZ;
        expect(blockAt(world, x, Y, z) !== "minecraft:air", `${x},${z}`).toBe(inside);
      }
  });

  it("borra los restos de la arena grande anterior: alrededor de la plataforma no queda nada", () => {
    // La arena de 57×45: piso negro y muros de vidrio de 5 bloques en x = ±28, z = ±22.
    const old = [
      `fill -28 ${Y} -22 28 ${Y} 22 minecraft:black_concrete`,
      `fill -28 ${Y + 1} -22 28 ${Y + 5} -22 minecraft:glass`,
      `fill -28 ${Y + 1} 22 28 ${Y + 5} 22 minecraft:glass`,
      `fill -28 ${Y + 1} -22 -28 ${Y + 5} 22 minecraft:glass`,
      `fill 28 ${Y + 1} -22 28 ${Y + 5} 22 minecraft:glass`,
    ];
    const after = simulate([...old, ...commands]);
    for (const [key, block] of after) {
      const [x, , z] = key.split(",").map(Number) as [number, number, number];
      expect(x >= minX && x <= maxX && z >= minZ && z <= maxZ, `${key} ${block}`).toBe(true);
      expect(block).not.toContain("glass");
    }
    // Lo construido es idéntico con o sin restos previos.
    expect([...after].sort()).toEqual([...world].sort());
    const out = surroundBounds(ARENA);
    expect(out.minX).toBeLessThanOrEqual(-28);
    expect(out.maxX).toBeGreaterThanOrEqual(28);
    expect(out.minZ).toBeLessThanOrEqual(-22);
    expect(out.maxZ).toBeGreaterThanOrEqual(22);
  });

  it("no tiene nada a la vista sobre el piso: solo pared y techo de barrera, sin huecos", () => {
    for (let y = Y + 1; y <= WALL_TOP + 1; y += 1)
      for (let x = minX; x <= maxX; x += 1)
        for (let z = minZ; z <= maxZ; z += 1) {
          const border = x === minX || x === maxX || z === minZ || z === maxZ;
          const lid = y === WALL_TOP + 1;
          expect(blockAt(world, x, y, z), `${x},${y},${z}`).toBe(border || lid ? WALL_BLOCK : "minecraft:air");
        }
    expect(WALL_BLOCK).toBe("minecraft:barrier");
    for (const [key, block] of world) {
      const y = Number(key.split(",")[1]);
      expect(y).toBeLessThanOrEqual(WALL_TOP + 1);
      if (y > Y) expect(block).toBe(WALL_BLOCK);
    }
    expect(commands.join("\n")).not.toMatch(/glass|sea_lantern/);
  });

  it("marca en el piso el lugar de cada lado", () => {
    const { red, blue } = ARENA.spawns;
    expect(blockAt(world, red.x, Y, red.z)).toBe(SPAWN_MARKS.red);
    expect(blockAt(world, blue.x, Y, blue.z)).toBe(SPAWN_MARKS.blue);
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
    expect(red.x).toBe(ARENA.center.x - 8);
    expect(blue.x).toBe(ARENA.center.x + 8);
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
    expect(teleportCommand("red", ARENA)).toBe("tp AgenteRojo -7.5 65 0.5 -90 0");
  });

  it("el círculo que usan los agentes cabe dentro de los muros", () => {
    expect(ARENA.radius).toBeLessThanOrEqual(Math.min(maxX - ARENA.center.x, maxZ - ARENA.center.z) - 1);
  });

  it("las cámaras quedan altas, en +Z (rojo a la izquierda) y fuera del piso", () => {
    for (const cam of [ARENA.camera, ARENA.cameraWide]) {
      expect(cam.x).toBe(ARENA.center.x);
      // Sobre el techo invisible, que va en WALL_TOP + 1.
      expect(cam.y).toBeGreaterThan(WALL_TOP + 1);
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
