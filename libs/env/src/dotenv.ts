import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Carga del archivo `.env` para correr las apps FUERA de Docker (`pnpm dev`).
 *
 * Dentro de Docker no hace nada: las imágenes no incluyen `.env` (ver .dockerignore)
 * y las variables las inyecta docker-compose.
 *
 * Reglas (las mismas que `${VAR:-defecto}` en docker-compose):
 *  - una variable ya definida en el entorno real SIEMPRE gana sobre el archivo;
 *  - una línea con valor vacío (`LLM_MODEL=`) se ignora, así aplica el valor por defecto.
 */

/** Parser mínimo de `.env`: `CLAVE=valor`, comentarios con `#`, comillas opcionales. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const first = value.charAt(0);
    if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
      value = value.slice(1, -1);
    } else {
      // Comentario al final de la línea: `VALOR  # nota`.
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Busca `.env` desde `startDir` hacia arriba y se detiene en la raíz del monorepo
 * (la carpeta que tiene `pnpm-workspace.yaml`), para no tomar un `.env` ajeno.
 */
export function findDotEnv(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Copia a `target` solo las claves con valor que `target` aún no define. Devuelve las aplicadas. */
export function applyDotEnv(
  values: Record<string, string>,
  target: Record<string, string | undefined> = process.env,
): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === "") continue;
    if (target[key] !== undefined) continue;
    target[key] = value;
    applied.push(key);
  }
  return applied;
}

/** Carga el `.env` más cercano en `process.env`. Devuelve su ruta, o null si no hay o no se pudo leer. */
export function loadDotEnv(startDir: string = process.cwd()): string | null {
  const file = findDotEnv(startDir);
  if (file === null) return null;
  try {
    applyDotEnv(parseDotEnv(readFileSync(file, "utf8")));
    return file;
  } catch {
    // Un `.env` ilegible no debe impedir el arranque: quedan los valores por defecto.
    return null;
  }
}
