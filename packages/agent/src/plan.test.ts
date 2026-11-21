import { describe, expect, it } from "vitest";
import {
  ActionPlan,
  isOpenEnded,
  MAX_QUEUED_ACTIONS,
  OPEN_ENDED_TOOLS,
  OVERFLOW_RESULT,
  QUEUE_STEP_DEFAULT_MS,
  QUEUED_RESULT,
  replyResults,
  stepSeconds,
} from "./plan";
import { TOOL_NAMES } from "./tools";

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: name, name, args });

describe("ActionPlan", () => {
  it("guarda las llamadas de una respuesta y las entrega en orden", () => {
    const plan = new ActionPlan();
    expect(plan.replace([call("eat", { food: "golden_apple" }), call("attack"), call("wait")])).toBe(3);
    expect(plan.pending()).toEqual(["eat", "attack", "wait"]);
    expect(plan.next()).toEqual({ index: 0, name: "eat", args: { food: "golden_apple" } });
    expect(plan.hasNext()).toBe(true);
    expect(plan.next()?.name).toBe("attack");
    expect(plan.next()).toEqual({ index: 2, name: "wait", args: {} });
    expect(plan.hasNext()).toBe(false);
    expect(plan.next()).toBeNull();
    expect(plan.pending()).toEqual([]);
  });

  it(`admite hasta ${MAX_QUEUED_ACTIONS} llamadas por respuesta`, () => {
    const plan = new ActionPlan();
    const calls = Array.from({ length: MAX_QUEUED_ACTIONS + 3 }, (_, i) => call(i % 2 === 0 ? "attack" : "shield"));
    expect(plan.replace(calls)).toBe(MAX_QUEUED_ACTIONS);
    expect(plan.pending()).toHaveLength(MAX_QUEUED_ACTIONS);
  });

  it("una respuesta con herramientas reemplaza lo que quedaba en cola", () => {
    const plan = new ActionPlan();
    plan.replace([call("approach"), call("attack"), call("eat")]);
    plan.next();
    plan.replace([call("retreat"), call("shoot")]);
    expect(plan.pending()).toEqual(["retreat", "shoot"]);
  });

  it("una respuesta sin herramientas no toca la cola", () => {
    const plan = new ActionPlan();
    plan.replace([call("approach"), call("attack")]);
    plan.next();
    expect(plan.replace([])).toBe(0);
    expect(plan.pending()).toEqual(["attack"]);
  });

  it("tolera llamadas mal formadas", () => {
    const plan = new ActionPlan();
    plan.replace([null, { name: 3, args: [1] }, { name: "eat", args: "x" }]);
    expect(plan.next()).toEqual({ index: 0, name: "", args: {} });
    expect(plan.next()).toEqual({ index: 1, name: "", args: {} });
    expect(plan.next()).toEqual({ index: 2, name: "eat", args: {} });
  });

  it("clear vacía la cola", () => {
    const plan = new ActionPlan();
    plan.replace([call("approach"), call("attack")]);
    plan.clear();
    expect(plan.hasNext()).toBe(false);
    expect(plan.next()).toBeNull();
  });
});

describe("herramientas que no terminan solas", () => {
  it("son las de moverse, pegar, disparar, cubrirse y esperar", () => {
    expect([...OPEN_ENDED_TOOLS].sort()).toEqual(["approach", "attack", "move", "retreat", "shield", "shoot", "wait"]);
    for (const name of ["eat", "drink", "throw", "pearl", "build", "dig", "water", "lava"]) {
      expect(isOpenEnded(name)).toBe(false);
    }
    for (const name of OPEN_ENDED_TOOLS) expect((TOOL_NAMES as readonly string[]).includes(name)).toBe(true);
  });
});

describe("stepSeconds", () => {
  it("respeta los segundos que pidió el LLM", () => {
    expect(stepSeconds("attack", 5, true)).toBe(5);
    expect(stepSeconds("attack", 5, false)).toBe(5);
  });

  it("una que no termina sola con otra acción detrás dura lo de por defecto", () => {
    expect(stepSeconds("attack", null, true)).toBe(QUEUE_STEP_DEFAULT_MS / 1000);
    expect(stepSeconds("wait", null, true)).toBe(2);
  });

  it("la última (o la única) sin segundos sigue hasta que la reemplacen", () => {
    expect(stepSeconds("attack", null, false)).toBeNull();
  });

  it("las que terminan solas no reciben un plazo", () => {
    expect(stepSeconds("eat", null, true)).toBeNull();
    expect(stepSeconds("build", null, false)).toBeNull();
  });
});

describe("replyResults", () => {
  it("la que corrió lleva su resultado; las demás, que están en cola", () => {
    expect(replyResults(3, ["atacando"])).toEqual(["atacando", QUEUED_RESULT, QUEUED_RESULT]);
    expect(QUEUED_RESULT).toBe("en cola: empieza cuando termine la acción anterior");
  });

  it("si la primera no se pudo usar y corrió la segunda, las dos llevan su resultado", () => {
    expect(replyResults(3, ["no puedes comer", "atacando"])).toEqual(["no puedes comer", "atacando", QUEUED_RESULT]);
  });

  it("las que no cupieron en la cola lo dicen", () => {
    const results = replyResults(MAX_QUEUED_ACTIONS + 2, ["atacando"]);
    expect(results).toHaveLength(MAX_QUEUED_ACTIONS + 2);
    expect(results[MAX_QUEUED_ACTIONS - 1]).toBe(QUEUED_RESULT);
    expect(results[MAX_QUEUED_ACTIONS]).toBe(OVERFLOW_RESULT);
    expect(OVERFLOW_RESULT).toBe("fuera de la cola: una respuesta admite hasta 8 acciones");
  });

  it("sin llamadas no hay resultados", () => {
    expect(replyResults(0, [])).toEqual([]);
  });
});
