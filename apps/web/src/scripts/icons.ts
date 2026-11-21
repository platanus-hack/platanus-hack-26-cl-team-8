/**
 * Íconos de píxeles creados en el navegador (ítem en la mano, última acción, inventario
 * del kit). Arma el mismo SVG que components/PixelIcon.astro, con los mismos datos de
 * pixelicons.ts.
 */
import { ICON_SIZE, iconRuns, type IconRef } from "./pixelicons";

const SVG_NS = "http://www.w3.org/2000/svg";

export function pixelIcon(ref: IconRef): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "pixel-icon");
  svg.setAttribute("data-icon", ref.name);
  svg.setAttribute("viewBox", `0 0 ${ICON_SIZE} ${ICON_SIZE}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  for (const run of iconRuns(ref.name, ref.material)) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(run.x));
    rect.setAttribute("y", String(run.y));
    rect.setAttribute("width", String(run.width));
    rect.setAttribute("height", "1");
    rect.setAttribute("fill", run.fill);
    svg.append(rect);
  }
  return svg;
}

/** Deja en `holder` el ícono pedido, o nada con null. Solo redibuja si cambió. */
export function setPixelIcon(holder: HTMLElement, ref: IconRef | null): void {
  const key = ref ? `${ref.name}:${ref.material ?? ""}` : "";
  // Los eventos de estado llegan varias veces por segundo: casi siempre no hay nada que hacer.
  if ((holder.dataset.icon ?? "") === key) return;
  holder.dataset.icon = key;
  if (ref) holder.replaceChildren(pixelIcon(ref));
  else holder.replaceChildren();
}
