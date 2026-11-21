import { describe, expect, it, vi } from "vitest";
import { MODEL_PRICE_CAP, ModelsResponseSchema } from "@phack/protocol";
import {
  CATALOG_URL,
  FALLBACK_MODELS,
  ModelCatalog,
  parseCatalog,
  pricePerMillion,
  withinPriceCap,
  type CatalogFetch,
} from "./models";

/** Una entrada con la forma del catálogo de Vercel AI Gateway (los precios vienen como texto, por token). */
function entry(id: string, input: unknown, output: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    object: "model",
    name: `Modelo ${id}`,
    type: "language",
    tags: ["reasoning", "tool-use"],
    pricing: { input, output },
    ...extra,
  };
}

const CATALOG = {
  object: "list",
  data: [
    entry("deepseek/barato", "0.0000006", "0.0000024"),
    entry("anthropic/justo-en-el-tope", "0.000001", "0.000005"),
    entry("openai/entrada-cara", "0.00000125", "0.000005"),
    entry("openai/salida-cara", "0.000001", "0.0000051"),
    entry("google/gratis", "0", "0"),
  ],
};

function okFetch(data: unknown): { fetch: CatalogFetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => data };
    },
  };
}

function catalogWith(fetch: CatalogFetch, defaultModel = "deepseek/por-defecto") {
  const logs: { level: string; text: string }[] = [];
  const catalog = new ModelCatalog({
    defaultModel,
    fetch,
    now: () => 1234,
    log: (level, text) => {
      logs.push({ level, text });
    },
  });
  return { catalog, logs };
}

describe("pricePerMillion / withinPriceCap", () => {
  it("convierte el precio por token a dólares por millón sin errores de coma flotante", () => {
    expect(pricePerMillion(0.000001)).toBe(1);
    expect(pricePerMillion(0.000005)).toBe(5);
    expect(pricePerMillion(0.0000006)).toBe(0.6);
    expect(pricePerMillion(0.00000125)).toBe(1.25);
  });

  it("los modelos que están justo en el tope pasan; apenas por encima, no", () => {
    const input = MODEL_PRICE_CAP.inputPerMillion / 1_000_000;
    const output = MODEL_PRICE_CAP.outputPerMillion / 1_000_000;
    expect(withinPriceCap({ inputPrice: input, outputPrice: output })).toBe(true);
    expect(withinPriceCap({ inputPrice: 0, outputPrice: 0 })).toBe(true);
    expect(withinPriceCap({ inputPrice: input * 1.01, outputPrice: output })).toBe(false);
    expect(withinPriceCap({ inputPrice: input, outputPrice: output * 1.01 })).toBe(false);
  });
});

describe("parseCatalog", () => {
  it("deja solo los modelos dentro del tope, con el precio por token como número", () => {
    expect(parseCatalog(CATALOG)).toEqual([
      { id: "deepseek/barato", name: "Modelo deepseek/barato", inputPrice: 0.0000006, outputPrice: 0.0000024 },
      {
        id: "anthropic/justo-en-el-tope",
        name: "Modelo anthropic/justo-en-el-tope",
        inputPrice: 0.000001,
        outputPrice: 0.000005,
      },
      { id: "google/gratis", name: "Modelo google/gratis", inputPrice: 0, outputPrice: 0 },
    ]);
  });

  it("descarta lo que no sirve para pelear: sin herramientas, otro tipo, diferidos o sin precio", () => {
    const data = {
      data: [
        entry("a/sin-herramientas", "0.0000001", "0.0000001", { tags: ["reasoning"] }),
        entry("a/sin-tags", "0.0000001", "0.0000001", { tags: undefined }),
        entry("a/imagenes", "0.0000001", "0.0000001", { type: "image" }),
        entry("a/barato-batch", "0.0000001", "0.0000001"),
        entry("a/sin-precio", undefined, undefined, { pricing: undefined }),
        entry("a/precio-incompleto", "0.0000001", undefined),
        entry("a/precio-vacio", "", ""),
        entry("a/precio-nulo", null, null),
        entry("a/precio-raro", "barato", "0.0000001"),
        entry("a/precio-negativo", "-0.0000001", "0.0000001"),
        { id: 42, type: "language", tags: ["tool-use"], pricing: { input: "0", output: "0" } },
        "basura",
        null,
        entry("a/bueno", 0.0000002, "0.0000004", { name: "  " }),
      ],
    };
    // Los precios pueden venir como número; sin nombre se usa el id.
    expect(parseCatalog(data)).toEqual([
      { id: "a/bueno", name: "a/bueno", inputPrice: 0.0000002, outputPrice: 0.0000004 },
    ]);
  });

  it("no repite un id que viene dos veces", () => {
    const data = { data: [entry("a/uno", "0", "0"), entry("a/uno", "0.0000001", "0.0000001")] };
    expect(parseCatalog(data).map((m) => m.id)).toEqual(["a/uno"]);
  });

  it("el modelo por defecto del servidor se salta el tope de precio (pero no los otros filtros)", () => {
    const always = ["openai/entrada-cara", "a/imagenes"];
    const data = { data: [...CATALOG.data, entry("a/imagenes", "0.00001", "0.00001", { type: "image" })] };
    const ids = parseCatalog(data, always).map((m) => m.id);
    expect(ids).toContain("openai/entrada-cara");
    expect(ids).not.toContain("openai/salida-cara");
    expect(ids).not.toContain("a/imagenes");
  });

  it("nunca lanza con datos que no entiende", () => {
    for (const data of [null, undefined, 42, "texto", [], {}, { data: "no es una lista" }, { data: [] }]) {
      expect(parseCatalog(data)).toEqual([]);
    }
  });
});

describe("FALLBACK_MODELS", () => {
  it("la lista fija respeta el tope e incluye el modelo por defecto de vercel", () => {
    expect(FALLBACK_MODELS.length).toBeGreaterThan(0);
    for (const model of FALLBACK_MODELS) expect(withinPriceCap(model)).toBe(true);
    expect(new Set(FALLBACK_MODELS.map((m) => m.id)).size).toBe(FALLBACK_MODELS.length);
    expect(FALLBACK_MODELS.map((m) => m.id)).toContain("deepseek/deepseek-v4.1-flash-1017-fast");
  });
});

describe("ModelCatalog", () => {
  it("antes de bajar el catálogo vale la lista fija", () => {
    const { catalog } = catalogWith(okFetch(CATALOG).fetch);
    const snapshot = catalog.snapshot();
    expect(snapshot.source).toBe("fallback");
    expect(snapshot.updatedAt).toBeNull();
    expect(snapshot.models).toEqual(FALLBACK_MODELS);
    expect(ModelsResponseSchema.safeParse(snapshot).success).toBe(true);
    expect(catalog.isAllowed("anthropic/claude-haiku-5.5")).toBe(true);
    expect(catalog.isAllowed("deepseek/barato")).toBe(false);
  });

  it("con el catálogo bajado permite solo lo que no pasa del tope", async () => {
    const { fetch, urls } = okFetch(CATALOG);
    const { catalog } = catalogWith(fetch);
    expect(await catalog.refresh()).toBe(true);

    expect(urls).toEqual([CATALOG_URL]);
    const snapshot = catalog.snapshot();
    expect(snapshot.source).toBe("catalog");
    expect(snapshot.updatedAt).toBe(1234);
    expect(snapshot.models.map((m) => m.id)).toEqual(["deepseek/barato", "anthropic/justo-en-el-tope", "google/gratis"]);
    expect(ModelsResponseSchema.safeParse(snapshot).success).toBe(true);

    expect(catalog.isAllowed("deepseek/barato")).toBe(true);
    expect(catalog.isAllowed("  anthropic/justo-en-el-tope  ")).toBe(true);
    expect(catalog.isAllowed("openai/entrada-cara")).toBe(false);
    expect(catalog.isAllowed("openai/salida-cara")).toBe(false);
    expect(catalog.isAllowed("inventado/modelo")).toBe(false);
    expect(catalog.isAllowed("")).toBe(false);
    // La lista fija ya no vale: el catálogo vivo manda.
    expect(catalog.isAllowed("anthropic/claude-haiku-5.5")).toBe(false);
  });

  it("el modelo por defecto del servidor siempre está permitido", async () => {
    const { catalog } = catalogWith(okFetch(CATALOG).fetch, "openai/entrada-cara");
    expect(catalog.isAllowed("openai/entrada-cara")).toBe(true);
    await catalog.refresh();
    expect(catalog.isAllowed("openai/entrada-cara")).toBe(true);
    // Y si el catálogo lo trae, aparece en la lista con su precio aunque pase del tope.
    expect(catalog.snapshot().models.map((m) => m.id)).toContain("openai/entrada-cara");

    const absent = catalogWith(okFetch(CATALOG).fetch, "privado/que-no-esta-en-el-catalogo").catalog;
    await absent.refresh();
    expect(absent.isAllowed("privado/que-no-esta-en-el-catalogo")).toBe(true);
  });

  it("si la descarga falla no lanza y sigue con la lista fija", async () => {
    const failures: CatalogFetch[] = [
      async () => {
        throw new Error("sin internet");
      },
      async () => ({ ok: false, status: 503, json: async () => ({}) }),
      async () => ({ ok: true, status: 200, json: async () => ({ data: "basura" }) }),
      async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("no es JSON");
        },
      }),
    ];
    for (const fetch of failures) {
      const { catalog, logs } = catalogWith(fetch);
      expect(await catalog.refresh()).toBe(false);
      expect(catalog.snapshot()).toEqual({ models: FALLBACK_MODELS, source: "fallback", updatedAt: null });
      expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
    }
  });

  it("si una descarga posterior falla conserva la última lista buena", async () => {
    let fail = false;
    const { catalog, logs } = catalogWith(async () => {
      if (fail) throw new Error("sin internet");
      return { ok: true, status: 200, json: async () => CATALOG };
    });
    await catalog.refresh();
    const good = catalog.snapshot();

    fail = true;
    expect(await catalog.refresh()).toBe(false);
    expect(await catalog.refresh()).toBe(false);
    expect(catalog.snapshot()).toEqual(good);
    expect(catalog.isAllowed("deepseek/barato")).toBe(true);
    // El mismo fallo repetido no llena el registro de avisos.
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("snapshot entrega una copia: modificarla no cambia la lista", () => {
    const { catalog } = catalogWith(okFetch(CATALOG).fetch);
    const snapshot = catalog.snapshot();
    snapshot.models.length = 0;
    expect(catalog.snapshot().models).toHaveLength(FALLBACK_MODELS.length);
  });

  it("start baja el catálogo sin bloquear y stop corta el refresco", async () => {
    const { catalog } = catalogWith(okFetch(CATALOG).fetch);
    catalog.start();
    catalog.start();
    try {
      // Todavía no terminó la descarga: la API ya puede responder con la lista fija.
      expect(catalog.snapshot().source).toBe("fallback");
      await vi.waitFor(() => expect(catalog.snapshot().source).toBe("catalog"));
    } finally {
      catalog.stop();
    }
  });
});
