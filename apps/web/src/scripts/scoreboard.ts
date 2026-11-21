import { SIDES, type AgentStatus, type MatchResult, type MatchState, type Side } from "@phack/protocol";
import { costOf, onCatalogReady } from "./catalog";
import { byId, el, setText } from "./dom";
import { formatClock, formatNumber, phaseLabel, resultDetail, resultTitle } from "./format";
import { setPixelIcon } from "./icons";
import { itemIcon, itemLabel } from "./items";
import { onDefaultsChange, renderModelTag, resolveModel } from "./models";
import type { IconRef } from "./pixelicons";
import { videoServerNow } from "./player";

const MAX_HEALTH = 20;
const URGENT_MS = 10_000;

type SideElements = {
  card: HTMLElement;
  bot: HTMLElement;
  status: HTMLElement;
  model: HTMLElement;
  hp: HTMLElement;
  hpFill: HTMLElement;
  hpValue: HTMLElement;
  food: HTMLElement;
  damage: HTMLElement;
  decisions: HTMLElement;
  held: HTMLElement;
  heldIcon: HTMLElement;
  heldName: HTMLElement;
  speed: HTMLElement;
  cost: HTMLElement;
};

const POP_MS = 1100;
const TICK_MS = 250;

type Elements = {
  sides: Record<Side, SideElements>;
  phase: HTMLElement;
  clock: HTMLElement;
  banner: HTMLElement;
  bannerTitle: HTMLElement;
  bannerDetail: HTMLElement;
  bannerWhy: HTMLElement;
};

let els: Elements | null = null;
let current: MatchState | null = null;

function sideElements(side: Side): SideElements {
  return {
    card: byId(`fighter-${side}`),
    bot: byId(`bot-${side}`),
    status: byId(`fighter-state-${side}`),
    model: byId(`fighter-model-${side}`),
    hp: byId(`hp-${side}`),
    hpFill: byId(`hp-fill-${side}`),
    hpValue: byId(`hp-value-${side}`),
    food: byId(`food-${side}`),
    damage: byId(`damage-${side}`),
    decisions: byId(`decisions-${side}`),
    held: byId(`held-${side}`),
    heldIcon: byId(`held-icon-${side}`),
    heldName: byId(`held-name-${side}`),
    speed: byId(`speed-${side}`),
    cost: byId(`cost-${side}`),
  };
}

export function initScoreboard(): void {
  els = {
    sides: { red: sideElements("red"), blue: sideElements("blue") },
    phase: byId("phase"),
    clock: byId("clock"),
    banner: byId("winner-banner"),
    bannerTitle: byId("winner-title"),
    bannerDetail: byId("winner-detail"),
    bannerWhy: byId("winner-why"),
  };
  window.setInterval(() => renderClock(), TICK_MS);
  const redraw = (): void => {
    if (current) renderState(current);
  };
  onDefaultsChange(redraw);
  // Los precios llegan con el catálogo: al cargar, los costos pasan de tokens a dólares.
  onCatalogReady(redraw);
}

function setHealth(side: SideElements, health: number): void {
  const clamped = Math.min(MAX_HEALTH, Math.max(0, health));
  side.hpFill.style.width = `${(clamped / MAX_HEALTH) * 100}%`;
  side.hp.setAttribute("aria-valuenow", String(Math.round(clamped)));
  side.hp.dataset.level = clamped <= 6 ? "low" : clamped <= 12 ? "mid" : "high";
  setText(side.hpValue, formatNumber(clamped));
}

/** Número de daño que salta junto a la vida del que recibió el golpe y se desvanece. */
function popDamage(target: SideElements, amount: number): void {
  if (!(amount > 0)) return;
  const pop = el("span", "hud__pop", `-${formatNumber(amount)}`);
  pop.setAttribute("aria-hidden", "true");
  target.card.append(pop);
  // Respaldo por si no corre la animación (movimiento reducido): igual se quita.
  window.setTimeout(() => pop.remove(), POP_MS);
}

/**
 * Qué ícono y nombre mostrar para el ítem que el agente tiene en la mano. Si el ítem no
 * tiene ícono, el casillero queda vacío y el nombre va en el tooltip.
 */
function heldItemView(name: string): { icon: IconRef | null; label: string } {
  if (name === "") return { icon: null, label: "nada" };
  const label = itemLabel(name);
  // En minúscula, porque va a mitad de frase: "En la mano: espada de hierro."
  return { icon: itemIcon(name), label: label.charAt(0).toLowerCase() + label.slice(1) };
}

function tokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1)}k` : String(tokens);
}

/** Costo de lo que lleva gastado el modelo: en dólares si se conoce su precio; si no, en tokens. */
function renderCost(side: SideElements, agent: AgentStatus, model: string | undefined): void {
  const total = agent.tokensIn + agent.tokensOut;
  const holder = side.cost.parentElement;
  if (total <= 0) {
    setText(side.cost, "–");
    if (holder) holder.dataset.tip = "Lo que ha costado el modelo en esta pelea.";
    return;
  }
  const dollars = model ? costOf(model, agent.tokensIn, agent.tokensOut) : null;
  // Menos de un centavo: cuatro decimales, para que no se vea siempre "$0.00".
  setText(side.cost, dollars === null ? `${tokenCount(total)} tok` : `$${dollars.toFixed(dollars < 0.01 ? 4 : 2)}`);
  if (holder) {
    const tokens = `${tokenCount(agent.tokensIn)} tokens de entrada y ${tokenCount(agent.tokensOut)} de salida`;
    holder.dataset.tip =
      dollars === null
        ? `Lo que ha gastado el modelo en esta pelea: ${tokens}. No se conoce su precio, por eso va en tokens.`
        : `Lo que ha costado el modelo en esta pelea: ${tokens}.`;
  }
}

/** Lo que piensa y hace el agente no va aquí: lo muestran las columnas de scripts/thoughts.ts. */
function renderAgent(side: SideElements, agent: AgentStatus, model: string | undefined): void {
  setText(side.bot, agent.username);
  setHealth(side, agent.health);
  setText(side.food, formatNumber(agent.food));
  setText(side.damage, formatNumber(agent.damageDealt));
  setText(side.decisions, String(agent.decisions));
  setText(side.speed, agent.avgDecisionMs > 0 ? `${(agent.avgDecisionMs / 1000).toFixed(1)} s` : "–");
  renderCost(side, agent, model);

  const held = heldItemView(agent.heldItem);
  setPixelIcon(side.heldIcon, held.icon);
  side.held.dataset.tip = `En la mano: ${held.label}.`;
  setText(side.heldName, held.label);

  const state = !agent.connected ? "off" : agent.alive ? "alive" : "dead";
  side.status.dataset.state = state;
  setText(side.status, state === "off" ? "Desconectado" : state === "alive" ? "En pie" : "Caído");
  side.card.classList.toggle("is-dead", state === "dead");
}

/** Tiempo que le queda a la pelea en el instante que se ve en pantalla (`now`, hora de la transmisión). */
function renderClock(now: number = videoServerNow()): void {
  if (!els) return;
  const state = current;
  if (state && state.phase === "running" && state.endsAt !== null) {
    const remaining = Math.max(0, state.endsAt - now);
    setText(els.clock, formatClock(remaining));
    els.clock.classList.toggle("is-urgent", remaining <= URGENT_MS);
  } else {
    setText(els.clock, "--:--");
    els.clock.classList.remove("is-urgent");
  }
}

function renderBanner(result: MatchResult | null): void {
  if (!els) return;
  if (!result) {
    els.banner.hidden = true;
    return;
  }
  els.banner.dataset.winner = result.winner ?? "none";
  setText(els.bannerTitle, resultTitle(result));
  setText(els.bannerDetail, resultDetail(result));
  // "Por qué ganó": llega unos segundos después que el resultado.
  const why = result.explanation?.trim() ?? "";
  // Un estado posterior del mismo resultado puede venir sin la frase: no se borra la que ya está.
  if (why !== "" || els.banner.hidden) {
    setText(els.bannerWhy, why);
    els.bannerWhy.hidden = why === "";
  }
  els.banner.hidden = false;
}

export function renderState(state: MatchState): void {
  if (!els) return;
  current = state;
  document.body.dataset.phase = state.phase;
  setText(els.phase, phaseLabel(state));
  for (const side of SIDES) {
    renderAgent(els.sides[side], state.agents[side], state.configs[side].model);
    // Modelo con el que se pelea (o se peleó) esta pelea.
    renderModelTag(els.sides[side].model, resolveModel(state.configs[side]));
    els.sides[side].card.classList.toggle(
      "is-winner",
      state.phase === "finished" && state.result !== null && state.result.winner === side,
    );
  }
  // El cartel de resultado se mantiene hasta que parte la siguiente pelea,
  // aunque el servidor vuelva a "idle" después de terminar.
  if (state.phase === "finished" && state.result) renderBanner(state.result);
  else if (state.phase === "preparing" || state.phase === "running") renderBanner(null);
  // La frase puede llegar cuando el servidor ya volvió a "idle" (tarda más que el cartel).
  else if (state.result?.explanation) showExplanation(state.result.explanation);
  renderClock();
}

/** match_end: muestra el resultado de inmediato, sin esperar el próximo "state". */
export function showResult(result: MatchResult): void {
  renderBanner(result);
}

/**
 * Actualizaciones puntuales entre dos eventos "state", para que se sienta instantáneo.
 * Un golpe cambia la barra, suelta el número y da el destello en la misma aplicación,
 * que main.ts hace justo cuando el golpe se ve en la imagen.
 */
export function applyDamage(side: Side, health: number, amount: number): void {
  if (!els) return;
  const target = els.sides[side];
  setHealth(target, health);
  popDamage(target, amount);
  target.card.classList.remove("is-hit");
  // Forzar reflow para reiniciar la animación si llegan golpes seguidos.
  void target.card.offsetWidth;
  target.card.classList.add("is-hit");
}

/** Agrega el "por qué ganó" al cartel de resultado que ya está en pantalla. */
export function showExplanation(text: string): void {
  if (!els || els.banner.hidden) return;
  setText(els.bannerWhy, text.trim());
  els.bannerWhy.hidden = text.trim() === "";
}

export function applyDeath(side: Side): void {
  if (!els) return;
  const target = els.sides[side];
  target.card.classList.add("is-dead");
  target.status.dataset.state = "dead";
  setText(target.status, "Caído");
}
