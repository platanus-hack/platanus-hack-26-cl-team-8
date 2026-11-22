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

describe("radio de observación", () => {
  it("usa 16 por defecto y admite configurarlo entre 8 y 64 bloques", () => {
    expect(loadEnv({}).AGENT_OBSERVATION_RADIUS).toBe(16);
    expect(loadEnv({ AGENT_OBSERVATION_RADIUS: "24" }).AGENT_OBSERVATION_RADIUS).toBe(24);
    for (const value of ["0", "7", "65", "16.5", "NaN"]) {
      expect(() => loadEnv({ AGENT_OBSERVATION_RADIUS: value })).toThrow(/AGENT_OBSERVATION_RADIUS/);
    }
  });
});

describe("voz de los agentes", () => {
  it("sin nada configurado no hay voz y valen los valores por defecto", () => {
    const env = loadEnv({});
    expect(env.ELEVENLABS_API_KEY).toBe("");
    expect(env.ELEVENLABS_VOICE_RED).toBe("");
    expect(env.ELEVENLABS_VOICE_BLUE).toBe("");
    // Las voces japonesas vienen puestas: el par alternativo anda sin tocar el .env.
    expect(env.ELEVENLABS_VOICE_JAPANESE_RED).toBe("jyogAI7BN5DyoykAgSk6");
    expect(env.ELEVENLABS_VOICE_JAPANESE_BLUE).toBe("nkmkwBCNHgzLGGnbmMTD");
    expect(env.ELEVENLABS_MODEL).toBe("eleven_flash_v2_5");
    expect(env.ELEVENLABS_SPEED).toBe(1.1);
    expect(env.ELEVENLABS_OUTPUT_FORMAT).toBe("mp3_44100_64");
    expect(env.ELEVENLABS_LANGUAGE).toBe("");
    expect(env.VOICE_MAX_CHARS).toBe(300);
    expect(env.VOICE_MIN_CREDITS_LEFT).toBe(5000);
  });

  it("lee los valores puestos y trata un número vacío como no puesto", () => {
    const env = loadEnv({ ELEVENLABS_SPEED: "0.9", VOICE_MAX_CHARS: "120", VOICE_MIN_CREDITS_LEFT: "" });
    expect(env.ELEVENLABS_SPEED).toBe(0.9);
    expect(env.VOICE_MAX_CHARS).toBe(120);
    expect(env.VOICE_MIN_CREDITS_LEFT).toBe(5000);
    expect(loadEnv({ ELEVENLABS_SPEED: "" }).ELEVENLABS_SPEED).toBe(1.1);
  });

  it("rechaza un largo máximo que no sirve", () => {
    expect(() => loadEnv({ VOICE_MAX_CHARS: "0" })).toThrow(/VOICE_MAX_CHARS/);
    expect(() => loadEnv({ ELEVENLABS_SPEED: "rápido" })).toThrow(/ELEVENLABS_SPEED/);
  });
});

describe("loadEnv: voz", () => {
  it("un modelo o formato vacío en el .env vale como no puesto", () => {
    const env = loadEnv({ ELEVENLABS_MODEL: "", ELEVENLABS_OUTPUT_FORMAT: "  " });
    expect(env.ELEVENLABS_MODEL).toBe("eleven_flash_v2_5");
    expect(env.ELEVENLABS_OUTPUT_FORMAT).toBe("mp3_44100_64");
  });
});
