import type { MatchPhase, MatchState } from "@phack/protocol";
import { describeError, startMatch, stopMatch } from "./api";
import { byId, setText } from "./dom";
import { showToast } from "./toast";

let startBtn: HTMLButtonElement | null = null;
let stopBtn: HTMLButtonElement | null = null;
let phase: MatchPhase | null = null;
let busy: "start" | "stop" | null = null;

function render(): void {
  if (!startBtn || !stopBtn) return;
  const canStart = phase === "idle" || phase === "finished";
  const canStop = phase === "preparing" || phase === "running" || phase === "intermission";
  startBtn.disabled = busy !== null || !canStart;
  stopBtn.disabled = busy !== null || !canStop;
  setText(startBtn, busy === "start" ? "Iniciando…" : phase === "finished" ? "Iniciar otra pelea" : "Iniciar pelea");
  setText(stopBtn, busy === "stop" ? "Deteniendo…" : "Detener");
}

/** Fase actual según el servidor; null = todavía no se conoce el estado. */
export function setPhase(next: MatchPhase | null): void {
  phase = next;
  render();
}

export function initControls(onState: (state: MatchState) => void): void {
  startBtn = byId<HTMLButtonElement>("btn-start");
  stopBtn = byId<HTMLButtonElement>("btn-stop");

  const run = async (kind: "start" | "stop"): Promise<void> => {
    if (busy !== null) return;
    busy = kind;
    render();
    try {
      const state = await (kind === "start" ? startMatch() : stopMatch());
      onState(state);
    } catch (err) {
      const prefix = kind === "start" ? "No se pudo iniciar la pelea" : "No se pudo detener la pelea";
      showToast(`${prefix}: ${describeError(err)}`);
    } finally {
      busy = null;
      render();
    }
  };

  startBtn.addEventListener("click", () => void run("start"));
  stopBtn.addEventListener("click", () => void run("stop"));
  render();
}
