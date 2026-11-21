/**
 * Selector de lo que va en un casillero del inventario. Al hacer clic en un casillero
 * (o Enter / Espacio con el foco en él) se abre un panel pegado a ese casillero con solo
 * lo que cabe ahí, sacado del catálogo del kit personalizado (CUSTOM_KIT_ITEMS): en la
 * armadura, esa pieza en sus materiales; en la mano secundaria, el escudo; en la barra
 * rápida, todo lo demás, por grupos. Un buscador filtra al escribir; las flechas mueven
 * y Enter elige. Lo que se apila pide después la cantidad; las pociones, su tipo.
 *
 * Se ve y se maneja como el selector de modelo (modelpicker.ts), pero el panel va con
 * posición fija: así no lo corta la columna del editor y se queda dentro de la pantalla
 * (se abre hacia arriba si abajo no cabe).
 *
 * No guarda el inventario: lo lee del editor con `getKit` y le entrega la lista nueva de
 * ítems con `onChange` (prompts.ts la valida y la deja como borrador).
 */
import {
  CUSTOM_KIT_ITEMS,
  CUSTOM_KIT_POTIONS,
  customKitArmorSlot,
  customKitGroup,
  type CustomKitGroup,
  type Kit,
  type KitItem,
  type KitSlot,
  type Side,
} from "@phack/protocol";
import { el } from "./dom";
import { itemGlyph, slotName } from "./inventory";

/** Títulos de los grupos de la barra rápida, en el orden en que se listan. */
const HOTBAR_GROUPS: readonly [CustomKitGroup, string][] = [
  ["weapon", "Armas"],
  ["ranged", "Arco y flechas"],
  ["food", "Comida"],
  ["potion", "Pociones"],
  ["block", "Bloques"],
  ["utility", "Utilidades"],
];

type Entry = { id: string; label: string; stack: number; group: CustomKitGroup };

/** El catálogo, en su orden, con el grupo de cada ítem. */
const CATALOG: readonly Entry[] = Object.entries(CUSTOM_KIT_ITEMS).map(([id, entry]) => ({
  id,
  label: entry.label,
  stack: entry.stack,
  group: customKitGroup(id),
}));

/** Qué cabe en cada casillero: la armadura en su lugar, el escudo en la mano secundaria y lo demás en la barra rápida. */
function fits(entry: Entry, slot: KitSlot): boolean {
  if (slot.startsWith("armor.")) return customKitArmorSlot(entry.id) === slot;
  if (slot === "weapon.offhand") return entry.group === "offhand";
  return entry.group !== "armor" && entry.group !== "offhand";
}

/** Cantidad al elegir algo que se apila: un stack entero de flechas y bloques; de lo demás (comida, perlas), unos pocos. */
function defaultCount(entry: Entry): number {
  if (entry.stack === 1) return 1;
  if (entry.id === "arrow" || entry.group === "block") return entry.stack;
  return Math.min(4, entry.stack);
}

/** Texto para buscar: sin tildes ni mayúsculas ("pocion" encuentra "Poción"). */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

type Option = {
  label: string;
  hint: string;
  /** Título del grupo bajo el que va; null = sin título. */
  group: string | null;
  /** Ítem del ícono; null = sin ícono ("Vacío"). */
  icon: { id: string; label: string } | null;
  selected: boolean;
  choose(): void;
};

const PANEL_WIDTH = 340;
const MAX_HEIGHT = 360;
/** Separación entre el casillero y el panel, y entre el panel y el borde de la pantalla. */
const GAP = 6;
const MARGIN = 8;

export type SlotPicker = {
  /** Cierra el panel si está abierto; `restoreFocus` devuelve el foco al casillero. */
  close(restoreFocus?: boolean): void;
};

export function createSlotPicker(opts: {
  side: Side;
  /** Dónde va el panel (dentro del editor, para heredar el color del lado). */
  host: HTMLElement;
  /** El inventario dibujado por inventory.ts: sus botones abren el panel. */
  inventory: HTMLElement;
  getKit(): Kit;
  onChange(items: KitItem[]): void;
}): SlotPicker {
  const id = `slotpick-${opts.side}`;
  const panel = el("div", "slotpick");
  panel.id = id;
  panel.hidden = true;
  panel.setAttribute("role", "dialog");

  const head = el("div", "slotpick__head");
  const title = el("span", "slotpick__title");
  title.id = `${id}-title`;
  panel.setAttribute("aria-labelledby", title.id);
  const back = el("button", "slotpick__back", "Volver");
  back.type = "button";
  head.append(title, back);

  const search = el("input", "picker__search");
  search.type = "search";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-expanded", "true");
  search.setAttribute("aria-controls", `${id}-list`);
  search.setAttribute("aria-autocomplete", "list");

  const list = el("ul", "picker__list");
  list.id = `${id}-list`;
  list.setAttribute("role", "listbox");

  // Cantidad: − [n] + y "Listo". Cada cambio se aplica al momento.
  const countBox = el("div", "slotpick__count");
  const minus = el("button", "slotpick__step", "−");
  minus.type = "button";
  minus.setAttribute("aria-label", "Uno menos");
  const amount = el("input", "slotpick__amount");
  amount.type = "number";
  amount.inputMode = "numeric";
  amount.min = "1";
  amount.step = "1";
  amount.setAttribute("aria-label", "Cantidad");
  const plus = el("button", "slotpick__step", "+");
  plus.type = "button";
  plus.setAttribute("aria-label", "Uno más");
  const stepper = el("div", "slotpick__stepper");
  stepper.append(minus, amount, plus);
  const range = el("span", "slotpick__range");
  const done = el("button", "btn btn--small slotpick__done", "Listo");
  done.type = "button";
  countBox.append(stepper, range, done);

  panel.append(head, search, list, countBox);
  opts.host.append(panel);

  let slot: KitSlot | null = null;
  let anchor: HTMLButtonElement | null = null;
  let view: "items" | "potions" | "count" = "items";
  /** En la vista de pociones: si es la que se bebe o la arrojadiza. */
  let potionEntry: Entry | null = null;
  /** En la vista de cantidad: el ítem al que se le cambia la cantidad. */
  let countEntry: Entry | null = null;
  let options: Option[] = [];
  let active = 0;

  const itemAt = (target: KitSlot): KitItem | undefined => opts.getKit().items.find((item) => item.slot === target);

  /** Deja `item` en el casillero abierto (null = vaciarlo) y avisa al editor. */
  const put = (item: KitItem | null): void => {
    if (!slot) return;
    const items = opts.getKit().items.filter((i) => i.slot !== slot);
    if (item) items.push(item);
    opts.onChange(items);
  };

  // ---------- Posición ----------

  const place = (): void => {
    if (!anchor || panel.hidden) return;
    const rect = anchor.getBoundingClientRect();
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = window.innerHeight;
    // Si el casillero ya salió de la pantalla (se desplazó la página), no tiene sentido seguirlo.
    if (rect.bottom < 0 || rect.top > viewHeight) {
      close(false);
      return;
    }
    const width = Math.min(PANEL_WIDTH, viewWidth - 2 * MARGIN);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(MARGIN, Math.min(rect.left, viewWidth - width - MARGIN))}px`;
    // Alto que pide el contenido, con el tope de siempre.
    panel.style.maxHeight = `${MAX_HEIGHT}px`;
    const natural = Math.min(panel.offsetHeight, MAX_HEIGHT);
    const below = viewHeight - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;
    const down = below >= natural || below >= above;
    panel.style.maxHeight = `${Math.max(0, Math.min(MAX_HEIGHT, down ? below : above))}px`;
    if (down) {
      panel.style.top = `${rect.bottom + GAP}px`;
      panel.style.bottom = "auto";
    } else {
      panel.style.top = "auto";
      panel.style.bottom = `${viewHeight - rect.top + GAP}px`;
    }
  };

  let placing = 0;
  const onViewport = (): void => {
    if (placing) return;
    placing = requestAnimationFrame(() => {
      placing = 0;
      place();
    });
  };

  // ---------- Lista (ítems o tipos de poción) ----------

  const itemOptions = (): Option[] => {
    if (!slot) return [];
    const target = slot;
    const current = itemAt(target);
    const words = fold(search.value).split(/\s+/).filter(Boolean);
    const matches = (text: string): boolean => words.every((word) => text.includes(word));
    const out: Option[] = [];

    if (current && matches("vacio vaciar quitar nada")) {
      out.push({
        label: "Vacío",
        hint: "Quita lo que hay",
        group: null,
        icon: null,
        selected: false,
        choose: () => {
          put(null);
          close(true);
        },
      });
    }

    const hotbar = !target.startsWith("armor.") && target !== "weapon.offhand";
    const groups: readonly [CustomKitGroup | null, string | null][] = hotbar ? HOTBAR_GROUPS : [[null, null]];
    for (const [group, heading] of groups) {
      for (const entry of CATALOG) {
        if (!fits(entry, target) || (group && entry.group !== group)) continue;
        if (!matches(fold(`${entry.label} ${entry.id.replaceAll("_", " ")} ${heading ?? ""}`))) continue;
        const selected = current?.item === entry.id;
        let hint = "";
        if (entry.group === "potion") hint = selected && current?.potion ? `De ${CUSTOM_KIT_POTIONS[current.potion]?.label ?? current.potion}` : "Elige el tipo";
        else if (selected) hint = entry.stack > 1 ? "Cambiar cantidad" : "Ya está aquí";
        out.push({ label: entry.label, hint, group: heading, icon: entry, selected, choose: () => chooseItem(entry) });
      }
    }
    return out;
  };

  const potionOptions = (): Option[] => {
    const entry = potionEntry;
    if (!slot || !entry) return [];
    const current = itemAt(slot);
    const words = fold(search.value).split(/\s+/).filter(Boolean);
    return Object.entries(CUSTOM_KIT_POTIONS)
      .filter(([kind, info]) => words.every((word) => fold(`${info.label} ${kind.replaceAll("_", " ")} ${info.effect}`).includes(word)))
      .map(([kind, info]) => {
        const label = `${entry.label} de ${info.label}`;
        const selected = current?.item === entry.id && current.potion === kind;
        return {
          label,
          hint: info.effect,
          group: null,
          icon: entry,
          selected,
          choose: () => {
            if (!selected) put({ slot: slot as KitSlot, item: entry.id, count: 1, label, potion: kind });
            close(true);
          },
        };
      });
  };

  const setActive = (index: number): void => {
    active = Math.max(0, Math.min(options.length - 1, index));
    const node = options.length > 0 ? document.getElementById(`${id}-opt-${active}`) : null;
    for (const option of list.querySelectorAll(".is-active")) option.classList.remove("is-active");
    if (node) {
      node.classList.add("is-active");
      // Se desplaza solo la lista (scrollIntoView podría mover la página entera).
      const top = node.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + node.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + node.offsetHeight - list.clientHeight;
      search.setAttribute("aria-activedescendant", node.id);
    } else {
      search.removeAttribute("aria-activedescendant");
    }
  };

  const renderList = (keepSelected: boolean): void => {
    options = view === "potions" ? potionOptions() : itemOptions();
    const nodes: HTMLElement[] = [];
    let lastGroup: string | null = null;
    options.forEach((option, index) => {
      if (option.group && option.group !== lastGroup) {
        const heading = el("li", "slotpick__group", option.group);
        heading.setAttribute("role", "presentation");
        nodes.push(heading);
      }
      lastGroup = option.group;
      const item = el("li", "picker__option slotpick__option");
      item.id = `${id}-opt-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      const icon = el("span", "slotpick__icon");
      if (option.icon) icon.append(itemGlyph(option.icon.id, option.icon.label));
      const name = el("span", "slotpick__name", option.label);
      item.append(icon, name);
      if (option.hint) {
        const hint = el("span", "picker__hint", option.hint);
        hint.title = option.hint;
        item.append(hint);
      }
      // mousedown y no click: el buscador no pierde el foco antes de elegir.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        choose(index);
      });
      item.addEventListener("mousemove", () => {
        if (active !== index) setActive(index);
      });
      nodes.push(item);
    });
    if (options.length === 0) nodes.push(el("li", "picker__empty", view === "potions" ? "Ningún tipo coincide." : "Ningún ítem coincide."));
    list.replaceChildren(...nodes);
    // Al abrir queda marcado lo que ya está en el casillero; al buscar, el primer resultado.
    const selected = keepSelected ? options.findIndex((option) => option.selected) : -1;
    setActive(selected >= 0 ? selected : 0);
  };

  const choose = (index: number): void => {
    options[index]?.choose();
  };

  const showList = (next: "items" | "potions"): void => {
    if (!slot) return;
    view = next;
    const entry = potionEntry;
    if (next === "potions" && entry) {
      title.textContent = `${entry.label}: elige el tipo`;
      search.placeholder = "Buscar tipo de poción";
    } else {
      title.textContent = `${slotName(slot)}: elige qué va aquí`;
      search.placeholder = "Buscar ítem";
    }
    search.setAttribute("aria-label", search.placeholder);
    back.hidden = next !== "potions";
    search.hidden = false;
    list.hidden = false;
    search.value = "";
    countBox.hidden = true;
    renderList(true);
    place();
    // Con el panel ya en su lugar: el foco no desplaza la página y la opción marcada queda a la vista.
    search.focus({ preventScroll: true });
    setActive(active);
  };

  // ---------- Cantidad ----------

  const syncCount = (): void => {
    const current = slot ? itemAt(slot) : undefined;
    const entry = countEntry;
    if (!current || !entry || current.item !== entry.id) return;
    if (document.activeElement !== amount || Number(amount.value) !== current.count) amount.value = String(current.count);
    minus.disabled = current.count <= 1;
    plus.disabled = current.count >= entry.stack;
  };

  const setCount = (wanted: number): void => {
    const current = slot ? itemAt(slot) : undefined;
    const entry = countEntry;
    // Si el casillero cambió por otro lado (p. ej. llegó otra versión), ya no hay qué ajustar.
    if (!current || !entry || current.item !== entry.id) {
      close(false);
      return;
    }
    const count = Math.max(1, Math.min(entry.stack, Math.round(wanted)));
    // Solo cambia la cantidad: el ítem conserva sus encantamientos y su tipo de poción.
    if (count !== current.count) put({ ...current, count });
    syncCount();
  };

  const showCount = (entry: Entry): void => {
    const current = slot ? itemAt(slot) : undefined;
    if (!current) {
      close(true);
      return;
    }
    view = "count";
    countEntry = entry;
    title.textContent = `${current.label}: cantidad`;
    back.hidden = true;
    amount.max = String(entry.stack);
    range.textContent = `de 1 a ${entry.stack}`;
    countBox.hidden = false;
    syncCount();
    // El foco pasa a la cantidad antes de ocultar el buscador, así el panel no lo pierde.
    amount.focus({ preventScroll: true });
    amount.select();
    search.hidden = true;
    list.hidden = true;
    place();
  };

  const chooseItem = (entry: Entry): void => {
    if (!slot) return;
    if (entry.group === "potion") {
      potionEntry = entry;
      showList("potions");
      return;
    }
    const current = itemAt(slot);
    // El mismo ítem otra vez: se conserva tal cual (con sus encantamientos) y solo se ajusta la cantidad.
    if (current?.item !== entry.id) put({ slot, item: entry.id, count: defaultCount(entry), label: entry.label });
    if (entry.stack > 1) showCount(entry);
    else close(true);
  };

  // ---------- Abrir y cerrar ----------

  const close = (restoreFocus = false): void => {
    if (panel.hidden) return;
    panel.hidden = true;
    window.removeEventListener("scroll", onViewport, true);
    window.removeEventListener("resize", onViewport);
    const from = anchor;
    if (from) {
      from.classList.remove("is-open");
      from.setAttribute("aria-expanded", "false");
      from.removeAttribute("aria-controls");
    }
    slot = null;
    anchor = null;
    potionEntry = null;
    countEntry = null;
    if (restoreFocus && from) from.focus({ preventScroll: true });
  };

  const open = (target: KitSlot, button: HTMLButtonElement): void => {
    close(false);
    slot = target;
    anchor = button;
    button.classList.add("is-open");
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-controls", id);
    panel.hidden = false;
    window.addEventListener("scroll", onViewport, true);
    window.addEventListener("resize", onViewport);
    showList("items");
  };

  opts.inventory.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-slot]") : null;
    if (!button || !opts.inventory.contains(button)) return;
    // Un segundo clic en el mismo casillero lo cierra.
    if (button === anchor) close(true);
    else open(button.dataset.slot as KitSlot, button);
  });

  search.addEventListener("input", () => renderList(false));
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") setActive(active + 1);
    else if (event.key === "ArrowUp") setActive(active - 1);
    else if (event.key === "Enter") choose(active);
    // Borrar con el buscador vacío vuelve de los tipos de poción a la lista de ítems.
    else if (event.key === "Backspace" && search.value === "" && view === "potions") showList("items");
    else return;
    // Enter no debe enviar el formulario del prompt.
    event.preventDefault();
  });
  back.addEventListener("click", () => showList("items"));

  minus.addEventListener("click", () => setCount(Number(amount.value) - 1));
  plus.addEventListener("click", () => setCount(Number(amount.value) + 1));
  amount.addEventListener("input", () => {
    const wanted = Number(amount.value);
    // Mientras se escribe solo se aplica un número válido; al salir se corrige el resto.
    if (amount.value !== "" && Number.isInteger(wanted) && wanted >= 1 && countEntry && wanted <= countEntry.stack) setCount(wanted);
  });
  amount.addEventListener("change", () => setCount(Number(amount.value) || 1));
  amount.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    setCount(Number(amount.value) || 1);
    close(true);
  });
  done.addEventListener("click", () => close(true));

  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
  // Un clic fuera cierra y devuelve el foco al casillero (si el clic cae en otro control, el foco sigue hacia él).
  document.addEventListener("mousedown", (event) => {
    if (panel.hidden || !(event.target instanceof Node)) return;
    if (panel.contains(event.target) || anchor?.contains(event.target)) return;
    close(true);
  });
  panel.addEventListener("focusout", (event) => {
    const to = event.relatedTarget;
    if (to instanceof Node && !panel.contains(to) && to !== anchor) close(false);
  });

  return { close };
}
