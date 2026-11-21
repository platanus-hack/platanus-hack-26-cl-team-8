import type { Side } from "@phack/protocol";
import { byId, el } from "./dom";
import { SIDE_LABEL, formatTime } from "./format";

export type FeedKind = "thought" | "action" | "damage" | "death" | "system" | "warn" | "error";

export type FeedEntry = {
  at: number;
  kind: FeedKind;
  text: string;
  side?: Side;
  /** Detalle para el tooltip (p. ej. la llamada a la herramienta tal cual). */
  title?: string;
};

const MAX_ITEMS = 200;
/** Tolerancia (px) para considerar que el usuario sigue "pegado" al final. */
const BOTTOM_SLACK = 48;

const KIND_LABEL: Record<FeedKind, string> = {
  thought: "piensa",
  action: "actúa",
  damage: "daño",
  death: "cae",
  system: "arena",
  warn: "aviso",
  error: "error",
};

let list: HTMLElement | null = null;
let jump: HTMLButtonElement | null = null;
let hasPlaceholder = true;

function isAtBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLACK;
}

function scrollToBottom(): void {
  if (!list || !jump) return;
  list.scrollTop = list.scrollHeight;
  jump.hidden = true;
}

export function initFeed(): void {
  const listEl = byId("feed-list");
  const jumpEl = byId<HTMLButtonElement>("feed-jump");
  list = listEl;
  jump = jumpEl;
  jumpEl.addEventListener("click", scrollToBottom);
  listEl.addEventListener("scroll", () => {
    if (isAtBottom(listEl)) jumpEl.hidden = true;
  });
}

export function addFeed(entry: FeedEntry): void {
  if (!list || !jump) return;
  if (hasPlaceholder) {
    list.replaceChildren();
    hasPlaceholder = false;
  }

  // Se mide ANTES de agregar: si el usuario subió a leer, no se le mueve el scroll.
  const stick = isAtBottom(list);

  const item = el("li", `feed-item feed-item--${entry.kind}`);
  if (entry.side) item.dataset.side = entry.side;
  item.append(
    el("time", "feed-item__time", formatTime(entry.at)),
    el("span", "feed-item__who", entry.side ? SIDE_LABEL[entry.side] : "Arena"),
    el("span", "feed-item__kind", KIND_LABEL[entry.kind]),
    el("span", "feed-item__text", entry.text),
  );
  if (entry.title) item.title = entry.title;
  list.append(item);

  while (list.children.length > MAX_ITEMS) list.firstElementChild?.remove();

  if (stick) scrollToBottom();
  else jump.hidden = false;
}
