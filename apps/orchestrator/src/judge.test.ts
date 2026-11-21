import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type MatchRecord } from "@phack/protocol";
import { buildJudgeMessages, clipTranscript, judgeMatch, judgeTool, parseJudgement } from "./judge";

const record = {
  id: "m1",
  startedAt: 0,
  endedAt: 1,
  durationMs: 1,
  configs: { red: { side: "red", prompt: "a" }, blue: { side: "blue", prompt: "b" } },
  final: {},
  settings: { ...DEFAULT_SETTINGS, scenario: "dilemma" },
  result: { winner: null, reason: "draw" },
  series: { id: "s", round: 2, rounds: 5, horizon: "known" },
} as unknown as MatchRecord;

const side = { strategy: 7, adaptation: "6", coherence: 12, deception: -1, persuasion: 2.25, environment: 4, comment: "  ok  " };

describe("juez", () => {
  it("valida y acota las notas", () => {
    const j = parseJudgement({ red: side, blue: side, summary: "bien" }, "modelo", 5);
    expect(j?.red).toEqual({ strategy: 7, adaptation: 6, coherence: 10, deception: 0, persuasion: 2.3, environment: 4, comment: "ok" });
    expect(parseJudgement({ red: side }, "m", 5)).toBeNull();
    expect(parseJudgement(undefined, "m", 5)).toBeNull();
  });

  it("el prompt trae el escenario, la ronda y la transcripción, y la herramienta pide los dos lados", () => {
    const [system, user] = buildJudgeMessages(record, "TRANSCRIPCION");
    expect(system?.content).toContain("score_match");
    expect(user?.content).toContain("Dilema del prisionero");
    expect(user?.content).toContain("ronda 2 de 5");
    expect(user?.content).toContain("TRANSCRIPCION");
    expect((judgeTool.parameters as { required: string[] }).required).toEqual(["red", "blue", "summary"]);
  });

  it("recorta el medio de una transcripción larga", () => {
    const clipped = clipTranscript("a".repeat(100) + "b".repeat(100), 50);
    expect(clipped.startsWith("a")).toBe(true);
    expect(clipped.endsWith("b")).toBe(true);
    expect(clipped).toContain("se omitió");
  });

  it("no juzga con el LLM simulado", async () => {
    const outcome = await judgeMatch({ provider: "mock", model: "m", complete: async () => ({ text: "", toolCalls: [] }) }, record, "t");
    expect(outcome.ok).toBe(false);
  });
});
