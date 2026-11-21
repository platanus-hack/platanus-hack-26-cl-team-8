/**
 * Inventario de un kit dibujado como el del juego: los cuatro casilleros de armadura y
 * el de la mano secundaria, los efectos permanentes a su lado y, debajo, los nueve de la barra rápida. Los
 * casilleros vacíos se dibujan vacíos, así se ve en qué posición queda cada ítem.
 *
 * Cada casillero es un botón (también los vacíos): al hacer clic se elige qué va ahí
 * (ver slotpicker.ts). Los botones se crean una sola vez y después solo se actualiza lo
 * que muestran, así el foco y el casillero del que cuelga el selector no se pierden.
 */
import { kitItemTitle, type Kit, type KitItem, type KitSlot } from "@phack/protocol";
import { el } from "./dom";
import { pixelIcon } from "./icons";
import { itemIcon } from "./items";

const ARMOR_SLOTS: readonly KitSlot[] = ["armor.head", "armor.chest", "armor.legs", "armor.feet"];
export const HOTBAR_SLOTS: readonly KitSlot[] = [
  "hotbar.0",
  "hotbar.1",
  "hotbar.2",
  "hotbar.3",
  "hotbar.4",
  "hotbar.5",
  "hotbar.6",
  "hotbar.7",
  "hotbar.8",
];

/** Nombre de cada casillero para la ayuda y los lectores de pantalla. */
export function slotName(slot: KitSlot): string {
  switch (slot) {
    case "armor.head":
      return "Cabeza";
    case "armor.chest":
      return "Pecho";
    case "armor.legs":
      return "Piernas";
    case "armor.feet":
      return "Pies";
    case "weapon.offhand":
      return "Mano secundaria";
    default: {
      const [group, index] = slot.split(".");
      return `${group === "hotbar" ? "Barra rápida" : "Inventario"} ${Number(index) + 1}`;
    }
  }
}

/**
 * Lo que hay en un inventario, sin nombres ni orden: sirve para comparar dos inventarios
 * (¿hay cambios sin guardar?) y para no redibujar si nada cambió. Vacío o sin kit = "".
 */
export function inventoryKey(kit: Pick<Kit, "items" | "effects"> | null): string {
  if (!kit || (kit.items.length === 0 && kit.effects.length === 0)) return "";
  const items = kit.items
    .map((i) => [i.slot, i.item, i.count, i.potion ?? "", (i.enchantments ?? []).map((e) => `${e.id}:${e.level}`).sort().join(",")])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const effects = kit.effects.map((e) => `${e.id}:${e.amplifier}`).sort();
  return JSON.stringify([items, effects]);
}

/** Ícono del ítem; si no hay uno dibujado (oro, netherita, picos…), su inicial, para que el casillero no parezca vacío. */
export function itemGlyph(id: string, label: string): Element {
  const icon = itemIcon(id);
  if (icon) return pixelIcon(icon);
  const glyph = el("span", "inv__glyph", label.charAt(0).toUpperCase());
  glyph.setAttribute("aria-hidden", "true");
  return glyph;
}

function slotButton(slot: KitSlot): HTMLButtonElement {
  const button = el("button", "inv__slot");
  button.type = "button";
  button.dataset.slot = slot;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  return button;
}

function fillSlot(button: HTMLButtonElement, item: KitItem | undefined): void {
  const name = slotName(button.dataset.slot as KitSlot);
  button.classList.toggle("is-enchanted", Boolean(item?.enchantments && item.enchantments.length > 0));
  if (!item) {
    button.setAttribute("aria-label", `${name}: vacío. Elegir ítem`);
    button.dataset.tip = `${name}: vacío`;
    button.replaceChildren();
    return;
  }
  // "Arco (Empuje I)", "Flechas x32": lo mismo para el tooltip y para lectores de pantalla.
  const title = kitItemTitle(item);
  button.setAttribute("aria-label", `${name}: ${title}. Cambiar ítem`);
  button.dataset.tip = title;
  const children: Node[] = [itemGlyph(item.item, item.label)];
  if (item.count > 1) {
    const count = el("span", "inv__count", String(item.count));
    count.setAttribute("aria-hidden", "true");
    children.push(count);
  }
  button.replaceChildren(...children);
}

/** Último inventario dibujado en cada contenedor, para no redibujar si nada cambió. */
const drawn = new WeakMap<HTMLElement, string>();

/** Dibuja el inventario de `kit` dentro de `target`. Solo redibuja si el kit cambió. */
export function renderInventory(target: HTMLElement, kit: Kit): void {
  const key = `${kit.id}|${kit.name}|${inventoryKey(kit)}|${kit.items.map((i) => i.label).join(",")}`;
  if (drawn.get(target) === key) return;
  drawn.set(target, key);
  target.setAttribute("aria-label", `Inventario del kit ${kit.name}`);

  // La primera vez se arman los casilleros; desde ahí solo cambia lo que muestran.
  if (!target.querySelector(".inv__slot")) {
    // La mano secundaria (el escudo) va junto a la armadura, como en el juego.
    const offhand = slotButton("weapon.offhand");
    offhand.classList.add("inv__slot--offhand");
    // Siempre presente, aunque el kit no tenga efectos: ocupa el resto de la fila de la armadura.
    const effects = el("div", "inv__effects");
    target.replaceChildren(...ARMOR_SLOTS.map(slotButton), offhand, effects, ...HOTBAR_SLOTS.map(slotButton));
  }

  const bySlot = new Map<KitSlot, KitItem>();
  for (const item of kit.items) bySlot.set(item.slot, item);
  for (const button of target.querySelectorAll<HTMLButtonElement>(".inv__slot")) {
    fillSlot(button, bySlot.get(button.dataset.slot as KitSlot));
  }

  const effects = target.querySelector<HTMLElement>(".inv__effects");
  effects?.replaceChildren(
    ...kit.effects.map((effect) => {
      const chip = el("span", "inv__effect", effect.label);
      chip.dataset.tip = "Efecto permanente: dura toda la pelea.";
      return chip;
    }),
  );
}
