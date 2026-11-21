/**
 * Modo por rondas: la parte del agente que no sabe nada del bot y se puede probar sola.
 * Entre una ronda y la siguiente el orquestador pausa al agente (pause) y después lo
 * reanuda (resume). Mientras está en pausa no decide ni actúa.
 */

/** Cómo va la serie, desde el punto de vista de este agente. */
export type SeriesView = {
  /** Ronda en juego, desde 1. */
  round: number;
  won: number;
  lost: number;
  drawn: number;
  maxRounds: number;
  /** Benchmarks: puntos sumados según el escenario (los propios y los del otro). */
  points?: { mine: number; rival: number };
  /** Benchmarks, horizonte "unknown": el agente no sabe cuántas rondas hay. */
  hideMax?: boolean;
};

/** Campos de la serie que van en la observación (solo en el modo por rondas). */
export type SeriesObservation = {
  /** Ronda en juego, desde 1. */
  round: number;
  /** Falta con el horizonte desconocido. */
  maxRounds?: number;
  /** Rondas que ganó este agente. */
  roundsWon: number;
  /** Rondas que ganó el otro agente. */
  roundsLost: number;
  /** Rondas empatadas (se acabó el tiempo con la misma vida). */
  roundsDrawn: number;
  /** Benchmarks: puntos propios y del otro agente. */
  myPoints?: number;
  rivalPoints?: number;
};

export function seriesObservation(series: SeriesView): SeriesObservation {
  // El orden de las claves es el de antes: round, maxRounds, roundsWon…
  const out: SeriesObservation = {
    round: series.round,
    ...(series.hideMax ? {} : { maxRounds: series.maxRounds }),
    roundsWon: series.won,
    roundsLost: series.lost,
    roundsDrawn: series.drawn,
  };
  if (series.points) {
    out.myPoints = series.points.mine;
    out.rivalPoints = series.points.rival;
  }
  return out;
}

/** Lo que se vacía al pausar: la cola de acciones (ver ActionPlan). */
type Clearable = { clear(): void };

/**
 * Llave de las decisiones. Cada llamada al LLM toma un número (ticket) al empezar; su
 * respuesta solo se ejecuta si sigue siendo el mismo número y no hay pausa. Pausar y
 * reanudar cambian el número: una respuesta pedida antes de una pausa no se ejecuta
 * nunca, aunque llegue después de reanudar.
 */
export class RoundGate {
  private paused = false;
  private generation = 0;

  get isPaused(): boolean {
    return this.paused;
  }

  /** Número de la llamada al LLM que empieza ahora. */
  ticket(): number {
    return this.generation;
  }

  /** ¿Se puede ejecutar la respuesta de la llamada que tomó `ticket`? */
  accepts(ticket: number): boolean {
    return !this.paused && ticket === this.generation;
  }

  /** Deja de decidir y de actuar: vacía la cola. */
  pause(queue: Clearable): void {
    this.paused = true;
    this.generation += 1;
    queue.clear();
  }

  resume(): void {
    this.paused = false;
    this.generation += 1;
  }
}
