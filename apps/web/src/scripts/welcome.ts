/**
 * Bienvenida: una hoja que explica el sitio a quien entra por primera vez, como las de
 * "Novedades" de las apps del teléfono. Sale sola una vez por navegador; después solo se
 * abre con el botón "Cómo funciona".
 *
 * Es un <dialog> del navegador: atrapa el foco, se cierra con Esc y deja el resto de la
 * página sin poder tocarse mientras está abierta. El video sigue corriendo detrás.
 */
import { MOCK } from "./config";

/** Dónde se anota, en este navegador, que la bienvenida ya se vio. */
const SEEN_KEY = "prompt-arena.welcome";
/** Sube cuando la bienvenida cambia tanto que vale mostrarla de nuevo a quien ya la vio. */
const VERSION = "1";

function alreadySeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === VERSION;
  } catch {
    // Sin almacenamiento (ventana privada estricta) no se sabe: se muestra.
    return false;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, VERSION);
  } catch {
    // Nada que anotar: volverá a salir en la próxima visita.
  }
}

export function initWelcome(): void {
  const dialog = document.getElementById("welcome");
  // Un navegador sin <dialog> se queda sin bienvenida; el sitio funciona igual.
  if (!(dialog instanceof HTMLDialogElement) || typeof dialog.showModal !== "function") return;

  const open = (): void => {
    if (!dialog.open) dialog.showModal();
  };

  dialog.addEventListener("close", markSeen);
  // El <dialog> no tiene relleno: un clic que le llega a él mismo cayó fuera de la hoja.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.getElementById("welcome-open")?.addEventListener("click", open);

  // "?welcome" la fuerza, para revisarla, y "?welcome=0" la calla: así el sitio se puede
  // mostrar dentro de otra página (las láminas del demo) sin que la hoja tape la pelea.
  // En la maqueta no sale sola: taparía lo que se prueba.
  const param = new URLSearchParams(window.location.search).get("welcome");
  const forced = param !== null && param !== "0";
  const silenced = param === "0";
  if (forced || (!MOCK && !silenced && !alreadySeen())) open();
}
