/**
 * Selector de modelo de cada prompt: un botón que muestra el modelo elegido (logo +
 * nombre) y, al abrirlo, un buscador sobre el catálogo.
 *
 * No guarda estado propio: lo elegido se escribe en los dos campos del formulario
 * (proveedor e id del modelo, que quedan bajo "Avanzado") y de ahí lo lee prompts.ts.
 */
import type { Side } from "@phack/protocol";
import { loadCatalog, type CatalogModel } from "./catalog";
import { byId, el } from "./dom";
import { describeModel, gatewayProvider, renderModelTag, resolveModel, type ModelInfo } from "./models";

/** Lo que queda en el formulario: "" significa "por defecto del servidor". */
export type ModelChoice = { provider: string; model: string };

type Option = { choice: ModelChoice; info: ModelInfo; hint: string; search: string };

/** Más resultados que esto no se dibujan: se afina escribiendo en el buscador. */
const MAX_RESULTS = 60;

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

  let catalog: CatalogModel[] = [];
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
        search: "por defecto del servidor default",
      },
      {
        choice: { provider: "mock", model: "" },
        info: { name: "Simulado", detail: "", brand: null },
        hint: "Sin LLM: sirve para probar",
        search: "simulado mock prueba",
      },
    ];
    const fromCatalog = catalog.map(
      (model): Option => ({
        choice: { provider: gatewayProvider(), model: model.id },
        info: describeModel(model.id, model.name),
        hint: model.id,
        search: `${model.name} ${model.id}`.toLowerCase(),
      }),
    );

    const found = [...fixed, ...fromCatalog].filter((option) => matches(option.search)).slice(0, MAX_RESULTS);
    // Un id que no está en la lista también vale: se usa tal cual se escribió.
    const typed = search.value.trim();
    if (typed !== "" && !fromCatalog.some((option) => option.choice.model.toLowerCase() === query)) {
      found.push({
        choice: { provider: typed.includes("/") ? gatewayProvider() : opts.getChoice().provider, model: typed },
        info: describeModel(typed),
        hint: "Usar este id tal cual",
        search: query,
      });
    }
    return found;
  };

  const setActive = (index: number): void => {
    active = Math.max(0, Math.min(options.length - 1, index));
    Array.from(list.children).forEach((node, i) => {
      node.classList.toggle("is-active", i === active);
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
        const selected = option.choice.provider === current.provider && option.choice.model === current.model.trim();
        item.setAttribute("aria-selected", String(selected));
        const tag = el("span", "model-tag");
        renderModelTag(tag, option.info);
        // El tooltip repetiría lo que ya dice la fila.
        tag.removeAttribute("title");
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
    if (options.length === 0) list.append(el("li", "picker__empty", "Ningún modelo coincide."));
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
    render();
    search.focus();
    // El catálogo se pide recién la primera vez que alguien abre un selector.
    void loadCatalog().then((models) => {
      catalog = models;
      if (!panel.hidden) render();
    });
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
