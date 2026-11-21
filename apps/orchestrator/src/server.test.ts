import { describe, expect, it } from "vitest";
import { applyModelPolicy, type ModelPolicy } from "./server";

/** Regla que aplica PUT /api/prompts/:side antes de guardar (la parte pura de la ruta). */

const ALLOWED = ["deepseek/barato"];
const models: ModelPolicy = { isAllowed: (id) => ALLOWED.includes(id) };

describe("applyModelPolicy", () => {
  it("sin modelo no hay nada que revisar", () => {
    const body = { prompt: "hola", kit: "tank" as const };
    expect(applyModelPolicy(body, "vercel", models)).toEqual(body);
    expect(applyModelPolicy({ prompt: "hola", model: "   " }, "vercel", models)).toEqual({ prompt: "hola", model: "   " });
  });

  it("acepta un modelo de la lista y conserva el resto del cuerpo", () => {
    const body = { prompt: "hola", provider: "vercel" as const, model: "deepseek/barato", kit: "ender" as const };
    expect(applyModelPolicy(body, "mock", models)).toEqual(body);
    // Sin proveedor en el cuerpo vale el del servidor.
    expect(applyModelPolicy({ prompt: "hola", model: "deepseek/barato" }, "vercel", models)).toEqual({
      prompt: "hola",
      model: "deepseek/barato",
    });
  });

  it("rechaza un modelo que no está en la lista", () => {
    expect(applyModelPolicy({ prompt: "hola", provider: "vercel", model: "openai/caro" }, "mock", models)).toBeNull();
    expect(applyModelPolicy({ prompt: "hola", model: "openai/caro" }, "vercel", models)).toBeNull();
  });

  it("con el proveedor simulado descarta el modelo en vez de rechazar", () => {
    expect(
      applyModelPolicy({ prompt: "hola", provider: "mock", model: "openai/caro", kit: "archer" }, "vercel", models),
    ).toEqual({ prompt: "hola", provider: "mock", kit: "archer" });
    // El servidor simula por defecto y el cuerpo no elige proveedor: también es simulado.
    const dropped = applyModelPolicy({ prompt: "hola", model: "openai/caro" }, "mock", models);
    expect(dropped).toEqual({ prompt: "hola" });
    expect(dropped && "model" in dropped).toBe(false);
  });

  it("no modifica el cuerpo que recibe", () => {
    const body = { prompt: "hola", provider: "mock" as const, model: "openai/caro" };
    applyModelPolicy(body, "vercel", models);
    expect(body).toEqual({ prompt: "hola", provider: "mock", model: "openai/caro" });
  });
});
