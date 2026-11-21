/**
 * Inventario de un kit dibujado como el del juego: los cuatro casilleros de armadura y
 * el de la mano secundaria, los efectos permanentes a su lado y, debajo, los nueve de la barra rápida. Los
 * casilleros vacíos se dibujan vacíos, así se ve en qué posición queda cada ítem.
 */
import { kitItemTitle, type Kit, type KitItem, type KitSlot } from "@phack/protocol";
import { el } from "./dom";
import { pixelIcon } from "./icons";
import { itemIcon } from "./items";

const ARMOR_SLOTS: readonly KitSlot[] = ["armor.head", "armor.chest", "armor.legs", "armor.feet"];
const HOTBAR_SLOTS: readonly KitSlot[] = [
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

function slotNode(item: KitItem | undefined): HTMLElement {
  const slot = el("span", "inv__slot");
  if (!item) {
    slot.setAttribute("aria-hidden", "true");
    return slot;
  }

  // "Arco (Empuje I)", "Flechas x32": lo mismo para el tooltip y para lectores de pantalla.
  const title = kitItemTitle(item);
  slot.setAttribute("role", "img");
  slot.setAttribute("aria-label", title);
  slot.dataset.tip = title;

  const icon = itemIcon(item.item);
  if (icon) slot.append(pixelIcon(icon));
  if (item.enchantments && item.enchantments.length > 0) slot.classList.add("is-enchanted");
  if (item.count > 1) {
    const count = el("span", "inv__count", String(item.count));
    count.setAttribute("aria-hidden", "true");
    slot.append(count);
  }
  return slot;
}

/** Dibuja el inventario de `kit` dentro de `target`. Solo redibuja si el kit cambió. */
export function renderInventory(target: HTMLElement, kit: Kit): void {
  if (target.dataset.kit === kit.id) return;
  target.dataset.kit = kit.id;
  target.setAttribute("aria-label", `Inventario del kit ${kit.name}`);

  const bySlot = new Map<KitSlot, KitItem>();
  for (const item of kit.items) bySlot.set(item.slot, item);

  // Siempre presente, aunque el kit no tenga efectos: ocupa el resto de la fila de la armadura.
  const effects = el("div", "inv__effects");
  for (const effect of kit.effects) {
    const chip = el("span", "inv__effect", effect.label);
    chip.dataset.tip = "Efecto permanente: dura toda la pelea.";
    effects.append(chip);
  }

  // La mano secundaria (el escudo) va junto a la armadura, como en el juego.
  const offhand = slotNode(bySlot.get("weapon.offhand"));
  offhand.classList.add("inv__slot--offhand");

  target.replaceChildren(
    ...ARMOR_SLOTS.map((slot) => slotNode(bySlot.get(slot))),
    offhand,
    effects,
    ...HOTBAR_SLOTS.map((slot) => slotNode(bySlot.get(slot))),
  );
}
