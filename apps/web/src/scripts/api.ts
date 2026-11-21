import {
  API_ROUTES,
  FlaggedPromptSchema,
  AgentConfigSchema,
  MatchRecordSchema,
  MatchSettingsSchema,
  MatchStateSchema,
  ModelsResponseSchema,
  ServerDefaultsSchema,
  type AgentConfig,
  type MatchRecord,
  type MatchSettings,
  type MatchState,
  type ModelsResponse,
  type PromptsResponse,
  type ServerDefaults,
  type Side,
  type UpdatePromptBody,
  type UpdateSettingsBody,
  type FlagBody,
  type FlaggedPrompt,
  JudgementSchema,
  type BenchOptions,
  type PresetsResponse,
  type BenchReport,
  type Judgement,
} from "@phack/protocol";
import { MOCK, apiUrl } from "./config";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type Parser<T> = { parse(data: unknown): T };

function defaultMessage(status: number): string {
  if (status === 409) return "Ya hay una pelea en curso.";
  if (status === 400 || status === 422) return "El servidor rechazó los datos enviados.";
  if (status === 404) return "El servidor no reconoce esa operación.";
  if (status === 429) return "Demasiadas solicitudes. Espera un momento.";
  if (status >= 500) return "El servidor de la arena falló o no está disponible.";
  return `La solicitud falló (HTTP ${status}).`;
}

/** Intenta rescatar un mensaje de error legible del cuerpo de la respuesta. */
function serverMessage(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  for (const key of ["error", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.slice(0, 300);
  }
  return null;
}

/** Modo maqueta: responde mock.ts en vez del servidor, pasando por los mismos parsers. */
async function mockedRequest<T>(path: string, parser: Parser<T>, init?: { method: string; body?: unknown }): Promise<T> {
  const { mockRequest } = await import("./mock");
  let data: unknown;
  try {
    data = await mockRequest(path, init);
  } catch (err) {
    const { status, message } = err as { status?: unknown; message?: unknown };
    if (typeof status === "number" && typeof message === "string") throw new ApiError(status, message);
    throw err;
  }
  return parser.parse(data);
}

async function request<T>(path: string, parser: Parser<T>, init?: { method: string; body?: unknown }): Promise<T> {
  if (MOCK) return mockedRequest(path, parser, init);

  const headers: Record<string, string> = { Accept: "application/json" };
  const options: RequestInit = { method: init?.method ?? "GET", headers };
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(init.body);
  }

  let res: Response;
  try {
    res = await fetch(apiUrl(path), options);
  } catch {
    throw new ApiError(0, "No se pudo conectar con el servidor de la arena.");
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) throw new ApiError(res.status, serverMessage(data) ?? defaultMessage(res.status));

  try {
    return parser.parse(data);
  } catch {
    throw new ApiError(res.status, "El servidor respondió con un formato inesperado.");
  }
}

const promptsParser: Parser<PromptsResponse> = {
  parse(data) {
    const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    return { red: AgentConfigSchema.parse(record.red), blue: AgentConfigSchema.parse(record.blue) };
  },
};

export function fetchState(): Promise<MatchState> {
  return request(API_ROUTES.state, MatchStateSchema);
}

export function fetchPrompts(): Promise<PromptsResponse> {
  return request(API_ROUTES.prompts, promptsParser);
}

export function savePrompt(side: Side, body: UpdatePromptBody): Promise<AgentConfig> {
  return request(API_ROUTES.prompt(side), AgentConfigSchema, { method: "PUT", body });
}

export function fetchSettings(): Promise<MatchSettings> {
  return request(API_ROUTES.settings, MatchSettingsSchema);
}

export function saveSettings(body: UpdateSettingsBody): Promise<MatchSettings> {
  return request(API_ROUTES.settings, MatchSettingsSchema, { method: "PUT", body });
}

export function startMatch(): Promise<MatchState> {
  return request(API_ROUTES.matchStart, MatchStateSchema, { method: "POST" });
}

export function stopMatch(): Promise<MatchState> {
  return request(API_ROUTES.matchStop, MatchStateSchema, { method: "POST" });
}

/** Últimas peleas guardadas. La web solo lo usa para leer el "por qué ganó" de la más reciente. */
export function fetchMatches(): Promise<MatchRecord[]> {
  return request(API_ROUTES.matches, { parse: (data) => MatchRecordSchema.array().parse(data) });
}

/** Prompts marcados, los más recientes primero. */
export function fetchFlags(): Promise<FlaggedPrompt[]> {
  return request(API_ROUTES.flags, { parse: (data) => FlaggedPromptSchema.array().parse(data) });
}

/** Marca (o edita la marca de) el prompt de un lado en una pelea. */
export function saveFlag(matchId: string, side: Side, body: FlagBody): Promise<FlaggedPrompt> {
  return request(API_ROUTES.flag(matchId, side), FlaggedPromptSchema, { method: "PUT", body });
}

export function removeFlag(matchId: string, side: Side): Promise<unknown> {
  return request(API_ROUTES.flag(matchId, side), { parse: (data) => data }, { method: "DELETE" });
}

export function fetchDefaults(): Promise<ServerDefaults> {
  return request(API_ROUTES.defaults, ServerDefaultsSchema);
}

/** Modelos que se pueden elegir: el servidor ya dejó fuera los que pasan del tope de precio. */
export function fetchModels(): Promise<ModelsResponse> {
  return request(API_ROUTES.models, ModelsResponseSchema);
}

/** Tablero de benchmarks, calculado por el servidor con todo el historial. */
export function fetchBench(options: BenchOptions = {}): Promise<BenchReport> {
  const query = new URLSearchParams();
  if (options.scenario) query.set("scenario", options.scenario);
  if (options.minMatches !== undefined) query.set("min", String(options.minMatches));
  const path = query.size > 0 ? `${API_ROUTES.bench}?${query}` : API_ROUTES.bench;
  return request(path, {
    parse: (data) => {
      const report = data as BenchReport;
      if (typeof report !== "object" || report === null || !Array.isArray(report.models)) throw new Error("formato");
      return report;
    },
  });
}

/** Pide al LLM juez que califique una pelea. */
export function judgeMatch(matchId: string): Promise<Judgement> {
  return request(API_ROUTES.judge(matchId), JudgementSchema, { method: "POST" });
}

/** Pre-ajustes de benchmark y cómo va la batería. */
const presetsParser: Parser<PresetsResponse> = {
  parse: (data) => {
    const value = data as PresetsResponse;
    if (typeof value !== "object" || value === null || !Array.isArray(value.presets) || typeof value.suite !== "object") {
      throw new Error("formato");
    }
    return value;
  },
};

/** Carga un pre-ajuste; con `start`, lo ejecuta ("todos" corre la batería completa). */
export function runPreset(id: string, start: boolean): Promise<PresetsResponse> {
  return request(API_ROUTES.preset(encodeURIComponent(id)), presetsParser, { method: "POST", body: { start } });
}

/** Archiva el historial de peleas en el servidor (el tablero queda vacío). */
export function clearHistory(): Promise<{ archived: string | null }> {
  return request(
    API_ROUTES.history,
    {
      parse: (data) => {
        const value = data as { archived?: unknown };
        return { archived: typeof value?.archived === "string" ? value.archived : null };
      },
    },
    { method: "DELETE", body: { confirm: "BORRAR" } },
  );
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Ocurrió un error inesperado.";
}
