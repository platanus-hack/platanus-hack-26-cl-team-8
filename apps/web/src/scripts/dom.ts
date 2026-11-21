/** Busca un elemento por id; si falta, es un error de maquetado y debe notarse. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Falta el elemento #${id} en la página`);
  return node as T;
}

/**
 * Crea un elemento. El texto SIEMPRE entra por textContent: prompts y
 * pensamientos del LLM son contenido no confiable y nunca deben ir a innerHTML.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
