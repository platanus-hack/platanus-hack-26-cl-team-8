import { describe, expect, it } from "vitest";
import { loadEnv, loadEnvKeys } from "./index";

describe("loadEnv con un .env de antes", () => {
  it('lee "gateway" como "vercel" y usa su clave antigua', () => {
    const env = loadEnv({ LLM_PROVIDER: "gateway", AI_GATEWAY_API_KEY: "clave-vieja" });
    expect(env.LLM_PROVIDER).toBe("vercel");
    expect(env.VERCEL_API_KEY).toBe("clave-vieja");
  });

  it("no pisa VERCEL_API_KEY si ya está", () => {
    const env = loadEnv({ LLM_PROVIDER: "vercel", VERCEL_API_KEY: "nueva", AI_GATEWAY_API_KEY: "vieja" });
    expect(env.VERCEL_API_KEY).toBe("nueva");
  });

  it("explica qué poner cuando el proveedor ya no existe", () => {
    expect(() => loadEnv({ LLM_PROVIDER: "openai" })).toThrow(/ya no existe.*vercel.*mock/s);
  });

  it("sigue rechazando un valor desconocido", () => {
    expect(() => loadEnv({ LLM_PROVIDER: "otro" })).toThrow(/LLM_PROVIDER/);
  });
});

describe("loadEnvKeys", () => {
  it("ignora un valor malo en una variable que no se pidió", () => {
    const env = loadEnvKeys(["MC_HOST", "MC_PORT"], { LLM_PROVIDER: "openai", MC_PORT: "25570" });
    expect(env).toEqual({ MC_HOST: "127.0.0.1", MC_PORT: 25570 });
  });

  it("valida las que sí se pidieron", () => {
    expect(() => loadEnvKeys(["MC_PORT"], { MC_PORT: "no-es-numero" })).toThrow(/MC_PORT/);
  });
});
