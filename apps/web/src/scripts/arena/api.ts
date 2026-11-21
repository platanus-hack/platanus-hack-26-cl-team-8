/**
 * Lectura del torneo desde el orquestador (solo GET). En modo maqueta (`?mock`)
 * responde arena/mock.ts, que se carga con import() dinámico.
 */
import {
  TOURNAMENT_ROUTES,
  type MatchAttempt,
  type TournamentReport,
  type TournamentSummary,
} from "@phack/protocol";
import { ApiError } from "../api";
import { MOCK, apiUrl } from "../config";

export function reportPath(id: string): string {
  return TOURNAMENT_ROUTES.report.replace(":id", encodeURIComponent(id));
}

/**
 * Ruta de una pareja. Las keys de modelo traen "/" (son ids del gateway), por eso van
 * codificadas. Se piden en orden de key (a < b), como las guarda el calendario.
 */
export function pairPath(id: string, x: string, y: string): string {
  const [a, b] = x < y ? [x, y] : [y, x];
  return TOURNAMENT_ROUTES.pair
    .replace(":id", encodeURIComponent(id))
    .replace(":a", encodeURIComponent(a))
    .replace(":b", encodeURIComponent(b));
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null;
}

async function getJson(path: string): Promise<unknown> {
  if (MOCK) {
    const { mockTournamentRequest } = await import("./mock");
    try {
      return await mockTournamentRequest(path);
    } catch (err) {
      const { status, message } = err as { status?: unknown; message?: unknown };
      if (typeof status === "number" && typeof message === "string") throw new ApiError(status, message);
      throw err;
    }
  }

  let res: Response;
  try {
    res = await fetch(apiUrl(path), { headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError(0, "No se pudo conectar con el servidor de la arena.");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = isRecord(data) && typeof data.message === "string" ? data.message : null;
    if (res.status === 404) throw new ApiError(404, message ?? "No existe ese torneo.");
    throw new ApiError(res.status, message ?? `La solicitud falló (HTTP ${res.status}).`);
  }
  return data;
}

function unexpected(): never {
  throw new ApiError(200, "El servidor respondió con un formato inesperado.");
}

export async function fetchTournaments(): Promise<TournamentSummary[]> {
  const data = await getJson(TOURNAMENT_ROUTES.list);
  if (!Array.isArray(data)) unexpected();
  return data as TournamentSummary[];
}

export async function fetchReport(id: string): Promise<TournamentReport> {
  const data = await getJson(reportPath(id));
  if (!isRecord(data) || !isRecord(data.config) || !Array.isArray(data.standings) || !Array.isArray(data.matrix)) {
    unexpected();
  }
  return data as unknown as TournamentReport;
}

export async function fetchPair(id: string, a: string, b: string): Promise<MatchAttempt[]> {
  const data = await getJson(pairPath(id, a, b));
  if (!Array.isArray(data)) unexpected();
  return data as MatchAttempt[];
}
