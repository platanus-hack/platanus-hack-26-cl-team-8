/**
 * Enlace "Ver transcripción" de la columna de eventos: abre, en otra pestaña, el registro
 * completo de la pelea que está en pantalla (el servidor lo va escribiendo en vivo, así
 * que sirve también a mitad de pelea).
 */
import { API_ROUTES } from "@phack/protocol";
import { MOCK, apiUrl } from "./config";
import { byId } from "./dom";

let link: HTMLAnchorElement | null = null;

export function initTranscriptLink(): void {
  const anchor = byId<HTMLAnchorElement>("transcript-link");
  link = anchor;
  if (!MOCK) return;
  // Modo maqueta: no hay servidor, el texto se arma con los eventos que emitió mock.ts.
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    void import("./mock").then(({ mockTranscriptText }) => {
      const blob = new Blob([mockTranscriptText()], { type: "text/plain;charset=utf-8" });
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
    });
  });
}

/** Apunta el enlace a una pelea; con id vacío (todavía no hubo ninguna) lo esconde. */
export function setTranscriptMatch(matchId: string): void {
  if (!link) return;
  link.hidden = matchId === "";
  if (matchId === "") return;
  link.href = MOCK ? "#" : `${apiUrl(API_ROUTES.transcript(encodeURIComponent(matchId)))}?format=text`;
}
