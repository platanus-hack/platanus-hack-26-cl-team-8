import { describe, expect, it } from "vitest";
import type { AgentStatus, MatchRecord, MatchResult, Side } from "@phack/protocol";
import {
  MAX_EXPLANATION_LENGTH,
  buildExplanationMessages,
  cleanExplanation,
  fallbackExplanation,
  shouldExplain,
  summarizeMatch,
} from "./explain";

function status(side: Side, extra: Partial<AgentStatus> = {}): AgentStatus {
  return {
    side,
    username: side === "red" ? "AgenteRojo" : "AgenteAzul",
    connected: true,
    alive: true,
    health: 20,
    food: 20,
    damageDealt: 0,
    decisions: 10,
    lastThought: "",
    lastAction: "",
    heldItem: "",
    tokensIn: 0,
    tokensOut: 0,
    avgDecisionMs: 0,
    ...extra,
  };
}

function record(result: MatchResult, red: Partial<AgentStatus> = {}, blue: Partial<AgentStatus> = {}): MatchRecord {
  return {
    id: "m1",
    startedAt: 0,
    endedAt: 42_400,
    durationMs: 42_400,
    configs: {
      red: { side: "red", prompt: "Eres agresivo: acércate y ataca sin parar.", provider: "openai", model: "gpt-x" },
      blue: { side: "blue", prompt: "Eres defensivo:\n\nmantén distancia y usa el arco." },
    },
    final: { red: status("red", red), blue: status("blue", blue) },
    result,
  };
}

describe("shouldExplain", () => {
  it("explica KO, tiempo con ganador y empate; no peleas detenidas ni con error", () => {
    expect(shouldExplain({ winner: "red", reason: "kill" })).toBe(true);
    expect(shouldExplain({ winner: "blue", reason: "timeout_health" })).toBe(true);
    expect(shouldExplain({ winner: null, reason: "draw" })).toBe(true);
    expect(shouldExplain({ winner: null, reason: "stopped" })).toBe(false);
    expect(shouldExplain({ winner: null, reason: "error" })).toBe(false);
  });
});

describe("buildExplanationMessages", () => {
  it("arma un system con las reglas y un user con el resumen y la pregunta", () => {
    const rec = record(
      { winner: "red", reason: "kill" },
      { damageDealt: 20, decisions: 30, avgDecisionMs: 812.4, health: 13.5 },
      { alive: false, health: 0, damageDealt: 6.5, decisions: 22, avgDecisionMs: 1400 },
    );
    const messages = buildExplanationMessages(rec);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("UNA sola frase en español");
    expect(messages[0]?.content).toContain("200 caracteres");
    expect(messages[1]?.role).toBe("user");
    const user = messages[1]?.content ?? "";
    expect(user).toContain("ganó Rojo por KO");
    expect(user).toContain("Duración: 42 s.");
    expect(user).toContain('Rojo (openai/gpt-x): prompt "Eres agresivo: acércate y ataca sin parar."');
    // Los saltos de línea del prompt se juntan para que el resumen quede compacto.
    expect(user).toContain('Azul (modelo por defecto): prompt "Eres defensivo: mantén distancia y usa el arco."');
    expect(user).toContain("Vida final 13,5/20, daño hecho 20, 30 decisiones, 812 ms promedio");
    expect(user).toContain("Vida final 0/20, daño hecho 6,5, 22 decisiones, 1400 ms promedio");
    expect(user.endsWith("Explica por qué ganó Rojo.")).toBe(true);
  });

  it("pregunta por el empate cuando no hay ganador", () => {
    const messages = buildExplanationMessages(record({ winner: null, reason: "draw" }));
    expect(messages[1]?.content.endsWith("Explica por qué la pelea terminó en empate.")).toBe(true);
  });

  it("trunca los prompts largos", () => {
    const rec = record({ winner: "red", reason: "kill" });
    rec.configs.red.prompt = "a".repeat(4000);
    expect(summarizeMatch(rec).length).toBeLessThan(1000);
  });
});

describe("cleanExplanation", () => {
  it("recorta, junta espacios y quita comillas que envuelven la frase", () => {
    expect(cleanExplanation('  "Rojo ganó\n  porque atacó sin parar."  ')).toBe("Rojo ganó porque atacó sin parar.");
    expect(cleanExplanation("«“Azul ganó a distancia.”»")).toBe("Azul ganó a distancia.");
    expect(cleanExplanation("'Empate.'")).toBe("Empate.");
  });

  it("no toca comillas internas", () => {
    expect(cleanExplanation('Rojo siguió su "ataca sin parar" y ganó.')).toBe('Rojo siguió su "ataca sin parar" y ganó.');
  });

  it("devuelve vacío si no queda texto", () => {
    expect(cleanExplanation("   ")).toBe("");
    expect(cleanExplanation('""')).toBe("");
  });

  it("corta al máximo del contrato", () => {
    const out = cleanExplanation("x".repeat(1000));
    expect(out.length).toBe(MAX_EXPLANATION_LENGTH);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("fallbackExplanation", () => {
  it("KO: daño, vida final y, si corresponde, velocidad de decisión", () => {
    const text = fallbackExplanation(
      record(
        { winner: "red", reason: "kill" },
        { damageDealt: 20, health: 13.5, avgDecisionMs: 700 },
        { alive: false, health: 0, damageDealt: 6.5, avgDecisionMs: 1400 },
      ),
    );
    expect(text).toBe(
      "Rojo ganó por KO a los 42 s: hizo 20 de daño contra 6,5 de Azul y terminó con 13,5/20 de vida, " +
        "decidiendo más rápido (700 ms frente a 1400 ms).",
    );
  });

  it("KO sin diferencia clara de velocidad no la menciona", () => {
    const text = fallbackExplanation(
      record({ winner: "blue", reason: "kill" }, { alive: false, health: 0, avgDecisionMs: 900 }, { damageDealt: 20, avgDecisionMs: 1000 }),
    );
    expect(text).toBe("Azul ganó por KO a los 42 s: hizo 20 de daño contra 0 de Rojo y terminó con 20/20 de vida.");
  });

  it("tiempo con ganador por vida", () => {
    const text = fallbackExplanation(
      record({ winner: "blue", reason: "timeout_health" }, { health: 9, damageDealt: 6 }, { health: 14, damageDealt: 11 }),
    );
    expect(text).toBe(
      "Se acabó el tiempo y Azul ganó por vida: terminó con 14/20 frente a 9/20 de Rojo, tras hacer 11 de daño contra 6.",
    );
  });

  it("empate con y sin daño", () => {
    expect(fallbackExplanation(record({ winner: null, reason: "draw" }))).toBe(
      "Empate: en 42 s ninguno logró dañar al otro y ambos terminaron con 20/20 de vida.",
    );
    expect(
      fallbackExplanation(record({ winner: null, reason: "draw" }, { health: 15, damageDealt: 5 }, { health: 15, damageDealt: 5 })),
    ).toBe("Empate: al acabarse el tiempo ambos quedaron con 15/20 de vida (Rojo hizo 5 de daño y Azul 5).");
  });

  it("peleas detenidas o con error también dan una frase válida", () => {
    expect(fallbackExplanation(record({ winner: null, reason: "stopped" }))).toContain("se detuvo a mano");
    expect(fallbackExplanation(record({ winner: null, reason: "error" }))).toContain("error");
  });

  it("nunca pasa del máximo del contrato", () => {
    const text = fallbackExplanation(
      record({ winner: "red", reason: "kill" }, { damageDealt: 1e300, avgDecisionMs: 1 }, { alive: false, avgDecisionMs: 1e300 }),
    );
    expect(text.length).toBeLessThanOrEqual(MAX_EXPLANATION_LENGTH);
  });
});
