# Imagen "web": compila el sitio Astro y lo sirve con Caddy (que además hace de
# proxy inverso hacia el orquestador y MediaMTX).
# IMPORTANTE: el contexto de build es la RAÍZ del repo:
#   docker build -f apps/web/Dockerfile .

# ---------- Etapa 1: build del sitio estático ----------
FROM node:20-slim AS build
WORKDIR /repo

RUN npm i -g pnpm@10

COPY . .

# Variables públicas: quedan incrustadas en el JS en tiempo de build.
# Vacío = mismo origen (lo normal detrás de Caddy).
ARG PUBLIC_API_BASE=""
ARG PUBLIC_HLS_URL="/live/arena/index.m3u8"
ENV PUBLIC_API_BASE=${PUBLIC_API_BASE} \
    PUBLIC_HLS_URL=${PUBLIC_HLS_URL} \
    ASTRO_TELEMETRY_DISABLED=1

# Se instala desde la raíz, pero solo @phack/web y sus dependencias del
# workspace: así esta imagen no compila las dependencias nativas de otras apps
# (canvas, gl...). pnpm-lock.yaml fija las versiones.
RUN pnpm install --frozen-lockfile --filter "@phack/web..."
RUN pnpm --filter @phack/web build

# ---------- Etapa 2: Caddy ----------
FROM caddy:2-alpine

COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv

EXPOSE 80
