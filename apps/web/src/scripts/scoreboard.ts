import { SIDES, type AgentStatus, type MatchResult, type MatchState, type Side } from "@phack/protocol";
import { byId, setText } from "./dom";
import { PHASE_LABEL, formatClock, formatNumber, resultDetail, resultTitle } from "./format";
import { onDefaultsChange, renderModelTag, resolveModel } from "./models";

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
  thought: HTMLElement;
  action: HTMLElement;
};

type Elements = {
  sides: Record<Side, SideElements>;
  phase: HTMLElement;
  clock: HTMLElement;
  banner: HTMLElement;
  bannerTitle: HTMLElement;
  bannerDetail: HTMLElement;
};

let els: Elements | null = null;
let current: MatchState | null = null;
/** Diferencia estimada entre el reloj del servidor y el del navegador (ms). */
let clockOffset = 0;

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
    thought: byId(`thought-${side}`),
    action: byId(`action-${side}`),
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
  };
  window.setInterval(renderClock, 250);
  onDefaultsChange(() => {
    if (current) renderState(current);
  });
}

/** Cada evento trae `at` (reloj del servidor): se usa para corregir la cuenta regresiva. */
export function syncClock(serverAt: number): void {
  clockOffset = serverAt - Date.now();
}

function setHealth(side: SideElements, health: number): void {
  const clamped = Math.min(MAX_HEALTH, Math.max(0, health));
  side.hpFill.style.width = `${(clamped / MAX_HEALTH) * 100}%`;
  side.hp.setAttribute("aria-valuenow", String(Math.round(clamped)));
  side.hp.dataset.level = clamped <= 6 ? "low" : clamped <= 12 ? "mid" : "high";
  setText(side.hpValue, formatNumber(clamped));
}

function renderAgent(side: SideElements, agent: AgentStatus): void {
  setText(side.bot, agent.username);
  setHealth(side, agent.health);
  setText(side.food, formatNumber(agent.food));
  setText(side.damage, formatNumber(agent.damageDealt));
  setText(side.decisions, String(agent.decisions));
  setText(side.thought, agent.lastThought.trim() || "—");
  setText(side.action, agent.lastAction.trim() || "—");

  const state = !agent.connected ? "off" : agent.alive ? "alive" : "dead";
  side.status.dataset.state = state;
  setText(side.status, state === "off" ? "Desconectado" : state === "alive" ? "En pie" : "Caído");
  side.card.classList.toggle("is-dead", state === "dead");
}

function renderClock(): void {
  if (!els) return;
  const state = current;
  if (state && state.phase === "running" && state.endsAt !== null) {
    const remaining = Math.max(0, state.endsAt - (Date.now() + clockOffset));
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
  els.banner.hidden = false;
}

export function renderState(state: MatchState): void {
  if (!els) return;
  current = state;
  document.body.dataset.phase = state.phase;
  setText(els.phase, PHASE_LABEL[state.phase]);
  for (const side of SIDES) {
    renderAgent(els.sides[side], state.agents[side]);
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
  renderClock();
}

/** match_end: muestra el resultado de inmediato, sin esperar el próximo "state". */
export function showResult(result: MatchResult): void {
  renderBanner(result);
}

/** Actualizaciones puntuales entre dos eventos "state", para que se sienta instantáneo. */
export function applyDamage(side: Side, health: number): void {
  if (!els) return;
  const target = els.sides[side];
  setHealth(target, health);
  target.card.classList.remove("is-hit");
  // Forzar reflow para reiniciar la animación si llegan golpes seguidos.
  void target.card.offsetWidth;
  target.card.classList.add("is-hit");
}

export function applyThought(side: Side, text: string): void {
  if (!els) return;
  setText(els.sides[side].thought, text.trim() || "—");
}

export function applyAction(side: Side, text: string): void {
  if (!els) return;
  setText(els.sides[side].action, text.trim() || "—");
}

export function applyDeath(side: Side): void {
  if (!els) return;
  const target = els.sides[side];
  target.card.classList.add("is-dead");
  target.status.dataset.state = "dead";
  setText(target.status, "Caído");
}
