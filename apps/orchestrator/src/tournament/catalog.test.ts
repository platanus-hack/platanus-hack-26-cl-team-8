import { describe, expect, it } from "vitest";
import fixture from "./catalog.fixture.json";
import {
  DEFAULT_PRIORITY_LINES,
  DEFAULT_REFERENCE_ID,
  DEFAULT_REFERENCE_PROVIDER,
  fetchCatalog,
  fetchEndpoints,
  freezeModel,
  isCompatible,
  lineKey,
  lowestReasoning,
  resolveCatalog,
} from "./catalog";
import type { CatalogEndpoints, CatalogModel } from "./types";

const MODELS = (fixture as { data: CatalogModel[] }).data;
const OPTS = { priorityLines: DEFAULT_PRIORITY_LINES, referenceId: DEFAULT_REFERENCE_ID, maxCandidates: 8 };

/** Modelo sintético compatible salvo que se pise algún campo. */
function model(id: string, released: number, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    released,
    type: "language",
    tags: ["tool-use"],
    modalities: { input: ["text"], output: ["text"] },
    reasoning_options: [{ type: "toggle" }],
    pricing: { input: "0.000001", output: "0.000002" },
    ...over,
  };
}

const REF = model(DEFAULT_REFERENCE_ID, 100);

describe("lineKey", () => {
  it("quita versión, snapshot y ruta", () => {
    expect(lineKey("deepseek/deepseek-v4.1-flash-1017-fast")).toEqual({
      line: "deepseek/deepseek-v*-flash",
      version: "4.1",
      snapshot: "1017",
      route: "fast",
      routeSuffix: "fast",
    });
  });

  it("reemplaza números pegados a letras y deja los sufijos semánticos", () => {
    expect(lineKey("alibaba/qwen3.8-flash").line).toBe("alibaba/qwen*-flash");
    expect(lineKey("openai/gpt-6.1-terra").line).toBe("openai/gpt-*-terra");
    expect(lineKey("minimax/minimax-m3.1-flash").line).toBe("minimax/minimax-m*-flash");
    expect(lineKey("anthropic/claude-haiku-5.5").line).toBe("anthropic/claude-haiku-*");
    expect(lineKey("meta/muse-ember")).toMatchObject({ line: "meta/muse-ember", version: "", route: "base" });
    expect(lineKey("zai/glm-5.3-flashx-legal").line).toBe("zai/glm-*-flashx-legal");
    expect(lineKey("alibaba/qwen3.8-omni-flash").line).toBe("alibaba/qwen*-omni-flash");
  });

  it("distingue rutas y conserva los tamaños de pesos", () => {
    expect(lineKey("openai/gpt-6-luna-batch").route).toBe("batch");
    expect(lineKey("nvidia/nemotron-3.5-lightning-free").route).toBe("free");
    expect(lineKey("moonshotai/kimi-k2.7-code-highspeed")).toMatchObject({ route: "fast", routeSuffix: "highspeed" });
    expect(lineKey("alibaba/qwen3-coder-30b-a3b").line).toBe("alibaba/qwen*-coder-30b-a3b");
  });

  it("separa Luna de Terra y Flash de Flash-Lite", () => {
    expect(lineKey("openai/gpt-6-luna").line).not.toBe(lineKey("openai/gpt-6.1-terra").line);
    expect(lineKey("google/gemini-3.8-flash").line).not.toBe(lineKey("google/gemini-3.5-flash-lite").line);
  });
});

describe("isCompatible", () => {
  it("acepta razonamiento apagable y también el obligatorio con nivel conocido", () => {
    expect(isCompatible(model("x/a", 1))).toBeNull();
    expect(isCompatible(model("x/a", 1, { reasoning_options: undefined }))).toBeNull();
    expect(isCompatible(model("x/a", 1, { reasoning_options: [{ type: "effort", values: ["none", "low"] }] }))).toBeNull();
    expect(isCompatible(model("x/a", 1, { reasoning_options: [{ type: "effort", values: ["low", "high"] }] }))).toBeNull();
    // Sin ningún nivel reconocible no hay cómo llamarlo.
    expect(isCompatible(model("x/a", 1, { reasoning_options: [{ type: "budget_tokens" }] }))).toMatch(/razonamiento/);
  });

  it("elige none si se puede apagar; si no, el nivel más bajo que acepta", () => {
    expect(lowestReasoning(model("x/a", 1))).toBe("none");
    expect(lowestReasoning(model("x/a", 1, { reasoning_options: undefined }))).toBe("none");
    expect(lowestReasoning(model("x/a", 1, { reasoning_options: [{ type: "effort", values: ["high", "low", "medium"] }] }))).toBe("low");
    expect(
      lowestReasoning(model("x/a", 1, { reasoning_options: [{ type: "effort", values: ["low", "minimal", "max"] }] })),
    ).toBe("minimal");
    // Endpoint con razonamiento obligatorio: nunca "none".
    const opt = model("x/a", 1, { reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }] });
    expect(lowestReasoning(opt, { reasoning: { mandatory: true }, endpoints: [] })).toBe("low");
    expect(lowestReasoning(model("x/a", 1, { reasoning_options: [{ type: "budget_tokens" }] }))).toBeNull();
  });

  it("exige lenguaje, texto y tools", () => {
    expect(isCompatible(model("x/a", 1, { type: "embedding" }))).toMatch(/lenguaje/);
    expect(isCompatible(model("x/a", 1, { tags: [] }))).toMatch(/tool-use/);
    expect(isCompatible(model("x/a", 1, { modalities: { input: ["image"], output: ["text"] } }))).toMatch(/texto/);
  });
});

describe("resolveCatalog con el catálogo real", () => {
  const res = resolveCatalog(MODELS, { ...OPTS, maxCandidates: 1000 });
  const all = [...res.candidates, ...res.overflow];

  it("la referencia resuelve a la ruta fast del snapshot 1017 y su línea no compite", () => {
    expect(res.reference.id).toBe("deepseek/deepseek-v4.1-flash-1017-fast");
    expect(all.some((l) => l.line === "deepseek/deepseek-v*-flash")).toBe(false);
  });

  it("una sola versión por línea y ninguna -batch", () => {
    const lines = all.map((l) => l.line);
    expect(new Set(lines).size).toBe(lines.length);
    for (const l of all) {
      expect(l.chosen).not.toBeNull();
      expect(lineKey(l.chosen!.id).line).toBe(l.line);
      expect(l.chosen!.id.endsWith("-batch")).toBe(false);
      expect(l.members.some((id) => id.endsWith("-batch"))).toBe(false);
      expect(isCompatible(l.chosen!)).toBeNull();
    }
  });

  it("prefiere la ruta rápida dentro de la versión más reciente", () => {
    const luna = all.find((l) => l.line === "openai/gpt-*-luna");
    expect(luna?.chosen?.id).toBe("openai/gpt-6-luna-fast");
    expect(all.find((l) => l.line === "openai/gpt-*-terra")?.chosen?.id).toBe("openai/gpt-6.1-terra-fast");
  });

  it("Luna y Terra, Flash y Flash-Lite son líneas distintas", () => {
    expect(all.find((l) => l.line === "openai/gpt-*-luna")?.members.some((id) => id.includes("terra"))).toBe(false);
    expect(all.find((l) => l.line === "google/gemini-*-flash")?.chosen?.id).toBe("google/gemini-3.8-flash");
    expect(all.find((l) => l.line === "google/gemini-*-flash-lite")?.chosen?.id).toBe("google/gemini-3.5-flash-lite");
  });

  it("las prioritarias con razonamiento obligatorio entran con su versión más reciente y el nivel mínimo", () => {
    const chosen = Object.fromEntries(all.map((l) => [l.line, l.chosen!]));
    const expected: Record<string, [string, string]> = {
      "google/gemini-*-flash": ["google/gemini-3.8-flash", "low"],
      "zai/glm-*-flash": ["zai/glm-5.3-flash", "low"],
      "minimax/minimax-m*-flash": ["minimax/minimax-m3.1-flash", "low"],
      "meta/muse-ember": ["meta/muse-ember", "minimal"],
    };
    for (const [line, [id, level]] of Object.entries(expected)) {
      expect(chosen[line]?.id).toBe(id);
      expect(lowestReasoning(chosen[line]!)).toBe(level);
    }
    expect(res.omitted.some((o) => o.line in expected)).toBe(false);
  });

  it("con 8 cupos entran exactamente las 8 prioritarias, en su orden, sin automáticas", () => {
    const top = resolveCatalog(MODELS, OPTS);
    expect(top.candidates.map((l) => [l.priority, l.chosen?.id])).toEqual([
      [0, "openai/gpt-6-luna-fast"],
      [1, "google/gemini-3.8-flash"],
      [2, "anthropic/claude-haiku-5.5"],
      [3, "alibaba/qwen3.8-flash"],
      [4, "zai/glm-5.3-flash"],
      [5, "xiaomi/mimo-v2.6-flash"],
      [6, "minimax/minimax-m3.1-flash"],
      [7, "meta/muse-ember"],
    ]);
    expect(top.overflow.length).toBe(all.length - 8);
  });

  it("las automáticas solo llenan cupos que sobran después de las prioritarias", () => {
    const top = resolveCatalog(MODELS, { ...OPTS, maxCandidates: 11 });
    expect(top.candidates.slice(0, 8).every((l) => l.priority !== null)).toBe(true);
    const rest = top.candidates.slice(8);
    expect(rest).toHaveLength(3);
    for (const l of rest) expect(l.priority).toBeNull();
    for (let i = 1; i < rest.length; i += 1) {
      expect(rest[i - 1]!.chosen!.released ?? 0).toBeGreaterThanOrEqual(rest[i]!.chosen!.released ?? 0);
    }
  });
});

describe("resolveCatalog con catálogo sintético", () => {
  it("si la versión más reciente es incompatible se omite la línea con motivo", () => {
    const res = resolveCatalog(
      [
        REF,
        model("acme/rocket-2-flash", 10),
        model("acme/rocket-3-flash", 20, { tags: [] }),
      ],
      { priorityLines: ["acme/rocket-*-flash"], referenceId: REF.id, maxCandidates: 8 },
    );
    expect(res.candidates).toEqual([]);
    expect(res.omitted).toEqual([
      { line: "acme/rocket-*-flash", latestId: "acme/rocket-3-flash", reason: expect.stringMatching(/tool-use/) },
    ]);
  });

  it("una prioritaria omitida deja su cupo vacío: no entra una automática en su lugar", () => {
    const res = resolveCatalog(
      [REF, model("acme/a-1", 10), model("acme/b-1", 10, { tags: [] }), model("acme/extra-1", 30)],
      { priorityLines: ["acme/a-*", "acme/b-*"], referenceId: REF.id, maxCandidates: 2 },
    );
    expect(res.candidates.map((l) => l.chosen?.id)).toEqual(["acme/a-1"]);
    expect(res.overflow.map((l) => l.chosen?.id)).toEqual(["acme/extra-1"]);
  });

  it("prioritaria ausente del catálogo queda registrada", () => {
    const res = resolveCatalog([REF], { priorityLines: ["acme/nada"], referenceId: REF.id, maxCandidates: 8 });
    expect(res.omitted).toEqual([{ line: "acme/nada", latestId: "", reason: "no está en el catálogo" }]);
  });

  it("dentro de una versión: -fast exacto, luego otras rápidas, luego base; pagada antes que -free", () => {
    const res = resolveCatalog(
      [
        REF,
        model("acme/jet-1", 10),
        model("acme/jet-1-ultrafast", 12),
        model("acme/jet-1-fast", 10),
        model("acme/jet-1-batch", 30),
        model("acme/glide-1-free", 10),
        model("acme/glide-1", 10),
      ],
      { priorityLines: [], referenceId: REF.id, maxCandidates: 8 },
    );
    const chosen = Object.fromEntries(res.candidates.map((l) => [l.line, l.chosen?.id]));
    expect(chosen).toEqual({ "acme/jet-*": "acme/jet-1-fast", "acme/glide-*": "acme/glide-1" });
  });

  it("snapshot más reciente gana; desempate por versión", () => {
    const res = resolveCatalog(
      [REF, model("acme/jet-2-0101", 10), model("acme/jet-2-0301", 20), model("acme/jet-2.1", 20)],
      { priorityLines: [], referenceId: REF.id, maxCandidates: 8 },
    );
    expect(res.candidates[0]?.chosen?.id).toBe("acme/jet-2.1");
    expect(res.candidates[0]?.members).toEqual(["acme/jet-2.1", "acme/jet-2-0301", "acme/jet-2-0101"]);
  });
});

describe("freezeModel", () => {
  const ref = MODELS.find((m) => m.id === DEFAULT_REFERENCE_ID)!;
  const endpoints: CatalogEndpoints = {
    reasoning: { mandatory: false, supported_efforts: ["none", "low"] },
    endpoints: [
      { provider_name: "baseten", status: 0, uptime_last_1h: 99 },
      { provider_name: "otro", status: 0, uptime_last_1h: 100 },
      { provider_name: "caido", status: 1, uptime_last_1h: 100 },
    ],
  };

  it("fija el proveedor pedido y convierte precios a número", () => {
    const frozen = freezeModel(ref, endpoints, { isReference: true, priority: null, pinProvider: DEFAULT_REFERENCE_PROVIDER });
    expect(frozen).toMatchObject({
      key: DEFAULT_REFERENCE_ID,
      gatewayId: DEFAULT_REFERENCE_ID,
      name: ref.name,
      line: "deepseek/deepseek-v*-flash",
      inferenceProvider: "baseten",
      clientProvider: "vercel",
      reasoning: "none",
      isReference: true,
    });
    if ("omittedReason" in frozen) throw new Error("no debía omitirse");
    expect(typeof frozen.pricing?.input).toBe("number");
    expect(frozen.pricing!.input).toBeGreaterThan(0);
  });

  it("sin pin elige el endpoint con status 0 y mayor uptime", () => {
    const frozen = freezeModel(ref, endpoints, { isReference: false, priority: 0 });
    expect(frozen).toMatchObject({ inferenceProvider: "otro" });
  });

  it("omite si no hay endpoints utilizables; con razonamiento obligatorio usa el nivel mínimo", () => {
    const none = freezeModel(ref, { endpoints: [{ provider_name: "caido", status: 1 }] }, { isReference: false, priority: null });
    expect(none).toEqual({ omittedReason: expect.stringMatching(/^inaccesible/) });
    const pinMissing = freezeModel(ref, endpoints, { isReference: false, priority: null, pinProvider: "nadie" });
    expect(pinMissing).toEqual({ omittedReason: expect.stringMatching(/^inaccesible/) });
    const mandatory = freezeModel(ref, { ...endpoints, reasoning: { mandatory: true } }, { isReference: false, priority: null });
    expect(mandatory).toMatchObject({ reasoning: "low" });
  });

  it("sin endpoints consultados deja el proveedor al gateway", () => {
    expect(freezeModel(ref, null, { isReference: false, priority: null })).toMatchObject({ inferenceProvider: null });
  });
});

describe("fetch", () => {
  it("fetchCatalog devuelve el cuerpo crudo y los modelos", async () => {
    const raw = JSON.stringify({ data: [REF] });
    const res = await fetchCatalog(async () => ({ ok: true, status: 200, text: async () => raw }));
    expect(res.raw).toBe(raw);
    expect(res.models.map((m) => m.id)).toEqual([REF.id]);
  });

  it("fetchEndpoints desenvuelve data y falla con status no ok", async () => {
    let url = "";
    const ep = await fetchEndpoints(REF.id, async (u) => {
      url = u;
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { endpoints: [{ provider_name: "baseten" }] } }) };
    });
    expect(url).toBe(`https://ai-gateway.vercel.sh/v1/models/${REF.id}/endpoints`);
    expect(ep).toEqual({ reasoning: null, endpoints: [{ provider_name: "baseten" }] });
    await expect(fetchEndpoints(REF.id, async () => ({ ok: false, status: 429, text: async () => "" }))).rejects.toThrow(/429/);
  });

  it("corta por timeout", async () => {
    const slow = (_u: string, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("abortado"))));
    await expect(fetchCatalog(slow, 10)).rejects.toThrow(/abortado/);
  });
});
