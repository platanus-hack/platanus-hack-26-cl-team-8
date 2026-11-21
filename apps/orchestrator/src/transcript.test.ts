import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTranscript, parseTranscript, type TranscriptEntry } from "@phack/protocol";
import { TranscriptStore, isTranscriptId } from "./transcript";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phack-transcript-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isTranscriptId", () => {
  it("solo acepta UUID en minúsculas", () => {
    expect(isTranscriptId(randomUUID())).toBe(true);
    expect(isTranscriptId("0F8FAD5B-D9CB-469F-A165-70867728950E")).toBe(false);
    expect(isTranscriptId("../../etc/passwd")).toBe(false);
    expect(isTranscriptId(`${randomUUID()}/../x`)).toBe(false);
    expect(isTranscriptId("")).toBe(false);
  });
});

describe("TranscriptStore", () => {
  it("escribe y lee la transcripción de una pelea", async () => {
    const store = new TranscriptStore(dir, () => {});
    const id = randomUUID();
    store.append(id, { type: "phase", at: 1, phase: "running" });
    store.append(id, { type: "message", at: 2, side: "red", text: "¡Ven acá!" });
    const raw = await store.read(id);
    expect(raw).not.toBeNull();
    expect(raw?.endsWith("\n")).toBe(true);
    expect(parseTranscript(raw ?? "")).toEqual([
      { type: "phase", at: 1, phase: "running" },
      { type: "message", at: 2, side: "red", text: "¡Ven acá!" },
    ]);
    expect(await readdir(join(dir, "transcripts"))).toEqual([`${id}.jsonl`]);
  });

  it("devuelve null si la pelea no tiene transcripción", async () => {
    const store = new TranscriptStore(dir, () => {});
    expect(await store.read(randomUUID())).toBeNull();
  });

  it("rechaza ids inválidos sin tocar el disco", async () => {
    const log = vi.fn();
    const store = new TranscriptStore(dir, log);
    store.append("../fuera", { type: "phase", at: 1, phase: "running" });
    await store.flush();
    expect(await store.read("../fuera")).toBeNull();
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("inválido"));
    expect(await readdir(dir)).toEqual([]);
  });

  it("mantiene el orden con muchas escrituras seguidas", async () => {
    const store = new TranscriptStore(dir, () => {});
    const id = randomUUID();
    for (let i = 0; i < 300; i++) store.append(id, { type: "log", at: i, level: "info", text: `línea ${i}` });
    const entries = parseTranscript((await store.read(id)) ?? "");
    expect(entries.map((entry) => entry.at)).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });

  it("un error de disco se registra y no lanza", async () => {
    const log = vi.fn();
    // Una ruta con un byte nulo hace fallar mkdir y appendFile.
    const store = new TranscriptStore(join(dir, "no-existe", "\u0000"), log);
    expect(() => store.append(randomUUID(), { type: "phase", at: 1, phase: "running" })).not.toThrow();
    await store.flush();
    expect(log).toHaveBeenCalledWith("error", expect.stringContaining("No se pudo escribir"));
  });

  it("se lee como texto con formatTranscript", async () => {
    const store = new TranscriptStore(dir, () => {});
    const id = randomUUID();
    const entries: TranscriptEntry[] = [
      {
        type: "start",
        at: 0,
        matchId: id,
        configs: { red: { side: "red", prompt: "ataca" }, blue: { side: "blue", prompt: "defiende" } },
        settings: { comms: "chat", timer: true },
        systemPrompts: { red: "sistema rojo", blue: "sistema azul" },
        tickMs: 1500,
        durationSeconds: 180,
      },
      { type: "phase", at: 1000, phase: "running" },
      { type: "message", at: 3500, side: "blue", text: "No me alcanzas" },
    ];
    for (const entry of entries) store.append(id, entry);
    const text = formatTranscript(parseTranscript((await store.read(id)) ?? ""));
    expect(text).toContain(`Pelea ${id}`);
    expect(text).toContain("Azul    dice: «No me alcanzas»");
    expect(text).toContain("0:02.5");
  });
});
