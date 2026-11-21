import { describe, expect, it } from "vitest";
import type { AgentStatus, MatchRecord, MatchResult, RoundResult, Side } from "@phack/protocol";
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
      red: {
        side: "red",
        prompt: "Eres agresivo: acércate y ataca sin parar.",
        provider: "vercel",
        model: "deepseek/x",
        kit: "berserker",
      },
      blue: { side: "blue", prompt: "Eres defensivo:\n\nmantén distancia y usa el arco." },
    },
    settings: { comms: "none", timer: true, timerSeconds: null, mode: "single" },
    series: null,
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
    // Solo el modelo (sin el proveedor delante) y el nombre del kit de cada lado.
    expect(user).toContain('Rojo (deepseek/x, kit Berserker): prompt "Eres agresivo: acércate y ataca sin parar."');
    expect(user).not.toContain("vercel");
    // Los saltos de línea del prompt se juntan para que el resumen quede compacto; sin kit
    // guardado (registros viejos) vale el kit por defecto.
    expect(user).toContain(
      'Azul (modelo por defecto, kit Clásico): prompt "Eres defensivo: mantén distancia y usa el arco."',
    );
    expect(user).toContain("Vida final 13,5/30, daño hecho 20, 30 decisiones, 812 ms promedio");
    expect(user).toContain("Vida final 0/30, daño hecho 6,5, 22 decisiones, 1400 ms promedio");
    expect(user.endsWith("Explica por qué ganó Rojo.")).toBe(true);
  });

  it("el proveedor simulado se nombra como tal, sin su modelo de mentira", () => {
    const rec = record({ winner: "red", reason: "kill" });
    rec.configs.blue = { side: "blue", prompt: "defiende", provider: "mock", model: "mock-scripted", kit: "tank" };
    const summary = summarizeMatch(rec);
    expect(summary).toContain('Azul (simulado, kit Tanque): prompt "defiende"');
    expect(summary).not.toContain("mock-scripted");
  });

  it("el system le explica al comentarista qué es un kit", () => {
    const [system] = buildExplanationMessages(record({ winner: "red", reason: "kill" }));
    expect(system?.content).toContain("kit");
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
      "Rojo ganó por KO a los 42 s: hizo 20 de daño contra 6,5 de Azul y terminó con 13,5/30 de vida, " +
        "decidiendo más rápido (700 ms frente a 1400 ms).",
    );
  });

  it("KO sin diferencia clara de velocidad no la menciona", () => {
    const text = fallbackExplanation(
      record({ winner: "blue", reason: "kill" }, { alive: false, health: 0, avgDecisionMs: 900 }, { damageDealt: 20, avgDecisionMs: 1000 }),
    );
    expect(text).toBe("Azul ganó por KO a los 42 s: hizo 20 de daño contra 0 de Rojo y terminó con 20/30 de vida.");
  });

  it("tiempo con ganador por vida", () => {
    const text = fallbackExplanation(
      record({ winner: "blue", reason: "timeout_health" }, { health: 9, damageDealt: 6 }, { health: 14, damageDealt: 11 }),
    );
    expect(text).toBe(
      "Se acabó el tiempo y Azul ganó por vida: terminó con 14/30 frente a 9/30 de Rojo, tras hacer 11 de daño contra 6.",
    );
  });

  it("empate con y sin daño", () => {
    expect(fallbackExplanation(record({ winner: null, reason: "draw" }))).toBe(
      "Empate: en 42 s ninguno logró dañar al otro y ambos terminaron con 20/30 de vida.",
    );
    expect(
      fallbackExplanation(record({ winner: null, reason: "draw" }, { health: 15, damageDealt: 5 }, { health: 15, damageDealt: 5 })),
    ).toBe("Empate: al acabarse el tiempo ambos quedaron con 15/30 de vida (Rojo hizo 5 de daño y Azul 5).");
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

describe("modo por rondas", () => {
  const round = (n: number, winner: Side | null, reason: RoundResult["reason"]): RoundResult => ({
    round: n,
    winner,
    reason,
    durationMs: 30_000 + n * 1000,
  });
  function seriesRecord(result: MatchResult, rounds: RoundResult[], red: Partial<AgentStatus> = {}, blue: Partial<AgentStatus> = {}): MatchRecord {
    const wins = { red: rounds.filter((r) => r.winner === "red").length, blue: rounds.filter((r) => r.winner === "blue").length };
    return {
      ...record(result, red, blue),
      settings: { comms: "none", timer: true, timerSeconds: null, mode: "rounds" },
      series: { round: rounds.length, maxRounds: 5, wins, rounds, roundStartedAt: null },
    };
  }
  const threeToOne = [round(1, "red", "kill"), round(2, "blue", "timeout_health"), round(3, "red", "surrender"), round(4, "red", "kill")];

  it("explica las series ganadas y las empatadas", () => {
    expect(shouldExplain({ winner: "red", reason: "rounds" })).toBe(true);
  });

  it("el resumen para el LLM lista cada ronda y el marcador final", () => {
    const messages = buildExplanationMessages(seriesRecord({ winner: "red", reason: "rounds" }, threeToOne));
    const user = messages[1]?.content ?? "";
    expect(user).toContain("Resultado: Rojo ganó la serie 3 a 1.");
    expect(user).toContain("- Ronda 1: ganó Rojo por KO (31 s).");
    expect(user).toContain("- Ronda 2: ganó Azul por tener más vida al acabarse el tiempo (32 s).");
    expect(user).toContain("- Ronda 3: ganó Rojo porque Azul se rindió (33 s).");
    expect(user).toContain("- Ronda 4: ganó Rojo por KO (34 s).");
    expect(user).toContain("Marcador final de la serie: Rojo 3, Azul 1.");
    expect(user.endsWith("Explica por qué ganó Rojo.")).toBe(true);
    const drawn = buildExplanationMessages(
      seriesRecord({ winner: null, reason: "draw" }, [round(1, "red", "kill"), round(2, null, "draw"), round(3, "blue", "kill")]),
    );
    expect(drawn[1]?.content).toContain("- Ronda 2: empate, se acabó el tiempo con la misma vida (32 s).");
    expect(drawn[1]?.content).toContain("Resultado: la serie terminó empatada 1 a 1 en rondas ganadas.");
    expect(drawn[1]?.content.endsWith("Explica por qué la serie terminó en empate.")).toBe(true);
  });

  it("la plantilla cuenta el marcador y cómo se ganaron las rondas", () => {
    expect(fallbackExplanation(seriesRecord({ winner: "red", reason: "rounds" }, threeToOne, { damageDealt: 40 }, { damageDealt: 22 }))).toBe(
      "Rojo ganó la serie 3 a 1: ganó 2 rondas por KO y 1 ronda porque Azul se rindió; hizo 40 de daño contra 22 de Azul.",
    );
    const withDraw = [round(1, null, "draw"), round(2, null, "draw"), round(3, "blue", "kill"), round(4, "blue", "kill")];
    expect(fallbackExplanation(seriesRecord({ winner: "blue", reason: "rounds" }, withDraw, {}, { damageDealt: 12.5 }))).toBe(
      "Azul ganó la serie 2 a 0 (con 2 empatadas): ganó 2 rondas por KO; hizo 12,5 de daño contra 0 de Rojo.",
    );
  });

  it("la plantilla de una serie empatada", () => {
    const rounds = [round(1, "red", "kill"), round(2, "blue", "kill"), round(3, null, "draw"), round(4, "red", "kill"), round(5, "blue", "surrender")];
    expect(fallbackExplanation(seriesRecord({ winner: null, reason: "draw" }, rounds, { damageDealt: 30 }, { damageDealt: 28 }))).toBe(
      "Empate en la serie: 2 rondas cada uno y 1 empatada (Rojo hizo 30 de daño y Azul 28).",
    );
  });

  it("una serie detenida a mano usa la frase de siempre", () => {
    expect(fallbackExplanation(seriesRecord({ winner: null, reason: "stopped" }, [round(1, "red", "kill")]))).toContain("se detuvo a mano");
  });
});
