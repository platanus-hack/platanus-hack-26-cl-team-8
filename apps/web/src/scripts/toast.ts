import { byId, el } from "./dom";

const TOAST_MS = 5000;
const MAX_TOASTS = 4;

export function showToast(text: string, kind: "error" | "ok" = "error"): void {
  const host = byId("toasts");
  const toast = el("div", `toast toast--${kind}`, text);
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  host.append(toast);
  while (host.children.length > MAX_TOASTS) host.firstElementChild?.remove();
  const remove = (): void => toast.remove();
  toast.addEventListener("click", remove);
  window.setTimeout(remove, TOAST_MS);
}
