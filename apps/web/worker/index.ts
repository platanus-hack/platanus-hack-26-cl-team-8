/**
 * Worker de Cloudflare que publica la web. Cumple el rol que Caddy tiene en Docker:
 * un solo origen para todo.
 *
 *   /          sitio estático de Astro (dist/, servido como assets del Worker)
 *   /api/*     -> orquestador (127.0.0.1:8787 en la máquina que corre el túnel)
 *   /live/*    -> MediaMTX HLS (127.0.0.1:8888 en la máquina que corre el túnel)
 *
 * El orquestador y MediaMTX no quedan expuestos a internet: se alcanzan por
 * Workers VPC, a través del túnel de Cloudflare (`cloudflared`) que corre junto a
 * ellos. Los bindings API y LIVE están definidos en wrangler.jsonc.
 */

type Fetcher = { fetch(input: Request): Promise<Response> };

type Env = {
  ASSETS: Fetcher;
  /** VPC service hacia el orquestador. */
  API: Fetcher;
  /** VPC service hacia el HLS de MediaMTX. */
  LIVE: Fetcher;
};

function errorResponse(status: number, text: string): Response {
  // Mismo formato de error que el orquestador: { error, message }.
  return Response.json({ error: text, message: text }, { status, headers: { "cache-control": "no-store" } });
}

async function proxy(upstream: Fetcher, request: Request): Promise<Response> {
  const url = new URL(request.url);
  // El destino real (host y puerto) lo fija el VPC service; del URL solo importa la ruta.
  const target = new Request(`http://127.0.0.1${url.pathname}${url.search}`, request);
  target.headers.set("x-forwarded-host", url.host);
  target.headers.set("x-forwarded-proto", "https");

  let response: Response;
  try {
    response = await upstream.fetch(target);
  } catch {
    // fetch() lanza cuando el túnel está caído o el servicio local no responde.
    return errorResponse(502, "La arena no está conectada: el servidor local o su túnel están apagados");
  }

  // Un websocket aceptado (101) se devuelve tal cual: el runtime une ambos extremos.
  if (response.status === 101) return response;

  // Los playlists HLS cambian cada fracción de segundo: nunca se cachean.
  if (url.pathname.endsWith(".m3u8")) {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return proxy(env.API, request);
    if (pathname.startsWith("/live/")) return proxy(env.LIVE, request);
    return env.ASSETS.fetch(request);
  },
};
