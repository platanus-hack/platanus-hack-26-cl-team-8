import {
  BENCH_PRESETS,
  SUITE_ALL,
  SIDES,
  findPreset,
  presetSettings,
  type AgentConfig,
  type BenchPreset,
  type MatchSettings,
  type MatchState,
  type PresetsResponse,
  type PromptsResponse,
  type Side,
  type SuiteStatus,
  type UpdatePromptBody,
} from "@phack/protocol";
import type { EventSink } from "./hub";
import { MatchActiveError } from "./match";
import { errorMessage, type LogFn } from "./util";

/**
 * Pre-ajustes de benchmark: cargar uno (prompts, kits y ajustes) y, si se pide, ejecutarlo.
 * Con el id "todos" corre una batería: cada pre-ajuste, uno tras otro, cada uno cuando
 * termina el anterior. El modelo de cada lado no se toca (salvo el espejo, que copia el de
 * Rojo en Azul): así una batería compara los modelos que cada uno eligió.
 */

export class UnknownPresetError extends Error {
  constructor(id: string) {
    super(`No existe el pre-ajuste "${id}"`);
    this.name = "UnknownPresetError";
  }
}

export type PresetDeps = {
  prompts: { get(): PromptsResponse; update(side: Side, body: UpdatePromptBody): Promise<AgentConfig> };
  settings: { get(): MatchSettings; update(change: Partial<MatchSettings>): Promise<MatchSettings> };
  match: { start(): MatchState; isActive(): boolean; getState(): MatchState };
  hub: Pick<EventSink, "broadcast">;
  log: LogFn;
  /** Cada cuánto se revisa si terminó la partida de la batería. */
  pollMs?: number;
};

/** Lo que se guarda de un lado al cargar el pre-ajuste: su prompt y kit, con el modelo de `model`. */
function sideBody(preset: BenchPreset, side: Side, model: AgentConfig): UpdatePromptBody {
  const body: UpdatePromptBody = { prompt: preset.prompts[side].prompt, kit: preset.prompts[side].kit };
  if (model.provider) body.provider = model.provider;
  if (model.model) body.model = model.model;
  return body;
}

export class PresetRunner {
  private suite: SuiteStatus = { running: false, queue: [], index: 0, done: 0, stoppedReason: null };
  private timer: ReturnType<typeof setInterval> | null = null;
  /** true mientras se arranca una partida de la batería (para no contarla como terminada). */
  private starting = false;

  constructor(private readonly deps: PresetDeps) {}

  snapshot(): PresetsResponse {
    return { presets: BENCH_PRESETS, suite: { ...this.suite, queue: [...this.suite.queue] } };
  }

  isRunning(): boolean {
    return this.suite.running;
  }

  /**
   * Carga el pre-ajuste `id` y, con `start`, lo ejecuta. "todos" (SUITE_ALL) siempre
   * ejecuta la batería completa. Lanza MatchActiveError si hay una pelea o una batería en
   * curso, y UnknownPresetError si el id no existe.
   */
  async run(id: string, start: boolean): Promise<PresetsResponse> {
    if (this.suite.running || this.deps.match.isActive()) throw new MatchActiveError();
    const queue = id === SUITE_ALL ? BENCH_PRESETS.map((preset) => preset.id) : [id];
    for (const presetId of queue) if (!findPreset(presetId)) throw new UnknownPresetError(presetId);
    if (!start && id !== SUITE_ALL) {
      await this.apply(findPreset(id) as BenchPreset);
      return this.snapshot();
    }
    this.suite = { running: true, queue, index: 0, done: 0, stoppedReason: null };
    this.deps.log("info", `Batería de benchmarks: ${queue.length} ${queue.length === 1 ? "pre-ajuste" : "pre-ajustes"}`);
    await this.startCurrent();
    return this.snapshot();
  }

  /** Corta la batería: la partida en curso sigue hasta terminar, pero no empieza otra. */
  stop(reason = "detenida a mano"): PresetsResponse {
    if (this.suite.running) {
      this.suite.running = false;
      this.suite.stoppedReason = reason;
      this.deps.log("info", `Batería de benchmarks ${reason}`);
    }
    this.clearTimer();
    return this.snapshot();
  }

  shutdown(): void {
    this.stop("cortada al apagar el servidor");
  }

  /** Guarda los ajustes y los prompts del pre-ajuste, y avisa a la web. */
  private async apply(preset: BenchPreset): Promise<void> {
    const settings = await this.deps.settings.update(presetSettings(preset));
    this.deps.hub.broadcast({ type: "settings", at: Date.now(), settings });
    const current = this.deps.prompts.get();
    // Cada lado conserva su modelo.
    for (const side of SIDES) await this.deps.prompts.update(side, sideBody(preset, side, current[side]));
    this.deps.hub.broadcast({ type: "prompts", at: Date.now(), prompts: this.deps.prompts.get() });
    this.deps.log("info", `Pre-ajuste cargado: ${preset.name}`);
  }

  private async startCurrent(): Promise<void> {
    const id = this.suite.queue[this.suite.index];
    const preset = id ? findPreset(id) : undefined;
    if (!preset) {
      this.finishSuite();
      return;
    }
    this.starting = true;
    try {
      await this.apply(preset);
      if (!this.suite.running) return;
      this.deps.match.start();
      this.deps.log(
        "info",
        `Batería: ${this.suite.index + 1} de ${this.suite.queue.length}, ${preset.name}`,
      );
    } catch (err) {
      this.stop(`detenida: no se pudo empezar "${preset.name}" (${errorMessage(err)})`);
      return;
    } finally {
      this.starting = false;
    }
    this.watch();
  }

  /** Revisa cada tanto si terminó la partida; entonces pasa a la siguiente. */
  private watch(): void {
    this.clearTimer();
    this.timer = setInterval(() => {
      if (!this.suite.running || this.starting || this.deps.match.isActive()) return;
      this.clearTimer();
      this.suite.done += 1;
      const reason = this.deps.match.getState().result?.reason;
      // Si alguien detuvo la partida o falló, la batería no sigue sola.
      if (reason === "stopped" || reason === "error") {
        this.stop(reason === "stopped" ? "detenida: se detuvo una partida" : "detenida: una partida terminó con error");
        return;
      }
      this.suite.index += 1;
      if (this.suite.index >= this.suite.queue.length) {
        this.finishSuite();
        return;
      }
      void this.startCurrent();
    }, this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  private finishSuite(): void {
    this.suite.running = false;
    this.suite.index = Math.max(0, this.suite.queue.length - 1);
    this.clearTimer();
    this.deps.log("info", `Batería de benchmarks completa: ${this.suite.done} ${this.suite.done === 1 ? "partida" : "partidas"}`);
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
