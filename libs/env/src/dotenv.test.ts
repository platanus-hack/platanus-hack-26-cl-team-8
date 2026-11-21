import { describe, expect, it } from "vitest";
import { applyDotEnv, parseDotEnv } from "./dotenv";

describe("parseDotEnv", () => {
  it("lee pares CLAVE=valor e ignora comentarios y líneas vacías", () => {
    const parsed = parseDotEnv(["# comentario", "", "LLM_PROVIDER=mock", "  MC_PORT = 25565  "].join("\n"));
    expect(parsed).toEqual({ LLM_PROVIDER: "mock", MC_PORT: "25565" });
  });

  it("quita comillas y comentarios al final de la línea", () => {
    const parsed = parseDotEnv(
      ['A="con espacios # no es comentario"', "B='simple'", "C=valor   # nota", "export D=4"].join("\r\n"),
    );
    expect(parsed).toEqual({ A: "con espacios # no es comentario", B: "simple", C: "valor", D: "4" });
  });

  it("conserva los '=' dentro del valor y descarta claves inválidas", () => {
    const parsed = parseDotEnv(["TOKEN=abc=def==", "1MALA=x", "=sinclave", "sin_igual"].join("\n"));
    expect(parsed).toEqual({ TOKEN: "abc=def==" });
  });

  it("deja los valores vacíos como cadena vacía", () => {
    expect(parseDotEnv("LLM_MODEL=")).toEqual({ LLM_MODEL: "" });
  });
});

describe("applyDotEnv", () => {
  it("no pisa variables ya definidas y omite valores vacíos", () => {
    const target: Record<string, string | undefined> = { LLM_PROVIDER: "openai" };
    const applied = applyDotEnv({ LLM_PROVIDER: "mock", LLM_MODEL: "", RCON_PASSWORD: "secreta" }, target);
    expect(applied).toEqual(["RCON_PASSWORD"]);
    expect(target).toEqual({ LLM_PROVIDER: "openai", RCON_PASSWORD: "secreta" });
  });
});
