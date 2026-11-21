/** Limitador simple en memoria, de ventana fija por clave (IP). */

export type RateLimiterOptions = {
  /** Máximo de solicitudes permitidas por ventana. */
  limit: number;
  windowMs: number;
  /** Reloj inyectable para tests. */
  now?: () => number;
};

export type RateLimiter = {
  /** true si la solicitud se permite (y la cuenta); false si excede el límite. */
  allow(key: string): boolean;
  /** Borra las ventanas vencidas para no acumular memoria. */
  prune(): void;
  size(): number;
};

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();

  return {
    allow(key) {
      const t = now();
      const current = windows.get(key);
      if (!current || t - current.start >= opts.windowMs) {
        windows.set(key, { start: t, count: 1 });
        return opts.limit >= 1;
      }
      if (current.count >= opts.limit) return false;
      current.count += 1;
      return true;
    },
    prune() {
      const t = now();
      for (const [key, w] of windows) {
        if (t - w.start >= opts.windowMs) windows.delete(key);
      }
    },
    size() {
      return windows.size;
    },
  };
}
