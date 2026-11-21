/**
 * Dos mejoras para los controles de los ajustes, sin cambiar los campos de verdad:
 *
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

export function initSettingControls(): void {
  document.querySelectorAll<HTMLElement>("[data-stepper]").forEach(initStepper);
  document.querySelectorAll<HTMLSelectElement>("select[data-segmented]").forEach(initSegmented);
}
