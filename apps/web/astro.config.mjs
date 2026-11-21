import { defineConfig } from "astro/config";

// Sitio 100% estático: Caddy sirve dist/ y hace de proxy a /api y /live.
// En desarrollo (astro dev) el proxy de Vite cumple el rol de Caddy.
const devApiTarget = process.env.DEV_API_TARGET ?? "http://127.0.0.1:8787";
const devHlsTarget = process.env.DEV_HLS_TARGET ?? "http://127.0.0.1:8888";

export default defineConfig({
  output: "static",
  server: { host: true, port: 4321 },
  devToolbar: { enabled: false },
  vite: {
    // @phack/protocol exporta TypeScript fuente: Vite debe transpilarlo siempre.
    ssr: { noExternal: ["@phack/protocol"] },
    server: {
      proxy: {
        "/api": { target: devApiTarget, changeOrigin: true, ws: true },
        "/live": { target: devHlsTarget, changeOrigin: true },
      },
    },
  },
});
