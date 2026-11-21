/**
 * Selector de modelo de cada prompt: un botón que muestra el modelo elegido (logo +
 * nombre) y, al abrirlo, un buscador sobre la lista de modelos permitidos que entrega
 * el servidor. No se puede escribir un id a mano: solo se elige de esa lista.
 *
 * No guarda estado propio: lo elegido vive en el editor (prompts.ts), que lo entrega
 * con `getChoice` y lo recibe con `onPick`.
 */
import type { AllowedModel, Side } from "@phack/protocol";
import { loadCatalog, priceDetail, priceHint } from "./catalog";
import { byId, el } from "./dom";
import { describeModel, renderModelTag, resolveModel, type ModelInfo } from "./models";

/**
 * Lo que se guarda con el prompt. Proveedor y modelo vacíos = "por defecto del servidor";
 * proveedor "mock" = simulado, sin modelo; un modelo de la lista va con proveedor "vercel".
 */
export type ModelChoice = { provider: string; model: string };

type Option = {
  choice: ModelChoice;
  info: ModelInfo;
  hint: string;
  /** Explicación larga de `hint`, para el tooltip de la fila. */
  title: string;
  search: string;
};

/** Más resultados que esto no se dibujan: se afina escribiendo en el buscador. */
const MAX_RESULTS = 60;

function isSelected(option: ModelChoice, current: ModelChoice): boolean {
  if (option.provider === "mock" || current.provider === "mock") return option.provider === current.provider;
  // Fila "por defecto": solo si de verdad no se eligió nada.
  if (option.model === "") return current.provider === "" && current.model.trim() === "";
  return option.model === current.model.trim();
}

export function createModelPicker(opts: {
  side: Side;
  getChoice(): ModelChoice;
  onPick(choice: ModelChoice): void;
}): void {
  const { side } = opts;
  const root = byId(`picker-${side}`);
  const trigger = byId<HTMLButtonElement>(`picker-trigger-${side}`);
  const panel = byId(`picker-panel-${side}`);
  const search = byId<HTMLInputElement>(`picker-search-${side}`);
  const list = byId(`picker-list-${side}`);

  let catalog: AllowedModel[] = [];
  let catalogState: "loading" | "ready" | "failed" = "loading";
  let options: Option[] = [];
  let active = 0;

  const buildOptions = (): Option[] => {
    const query = search.value.trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    const matches = (text: string): boolean => words.every((word) => text.includes(word));

    const fixed: Option[] = [
      {
        choice: { provider: "", model: "" },
        info: resolveModel({}) ?? { name: "Por defecto del servidor", detail: "", brand: null },
        hint: "Por defecto del servidor",
        title: "El modelo que el servidor usa cuando no se elige uno.",
        search: "por defecto del servidor default",
      },
      {
        choice: { provider: "mock", model: "" },
        info: { name: "Simulado", detail: "", brand: null },
        hint: "Sin LLM: sirve para probar",
        title: "Un agente con reglas fijas, sin llamar a ningún modelo. No cuesta nada.",
        search: "simulado mock prueba",
      },
    ];
    const fromCatalog = catalog.map(
      (model): Option => ({
        choice: { provider: "vercel", model: model.id },
        info: describeModel(model.id, model.name),
        hint: priceHint(model),
        title: `${model.id} · ${priceDetail(model)}`,
        search: `${model.name} ${model.id}`.toLowerCase(),
      }),
    );

    return [...fixed, ...fromCatalog].filter((option) => matches(option.search)).slice(0, MAX_RESULTS);
  };

  const setActive = (index: number): void => {
    active = Math.max(0, Math.min(options.length - 1, index));
    Array.from(list.children).forEach((node, i) => {
      // Las filas de aviso ("Cargando…") van después de las opciones y nunca quedan activas.
      node.classList.toggle("is-active", i === active && i < options.length);
      if (i === active) node.scrollIntoView({ block: "nearest" });
    });
  };

  const render = (): void => {
    options = buildOptions();
    const current = opts.getChoice();
    list.replaceChildren(
      ...options.map((option, index) => {
        const item = el("li", "picker__option");
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(isSelected(option.choice, current)));
        item.title = option.title;
        const tag = el("span", "model-tag");
        renderModelTag(tag, option.info);
        // La ayuda repetiría lo que ya dice la fila.
        delete tag.dataset.tip;
        item.append(tag, el("span", "picker__hint", option.hint));
        // mousedown y no click: el buscador no pierde el foco antes de elegir.
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          pick(index);
        });
        item.addEventListener("mousemove", () => setActive(index));
        return item;
      }),
    );
    if (catalogState === "loading") list.append(el("li", "picker__empty", "Cargando la lista de modelos…"));
    else if (catalogState === "failed") {
      list.append(el("li", "picker__empty", "No se pudo cargar la lista de modelos. Cierra y vuelve a abrir para reintentar."));
    } else if (options.length === 0) list.append(el("li", "picker__empty", "Ningún modelo coincide."));
    setActive(0);
  };

  const close = (): void => {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };

  const open = (): void => {
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    search.value = "";
    if (catalogState === "failed") catalogState = "loading";
    render();
    search.focus();
    // La lista se pide recién la primera vez que alguien abre un selector.
    loadCatalog().then(
      (models) => {
        catalog = models;
        catalogState = "ready";
        if (!panel.hidden) render();
      },
      () => {
        catalogState = "failed";
        if (!panel.hidden) render();
      },
    );
  };

  const pick = (index: number): void => {
    const option = options[index];
    if (!option) return;
    opts.onPick(option.choice);
    close();
    trigger.focus();
  };

  trigger.addEventListener("click", () => (panel.hidden ? open() : close()));
  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") setActive(active + 1);
    else if (event.key === "ArrowUp") setActive(active - 1);
    else if (event.key === "Enter") pick(active);
    else if (event.key === "Escape") {
      close();
      trigger.focus();
    } else return;
    // Enter no debe enviar el formulario del prompt.
    event.preventDefault();
  });
  document.addEventListener("mousedown", (event) => {
    if (event.target instanceof Node && !root.contains(event.target)) close();
  });
  root.addEventListener("focusout", (event) => {
    if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) close();
  });
}
