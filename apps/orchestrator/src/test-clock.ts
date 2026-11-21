import type { ConversationClock } from "./conversation";

/**
 * Solo para los tests: un reloj a mano para Conversation. El tiempo avanza solo con
 * advance(), que dispara en orden los temporizadores que vencen en el camino.
 */
export function manualClock(random = 0) {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      nextId += 1;
      timers.set(nextId, { at: now + ms, fn });
      return nextId;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    random: () => random,
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let first: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) if (entry[1].at <= target && (!first || entry[1].at < first[1].at)) first = entry;
        if (!first) break;
        timers.delete(first[0]);
        now = first[1].at;
        first[1].fn();
      }
      now = target;
    },
    /** Temporizadores pendientes. */
    timers: () => timers.size,
  } satisfies ConversationClock & { advance(ms: number): void; timers(): number };
}
