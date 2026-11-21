import { describe, expect, it } from "vitest";
import { buildObservation, summarizeInventory, type ObservationInput } from "./observation";

const base: ObservationInput = {
  now: 12_400,
  startedAt: 2_000,
  self: {
    position: { x: -8.04, y: 65, z: 0.26 },
    health: 17.5,
    food: 20,
    heldItem: "iron_sword",
    inventory: [
      { name: "iron_sword", count: 1 },
      { name: "arrow", count: 10 },
      { name: "arrow", count: 6 },
    ],
  },
  opponent: { position: { x: -4.04, y: 65, z: 3.26 }, health: 12.34 },
  arena: { center: { x: 0, y: 64, z: 0 }, radius: 12 },
  currentAction: "attack",
  lastActionResult: "atacando",
};

describe("buildObservation", () => {
  it("conserva la posición conocida del rival aunque un obstáculo tape la línea de visión", () => {
    const obs = buildObservation({ ...base, opponentState: { position: { x: 0, y: 65, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, lineOfSight: false, equipment: [] } });
    expect(obs.opponentVisible).toBe(false);
    expect(obs.opponentRelative).not.toBeNull();
    expect(obs.opponentState?.lineOfSight).toBe(false);
  });
  it("incluye los campos del contrato con el rival visible", () => {
    const obs = buildObservation(base);
    expect(obs.distance).toBe(5);
    expect(obs.health).toBe(17.5);
    expect(obs.opponentHealth).toBe(12.3);
    expect(obs.opponentVisible).toBe(true);
    expect(obs.opponentRelative).toEqual({ x: 4, y: 0, z: 3 });
    expect(obs.secondsElapsed).toBe(10);
    expect(obs.heldItem).toBe("iron_sword");
    expect(obs.inventory).toEqual({ iron_sword: 1, arrow: 16 });
    expect(obs.currentAction).toBe("attack");
  });

  it("usa null cuando el rival no está a la vista", () => {
    const obs = buildObservation({ ...base, opponent: null });
    expect(obs.distance).toBeNull();
    expect(obs.opponentHealth).toBeNull();
    expect(obs.opponentRelative).toBeNull();
    expect(obs.opponentVisible).toBe(false);
  });

  it("usa null si se ve al rival pero no se conoce su vida", () => {
    const obs = buildObservation({ ...base, opponent: { position: { x: 0, y: 65, z: 0 }, health: null } });
    expect(obs.distance).not.toBeNull();
    expect(obs.opponentHealth).toBeNull();
  });

  it("sobrevive a JSON.stringify con las claves que usa el LLM de prueba", () => {
    const parsed = JSON.parse(JSON.stringify(buildObservation(base))) as Record<string, unknown>;
    expect(typeof parsed["distance"]).toBe("number");
    expect(typeof parsed["health"]).toBe("number");
    expect(typeof parsed["opponentHealth"]).toBe("number");
    // Y las que lee para decidir con los kits: comida, inventario y acción actual.
    expect(typeof parsed["food"]).toBe("number");
    expect(parsed["inventory"]).toEqual({ iron_sword: 1, arrow: 16 });
    expect(parsed["currentAction"]).toBe("attack");
  });

  it("no manda recargas si no hay ninguna corriendo", () => {
    const obs = buildObservation(base);
    expect("pearlCooldown" in obs).toBe(false);
    expect("buildCooldown" in obs).toBe(false);
    const past = buildObservation({ ...base, pearlReadyAt: base.now - 1 });
    expect("pearlCooldown" in past).toBe(false);
    expect("buildCooldown" in past).toBe(false);
  });

  it("informa en segundos lo que falta de cada recarga", () => {
    const obs = buildObservation({ ...base, pearlReadyAt: base.now + 3_240 });
    expect(obs.pearlCooldown).toBe(3.2);
    const onlyPearl = buildObservation({ ...base, pearlReadyAt: base.now + 1_000 });
    expect(onlyPearl.pearlCooldown).toBe(1);
    expect("buildCooldown" in onlyPearl).toBe(false);
  });

  it("cuenta las perlas y los bloques en el inventario", () => {
    const obs = buildObservation({
      ...base,
      self: {
        ...base.self,
        inventory: [
          { name: "ender_pearl", count: 3 },
          { name: "oak_planks", count: 10 },
          { name: "golden_apple", count: 2 },
        ],
      },
    });
    expect(obs.inventory).toEqual({ ender_pearl: 3, oak_planks: 10, golden_apple: 2 });
  });

  it("informa los corazones amarillos solo mientras queda alguno", () => {
    expect("absorption" in buildObservation(base)).toBe(false);
    const none = buildObservation({ ...base, self: { ...base.self, absorption: 0 } });
    expect("absorption" in none).toBe(false);
    const broken = buildObservation({ ...base, self: { ...base.self, absorption: Number.NaN } });
    expect("absorption" in broken).toBe(false);

    const fresh = buildObservation({ ...base, self: { ...base.self, absorption: 4 } });
    expect(fresh.absorption).toBe(4);
    // No se suman a la vida: son un campo aparte.
    expect(fresh.health).toBe(17.5);
    const almostGone = buildObservation({ ...base, self: { ...base.self, absorption: 0.04 } });
    expect(almostGone.absorption).toBe(0.1);
  });
});

describe("summarizeInventory", () => {
  it("suma las pilas del mismo ítem", () => {
    expect(summarizeInventory([{ name: "bread", count: 2 }, { name: "bread", count: 3 }])).toEqual({ bread: 5 });
    expect(summarizeInventory([])).toEqual({});
  });
});

describe("buildObservation: lo que llega del rival", () => {
  it("solo trae rivalThoughts / rivalMessages cuando hay algo nuevo", () => {
    const quiet = buildObservation({ ...base, rivalThoughts: [], rivalMessages: [] });
    expect(quiet).not.toHaveProperty("rivalThoughts");
    expect(quiet).not.toHaveProperty("rivalMessages");

    const thoughts = ["voy a flanquear"];
    const obs = buildObservation({ ...base, rivalThoughts: thoughts, rivalMessages: ["tregua?"] });
    expect(obs.rivalThoughts).toEqual(["voy a flanquear"]);
    expect(obs.rivalMessages).toEqual(["tregua?"]);
    // Copia: vaciar la bandeja del agente no cambia la observación ya armada.
    thoughts.length = 0;
    expect(obs.rivalThoughts).toEqual(["voy a flanquear"]);
  });

  it("solo trae conversation cuando hay mensajes, en el orden en que llegaron", () => {
    expect(buildObservation({ ...base, conversation: [] })).not.toHaveProperty("conversation");
    expect(buildObservation(base)).not.toHaveProperty("conversation");
    const conversation = [
      { from: "rival" as const, text: "¿tregua?" },
      { from: "tú" as const, text: "no" },
    ];
    const obs = buildObservation({ ...base, conversation });
    expect(obs.conversation).toEqual(conversation);
    conversation.length = 0;
    expect(obs.conversation).toHaveLength(2);
  });
});

describe("buildObservation: cola de acciones", () => {
  it("queuedActions solo aparece si queda alguna en cola, en orden", () => {
    expect(buildObservation(base)).not.toHaveProperty("queuedActions");
    expect(buildObservation({ ...base, queuedActions: [] })).not.toHaveProperty("queuedActions");
    const queued = ["eat", "attack"];
    const obs = buildObservation({ ...base, queuedActions: queued });
    expect(obs.queuedActions).toEqual(["eat", "attack"]);
    queued.push("wait");
    expect(obs.queuedActions).toEqual(["eat", "attack"]);
    expect(JSON.parse(JSON.stringify(obs)).queuedActions).toEqual(["eat", "attack"]);
  });
});

describe("buildObservation: terreno", () => {
  it("altura, bloques en medio y encierro solo aparecen cuando dicen algo", () => {
    const flat = buildObservation({ ...base, terrain: { height: 0.02, blocksBetween: 0, enclosed: false } });
    expect(flat).not.toHaveProperty("height");
    expect(flat).not.toHaveProperty("blocksBetween");
    expect(flat).not.toHaveProperty("enclosed");

    const boxed = buildObservation({ ...base, terrain: { height: 3.04, blocksBetween: 2, enclosed: true } });
    expect(boxed).toMatchObject({ height: 3, blocksBetween: 2, enclosed: true });
  });
});


describe("buildObservation: modo por rondas", () => {
  it("trae la ronda y cómo va la serie solo si hay serie", () => {
    expect(buildObservation(base)).not.toHaveProperty("round");
    expect(buildObservation({ ...base, series: null })).not.toHaveProperty("round");
    const obs = buildObservation({ ...base, series: { round: 3, won: 1, lost: 0, drawn: 1, maxRounds: 5 } });
    expect(obs).toMatchObject({ round: 3, maxRounds: 5, roundsWon: 1, roundsLost: 0, roundsDrawn: 1 });
    expect(JSON.parse(JSON.stringify(obs))).toMatchObject({ round: 3, roundsWon: 1, roundsLost: 0, roundsDrawn: 1 });
  });
});
