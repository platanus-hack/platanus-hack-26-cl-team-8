import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARENAS, type IslandsArena } from "@phack/protocol";
import {
  arenaAt,
  currentArena,
  orchestratorView,
  parseEntityPos,
  pickScenario,
  setCurrentArena,
  trackOnce,
  type ArenaTrackerDeps,
} from "./arena";

const BUILT = ["platanus", "chunk-battle"] as const;
const [RED_ISLAND, BLUE_ISLAND] = (ARENAS["chunk-battle"] as IslandsArena).islands;

describe("mapa por posición", () => {
  it("ubica a un peleador en Platanus, en cualquiera de las islas o en ninguna parte", () => {
    expect(arenaAt({ x: -16, z: 0 }, BUILT)).toBe("platanus");
    expect(arenaAt({ x: RED_ISLAND.from.x + 3, z: 0 }, BUILT)).toBe("chunk-battle");
    expect(arenaAt({ x: BLUE_ISLAND.to.x - 3, z: 2 }, BUILT)).toBe("chunk-battle");
    // Sobre el hueco entre islas (puente) también es Chunk Battle.
    expect(arenaAt({ x: 1000, z: 0 }, BUILT)).toBe("chunk-battle");
    expect(arenaAt({ x: 500, z: 0 }, BUILT)).toBeNull();
  });

  it("lee la respuesta de data get entity", () => {
    expect(parseEntityPos("AgenteRojo has the following entity data: [986.5d, 65.0d, -0.5d]")).toEqual({ x: 986.5, y: 65, z: -0.5 });
    expect(parseEntityPos("No entity was found")).toBeNull();
  });
});

describe("pickScenario", () => {
  it("con pelea en el orquestador manda él; en reposo mandan los peleadores; si no, el último mapa", () => {
    const fighterOnIsland = { x: 990, y: 65, z: 0 };
    expect(pickScenario({ phase: "preparing", scenario: "chunk-battle" }, [], BUILT)).toBe("chunk-battle");
    expect(pickScenario({ phase: "running", scenario: "platanus" }, [fighterOnIsland], BUILT)).toBe("platanus");
    // Pelea del torneo por CLI: el orquestador está en reposo, pero los bots están en las islas.
    expect(pickScenario({ phase: "idle", scenario: "platanus" }, [null, fighterOnIsland], BUILT)).toBe("chunk-battle");
    expect(pickScenario(null, [fighterOnIsland], BUILT)).toBe("chunk-battle");
    // Tras una pelea de la web el orquestador queda en "finished": eso no es una pelea en
    // curso, así que una partida del torneo en las islas igual se sigue por los peleadores.
    expect(pickScenario({ phase: "finished", scenario: "platanus" }, [fighterOnIsland], BUILT)).toBe("chunk-battle");
    expect(pickScenario({ phase: "finished", scenario: "chunk-battle" }, [null, null], BUILT)).toBe("chunk-battle");
    expect(pickScenario({ phase: "idle", scenario: "chunk-battle" }, [null, null], BUILT)).toBe("chunk-battle");
    expect(pickScenario(null, [], BUILT)).toBeNull();
    // Un mapa que el servidor no puede construir se ignora.
    expect(pickScenario({ phase: "running", scenario: "pizza-spleef-2" }, [], BUILT)).toBeNull();
  });

  it("acepta el estado de un orquestador más viejo (sin arena = Platanus)", () => {
    const state = {
      id: "",
      phase: "idle",
      startedAt: null,
      endsAt: null,
      agents: {
        red: { side: "red", username: "AgenteRojo", connected: false, alive: false, health: 20, food: 20, damageDealt: 0, decisions: 0, lastThought: "", lastAction: "" },
        blue: { side: "blue", username: "AgenteAzul", connected: false, alive: false, health: 20, food: 20, damageDealt: 0, decisions: 0, lastThought: "", lastAction: "" },
      },
      configs: { red: { side: "red", prompt: "" }, blue: { side: "blue", prompt: "" } },
      result: null,
    };
    expect(orchestratorView(state)).toEqual({ phase: "idle", scenario: "platanus" });
    expect(orchestratorView({ ...state, phase: "running", arena: "chunk-battle" })).toEqual({ phase: "running", scenario: "chunk-battle" });
    expect(orchestratorView({ nada: true })).toBeNull();
  });
});

describe("trackOnce", () => {
  const previous = process.env.ARENA_SCENARIO;
  beforeEach(() => {
    delete process.env.ARENA_SCENARIO;
    setCurrentArena("platanus");
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.ARENA_SCENARIO;
    else process.env.ARENA_SCENARIO = previous;
  });

  function deps(state: unknown, replies: string[] = []): ArenaTrackerDeps & { onChange: ReturnType<typeof vi.fn>; rcon: ReturnType<typeof vi.fn> } {
    return {
      orchestratorUrl: "http://orquestador:8787/",
      rcon: vi.fn(async () => replies),
      onChange: vi.fn(),
      log: () => {},
      fetchFn: (async (url: string) => {
        expect(url).toBe("http://orquestador:8787/api/state");
        if (state === null) throw new Error("ECONNREFUSED");
        return new Response(JSON.stringify(state));
      }) as typeof fetch,
    };
  }

  const running = (scenario: string) => ({
    id: "m",
    phase: "running",
    startedAt: 1,
    endsAt: 2,
    result: null,
    arena: scenario,
    agents: {
      red: { side: "red", username: "AgenteRojo", connected: true, alive: true, health: 20, food: 20, damageDealt: 0, decisions: 0, lastThought: "", lastAction: "" },
      blue: { side: "blue", username: "AgenteAzul", connected: true, alive: true, health: 20, food: 20, damageDealt: 0, decisions: 0, lastThought: "", lastAction: "" },
    },
    configs: { red: { side: "red", prompt: "" }, blue: { side: "blue", prompt: "" } },
  });

  it("reencuadra cuando la pelea del orquestador cambia de mapa, sin preguntar por RCON", async () => {
    const d = deps(running("chunk-battle"));
    expect(await trackOnce(d)).toBe("chunk-battle");
    expect(currentArena().id).toBe("chunk-battle");
    expect(d.onChange).toHaveBeenCalledTimes(1);
    expect(d.rcon).not.toHaveBeenCalled();
    // Mismo mapa: no se vuelve a avisar.
    await trackOnce(d);
    expect(d.onChange).toHaveBeenCalledTimes(1);
  });

  it("sin orquestador, sigue a los peleadores por RCON", async () => {
    const d = deps(null, ["No entity was found", "AgenteAzul has the following entity data: [1013.5d, 65.0d, 0.5d]"]);
    expect(await trackOnce(d)).toBe("chunk-battle");
    expect(d.rcon).toHaveBeenCalledWith(["data get entity AgenteRojo Pos", "data get entity AgenteAzul Pos"]);
    expect(d.onChange).toHaveBeenCalledTimes(1);
  });

  it("con la pizza (un solo mapa posible) no hace nada", async () => {
    process.env.ARENA_SCENARIO = "pizza-spleef-2";
    const d = deps(running("chunk-battle"));
    expect(await trackOnce(d)).toBeNull();
    expect(d.onChange).not.toHaveBeenCalled();
  });
});
