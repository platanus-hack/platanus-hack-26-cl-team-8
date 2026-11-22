/**
 * Con qué rol está este navegador frente a la arena, y qué se le muestra por eso.
 *
 * La clave (del equipo o de invitados) vive en localStorage, en ACCESS_STORAGE, como JSON:
 * `{"key":"..."}`. Llega de dos maneras:
 *
 *  - A mano, desde la consola del navegador:
 *      localStorage.setItem("prompt-arena.access", JSON.stringify({ key: "la clave" }))
 *  - Abriendo un enlace que la trae después del "#": https://sitio/#key=la-clave. La página
 *    la guarda y la borra de la dirección. Lo que va tras el "#" no viaja al servidor ni queda
 *    en sus registros: sirve para pasarle la clave a un jurado con un QR.
 *
 * El servidor es el que manda: cada solicitud que cambia algo lleva la clave y él decide.
 * Aquí solo se esconde lo que igual sería rechazado:
 *
 *  - `data-needs="admin"`: solo se ve con la clave del equipo.
 *  - `data-needs="play"`: se ve si se puede jugar (equipo, invitados o arena abierta).
 *  - `data-lock="play"`: queda a la vista pero sin poder tocarse si no se puede jugar.
 */
import { ACCESS_HEADER, AccessResponseSchema, API_ROUTES, canPlay, type AccessRole } from "@phack/protocol";
import { MOCK, apiUrl } from "./config";

export const ACCESS_STORAGE = "prompt-arena.access";

let key: string | null = null;
let role: AccessRole = "visitor";
/** El servidor pide clave. Sin eso (una máquina local) todos son del equipo. */
let enabled = true;
let publicPlay = false;
const listeners = new Set<() => void>();

function readStored(): string | null {
  try {
    const raw = window.localStorage.getItem(ACCESS_STORAGE);
    if (!raw) return null;
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // También vale la clave suelta, sin JSON.
    }
    const text = typeof value === "string" ? value : typeof value === "object" && value !== null ? (value as { key?: unknown }).key : null;
    return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
  } catch {
    return null;
  }
}

/** Si la dirección trae "#key=...", la guarda y la saca de la dirección. */
function takeFromUrl(): void {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "") return;
  const params = new URLSearchParams(hash);
  const given = params.get("key")?.trim();
  if (!given) return;
  try {
    window.localStorage.setItem(ACCESS_STORAGE, JSON.stringify({ key: given }));
  } catch {
    // Sin almacenamiento (ventana privada): vale para esta visita.
  }
  key = given;
  params.delete("key");
  const rest = params.toString();
  window.history.replaceState(null, "", window.location.pathname + window.location.search + (rest ? `#${rest}` : ""));
}

/** Cabeceras que identifican a este navegador ante el servidor (vacío sin clave). */
export function accessHeaders(): Record<string, string> {
  return key ? { [ACCESS_HEADER]: key } : {};
}

export function getRole(): AccessRole {
  return role;
}

export function isAdmin(): boolean {
  return role === "admin";
}

/** Puede escribir prompts e iniciar peleas ahora. */
export function mayPlay(): boolean {
  return canPlay(role, { publicPlay });
}

/** El servidor pide clave para cambiar la arena. */
export function accessEnabled(): boolean {
  return enabled;
}

export function onAccessChange(listener: () => void): void {
  listeners.add(listener);
}

function apply(): void {
  const play = mayPlay();
  document.body.dataset.role = role;
  document.body.dataset.play = play ? "yes" : "no";
  for (const node of document.querySelectorAll<HTMLElement>('[data-lock="play"]')) node.inert = !play;

  const note = document.getElementById("access-note");
  if (note) {
    const text = !enabled
      ? ""
      : role === "player"
        ? "Entraste como invitado: puedes escribir los prompts e iniciar peleas."
        : role === "visitor"
          ? play
            ? "La arena está abierta: escribe un prompt para cada lado e inicia la pelea."
            : "Modo espectador: aquí se ve la pelea en vivo y lo que piensa cada agente. Por ahora solo el equipo y sus invitados escriben los prompts e inician peleas."
          : "";
    note.textContent = text;
    note.hidden = text === "";
  }

  const chip = document.getElementById("access-chip");
  if (chip) {
    const named = enabled && role !== "visitor";
    chip.hidden = !named;
    chip.textContent = role === "admin" ? "Equipo" : "Invitado";
  }
  for (const listener of listeners) listener();
}

/** Los ajustes dicen si la arena está abierta a quien visita. */
export function setPublicPlay(open: boolean): void {
  if (publicPlay === open) return;
  publicPlay = open;
  apply();
}

/** Olvida la clave de este navegador. */
function forget(): void {
  try {
    window.localStorage.removeItem(ACCESS_STORAGE);
  } catch {
    // Nada que borrar.
  }
  key = null;
  role = "visitor";
  apply();
}

async function ask(): Promise<void> {
  if (MOCK) {
    // Maqueta: sin control, o con el rol pedido en ?as=visitor|player|admin para ver cómo queda.
    const wanted = new URLSearchParams(window.location.search).get("as");
    role = wanted === "visitor" || wanted === "player" ? wanted : "admin";
    enabled = wanted !== null;
    apply();
    return;
  }
  try {
    const res = await fetch(apiUrl(API_ROUTES.access), { headers: { Accept: "application/json", ...accessHeaders() } });
    if (res.status === 404) {
      // Un servidor anterior al control de acceso: no pide clave.
      enabled = false;
      role = "admin";
    } else {
      const answer = AccessResponseSchema.parse(await res.json());
      enabled = answer.enabled;
      role = answer.role;
    }
  } catch {
    // Sin respuesta se queda como visitante: nada se rompe, y el servidor decide igual.
  }
  apply();
}

export function initAccess(): void {
  key = readStored();
  takeFromUrl();
  // Hasta que el servidor responda: con clave se asume que vale; sin ella, visitante.
  role = key ? "admin" : "visitor";
  apply();
  // Quitar la clave pide dos clics: el primero pregunta en el mismo botón.
  const chip = document.getElementById("access-chip");
  let asking: number | null = null;
  chip?.addEventListener("click", () => {
    if (asking !== null) {
      window.clearTimeout(asking);
      asking = null;
      forget();
      return;
    }
    chip.textContent = "¿Quitar la clave?";
    asking = window.setTimeout(() => {
      asking = null;
      apply();
    }, 3000);
  });
  void ask();
}
