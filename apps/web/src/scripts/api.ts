import {
  API_ROUTES,
  AgentConfigSchema,
  MatchRecordSchema,
  MatchStateSchema,
  type AgentConfig,
  type MatchRecord,
  type MatchState,
  type PromptsResponse,
  type Side,
  type UpdatePromptBody,
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

const matchesParser: Parser<MatchRecord[]> = {
  parse(data) {
    return MatchRecordSchema.array().parse(data);
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

export function startMatch(): Promise<MatchState> {
  return request(API_ROUTES.matchStart, MatchStateSchema, { method: "POST" });
}

export function stopMatch(): Promise<MatchState> {
  return request(API_ROUTES.matchStop, MatchStateSchema, { method: "POST" });
}

export function fetchMatches(): Promise<MatchRecord[]> {
  return request(API_ROUTES.matches, matchesParser);
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Ocurrió un error inesperado.";
}
