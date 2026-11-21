import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BENCH_PRESETS,
  DEFAULT_SETTINGS,
  SUITE_ALL,
  syncMode,
  type AgentConfig,
  type ArenaEvent,
  type MatchSettings,
  type MatchState,
  type PromptsResponse,
  type Side,
  type UpdatePromptBody,
} from "@phack/protocol";
import { MatchActiveError } from "./match";
import { PresetRunner, UnknownPresetError } from "./presets";

function setup() {
  let settings: MatchSettings = { ...DEFAULT_SETTINGS, judge: true };
  const prompts: PromptsResponse = {
    red: { side: "red", prompt: "viejo rojo", provider: "vercel", model: "a/rojo", kit: "tank" },
    blue: { side: "blue", prompt: "viejo azul", provider: "vercel", model: "b/azul", kit: "archer" },
  };
  let active = false;
  let reason: "kill" | "stopped" = "kill";
  const starts: MatchSettings[] = [];
  const events: ArenaEvent[] = [];
  const runner = new PresetRunner({
    prompts: {
      get: () => structuredClone(prompts),
      update: async (side: Side, body: UpdatePromptBody): Promise<AgentConfig> => {
        prompts[side] = { side, ...body };
        return prompts[side];
      },
    },
    settings: {
      get: () => settings,
      update: async (change) => {
        settings = syncMode({ ...settings, ...change });
        return settings;
      },
    },
    match: {
      start: () => {
        active = true;
        starts.push(structuredClone(settings));
        return {} as MatchState;
      },
      isActive: () => active,
      getState: () => ({ result: { winner: null, reason } }) as MatchState,
    },
    hub: { broadcast: (event) => events.push(event) },
    log: () => {},
    pollMs: 5,
  });
  return {
    runner,
    prompts,
    settings: () => settings,
    starts,
    events,
    finish: (how: "kill" | "stopped" = "kill") => {
      reason = how;
      active = false;
    },
    setActive: (value: boolean) => {
      active = value;
    },
  };
}

let current: PresetRunner | null = null;
afterEach(() => {
  current?.shutdown();
  current = null;
});

describe("PresetRunner", () => {
  it("cargar un pre-ajuste fija ajustes, prompts y kits, y conserva el modelo de cada lado", async () => {
    const t = setup();
    current = t.runner;
    await t.runner.run("postura", false);
    expect(t.settings()).toMatchObject({ scenario: "surrender", rounds: 3, mode: "rounds", comms: "chat", judge: true });
    expect(t.prompts.red).toMatchObject({ kit: "classic", model: "a/rojo" });
    expect(t.prompts.blue).toMatchObject({ kit: "classic", model: "b/azul" });
    expect(t.starts).toHaveLength(0);
    expect(t.events.map((e) => e.type)).toEqual(["settings", "prompts"]);
  });

  it("con start ejecuta uno; la batería corre todos en orden, cada uno cuando termina el anterior", async () => {
    const t = setup();
    current = t.runner;
    await t.runner.run(SUITE_ALL, true);
    expect(t.starts).toHaveLength(1);
    expect(t.runner.snapshot().suite).toMatchObject({ running: true, index: 0, queue: BENCH_PRESETS.map((p) => p.id) });
    for (let i = 1; i < BENCH_PRESETS.length; i += 1) {
      t.finish();
      await vi.waitFor(() => expect(t.starts).toHaveLength(i + 1));
    }
    expect(t.starts.map((s) => s.scenario)).toEqual(BENCH_PRESETS.map((p) => p.settings.scenario));
    t.finish();
    await vi.waitFor(() => expect(t.runner.snapshot().suite.running).toBe(false));
    expect(t.runner.snapshot().suite).toMatchObject({ done: BENCH_PRESETS.length, stoppedReason: null });
  });

  it("si se detiene una partida, la batería no sigue; también se puede cortar a mano", async () => {
    const t = setup();
    current = t.runner;
    await t.runner.run(SUITE_ALL, true);
    t.finish("stopped");
    await vi.waitFor(() => expect(t.runner.snapshot().suite.running).toBe(false));
    expect(t.runner.snapshot().suite.stoppedReason).toContain("se detuvo");
    expect(t.starts).toHaveLength(1);

    const u = setup();
    current = u.runner;
    await u.runner.run(SUITE_ALL, true);
    expect(u.runner.stop().suite).toMatchObject({ running: false, stoppedReason: "detenida a mano" });
    u.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(u.starts).toHaveLength(1);
  });

  it("no arranca con una pelea en curso ni con un id que no existe", async () => {
    const t = setup();
    current = t.runner;
    await expect(t.runner.run("nada", false)).rejects.toBeInstanceOf(UnknownPresetError);
    t.setActive(true);
    await expect(t.runner.run("postura", true)).rejects.toBeInstanceOf(MatchActiveError);
  });

  it("todos los pre-ajustes son válidos: escenario, rondas y duración dentro de los límites", () => {
    for (const preset of BENCH_PRESETS) {
      const parsed = syncMode({ ...DEFAULT_SETTINGS, ...preset.settings });
      expect(parsed.rounds).toBeGreaterThanOrEqual(1);
      expect(parsed.timerSeconds).toBeGreaterThanOrEqual(60);
      expect(preset.prompts.red.prompt.length).toBeGreaterThan(0);
    }
    expect(new Set(BENCH_PRESETS.map((p) => p.id)).size).toBe(BENCH_PRESETS.length);
  });
});

describe("pre-ajustes: el escenario va en el prompt del jugador", () => {
  it("cada pre-ajuste explica sus rondas y cómo se gana en el prompt de los dos lados", () => {
    for (const preset of BENCH_PRESETS) {
      for (const side of ["red", "blue"] as const) {
        expect(preset.prompts[side].prompt).toMatch(/La partida es/);
        expect(preset.prompts[side].prompt.length).toBeLessThanOrEqual(4000);
      }
    }
    const rules = BENCH_PRESETS.find((p) => p.id === "reglas");
    expect(rules?.prompts.red.prompt).toContain("nunca uses el arco");
    // La inyección y los avisos falsos no se anuncian: son lo que se mide.
    for (const id of ["inyeccion", "verificar"]) {
      const preset = BENCH_PRESETS.find((p) => p.id === id);
      expect(preset?.prompts.red.prompt).not.toMatch(/árbitro|aviso/i);
    }
  });
});
