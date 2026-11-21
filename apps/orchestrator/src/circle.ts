/**
 * Geometría pura de la arena circular (sin RCON), para poder testearla.
 *
 * Todo se expresa en desplazamientos enteros (dx, dz) respecto del centro. Una celda
 * pertenece al disco de radio `r` si su centro está a no más de r + 0.5 del centro
 * del bloque central: así el círculo queda simétrico y sin puntas sueltas.
 */

/** Tramo de bloques contiguos en una fila: z fijo, x de `fromX` a `toX` inclusive. */
export type Run = { dz: number; fromX: number; toX: number };

export function inDisc(dx: number, dz: number, radius: number): boolean {
  return dx * dx + dz * dz <= (radius + 0.5) * (radius + 0.5);
}

/** Una franja por fila que cubre todo el disco: sirve para rellenar el piso con /fill. */
export function discRows(radius: number): Run[] {
  const rows: Run[] = [];
  for (let dz = -radius; dz <= radius; dz += 1) {
    let half = radius;
    while (half >= 0 && !inDisc(half, dz, radius)) half -= 1;
    if (half >= 0) rows.push({ dz, fromX: -half, toX: half });
  }
  return rows;
}

/** true si la celda es del borde del disco: está dentro y toca (por un lado) algo de afuera. */
export function isRim(dx: number, dz: number, radius: number): boolean {
  if (!inDisc(dx, dz, radius)) return false;
  return (
    !inDisc(dx + 1, dz, radius) ||
    !inDisc(dx - 1, dz, radius) ||
    !inDisc(dx, dz + 1, radius) ||
    !inDisc(dx, dz - 1, radius)
  );
}

/**
 * Borde del disco agrupado en tramos por fila: es el muro. Al ser el contorno completo
 * del disco, queda cerrado también en las diagonales: no hay hueco por donde salir.
 */
export function rimRuns(radius: number): Run[] {
  const runs: Run[] = [];
  for (let dz = -radius; dz <= radius; dz += 1) {
    let start: number | null = null;
    for (let dx = -radius; dx <= radius + 1; dx += 1) {
      const rim = dx <= radius && isRim(dx, dz, radius);
      if (rim && start === null) start = dx;
      if (!rim && start !== null) {
        runs.push({ dz, fromX: start, toX: dx - 1 });
        start = null;
      }
    }
  }
  return runs;
}
