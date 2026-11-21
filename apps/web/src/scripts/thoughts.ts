/**
 * Pensamientos en vivo: una columna por agente a cada lado del video (Rojo a la
 * izquierda, Azul a la derecha). Cada columna apila los últimos pensamientos de su
 * agente, el más nuevo abajo y escribiéndose letra a letra, y cada uno lleva una ficha
 * con la acción que eligió (ícono y frase de actions.ts). El resultado de la acción no
 * se muestra aquí: queda en la ayuda de la ficha y en la lista de eventos.
 *
 * Lo que el agente le DICE al otro (modo "chat") va en la misma columna, en el orden en
 * que pasó, pero como un globo de conversación: es lo único que el rival también recibe.
 * Para que se distingan de un vistazo, cada entrada con texto lleva su marca: una nube
 * junto a lo que piensa, y un cuadro del color del lado con un globo junto a lo que dice.
 *
 * Los pensamientos y las acciones llegan por la cola sincronizada de main.ts, así que
 * aparecen cuando la imagen llega a ese instante. Lo que aquí depende del tiempo (a qué
 * pensamiento se une una acción, cuándo se muestra "pensando") se mide con el reloj de
 * la transmisión: la hora `at` de cada evento contra videoServerNow().
 *
 * Cuántos pensamientos se ven y cuánto se apagan los anteriores lo decide global.css
 * según el puesto de cada uno, contado desde el más nuevo.
 */
import { SIDES, type AgentStatus, type MatchPhase, type MatchState, type Side } from "@phack/protocol";
import { parseAction, type ActionView } from "./actions";
import { byId, el, setText } from "./dom";
import { pixelIcon } from "./icons";
import { videoServerNow } from "./player";

/** Pensamientos que guarda cada columna. En pantallas chicas global.css muestra menos. */
const MAX_ENTRIES = 5;
/** Lo que tarda en irse el más viejo; cubre la transición de salida de global.css. */
const LEAVE_MS = 400;
/** Escritura letra a letra: este tiempo por letra, y el texto entero en no más de TYPE_MAX_MS. */
const TYPE_CHAR_MS = 25;
const TYPE_MAX_MS = 1200;
/** Una acción se une al pensamiento más nuevo de su lado si llegó a lo más este tiempo después. */
const CHIP_WINDOW_MS = 2000;
/** Sin novedades de un agente durante este tiempo, se muestra que está pensando. */
const THINKING_AFTER_MS = 1200;
const TICK_MS = 200;
const PULSE_MS = 500;
const EMPTY = "—";

type Entry = {
  node: HTMLLIElement;
  /** Hora del servidor del pensamiento (o de la acción, si la entrada es solo una ficha). */
  at: number;
  /** Texto del pensamiento; "" si la entrada es solo una ficha de acción. */
  text: string;
  chip: HTMLElement | null;
  /** Frase de la ficha; "" si no tiene. */
  chipLabel: string;
  /** La entrada es algo que el agente dijo en voz alta, no un pensamiento. */
  said: boolean;
};

/** Pensamiento que se está escribiendo letra a letra. */
type Typing = { holder: HTMLElement; text: string; frame: number };

type Column = {
  list: HTMLElement;
  thinking: HTMLElement;
  /** Textos ocultos para lectores de pantalla: la lista visible cambia demasiado seguido. */
  lastThought: HTMLElement;
  lastAction: HTMLElement;
  /** De la más vieja a la más nueva, igual que en la página. */
  entries: Entry[];
  typing: Typing | null;
  /** Hora del servidor de la última novedad (pensamiento o acción); null si no hay ninguna. */
  newsAt: number | null;
  /** Última acción mostrada, tal cual llegó. */
  lastRaw: string;
  /** Ya llegaron eventos de este agente en esta pelea: no hace falta mirar el estado. */
  live: boolean;
  /** El agente está conectado y en pie. */
  alive: boolean;
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let columns: Record<Side, Column> | null = null;
let lastPhase: MatchPhase | null = null;
let matchId: string | null = null;
let fighting = false;

function column(side: Side): Column {
  return {
    list: byId(`thoughts-list-${side}`),
    thinking: byId(`thinking-${side}`),
    lastThought: byId(`last-thought-${side}`),
    lastAction: byId(`last-action-${side}`),
    entries: [],
    typing: null,
    newsAt: null,
    lastRaw: "",
    live: false,
    alive: false,
  };
}

export function initThoughts(): void {
  columns = { red: column("red"), blue: column("blue") };
  window.setInterval(refreshThinking, TICK_MS);
}

// ---------- Escritura letra a letra ----------

/** Deja completo, de una vez, el pensamiento que se estaba escribiendo. */
function finishTyping(target: Column): void {
  const typing = target.typing;
  if (!typing) return;
  target.typing = null;
  window.cancelAnimationFrame(typing.frame);
  typing.holder.textContent = typing.text;
}

/**
 * Escribe `text` en `holder` letra a letra. El texto entero está en la página desde el
 * principio, con la parte que falta invisible: así el pensamiento ocupa su alto final de
 * inmediato y la columna no salta con cada línea nueva.
 */
function typeOut(target: Column, holder: HTMLElement, text: string): void {
  // Un pensamiento nuevo termina de golpe el anterior.
  finishTyping(target);
  // De a un carácter completo, para no partir un emoji por la mitad.
  const chars = Array.from(text);
  if (reducedMotion.matches || document.hidden || chars.length < 2) {
    holder.textContent = text;
    return;
  }

  const typed = el("span");
  const rest = el("span", "thought__rest", text);
  holder.replaceChildren(typed, rest);

  const charMs = Math.min(TYPE_CHAR_MS, TYPE_MAX_MS / chars.length);
  const startedAt = performance.now();
  const typing: Typing = { holder, text, frame: 0 };
  let shown = 0;
  const step = (now: number): void => {
    if (target.typing !== typing) return;
    const count = Math.floor(Math.max(0, now - startedAt) / charMs) + 1;
    if (count >= chars.length) {
      finishTyping(target);
      return;
    }
    if (count !== shown) {
      shown = count;
      typed.textContent = chars.slice(0, count).join("");
      rest.textContent = chars.slice(count).join("");
    }
    typing.frame = window.requestAnimationFrame(step);
  };
  target.typing = typing;
  typing.frame = window.requestAnimationFrame(step);
}

// ---------- Entradas de la columna ----------

/** Destello breve sobre una entrada que ya estaba: el agente repitió lo mismo. */
function pulse(node: HTMLElement): void {
  if (reducedMotion.matches) return;
  node.animate(
    [{ backgroundColor: "rgba(237, 236, 232, 0.3)" }, { backgroundColor: "rgba(237, 236, 232, 0)" }],
    { duration: PULSE_MS, easing: "ease-out" },
  );
}

/**
 * La entrada más nueva que es un pensamiento o una ficha. Lo dicho en voz alta se salta:
 * el mensaje llega entre el pensamiento y su acción, y la ficha es del pensamiento.
 */
function newest(target: Column): Entry | undefined {
  for (let index = target.entries.length - 1; index >= 0; index -= 1) {
    const entry = target.entries[index]!;
    if (!entry.said) return entry;
  }
  return undefined;
}

/** El pensamiento más nuevo de la columna, saltándose las fichas sueltas y lo dicho en voz alta. */
function newestThought(target: Column): Entry | undefined {
  for (let index = target.entries.length - 1; index >= 0; index -= 1) {
    const entry = target.entries[index]!;
    if (entry.text !== "" && !entry.said) return entry;
  }
  return undefined;
}

function addEntry(target: Column, at: number, text: string, said = false): Entry {
  const node = el("li", said ? "thought thought--said" : "thought");
  const entry: Entry = { node, at, text, chip: null, chipLabel: "", said };
  if (text !== "") {
    // La marca de qué es: nube = lo piensa, globo = lo dice. voice.ts la cambia por el
    // medidor de voz mientras el mensaje se oye.
    const kind = el("span", "thought__kind");
    kind.append(pixelIcon({ name: said ? "talk" : "thought" }));
    const holder = el("p", "thought__text");
    node.append(kind, holder);
    typeOut(target, holder, text);
  }
  target.entries.push(entry);
  target.list.append(node);
  // Las que sobran se quitan después de su transición de salida: global.css las apaga
  // en cuanto dejan de estar entre las más nuevas.
  while (target.entries.length > MAX_ENTRIES) {
    const old = target.entries.shift()!;
    window.setTimeout(() => old.node.remove(), LEAVE_MS);
  }
  return entry;
}

/** Pone (o actualiza) la ficha de la acción de una entrada: ícono + frase, y la llamada tal cual en la ayuda. */
function setChip(entry: Entry, view: ActionView): void {
  const chip = entry.chip ?? el("span", "thought__chip");
  chip.dataset.tool = view.tool;
  // Aquí queda también el resultado de la acción, que ya no se muestra en la columna.
  chip.dataset.tip = `Lo que pidió el modelo: ${view.raw}`;
  const label = el("span", "thought__label", view.label);
  if (view.icon) chip.replaceChildren(pixelIcon(view.icon), label);
  else chip.replaceChildren(label);
  if (!entry.chip) {
    entry.chip = chip;
    entry.node.append(chip);
  }
  entry.chipLabel = view.label;
}

function addThought(target: Column, raw: string, at: number): void {
  const text = raw.trim();
  if (text === "") return;
  target.newsAt = at;
  setText(target.lastThought, text);

  // El mismo pensamiento dos veces seguidas no suma una entrada: se destaca la que ya está.
  const previous = newestThought(target);
  if (previous && previous.text === text) {
    previous.at = at;
    pulse(previous.node);
    return;
  }
  addEntry(target, at, text);
}

/** Lo dicho en voz alta siempre suma una entrada: si el agente se repite, se ve repetido. */
function addMessage(target: Column, raw: string, at: number): HTMLElement | null {
  const text = raw.trim();
  if (text === "") return null;
  target.newsAt = at;
  return addEntry(target, at, text, true).node;
}

function addAction(target: Column, view: ActionView, at: number): void {
  if (view.label === "") return;
  target.newsAt = at;
  target.lastRaw = view.raw;
  setText(target.lastAction, view.label);

  const last = newest(target);
  // La acción llega justo después de su pensamiento: va como ficha de ese pensamiento.
  if (last && last.text !== "" && !last.chip && at - last.at < CHIP_WINDOW_MS) {
    setChip(last, view);
    return;
  }
  // La misma acción otra vez (el agente insiste sin decir nada nuevo): se renueva la
  // ficha que ya está al final, en vez de apilar fichas iguales.
  if (last && last.chip && last.chipLabel === view.label) {
    setChip(last, view);
    pulse(last.node);
    return;
  }
  setChip(addEntry(target, at, ""), view);
}

function clearColumn(target: Column): void {
  finishTyping(target);
  target.entries = [];
  target.list.replaceChildren();
  target.newsAt = null;
  target.lastRaw = "";
  target.live = false;
  setText(target.lastThought, EMPTY);
  setText(target.lastAction, EMPTY);
}

/**
 * Sin eventos de este agente (página recién abierta a mitad de pelea, o websocket caído
 * y estado por HTTP), la columna se alimenta de lo último que trae el estado.
 */
function seedFromState(target: Column, agent: AgentStatus): void {
  const now = videoServerNow();
  const thought = agent.lastThought.trim();
  if (thought !== "" && thought !== newestThought(target)?.text) addThought(target, thought, now);
  const action = agent.lastAction.trim();
  if (action !== "" && action !== target.lastRaw) addAction(target, parseAction(action), now);
}

/** Tres puntos al pie de la columna mientras el agente pelea y lleva un rato sin decir nada. */
function refreshThinking(): void {
  if (!columns) return;
  const now = videoServerNow();
  for (const side of SIDES) {
    const target = columns[side];
    const on =
      fighting &&
      target.alive &&
      target.typing === null &&
      (target.newsAt === null || now - target.newsAt > THINKING_AFTER_MS);
    target.thinking.classList.toggle("is-on", on);
  }
}

// ---------- Entradas del módulo ----------

/** Evento "thought": `at` es la hora del servidor en que el agente lo pensó. */
export function pushThought(side: Side, text: string, at: number): void {
  if (!columns) return;
  const target = columns[side];
  target.live = true;
  addThought(target, text, at);
  refreshThinking();
}

/**
 * Evento "message": `at` es la hora del servidor en que el agente lo dijo. Devuelve el
 * globo, para marcarlo mientras se oye su voz (voice.ts); null si no se dibujó.
 */
export function pushMessage(side: Side, text: string, at: number): HTMLElement | null {
  if (!columns) return null;
  const target = columns[side];
  target.live = true;
  const bubble = addMessage(target, text, at);
  refreshThinking();
  return bubble;
}

/** Evento "action": `at` es la hora del servidor en que el agente la ejecutó. */
export function pushAction(side: Side, view: ActionView, at: number): void {
  if (!columns) return;
  const target = columns[side];
  target.live = true;
  addAction(target, view, at);
  refreshThinking();
}

/** Evento "death": el agente caído deja de "pensar" sin esperar el próximo estado. */
export function markFallen(side: Side): void {
  if (!columns) return;
  columns[side].alive = false;
  refreshThinking();
}

/** Con cada estado de la pelea: vacía las columnas cuando parte una pelea nueva y sabe quién sigue en pie. */
export function syncThoughts(state: MatchState): void {
  if (!columns) return;
  const { phase } = state;
  // Pelea nueva: empieza a prepararse, o cambió de id sin que se viera la preparación.
  const fresh =
    phase === "preparing"
      ? lastPhase !== "preparing"
      : phase === "running" && matchId !== null && matchId !== state.id;
  if (fresh) for (const side of SIDES) clearColumn(columns[side]);
  if (phase === "preparing" || phase === "running") matchId = state.id;
  lastPhase = phase;
  fighting = phase === "running";

  for (const side of SIDES) {
    const target = columns[side];
    const agent = state.agents[side];
    target.alive = agent.connected && agent.alive;
    if (!target.live && (phase === "running" || phase === "finished")) seedFromState(target, agent);
  }
  refreshThinking();
}
