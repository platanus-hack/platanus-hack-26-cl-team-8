/**
 * Catálogo de Vercel AI Gateway: agrupa los modelos en líneas (mismo modelo sin importar
 * versión, snapshot o ruta), elige la versión más reciente de cada una, decide si sirve
 * para el benchmark (texto, tools, razonamiento apagable) y congela lo elegido.
 *
 * Todo es puro salvo fetchCatalog/fetchEndpoints, que reciben el fetch inyectado.
 */
import { REASONING_LEVELS, type FrozenModel, type OmittedLine, type ReasoningLevel } from "@phack/protocol";
import type {
  CatalogEndpoints,
  CatalogModel,
  CatalogResolution,
  ResolvedLine,
  ResolveOptions,
} from "./types";

export const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

/** Líneas prioritarias en orden: GPT Luna, Gemini Flash, Claude Haiku, Qwen Flash, GLM Flash, MiMo Flash, MiniMax Flash, Muse Ember. */
export const DEFAULT_PRIORITY_LINES: string[] = [
  "openai/gpt-*-luna",
  "google/gemini-*-flash",
  "anthropic/claude-haiku-*",
  "alibaba/qwen*-flash",
  "zai/glm-*-flash",
  "xiaomi/mimo-v*-flash",
  "minimax/minimax-m*-flash",
  "meta/muse-ember",
];

export const DEFAULT_REFERENCE_ID = "deepseek/deepseek-v4.1-flash-1017-fast";
export const DEFAULT_REFERENCE_PROVIDER = "baseten";

const DEFAULT_TIMEOUT_MS = 20_000;

// ---------- Líneas ----------

export type Route = "base" | "fast" | "free" | "batch";

export type LineKey = {
  line: string;
  version: string;
  snapshot: string | null;
  route: Route;
  /** Sufijo de ruta tal cual ("fast", "ultrafast", "free"…); null si es la ruta base. */
  routeSuffix: string | null;
};

const FAST_SUFFIXES = new Set(["fast", "ultrafast", "highspeed", "ultraspeed"]);
/** Tamaños de pesos ("27b", "a3b", "2.4t"): distinguen modelos, no versiones. */
const SIZE_TOKEN = /^a?\d+(\.\d+)?[bt]$/;
const SNAPSHOT_TOKEN = /^\d{4}$/;
const VERSION_RUN = /\d+(?:\.\d+)*/;

/**
 * Clave de línea de un id del gateway: creador + nombre con los números de versión
 * reemplazados por "*" y sin sufijos de ruta (-fast, -free, -batch…) ni snapshot -MMDD.
 *   "deepseek/deepseek-v4.1-flash-1017-fast" → línea "deepseek/deepseek-v*-flash", versión "4.1", snapshot "1017", ruta fast
 *   "alibaba/qwen3.8-flash" → "alibaba/qwen*-flash"; "meta/muse-ember" queda igual (versión "").
 */
export function lineKey(id: string): LineKey {
  const slash = id.indexOf("/");
  const creator = slash >= 0 ? id.slice(0, slash) : "";
  const tokens = (slash >= 0 ? id.slice(slash + 1) : id).split("-");

  let route: Route = "base";
  let routeSuffix: string | null = null;
  let snapshot: string | null = null;
  // Sufijos desde el final: rutas en cualquier orden y, como mucho, un snapshot.
  for (;;) {
    const last = tokens[tokens.length - 1];
    if (tokens.length <= 1 || last === undefined) break;
    if (last === "batch" || last === "free" || FAST_SUFFIXES.has(last)) {
      const r: Route = last === "batch" ? "batch" : last === "free" ? "free" : "fast";
      // batch domina a free, y free a fast (es lo que decide si se usa o no).
      if (rank(r) > rank(route)) {
        route = r;
        routeSuffix = last;
      }
      tokens.pop();
      continue;
    }
    if (snapshot === null && SNAPSHOT_TOKEN.test(last)) {
      snapshot = last;
      tokens.pop();
      continue;
    }
    break;
  }

  const versions: string[] = [];
  const name = tokens.map((token) => {
    if (SIZE_TOKEN.test(token)) return token;
    const match = VERSION_RUN.exec(token);
    if (!match) return token;
    versions.push(match[0]);
    return token.replace(VERSION_RUN, "*");
  });

  return {
    line: creator ? `${creator}/${name.join("-")}` : name.join("-"),
    version: versions.join("-"),
    snapshot,
    route,
    routeSuffix,
  };
}

function rank(route: Route): number {
  return { base: 0, fast: 1, free: 2, batch: 3 }[route];
}

// ---------- Compatibilidad ----------

/** null si el modelo sirve para el benchmark; si no, el motivo en español. */
export function isCompatible(m: CatalogModel): string | null {
  if (m.type !== "language") return `tipo "${m.type ?? "desconocido"}", no es un modelo de lenguaje`;
  if (!m.modalities?.input?.includes("text")) return "no recibe texto";
  if (!m.modalities?.output?.includes("text")) return "no responde texto";
  if (!m.tags?.includes("tool-use")) return "no declara uso de tools (tag tool-use)";
  if (lowestReasoning(m) === null) {
    const opts = (m.reasoning_options ?? [])
      .map((o) => (o.values ? `${o.type}[${o.values.join(",")}]` : o.type))
      .join(", ");
    return `no se reconoce ningún nivel de razonamiento usable (opciones: ${opts})`;
  }
  return null;
}

/**
 * Nivel de razonamiento con que juega el modelo: "none" si se puede apagar (sin opciones,
 * con toggle o con effort "none"); si no, el nivel más bajo que acepta (p. ej. "minimal" o
 * "low"). Si el endpoint declara razonamiento obligatorio, nunca "none". null = no hay nivel
 * reconocible.
 */
export function lowestReasoning(m: CatalogModel, endpoints?: CatalogEndpoints | null): ReasoningLevel | null {
  const mandatory = endpoints?.reasoning?.mandatory === true;
  const opts = m.reasoning_options ?? [];
  const efforts = new Set<string>([
    ...opts.flatMap((o) => (o.type === "effort" ? (o.values ?? []) : [])),
    ...(endpoints?.reasoning?.supported_efforts ?? []),
  ]);
  const canDisable = opts.length === 0 || opts.some((o) => o.type === "toggle") || efforts.has("none");
  if (canDisable && !mandatory) return "none";
  const lowest = REASONING_LEVELS.find((level) => level !== "none" && efforts.has(level));
  return lowest ?? null;
}

// ---------- Resolución ----------

type Member = { model: CatalogModel; key: LineKey };

/** Preferencia de ruta dentro de una misma versión: -fast exacto, otras rápidas, base, -free. */
function routePreference(key: LineKey): number {
  if (key.route === "fast") return key.routeSuffix === "fast" ? 0 : 1;
  if (key.route === "base") return 2;
  return 3; // free
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).filter(Boolean).map(Number);
  const pb = b.split(/[.-]/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

type Variant = { version: string; snapshot: string | null; released: number; members: Member[] };

/** Agrupa una línea por (versión, snapshot) y la ordena de la más reciente a la más vieja. */
function variantsOf(members: Member[]): Variant[] {
  const byKey = new Map<string, Variant>();
  for (const m of members) {
    const k = `${m.key.version}|${m.key.snapshot ?? ""}`;
    let v = byKey.get(k);
    if (!v) {
      v = { version: m.key.version, snapshot: m.key.snapshot, released: 0, members: [] };
      byKey.set(k, v);
    }
    v.members.push(m);
    v.released = Math.max(v.released, m.model.released ?? 0);
  }
  const list = [...byKey.values()];
  for (const v of list) {
    v.members.sort((x, y) => routePreference(x.key) - routePreference(y.key) || cmpStr(x.model.id, y.model.id));
  }
  return list.sort(
    (x, y) =>
      y.released - x.released ||
      compareVersions(y.version, x.version) ||
      cmpStr(y.snapshot ?? "", x.snapshot ?? ""),
  );
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type LineInfo = {
  line: string;
  resolved: ResolvedLine;
  /** Id de la versión más reciente (la elegida o la que se habría usado). */
  latestId: string;
  released: number;
  /** Alguna versión (aunque sea vieja) era compatible: su omisión es informativa. */
  everCompatible: boolean;
};

function resolveLine(line: string, members: Member[], priority: number | null): LineInfo {
  const variants = variantsOf(members);
  const members_ = variants.flatMap((v) => v.members.map((m) => m.model.id));
  const latest = variants[0];
  const everCompatible = members.some((m) => isCompatible(m.model) === null);
  if (!latest) {
    return {
      line,
      latestId: "",
      released: 0,
      everCompatible,
      resolved: { line, chosen: null, members: members_, omittedReason: "no está en el catálogo", priority },
    };
  }
  // Dentro de la versión más reciente: la primera ruta compatible según la preferencia.
  // Nunca se cae a una versión más vieja.
  const chosen = latest.members.find((m) => isCompatible(m.model) === null) ?? null;
  const preferred = latest.members[0]!;
  const omittedReason = chosen ? null : `la versión más reciente (${preferred.model.id}) no sirve: ${isCompatible(preferred.model)}`;
  return {
    line,
    latestId: (chosen ?? preferred).model.id,
    released: latest.released,
    everCompatible,
    resolved: { line, chosen: chosen?.model ?? null, members: members_, omittedReason, priority },
  };
}

/**
 * Agrupa el catálogo en líneas, elige una versión por línea y arma la lista de candidatos:
 * primero las prioritarias (en su orden), luego las demás compatibles por `released` desc.
 * maxCandidates corta; el resto compatible va a overflow. La línea de la referencia no compite.
 * Las rutas -batch se descartan siempre.
 */
export function resolveCatalog(models: CatalogModel[], opts: ResolveOptions): CatalogResolution {
  const reference = models.find((m) => m.id === opts.referenceId);
  if (!reference) throw new Error(`el modelo de referencia ${opts.referenceId} no está en el catálogo`);
  const referenceLine = lineKey(reference.id).line;

  const groups = new Map<string, Member[]>();
  for (const model of models) {
    const key = lineKey(model.id);
    if (key.route === "batch") continue;
    const list = groups.get(key.line) ?? [];
    list.push({ model, key });
    groups.set(key.line, list);
  }

  const priorityOf = new Map(opts.priorityLines.map((line, i) => [line, i] as const));
  const infos: LineInfo[] = [];
  for (const line of opts.priorityLines) {
    if (line === referenceLine) continue;
    infos.push(resolveLine(line, groups.get(line) ?? [], priorityOf.get(line) ?? null));
  }
  const others = [...groups.keys()]
    .filter((line) => !priorityOf.has(line) && line !== referenceLine)
    .map((line) => resolveLine(line, groups.get(line)!, null))
    .sort((x, y) => y.released - x.released || cmpStr(x.line, y.line));
  infos.push(...others);

  const compatible = infos.filter((i) => i.resolved.chosen !== null).map((i) => i.resolved);
  const max = Math.max(0, opts.maxCandidates);
  const omitted: OmittedLine[] = infos
    .filter((i) => i.resolved.chosen === null && (i.resolved.priority !== null || i.everCompatible))
    .map((i) => ({ line: i.line, latestId: i.latestId, reason: i.resolved.omittedReason ?? "sin motivo" }));

  // Las prioritarias van primero y sus cupos son suyos: una línea automática solo entra si
  // maxCandidates deja lugar después de TODAS las prioritarias (aunque alguna se haya omitido).
  // Así nunca reemplaza a una prioritaria un modelo cualquiera del catálogo.
  const priorityCount = opts.priorityLines.filter((line) => line !== referenceLine).length;
  const prio = compatible.filter((r) => r.priority !== null);
  const auto = compatible.filter((r) => r.priority === null);
  const prioIn = prio.slice(0, max);
  const autoSlots = Math.max(0, max - Math.max(priorityCount, prioIn.length));
  const autoIn = auto.slice(0, autoSlots);
  return {
    reference,
    candidates: [...prioIn, ...autoIn],
    overflow: [...prio.slice(max), ...auto.slice(autoSlots)],
    omitted,
  };
}

// ---------- Congelar ----------

/**
 * Arma el FrozenModel de un modelo elegido. Con endpoints: razonamiento obligatorio ⇒ omitido;
 * proveedor = pinProvider si viene (debe estar entre los endpoints), si no el endpoint con
 * status 0 y mayor uptime. Sin endpoints (null): proveedor = pinProvider o null (lo elige el gateway).
 */
export function freezeModel(
  m: CatalogModel,
  endpoints: CatalogEndpoints | null,
  extra: { isReference: boolean; priority: number | null; pinProvider?: string },
): FrozenModel | { omittedReason: string } {
  const incompatible = isCompatible(m);
  if (incompatible) return { omittedReason: incompatible };
  const reasoning = lowestReasoning(m, endpoints);
  if (reasoning === null) return { omittedReason: "el endpoint exige razonamiento y no declara niveles usables" };

  let inferenceProvider: string | null = extra.pinProvider ?? null;
  if (endpoints) {
    const usable = endpoints.endpoints.filter((e) => (e.status ?? 0) === 0);
    if (extra.pinProvider) {
      if (!usable.some((e) => e.provider_name === extra.pinProvider)) {
        return { omittedReason: `inaccesible: el proveedor ${extra.pinProvider} no tiene un endpoint disponible` };
      }
    } else {
      const best = [...usable].sort(
        (x, y) => (y.uptime_last_1h ?? -1) - (x.uptime_last_1h ?? -1) || cmpStr(x.provider_name, y.provider_name),
      )[0];
      if (!best) return { omittedReason: "inaccesible: no hay endpoints disponibles" };
      inferenceProvider = best.provider_name;
    }
  }

  const key = lineKey(m.id);
  return {
    key: m.id,
    name: m.name ?? m.id,
    line: key.line,
    gatewayId: m.id,
    version: versionLabel(key),
    released: m.released ?? null,
    inferenceProvider,
    clientProvider: "vercel",
    reasoning,
    pricing: parsePricing(m.pricing),
    isReference: extra.isReference,
    priority: extra.priority,
  };
}

/** "4.1 · snapshot 1017 · ruta fast"; "sin versión" para líneas sin número. */
function versionLabel(key: LineKey): string {
  const parts = [key.version || "sin versión"];
  if (key.snapshot) parts.push(`snapshot ${key.snapshot}`);
  if (key.routeSuffix) parts.push(`ruta ${key.routeSuffix}`);
  return parts.join(" · ");
}

function parsePricing(p: CatalogModel["pricing"]): FrozenModel["pricing"] {
  const input = toNumber(p?.input);
  const output = toNumber(p?.output);
  if (input === null || output === null) return null;
  return { input, output, cacheRead: toNumber(p?.input_cache_read) };
}

function toNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- Red ----------

type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

async function getText(url: string, fetchFn: FetchFn, timeoutMs: number): Promise<string> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} respondió ${res.status}`);
  return res.text();
}

/** Descarga el catálogo completo. `raw` es el cuerpo tal cual (se congela con su sha256). fetchedAt en ms. */
export async function fetchCatalog(
  fetchFn: FetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ models: CatalogModel[]; raw: string; fetchedAt: number }> {
  const fetchedAt = Date.now();
  const raw = await getText(CATALOG_URL, fetchFn, timeoutMs);
  const body = JSON.parse(raw) as { data?: CatalogModel[] };
  if (!Array.isArray(body.data)) throw new Error("el catálogo no trae una lista data");
  return { models: body.data, raw, fetchedAt };
}

/** Endpoints (proveedores de inferencia) de un modelo; la API los envuelve en `data`. */
export async function fetchEndpoints(
  id: string,
  fetchFn: FetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CatalogEndpoints> {
  const raw = await getText(`${CATALOG_URL}/${id}/endpoints`, fetchFn, timeoutMs);
  const body = JSON.parse(raw) as { data?: Partial<CatalogEndpoints> } & Partial<CatalogEndpoints>;
  const data = body.data ?? body;
  return { reasoning: data.reasoning ?? null, endpoints: Array.isArray(data.endpoints) ? data.endpoints : [] };
}
