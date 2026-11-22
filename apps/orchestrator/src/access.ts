import { createHash, timingSafeEqual } from "node:crypto";
import { API_ROUTES, PLAYER_SETTINGS, type AccessRole, type MatchSettings } from "@phack/protocol";

/**
 * Quién puede cambiar qué. La arena se ve sin clave; cambiarla pide una, que la web manda
 * en la cabecera ACCESS_HEADER:
 *
 *  - Clave del equipo (ADMIN_PASSPHRASE): todo.
 *  - Clave de invitados (PLAYER_PASSPHRASE, opcional): escribir prompts, elegir cómo se
 *    comunican los agentes e iniciar peleas. Pensada para un jurado.
 *  - Sin clave: solo mirar. Si el equipo abre la arena (MatchSettings.publicPlay), quien
 *    visita puede lo mismo que un invitado.
 *
 * Sin ADMIN_PASSPHRASE no hay control: todos son del equipo, como en una máquina local.
 */

export type AccessConfig = { adminKey: string; playerKey: string };

/** Lo que pide una ruta que cambia algo: jugar o ser del equipo. */
export type Need = "play" | "admin";

/** Compara sin filtrar por tiempo cuánto de la clave coincide. */
function sameKey(given: string, expected: string): boolean {
  const digest = (text: string): Buffer => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export function createAccess(config: AccessConfig) {
  const adminKey = config.adminKey.trim();
  const playerKey = config.playerKey.trim();
  const enabled = adminKey !== "";
  return {
    /** Hay clave del equipo: las rutas que cambian algo la piden. */
    enabled,
    /** Rol de quien manda esa clave (la cabecera puede faltar o venir repetida). */
    roleOf(header: string | string[] | undefined): AccessRole {
      if (!enabled) return "admin";
      const given = (Array.isArray(header) ? header[0] : header)?.trim() ?? "";
      if (given === "") return "visitor";
      if (sameKey(given, adminKey)) return "admin";
      if (playerKey !== "" && sameKey(given, playerKey)) return "player";
      return "visitor";
    },
  };
}

export type Access = ReturnType<typeof createAccess>;

/**
 * Qué pide una solicitud. Leer no pide nada. De lo que cambia algo, escribir un prompt,
 * iniciar una pelea y los ajustes de PLAYER_SETTINGS piden jugar; todo lo demás (detener,
 * el resto de los ajustes, baterías, banderas, juez, borrar el historial y cualquier ruta
 * nueva) queda para el equipo.
 */
export function needOf(method: string, route: string, body: unknown): Need | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (method === "PUT" && route === "/api/prompts/:side") return "play";
  if (method === "POST" && route === API_ROUTES.matchStart) return "play";
  if (method === "PUT" && route === API_ROUTES.settings) {
    const keys = typeof body === "object" && body !== null ? Object.keys(body) : [];
    const open: readonly string[] = PLAYER_SETTINGS;
    return keys.length > 0 && keys.every((key) => open.includes(key)) ? "play" : "admin";
  }
  return "admin";
}

/** Si ese rol puede, con los ajustes de ahora. */
export function allowed(need: Need | null, role: AccessRole, settings: Pick<MatchSettings, "publicPlay">): boolean {
  if (need === null || role === "admin") return true;
  if (need === "admin") return false;
  return role === "player" || settings.publicPlay;
}

/** Por qué no, en una frase para quien lo intentó. */
export function denial(need: Need, role: AccessRole): string {
  if (need === "admin") return "Esto solo lo puede hacer el equipo de la arena";
  return role === "visitor"
    ? "La arena está en modo espectador: por ahora solo el equipo y sus invitados pueden escribir prompts e iniciar peleas"
    : "No tienes permiso para esto";
}
