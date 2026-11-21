/**
 * Mejoras para los controles de los ajustes, sin cambiar los campos de verdad:
 *
 * - Ayuda a pedido: el texto que explica cada ajuste se guarda tras un botón "i" junto a
 *   su nombre y se abre con un clic, en un recuadro. Los avisos de estado (los de
 *   `.setting__help--strong`) quedan siempre a la vista.
 * - Contador: un `<input type="number">` dentro de `[data-stepper]` gana botones − y +.
 * - Opciones a la vista: un `<select data-segmented>` de pocas opciones se muestra como una
 *   fila de botones, una por opción. El select sigue en la página (oculto) y es quien
 *   guarda el valor: los botones solo lo cambian y avisan con el mismo evento "change".
 *
 * settings.ts y benchsettings.ts siguen leyendo y escribiendo los campos como siempre; por
 * eso aquí se vuelve a mirar su valor cada poco, además de al cambiar.
 */
const SYNC_MS = 200;

function fire(target: HTMLElement): void {
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

function initStepper(holder: HTMLElement): void {
  const input = holder.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) return;
  const buttons = Array.from(holder.querySelectorAll<HTMLButtonElement>("button[data-step]"));
  const limit = (name: "min" | "max", fallback: number): number => {
    const value = Number(input.getAttribute(name));
    return input.hasAttribute(name) && Number.isFinite(value) ? value : fallback;
  };

  const sync = (): void => {
    const value = Number(input.value);
    for (const button of buttons) {
      const step = Number(button.dataset.step);
      const atEdge = step < 0 ? value <= limit("min", -Infinity) : value >= limit("max", Infinity);
      button.disabled = input.disabled || atEdge;
    }
  };

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const current = Number(input.value);
      const base = Number.isFinite(current) ? current : limit("min", 0);
      const next = Math.min(limit("max", Infinity), Math.max(limit("min", -Infinity), base + Number(button.dataset.step)));
      if (String(next) === input.value) return;
      input.value = String(next);
      fire(input);
      sync();
    });
  }
  input.addEventListener("input", sync);
  window.setInterval(sync, SYNC_MS);
  sync();
}

function initSegmented(select: HTMLSelectElement): void {
  const group = document.createElement("div");
  group.className = "segmented";
  group.setAttribute("role", "group");
  const label = select.getAttribute("aria-label") ?? select.labels?.[0]?.textContent?.trim();
  if (label) group.setAttribute("aria-label", label);

  const buttons = Array.from(select.options).map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segmented__option";
    button.textContent = option.textContent;
    button.dataset.value = option.value;
    button.addEventListener("click", () => {
      if (select.value === option.value) return;
      select.value = option.value;
      fire(select);
      sync();
    });
    return button;
  });

  let shown = "";
  const sync = (): void => {
    const state = `${select.value}|${select.disabled}`;
    if (state === shown) return;
    shown = state;
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.value === select.value));
      button.disabled = select.disabled;
    }
  };

  group.append(...buttons);
  select.hidden = true;
  select.after(group);
  select.addEventListener("change", sync);
  window.setInterval(sync, SYNC_MS);
  sync();
}

// ---------- Ayuda a pedido ----------

/** El recuadro de ayuda abierto, si hay uno: se cierra al abrir otro, con Escape o con un clic fuera. */
let openInfo: { button: HTMLButtonElement; panel: HTMLElement } | null = null;

function closeInfo(refocus = false): void {
  if (!openInfo) return;
  const { button, panel } = openInfo;
  openInfo = null;
  panel.hidden = true;
  button.setAttribute("aria-expanded", "false");
  if (refocus) button.focus();
}

/**
 * Los párrafos de ayuda de la fila siguen siendo los mismos (settings.ts y
 * benchsettings.ts les cambian el texto): solo se mudan a un recuadro oculto, que el
 * botón "i" abre bajo el nombre del ajuste.
 */
function initInfo(row: HTMLElement, index: number): void {
  const label = row.querySelector<HTMLElement>(".setting__label");
  const helps = Array.from(row.querySelectorAll<HTMLElement>(".setting__help:not(.setting__help--strong)"));
  if (!label || helps.length === 0) return;

  const head = document.createElement("div");
  head.className = "setting__head";
  label.before(head);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "info";
  button.textContent = "i";
  button.setAttribute("aria-label", `Qué es: ${label.textContent?.trim() ?? "este ajuste"}`);
  button.setAttribute("aria-expanded", "false");

  const panel = document.createElement("div");
  panel.className = "setting__info";
  panel.id = `setting-info-${index}`;
  panel.hidden = true;
  panel.append(...helps);
  button.setAttribute("aria-controls", panel.id);
  head.append(label, button, panel);

  // Sin texto que mostrar (una descripción que todavía no llega), el botón no aparece.
  const refresh = (): void => {
    const empty = helps.every((help) => help.hidden || (help.textContent ?? "").trim() === "");
    button.hidden = empty;
    if (empty && openInfo?.button === button) closeInfo();
  };
  new MutationObserver(refresh).observe(panel, { childList: true, characterData: true, subtree: true, attributes: true });
  refresh();

  button.addEventListener("click", () => {
    const wasOpen = openInfo?.button === button;
    closeInfo();
    if (wasOpen) return;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    openInfo = { button, panel };
  });
}

function initInfos(): void {
  document.querySelectorAll<HTMLElement>(".setting").forEach(initInfo);
  document.addEventListener("mousedown", (event) => {
    if (!openInfo || !(event.target instanceof Node)) return;
    if (openInfo.button.contains(event.target) || openInfo.panel.contains(event.target)) return;
    closeInfo();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openInfo) closeInfo(true);
  });
}

export function initSettingControls(): void {
  initInfos();
  document.querySelectorAll<HTMLElement>("[data-stepper]").forEach(initStepper);
  document.querySelectorAll<HTMLSelectElement>("select[data-segmented]").forEach(initSegmented);
}
