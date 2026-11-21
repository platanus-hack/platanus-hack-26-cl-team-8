import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "@phack/env";
import { ARENA, ARENA_SCENARIOS, ARENAS, DEFAULT_ARENA_SCENARIO, arenaFor, type TemplateArena } from "@phack/protocol";
import { activeArena, buildArena, forceloadCommand, teleportCommand } from "./arena";

const PIZZA = ARENAS["pizza-spleef-2"] as TemplateArena;

describe("Pizza Spleef 2", () => {
  it("restaura la plantilla original sin generar otra arena ni eliminar decoraciones", async () => {
    const send = vi.fn(async (_command: string) => "Test passed, count: 1");
    const sleep = vi.fn(async () => {});
    await buildArena({ send }, sleep, PIZZA);
    await buildArena({ send }, sleep, PIZZA);

    const commands = send.mock.calls.map(([command]) => command);
    expect(commands.filter((command) => /^setblock /.test(command))).toEqual([]);
    // Las versiones con kits de construcción pueden retirar bloques y fluidos antes
    // de restaurar la plantilla. Nunca deben generar un piso ni muros nuevos.
    for (const command of commands.filter((command) => command.startsWith("fill "))) {
      expect(command).toMatch(/ minecraft:air replace (#minecraft:(planks|wool)|minecraft:(water|lava|fire))$/);
    }
    expect(commands.filter((command) => command.startsWith("clone "))).toEqual([
      "clone -25 6 -135 37 8 -73 -23 3 -23 replace",
      "clone -25 6 -135 37 8 -73 -23 3 -23 replace",
    ]);
    const cleanup = commands.filter((command) => command.startsWith("kill "));
    expect(cleanup).toHaveLength(8);
    for (const command of cleanup) {
      expect(command).toMatch(/^kill @e\[type=minecraft:(item|arrow|spectral_arrow|experience_orb),/);
      expect(command).toContain("distance=..");
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it("espera a los chunks antes de comprobar el mapa", async () => {
    const send = vi.fn(async (_command: string) => "Test passed, count: 1");
    send.mockResolvedValueOnce("").mockResolvedValueOnce("That position is not loaded");
    const sleep = vi.fn(async () => {});
    await buildArena({ send }, sleep, PIZZA);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(send.mock.calls[1]?.[0]).toBe(send.mock.calls[2]?.[0]);
  });

  it("rechaza el mundo anterior antes de preparar una pelea", async () => {
    const send = vi.fn(async (_command: string) => "Test failed");
    await expect(buildArena({ send }, async () => {}, PIZZA)).rejects.toThrow("No está cargado el mapa Pizza Spleef 2");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("carga el disco y ambas cámaras y coloca a los agentes sobre la pizza", () => {
    const bounds = forceloadCommand(PIZZA).split(" ").slice(2).map(Number);
    const [minX, minZ, maxX, maxZ] = bounds;
    for (const position of [PIZZA.camera, PIZZA.cameraWide, PIZZA.template.from, PIZZA.template.to, ...Object.values(PIZZA.spawns)]) {
      expect(position.x).toBeGreaterThanOrEqual(minX!);
      expect(position.x).toBeLessThanOrEqual(maxX!);
      expect(position.z).toBeGreaterThanOrEqual(minZ!);
      expect(position.z).toBeLessThanOrEqual(maxZ!);
    }
    expect(teleportCommand("red", PIZZA)).toBe("tp AgenteRojo -7.5 4 8.5 -90 0");
    expect(teleportCommand("blue", PIZZA)).toBe("tp AgenteAzul 24.5 4 8.5 90 0");
  });
});

describe("escenario activo", () => {
  it("usa Platanus por defecto y respeta ARENA_SCENARIO", () => {
    const previous = process.env.ARENA_SCENARIO;
    try {
      delete process.env.ARENA_SCENARIO;
      expect(activeArena().id).toBe("platanus");
      process.env.ARENA_SCENARIO = "pizza-spleef-2";
      expect(activeArena().id).toBe("pizza-spleef-2");
      process.env.ARENA_SCENARIO = "lava";
      expect(() => activeArena()).toThrow("Escenario de arena desconocido");
      expect(arenaFor("")).toBe(ARENA);
    } finally {
      if (previous === undefined) delete process.env.ARENA_SCENARIO;
      else process.env.ARENA_SCENARIO = previous;
    }
  });

  it("libs/env acepta exactamente los escenarios del contrato", () => {
    expect(loadEnv({}).ARENA_SCENARIO).toBe(DEFAULT_ARENA_SCENARIO);
    for (const id of ARENA_SCENARIOS) {
      expect(loadEnv({ ARENA_SCENARIO: id }).ARENA_SCENARIO).toBe(id);
      expect(ARENAS[id].id).toBe(id);
      expect(ARENAS[id].level).toBe(id);
    }
    expect(() => loadEnv({ ARENA_SCENARIO: "lava" })).toThrow();
  });
});
