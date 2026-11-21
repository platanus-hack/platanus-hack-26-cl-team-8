import { describe, expect, it } from "vitest";
import { discRows, inDisc, isRim, rimRuns } from "./circle";

const RADIUS = 13;

function cells(runs: { dz: number; fromX: number; toX: number }[]): Set<string> {
  const set = new Set<string>();
  for (const run of runs) for (let dx = run.fromX; dx <= run.toX; dx += 1) set.add(`${dx},${run.dz}`);
  return set;
}

describe("discRows", () => {
  it("cubre exactamente las celdas del disco", () => {
    const covered = cells(discRows(RADIUS));
    for (let dx = -RADIUS - 2; dx <= RADIUS + 2; dx += 1) {
      for (let dz = -RADIUS - 2; dz <= RADIUS + 2; dz += 1) {
        expect(covered.has(`${dx},${dz}`)).toBe(inDisc(dx, dz, RADIUS));
      }
    }
  });

  it("es simétrico y llega al radio en los ejes", () => {
    const rows = discRows(RADIUS);
    expect(rows).toHaveLength(2 * RADIUS + 1);
    expect(rows.find((r) => r.dz === 0)).toEqual({ dz: 0, fromX: -RADIUS, toX: RADIUS });
    for (const row of rows) expect(row.fromX).toBe(-row.toX);
  });
});

describe("rimRuns", () => {
  const rim = cells(rimRuns(RADIUS));

  it("coincide con el borde del disco", () => {
    for (let dx = -RADIUS - 1; dx <= RADIUS + 1; dx += 1) {
      for (let dz = -RADIUS - 1; dz <= RADIUS + 1; dz += 1) {
        expect(rim.has(`${dx},${dz}`)).toBe(isRim(dx, dz, RADIUS));
      }
    }
  });

  it("no deja salir del interior, ni siquiera en diagonal", () => {
    // Relleno desde el centro moviéndose en las 8 direcciones sin pisar el muro. Un paso
    // diagonal solo vale si no pasa entre dos bloques de muro (igual que un jugador).
    const seen = new Set<string>(["0,0"]);
    const queue: Array<[number, number]> = [[0, 0]];
    let escaped = false;
    while (queue.length > 0) {
      const [x, z] = queue.pop() as [number, number];
      if (!inDisc(x, z, RADIUS)) {
        escaped = true;
        break;
      }
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oz = -1; oz <= 1; oz += 1) {
          if (ox === 0 && oz === 0) continue;
          const nx = x + ox;
          const nz = z + oz;
          const key = `${nx},${nz}`;
          if (seen.has(key) || rim.has(key)) continue;
          if (ox !== 0 && oz !== 0 && rim.has(`${x + ox},${z}`) && rim.has(`${x},${z + oz}`)) continue;
          seen.add(key);
          queue.push([nx, nz]);
        }
      }
    }
    expect(escaped).toBe(false);
  });

  it("deja libre el interior hasta el radio de juego", () => {
    // El muro va en el radio 13; el interior jugable es de radio 12.
    for (const [dx, dz] of [[12, 0], [0, -12], [8, 8], [-8, 0], [8, 0]] as const) {
      expect(rim.has(`${dx},${dz}`)).toBe(false);
      expect(inDisc(dx, dz, RADIUS)).toBe(true);
    }
  });
});
