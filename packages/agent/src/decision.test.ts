import { describe, expect, it } from "vitest";
import { LlmError } from "@phack/llm";
import { classifyLlmError, isValidAction } from "./decision";

describe("classifyLlmError", () => {
  it("usa status y retryable de LlmError", () => {
    expect(classifyLlmError(new LlmError("vercel", 429, "limit"), { timedOut: false })).toMatchObject({
      status: 429,
      retryable: true,
    });
    expect(classifyLlmError(new LlmError("vercel", 401, "clave"), { timedOut: false })).toMatchObject({
      status: 401,
      retryable: false,
    });
    expect(classifyLlmError(new LlmError("vercel", null, "", "error de red"), { timedOut: false })).toMatchObject({
      status: null,
      retryable: true,
    });
  });

  it("el timeout propio del agente es reintentable", () => {
    const aborted = Object.assign(new Error("solicitud cancelada"), { name: "AbortError" });
    const info = classifyLlmError(aborted, { timedOut: true });
    expect(info).toMatchObject({ status: null, retryable: true });
    expect(info.message).toMatch(/tiempo de espera/);
  });

  it("deduce de un status suelto y toma como definitivo un error sin datos", () => {
    expect(classifyLlmError({ status: 503, message: "x" }, { timedOut: false }).retryable).toBe(true);
    expect(classifyLlmError(new Error("raro"), { timedOut: false })).toEqual({
      status: null,
      retryable: false,
      message: "raro",
    });
  });
});

describe("isValidAction", () => {
  it("acepta una herramienta conocida con argumentos objeto", () => {
    expect(isValidAction({ id: "1", name: "attack", args: { reason: "cerca" } })).toBe(true);
    expect(isValidAction({ id: "1", name: "wait", args: {} })).toBe(true);
  });

  it("rechaza sin tool, tool desconocida o argumentos que no son objeto", () => {
    expect(isValidAction(undefined)).toBe(false);
    expect(isValidAction({ id: "1", name: "volar", args: {} })).toBe(false);
    expect(isValidAction({ id: "1", name: "attack", args: null as unknown as Record<string, unknown> })).toBe(false);
    expect(isValidAction({ id: "1", name: "attack", args: [] as unknown as Record<string, unknown> })).toBe(false);
  });
});
