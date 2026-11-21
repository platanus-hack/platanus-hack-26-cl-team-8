/**
 * Cola de acciones de una respuesta del LLM. Una respuesta puede llamar varias
 * herramientas: la primera se ejecuta al llegar la respuesta y las demás esperan aquí,
 * en orden; cada una empieza cuando termina la anterior. El cuerpo (fighter.ts) solo
 * pide la siguiente: esta parte no sabe nada del bot y se puede probar sola.
 */

/** Tope técnico de llamadas que entran a la cola desde una sola respuesta. */
export const MAX_QUEUED_ACTIONS = 8;

/**
 * Lo que dura una acción que no termina sola cuando viene otra detrás y no trae
 * "seconds". Sin esto la cola no avanzaría nunca.
 */
export const QUEUE_STEP_DEFAULT_MS = 2000;

/**
 * Herramientas que no terminan solas: siguen hasta que otra las reemplaza (o hasta que
 * pasa su "seconds"). Las demás terminan cuando el cuerpo acaba lo que hacía (comer,
 * beber, construir, lanzar...) o cuando ya no se pueden hacer.
 */
export const OPEN_ENDED_TOOLS: readonly string[] = ["approach", "attack", "retreat", "move", "shoot", "shield", "wait"];

export function isOpenEnded(name: string): boolean {
  return OPEN_ENDED_TOOLS.includes(name);
}

/** Resultado (para el historial del LLM) de una llamada que quedó esperando su turno. */
export const QUEUED_RESULT = "en cola: empieza cuando termine la acción anterior";
/** Resultado de una llamada que no cupo en la cola. */
export const OVERFLOW_RESULT = `fuera de la cola: una respuesta admite hasta ${MAX_QUEUED_ACTIONS} acciones`;

/** Una llamada a herramienta tal como quedó en la cola. */
export type PlanStep = {
  /** Posición de la llamada dentro de su respuesta (0 = la primera). */
  index: number;
  name: string;
  args: Record<string, unknown>;
};

/** Lo que trae el LLM: se toleran llamadas mal formadas (nombre vacío, args que no son objeto). */
function toStep(call: unknown, index: number): PlanStep {
  const { name, args } = (typeof call === "object" && call !== null ? call : {}) as { name?: unknown; args?: unknown };
  return {
    index,
    name: typeof name === "string" ? name : "",
    args: typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
  };
}

export class ActionPlan {
  private steps: PlanStep[] = [];

  /**
   * Toma las llamadas de una respuesta. Si trae al menos una, reemplaza lo que quedaba
   * en cola (hasta MAX_QUEUED_ACTIONS); si no trae ninguna, no toca nada.
   * Devuelve cuántas entraron a la cola.
   */
  replace(calls: readonly unknown[]): number {
    if (calls.length === 0) return 0;
    this.steps = calls.slice(0, MAX_QUEUED_ACTIONS).map(toStep);
    return this.steps.length;
  }

  /** Saca la siguiente llamada de la cola (null si no queda ninguna). */
  next(): PlanStep | null {
    return this.steps.shift() ?? null;
  }

  hasNext(): boolean {
    return this.steps.length > 0;
  }

  /** Nombres de las herramientas que siguen esperando, en orden. */
  pending(): string[] {
    return this.steps.map((step) => step.name);
  }

  clear(): void {
    this.steps = [];
  }
}

/**
 * Segundos que dura una acción al empezar: los que pidió el LLM; si no pidió y es una
 * herramienta que no termina sola con otra acción detrás, QUEUE_STEP_DEFAULT_MS; si no,
 * null (una que no termina sola sigue hasta que la reemplacen).
 */
export function stepSeconds(name: string, requested: number | null, hasNext: boolean): number | null {
  if (requested !== null) return requested;
  return hasNext && isOpenEnded(name) ? QUEUE_STEP_DEFAULT_MS / 1000 : null;
}

/**
 * Resultados que van al historial del LLM, uno por llamada de la respuesta: las que ya
 * corrieron al llegar la respuesta llevan su resultado real (`ran`, en orden); las que
 * esperan su turno, QUEUED_RESULT; las que no cupieron, OVERFLOW_RESULT.
 */
export function replyResults(callCount: number, ran: readonly string[]): string[] {
  return Array.from({ length: callCount }, (_, index) =>
    index < ran.length ? (ran[index] as string) : index < MAX_QUEUED_ACTIONS ? QUEUED_RESULT : OVERFLOW_RESULT,
  );
}
