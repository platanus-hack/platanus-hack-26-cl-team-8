import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SpeechService,
  clampSpeed,
  cutAtWord,
  isSpeechId,
  mp3Kbps,
  type SpeechConfig,
  type SpeechDeps,
  type SpeechFetch,
} from "./speech";

/** Voz de ElevenLabs con dobles: nada sale a la red. */

const KEY = "sk-clave-secreta";

const CONFIG: SpeechConfig = {
  apiKey: KEY,
  voices: { red: "voz-roja", blue: "voz-azul" },
  model: "eleven_flash_v2_5",
  speed: 1.1,
  outputFormat: "mp3_44100_64",
  language: "",
  maxChars: 300,
  minCreditsLeft: 5000,
};

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
type Reply = Awaited<ReturnType<SpeechFetch>>;
type Init = Parameters<SpeechFetch>[1];

function audio(bytes: string, headers: Record<string, string> = {}): Reply {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => {
      const buf = Buffer.from(bytes);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    text: async () => bytes,
  };
}

function failure(status: number, detail: Record<string, string> = {}): Reply {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => JSON.stringify({ detail }),
  };
}

function json(data: unknown): Reply {
  return { ...audio(JSON.stringify(data)) };
}

/** Lo que responde la cuenta por defecto: créditos de sobra. */
const PLENTY = { character_count: 1000, character_limit: 100_000, next_character_count_reset_unix: 0 };

let dirs: string[] = [];

afterEach(async () => {
  // Lo que aún se escribe en segundo plano termina antes de borrar la carpeta.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 })));
  dirs = [];
});

async function newDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "phack-speech-"));
  dirs.push(dir);
  return dir;
}

type Options = {
  config?: Partial<SpeechConfig>;
  /** Respuesta a cada síntesis; por defecto, "mp3:<texto>". */
  tts?: (call: Call, init: Init) => Promise<Reply> | Reply;
  subscription?: () => Promise<Reply> | Reply;
  limits?: SpeechDeps["limits"];
  dataDir?: string;
};

async function setup(opts: Options = {}) {
  const dataDir = opts.dataDir ?? (await newDir());
  const calls: Call[] = [];
  const logs: { level: string; text: string }[] = [];
  let now = 1_000_000;
  const fetchFn: SpeechFetch = async (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (url.endsWith("/v1/user/subscription")) return opts.subscription ? opts.subscription() : json(PLENTY);
    return opts.tts ? opts.tts(call, init) : audio(`mp3:${String(call.body?.text)}`);
  };
  const service = new SpeechService({
    config: { ...CONFIG, ...opts.config },
    dataDir,
    log: (level, text) => logs.push({ level, text }),
    fetch: fetchFn,
    now: () => now,
    sleep: async () => {},
    limits: { waitMs: 200, requestTimeoutMs: 200, ...opts.limits },
  });
  return {
    service,
    calls,
    logs,
    dataDir,
    tts: () => calls.filter((c) => c.url.includes("/text-to-speech/")),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Espera a que terminen las lecturas de créditos en segundo plano. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("cutAtWord y clampSpeed", () => {
  it("corta en una palabra y no toca un texto corto", () => {
    expect(cutAtWord("hola amigo mío", 50)).toBe("hola amigo mío");
    expect(cutAtWord("hola amigo mío qué tal", 10)).toBe("hola amigo");
    expect(cutAtWord("hola amigo mío qué tal", 12)).toBe("hola amigo");
    expect(cutAtWord("supercalifragilístico", 5)).toBe("super");
    expect(cutAtWord("ríndete 😀😀 ya", 10)).toBe("ríndete 😀😀");
  });

  it("deja la velocidad entre 0.7 y 1.2", () => {
    expect(clampSpeed(1.1)).toBe(1.1);
    expect(clampSpeed(2)).toBe(1.2);
    expect(clampSpeed(0.1)).toBe(0.7);
    expect(clampSpeed(Number.NaN)).toBe(1);
  });
});

describe("SpeechService: solicitud a ElevenLabs", () => {
  it("manda el modelo, la velocidad acotada, el formato y sin speaker boost; el idioma solo si está", async () => {
    const t = await setup({ config: { speed: 1.5 } });
    const id = t.service.request("red", "  hola rival  ");
    expect(id).not.toBeNull();
    await t.service.get(id ?? "");
    const [call] = t.tts();
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voz-roja/stream?output_format=mp3_44100_64");
    expect(call?.headers).toEqual({ "xi-api-key": KEY, "Content-Type": "application/json", Accept: "audio/mpeg" });
    expect(call?.body).toEqual({
      text: "hola rival",
      model_id: "eleven_flash_v2_5",
      voice_settings: { speed: 1.2, stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: false },
    });
    expect(call?.body).not.toHaveProperty("optimize_streaming_latency");

    const es = await setup({ config: { language: "es" } });
    await es.service.get(es.service.request("blue", "hola") ?? "");
    expect(es.tts()[0]?.url).toContain("/text-to-speech/voz-azul/stream");
    expect(es.tts()[0]?.body?.language_code).toBe("es");
  });

  it("request devuelve un id al tiro y get entrega el audio", async () => {
    const t = await setup();
    const id = t.service.request("red", "a la carga");
    expect(id && isSpeechId(id)).toBe(true);
    expect((await t.service.get(id ?? ""))?.toString()).toBe("mp3:a la carga");
    // Una segunda lectura sale del disco.
    expect((await t.service.get(id ?? ""))?.toString()).toBe("mp3:a la carga");
    expect(await t.service.get("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("sin clave, sin voces o con texto vacío no hay voz", async () => {
    for (const config of [{ apiKey: "" }, { voices: { red: "voz-roja", blue: " " } }]) {
      const t = await setup({ config });
      expect(t.service.configured()).toBe(false);
      expect(t.service.available()).toBe(false);
      expect(t.service.request("red", "hola")).toBeNull();
      t.service.start();
      expect(t.calls).toEqual([]);
    }
    const t = await setup();
    expect(t.service.request("red", "   ")).toBeNull();
  });

  it("corta el texto en VOICE_MAX_CHARS sin partir una palabra", async () => {
    const t = await setup({ config: { maxChars: 12 } });
    await t.service.get(t.service.request("red", "no tengo flechas, en serio") ?? "");
    expect(t.tts()[0]?.body?.text).toBe("no tengo");
  });
});

describe("SpeechService: duración real del audio", () => {
  it("lee los kbps de los formatos mp3 de ElevenLabs y nada más", () => {
    expect(mp3Kbps("mp3_44100_64")).toBe(64);
    expect(mp3Kbps(" mp3_22050_32 ")).toBe(32);
    expect(mp3Kbps("mp3_44100_128")).toBe(128);
    for (const format of ["pcm_16000", "opus_48000_64", "ulaw_8000", "mp3_44100", "mp3_44100_0", ""]) {
      expect(mp3Kbps(format)).toBeNull();
    }
  });

  it("calcula los ms por el tamaño y el bitrate, esperando a que el audio esté listo", async () => {
    // 21 600 bytes a 64 kbps = 2,7 s.
    const t = await setup({ tts: () => audio("x".repeat(21_600)) });
    const id = t.service.request("red", "una frase de prueba") ?? "";
    expect(await t.service.durationMs(id)).toBe(2700);
    // Ya listo, responde igual.
    expect(await t.service.durationMs(id)).toBe(2700);
    const fast = await setup({ config: { outputFormat: "mp3_44100_128" }, tts: () => audio("x".repeat(21_600)) });
    expect(await fast.service.durationMs(fast.service.request("blue", "otra") ?? "")).toBe(1350);
  });

  it("null si el audio falló, si el id no existe o si el formato no es mp3 con bitrate", async () => {
    const failed = await setup({ tts: () => failure(500) });
    expect(await failed.service.durationMs(failed.service.request("red", "hola") ?? "")).toBeNull();
    expect(await failed.service.durationMs("00000000-0000-4000-8000-000000000000")).toBeNull();
    const pcm = await setup({ config: { outputFormat: "pcm_16000" } });
    const id = pcm.service.request("red", "hola") ?? "";
    expect(id).not.toBe("");
    expect(await pcm.service.durationMs(id)).toBeNull();
  });
});

describe("SpeechService: calentar las voces", () => {
  it("le pide una palabra a cada voz y no guarda ese audio", async () => {
    const t = await setup();
    t.service.warm();
    await settle();
    expect(t.tts().map((c) => c.url.split("/text-to-speech/")[1]?.split("/")[0])).toEqual(["voz-roja", "voz-azul"]);
    expect(t.tts().every((c) => c.body?.text === "Hola.")).toBe(true);
    const saved = await readdir(join(t.dataDir, "speech")).catch(() => []);
    expect(saved).toEqual([]);
  });

  it("no vuelve a calentar una voz que se usó hace poco, y sí pasado un rato", async () => {
    const t = await setup({ limits: { warmForMs: 60_000 } });
    t.service.warm();
    t.service.warm();
    await settle();
    expect(t.tts()).toHaveLength(2);
    // Una frase real de Rojo también la mantiene despierta.
    t.advance(50_000);
    await t.service.get(t.service.request("red", "sigo aquí") ?? "");
    t.advance(20_000);
    t.service.warm();
    await settle();
    const warmUps = t.tts().filter((c) => c.body?.text === "Hola.");
    expect(warmUps.map((c) => c.url.includes("voz-azul"))).toEqual([false, true, true]);
  });

  it("con el par japonés, calienta y habla con esas voces; un lado sin voz japonesa usa la habitual", async () => {
    const t = await setup({ config: { japaneseVoices: { red: "voz-ja-roja", blue: "voz-ja-azul" } } });
    const voiceOf = (c: { url: string }) => c.url.split("/text-to-speech/")[1]?.split("/")[0];
    t.service.warm("japanese");
    await settle();
    expect(t.tts().map(voiceOf)).toEqual(["voz-ja-roja", "voz-ja-azul"]);
    // Las habituales no quedaron despiertas por eso: se calientan aparte.
    t.service.warm();
    await settle();
    expect(t.tts().map(voiceOf).slice(2)).toEqual(["voz-roja", "voz-azul"]);

    expect((await t.service.get(t.service.request("red", "konnichiwa", "japanese") ?? ""))?.toString()).toBe("mp3:konnichiwa");
    expect(voiceOf(t.tts().at(-1)!)).toBe("voz-ja-roja");
    // La misma frase con la voz habitual es otra solicitud (otra voz, otro audio).
    await t.service.get(t.service.request("red", "konnichiwa") ?? "");
    expect(voiceOf(t.tts().at(-1)!)).toBe("voz-roja");

    const half = await setup({ config: { japaneseVoices: { red: "voz-ja-roja", blue: " " } } });
    await half.service.get(half.service.request("blue", "hola", "japanese") ?? "");
    expect(voiceOf(half.tts().at(-1)!)).toBe("voz-azul");
    const none = await setup();
    await none.service.get(none.service.request("red", "hola", "japanese") ?? "");
    expect(voiceOf(none.tts().at(-1)!)).toBe("voz-roja");
  });

  it("sin clave o en pausa por un error no pide nada", async () => {
    const off = await setup({ config: { apiKey: "" } });
    off.service.warm();
    await settle();
    expect(off.tts()).toHaveLength(0);

    const bad = await setup({ tts: () => failure(401, { type: "authentication_error" }) });
    await bad.service.get(bad.service.request("red", "hola") ?? "");
    const before = bad.tts().length;
    bad.service.warm();
    await settle();
    expect(bad.tts()).toHaveLength(before);
  });
});

describe("SpeechService: caché", () => {
  it("la misma frase y voz se genera una vez; la otra voz es otra solicitud", async () => {
    const t = await setup();
    await t.service.get(t.service.request("red", "ríndete") ?? "");
    const again = t.service.request("red", "ríndete");
    expect((await t.service.get(again ?? ""))?.toString()).toBe("mp3:ríndete");
    expect(t.tts()).toHaveLength(1);
    await t.service.get(t.service.request("blue", "ríndete") ?? "");
    expect(t.tts()).toHaveLength(2);
    expect(t.tts()[1]?.url).toContain("voz-azul");
    expect((await readdir(join(t.dataDir, "speech"))).filter((f) => f.endsWith(".mp3"))).toHaveLength(2);

    // Otro proceso con la misma carpeta encuentra el audio en disco.
    const other = await setup({ dataDir: t.dataDir });
    expect((await other.service.get(other.service.request("red", "ríndete") ?? ""))?.toString()).toBe("mp3:ríndete");
    expect(other.tts()).toHaveLength(0);
  });

  it("dos pedidos iguales a la vez comparten una sola solicitud", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = await setup({
      tts: async (call) => {
        await gate;
        return audio(`mp3:${String(call.body?.text)}`);
      },
    });
    const a = t.service.request("red", "hola");
    const b = t.service.request("red", "hola");
    expect(a).not.toBe(b);
    await vi.waitFor(() => expect(t.tts()).toHaveLength(1));
    release();
    const [first, second] = await Promise.all([t.service.get(a ?? ""), t.service.get(b ?? "")]);
    expect(first?.toString()).toBe("mp3:hola");
    expect(second?.toString()).toBe("mp3:hola");
    expect(t.tts()).toHaveLength(1);
  });

  it("la carpeta no pasa de maxFiles: salen los más viejos", async () => {
    const t = await setup({ limits: { maxFiles: 2 } });
    for (const text of ["uno", "dos", "tres", "cuatro"]) {
      await t.service.get(t.service.request("red", text) ?? "");
      t.advance(1000);
      await settle();
    }
    await vi.waitFor(async () => {
      const files = (await readdir(join(t.dataDir, "speech"))).filter((f) => f.endsWith(".mp3"));
      expect(files).toHaveLength(2);
    });
  });
});

describe("SpeechService: ids recientes", () => {
  it("recuerda como mucho maxIds y olvida los de más de 30 minutos", async () => {
    const t = await setup({ limits: { maxIds: 2 } });
    const ids = ["uno", "dos", "tres"].map((text) => t.service.request("red", text) ?? "");
    expect(await t.service.get(ids[0] ?? "")).toBeNull();
    expect((await t.service.get(ids[2] ?? ""))?.toString()).toBe("mp3:tres");

    const old = await setup();
    const first = old.service.request("red", "uno") ?? "";
    await old.service.get(first);
    old.advance(31 * 60_000);
    old.service.request("red", "dos");
    expect(await old.service.get(first)).toBeNull();
  });

  it("get no espera más que waitMs a una síntesis colgada", async () => {
    const t = await setup({
      limits: { waitMs: 20, requestTimeoutMs: 60_000 },
      tts: (_call, init) =>
        new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("abortado")))),
    });
    const id = t.service.request("red", "hola") ?? "";
    const started = Date.now();
    expect(await t.service.get(id)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("SpeechService: fallos", () => {
  it("clave inválida: se avisa una vez, la voz se apaga 10 minutos y vuelve", async () => {
    const t = await setup({ tts: () => failure(401, { type: "authentication_error", message: "Invalid API key" }) });
    const ids = [t.service.request("red", "uno"), t.service.request("blue", "dos")];
    for (const id of ids) expect(await t.service.get(id ?? "")).toBeNull();
    expect(t.service.available()).toBe(false);
    expect(t.service.request("red", "tres")).toBeNull();
    const errors = t.logs.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.text).toMatch(/clave.*ELEVENLABS_API_KEY/);
    expect(errors[0]?.text).not.toContain(KEY);
    t.advance(10 * 60_000);
    expect(t.service.available()).toBe(true);
  });

  it("sin créditos (402, o el 400/401 antiguo con quota_exceeded) también apaga la voz", async () => {
    const cases = [
      failure(402, { code: "insufficient_credits" }),
      failure(401, { status: "quota_exceeded" }),
      failure(400, { status: "quota_exceeded" }),
    ];
    for (const reply of cases) {
      const t = await setup({ tts: () => reply });
      expect(await t.service.get(t.service.request("red", "hola") ?? "")).toBeNull();
      expect(t.service.available()).toBe(false);
      expect(t.logs.filter((l) => l.level === "error").map((l) => l.text)).toEqual([
        expect.stringMatching(/sin créditos/),
      ]);
    }
  });

  it("voz desconocida: se avisa una vez por voz y la otra sigue hablando", async () => {
    const t = await setup({
      tts: (call) =>
        call.url.includes("voz-roja")
          ? failure(404, { code: "voice_not_found" })
          : audio(`mp3:${String(call.body?.text)}`),
    });
    expect(await t.service.get(t.service.request("red", "uno") ?? "")).toBeNull();
    expect(await t.service.get(t.service.request("red", "dos") ?? "")).toBeNull();
    expect((await t.service.get(t.service.request("blue", "tres") ?? ""))?.toString()).toBe("mp3:tres");
    expect(t.service.available()).toBe(true);
    const errors = t.logs.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.text).toMatch(/ELEVENLABS_VOICE_RED/);

    const invalid = await setup({ tts: () => failure(400, { code: "invalid_voice_id" }) });
    expect(await invalid.service.get(invalid.service.request("blue", "uno") ?? "")).toBeNull();
    expect(invalid.logs.filter((l) => l.level === "error")[0]?.text).toMatch(/ELEVENLABS_VOICE_BLUE/);
    expect(invalid.service.available()).toBe(true);

    // Una voz japonesa desconocida apunta a su propia variable.
    const japanese = await setup({
      config: { japaneseVoices: { red: "voz-ja-roja", blue: "voz-ja-azul" } },
      tts: () => failure(404, { code: "voice_not_found" }),
    });
    expect(await japanese.service.get(japanese.service.request("red", "uno", "japanese") ?? "")).toBeNull();
    expect(japanese.logs.filter((l) => l.level === "error")[0]?.text).toMatch(/ELEVENLABS_VOICE_JAPANESE_RED/);
  });

  it("429: reintenta una vez; si vuelve a pasar, esa frase queda sin voz", async () => {
    let n = 0;
    const once = await setup({
      tts: (call) => (++n === 1 ? failure(429, { code: "concurrent_limit_exceeded" }) : audio(`mp3:${String(call.body?.text)}`)),
    });
    expect((await once.service.get(once.service.request("red", "hola") ?? ""))?.toString()).toBe("mp3:hola");
    expect(once.tts()).toHaveLength(2);

    const always = await setup({ tts: () => failure(429, { code: "rate_limit_exceeded" }) });
    expect(await always.service.get(always.service.request("red", "hola") ?? "")).toBeNull();
    expect(always.tts()).toHaveLength(2);
    expect(always.service.available()).toBe(true);
  });

  it("un error de red o un tiempo agotado dejan esa frase sin voz y nunca muestran la clave", async () => {
    const net = await setup({
      tts: () => {
        throw new Error(`fetch failed con ${KEY}`);
      },
    });
    expect(await net.service.get(net.service.request("red", "hola") ?? "")).toBeNull();
    expect(net.service.available()).toBe(true);
    expect(net.logs.map((l) => l.text).join("\n")).not.toContain(KEY);
    expect(net.logs.some((l) => l.text.includes("***"))).toBe(true);

    const slow = await setup({
      limits: { requestTimeoutMs: 20, waitMs: 1000 },
      tts: (_call, init) =>
        new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("abortado")))),
    });
    expect(await slow.service.get(slow.service.request("red", "hola") ?? "")).toBeNull();
    expect(slow.logs.some((l) => /tardó más/.test(l.text))).toBe(true);
    // Fue un solo intento: los tiempos agotados no se reintentan.
    expect(slow.tts()).toHaveLength(1);
  });

  it("no más de maxConcurrent solicitudes a la vez; las demás esperan su turno", async () => {
    let active = 0;
    let peak = 0;
    const t = await setup({
      limits: { maxConcurrent: 4, waitMs: 2000, requestTimeoutMs: 2000 },
      tts: async (call) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return audio(`mp3:${String(call.body?.text)}`);
      },
    });
    const ids = Array.from({ length: 9 }, (_, i) => t.service.request(i % 2 ? "red" : "blue", `frase ${i}`) ?? "");
    const results = await Promise.all(ids.map((id) => t.service.get(id)));
    expect(results.map((r) => r?.toString())).toEqual(ids.map((_, i) => `mp3:frase ${i}`));
    expect(peak).toBe(4);
  });

  it("una frase que esperó su turno más de waitMs ya no se pide (nadie la va a oír)", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const t = await setup({
      limits: { maxConcurrent: 1 },
      tts: async (call) => {
        if (call.body?.text === "uno") await gate;
        return audio(`mp3:${String(call.body?.text)}`);
      },
    });
    const first = t.service.request("red", "uno") ?? "";
    await vi.waitFor(() => expect(t.tts()).toHaveLength(1));
    const stale = t.service.request("blue", "dos") ?? "";
    const shared = t.service.request("red", "tres") ?? "";
    await settle();
    t.advance(300);
    // Otro pedido de la misma frase llega a tiempo: esa sí se sigue esperando.
    const again = t.service.request("red", "tres") ?? "";
    open();
    expect((await t.service.get(first))?.toString()).toBe("mp3:uno");
    expect(await t.service.get(stale)).toBeNull();
    expect((await t.service.get(again))?.toString()).toBe("mp3:tres");
    expect((await t.service.get(shared))?.toString()).toBe("mp3:tres");
    expect(t.tts().map((c) => c.body?.text)).toEqual(["uno", "tres"]);
    expect(t.logs.filter((l) => /atrasado/.test(l.text))).toHaveLength(1);
    // Al ponerse al día, una frase nueva se pide como siempre.
    expect((await t.service.get(t.service.request("blue", "cuatro") ?? ""))?.toString()).toBe("mp3:cuatro");
  });

  it("las frases en fila no se piden si otra dio con una clave mala mientras esperaban", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const t = await setup({
      limits: { maxConcurrent: 1 },
      tts: async (call) => {
        if (call.body?.text !== "uno") return audio(`mp3:${String(call.body?.text)}`);
        await gate;
        return failure(401, { message: "Invalid API key" });
      },
    });
    const ids = [t.service.request("red", "uno") ?? ""];
    await vi.waitFor(() => expect(t.tts()).toHaveLength(1));
    ids.push(t.service.request("blue", "dos") ?? "", t.service.request("red", "tres") ?? "");
    await settle();
    open();
    for (const id of ids) expect(await t.service.get(id)).toBeNull();
    expect(t.tts()).toHaveLength(1);
    expect(t.logs.filter((l) => l.level === "error")).toHaveLength(1);
  });
});

describe("SpeechService: créditos", () => {
  it("con pocos créditos los agentes dejan de hablar (un solo aviso)", async () => {
    const t = await setup({ subscription: () => json({ character_count: 96_000, character_limit: 100_000 }) });
    await t.service.refreshCredits();
    expect(t.service.available()).toBe(false);
    expect(t.service.available()).toBe(false);
    expect(t.service.request("red", "hola")).toBeNull();
    const warnings = t.logs.filter((l) => /créditos/.test(l.text));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toMatch(/quedan 4000/);
  });

  it("suma el character-cost de cada frase para reaccionar entre lecturas", async () => {
    const t = await setup({
      subscription: () => json({ character_count: 94_000, character_limit: 100_000 }),
      tts: () => audio("mp3", { "character-cost": "1500" }),
    });
    await t.service.refreshCredits();
    expect(t.service.available()).toBe(true);
    await t.service.get(t.service.request("red", "una frase larga") ?? "");
    expect(t.service.available()).toBe(false);
  });

  it("una lectura fallida no apaga la voz", async () => {
    for (const subscription of [() => failure(500), () => Promise.reject(new Error("sin red"))]) {
      const t = await setup({ subscription });
      await t.service.refreshCredits();
      expect(t.service.available()).toBe(true);
      expect(t.logs.some((l) => l.level === "warn" && /créditos/.test(l.text))).toBe(true);
    }
  });

  it("una clave sin permiso para leer la cuenta: un solo error que dice que el tope no corre", async () => {
    let reply: () => Reply = () => failure(403, { status: "missing_permissions" });
    const t = await setup({ subscription: () => reply() });
    await t.service.refreshCredits();
    t.advance(10 * 60_000);
    await t.service.refreshCredits();
    expect(t.service.available()).toBe(true);
    const errors = t.logs.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.text).toMatch(/VOICE_MIN_CREDITS_LEFT.*User/);
    expect(t.logs.filter((l) => /créditos/.test(l.text))).toHaveLength(1);
    // Tras una lectura buena, un fallo nuevo se vuelve a avisar.
    reply = () => json(PLENTY);
    await t.service.refreshCredits();
    reply = () => failure(401);
    await t.service.refreshCredits();
    expect(t.logs.filter((l) => l.level === "error")).toHaveLength(2);
  });

  it("start lee los créditos sin esperar y se vuelven a leer cada 10 minutos como mucho", async () => {
    const t = await setup();
    const subscription = () => t.calls.filter((c) => c.url.endsWith("/v1/user/subscription"));
    t.service.start();
    await settle();
    expect(subscription()).toHaveLength(1);
    expect(subscription()[0]?.headers["xi-api-key"]).toBe(KEY);
    for (let i = 0; i < 5; i += 1) t.service.request("red", `frase ${i}`);
    t.advance(9 * 60_000);
    t.service.available();
    expect(subscription()).toHaveLength(1);
    t.advance(60_000);
    t.service.available();
    await settle();
    expect(subscription()).toHaveLength(2);
  });

  it("vuelve a hablar cuando la cuenta se recarga", async () => {
    let used = 99_000;
    const t = await setup({ subscription: () => json({ character_count: used, character_limit: 100_000 }) });
    await t.service.refreshCredits();
    expect(t.service.available()).toBe(false);
    used = 0;
    t.advance(10 * 60_000);
    t.service.available();
    await settle();
    expect(t.service.available()).toBe(true);
  });
});
