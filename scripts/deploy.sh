#!/usr/bin/env bash
# Despliega el repo en el servidor casero: rsync por SSH + docker compose up.
#
# Uso:
#   scripts/deploy.sh [usuario@]host [ruta_remota]
#   DEPLOY_HOST=mi-servidor DEPLOY_USER=seba DEPLOY_PATH=/home/seba/phack2026 scripts/deploy.sh
#
# Variables (los argumentos tienen prioridad):
#   DEPLOY_HOST    host o IP del servidor (obligatorio si no se pasa como argumento)
#   DEPLOY_USER    usuario SSH (opcional; también sirve "usuario@host" como argumento)
#   DEPLOY_PATH    carpeta de destino en el servidor (por defecto: phack2026, relativa al home)
#   DEPLOY_PORT    puerto SSH (por defecto: 22)
#   DEPLOY_TUNNEL  1 = levantar también el perfil "tunnel" (cloudflared). Antes de levantar
#                  revisa que el .env del servidor tenga TUNNEL_TOKEN.
#   DEPLOY_SMOKE   1 = correr scripts/smoke.sh en el servidor al terminar
#   DEPLOY_CF_ACCESS 1 = entrar por SSH a través de Cloudflare Access (host = ssh.<dominio>),
#                  sin Tailscale: agrega ProxyCommand "cloudflared access ssh" a ssh y rsync.
#                  Requiere `cloudflared` en esta máquina. Ver docs/CLOUDFLARE.md.
#   DEPLOY_CF_TOKEN_ID / DEPLOY_CF_TOKEN_SECRET  service token de Cloudflare Access (opcional,
#                  los dos juntos): evita el login en el navegador.
#
# Requiere rsync y ssh en esta máquina; docker (con compose v2) en el servidor.
# NO copia node_modules, .git, data ni .env: el .env del servidor se conserva.
# Este script no construye nada en la máquina local: todo el trabajo pesado ocurre en el servidor.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET="${1:-${DEPLOY_HOST:-}}"
REMOTE_PATH="${2:-${DEPLOY_PATH:-phack2026}}"
SSH_PORT="${DEPLOY_PORT:-22}"

if [ -z "$TARGET" ]; then
  echo "Falta el servidor. Uso: scripts/deploy.sh [usuario@]host [ruta_remota]" >&2
  echo "También se puede definir DEPLOY_HOST (y opcionalmente DEPLOY_USER, DEPLOY_PATH, DEPLOY_PORT)." >&2
  exit 1
fi

case "$TARGET" in
  *@*) ;;
  *)
    if [ -n "${DEPLOY_USER:-}" ]; then
      TARGET="${DEPLOY_USER}@${TARGET}"
    fi
    ;;
esac

case "$REMOTE_PATH" in
  *"'"*)
    echo "La ruta remota no puede contener comillas simples." >&2
    exit 1
    ;;
esac

for bin in rsync ssh; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Falta '$bin' en esta máquina." >&2
    exit 1
  fi
done

SSH_OPTS=(-p "$SSH_PORT")

# SSH a través de Cloudflare Access: cloudflared lleva la conexión hasta ssh.<dominio>
# (%h = el host de destino). Con ProxyCommand el puerto no se usa.
CF_ACCESS="${DEPLOY_CF_ACCESS:-0}"
if [ "$CF_ACCESS" = "1" ]; then
  if ! CLOUDFLARED_BIN="$(command -v cloudflared)"; then
    echo "DEPLOY_CF_ACCESS=1 necesita 'cloudflared' en esta máquina (ver docs/CLOUDFLARE.md)." >&2
    exit 1
  fi
  case "$CLOUDFLARED_BIN" in
    *[[:space:]]* | *\'* | *\"*)
      echo "La ruta de cloudflared ($CLOUDFLARED_BIN) no puede tener espacios ni comillas." >&2
      exit 1
      ;;
  esac
  SSH_OPTS+=(-o "ProxyCommand=$CLOUDFLARED_BIN access ssh --hostname %h")
  if [ -n "${DEPLOY_CF_TOKEN_ID:-}" ] || [ -n "${DEPLOY_CF_TOKEN_SECRET:-}" ]; then
    if [ -z "${DEPLOY_CF_TOKEN_ID:-}" ] || [ -z "${DEPLOY_CF_TOKEN_SECRET:-}" ]; then
      echo "El service token necesita DEPLOY_CF_TOKEN_ID y DEPLOY_CF_TOKEN_SECRET." >&2
      exit 1
    fi
    # cloudflared los lee del entorno: así el secreto no queda a la vista en `ps`.
    export TUNNEL_SERVICE_TOKEN_ID="$DEPLOY_CF_TOKEN_ID"
    export TUNNEL_SERVICE_TOKEN_SECRET="$DEPLOY_CF_TOKEN_SECRET"
  else
    # Sin service token hace falta un login vigente. Si no lo hay, cloudflared se queda
    # esperando el navegador: mejor avisar antes del primer ssh.
    CF_HOST="${TARGET#*@}"
    if ! "$CLOUDFLARED_BIN" access token --app="https://$CF_HOST" >/dev/null 2>&1; then
      echo "Venció o no hay login de Cloudflare Access: corre cloudflared access login https://$CF_HOST" >&2
      exit 2
    fi
  fi
fi

SSH=(ssh "${SSH_OPTS[@]}")
# rsync parte -e en espacios pero respeta comillas simples: cada opción va entre comillas
# (el ProxyCommand tiene espacios).
RSYNC_RSH="ssh"
for opt in "${SSH_OPTS[@]}"; do
  RSYNC_RSH="$RSYNC_RSH '$opt'"
done

COMPOSE="docker compose"
if [ "${DEPLOY_TUNNEL:-0}" = "1" ]; then
  COMPOSE="docker compose --profile tunnel"
fi

echo "==> Destino: ${TARGET}:${REMOTE_PATH} (puerto SSH ${SSH_PORT}$([ "$CF_ACCESS" = "1" ] && echo ", por Cloudflare Access"))"

echo "==> Creando la carpeta remota"
"${SSH[@]}" "$TARGET" "mkdir -p '$REMOTE_PATH'"

echo "==> Sincronizando archivos"
# --delete borra en el servidor lo que ya no existe en el repo. Lo excluido
# (.env, data, node_modules) NO se toca en el destino.
# La regla "P" protege el pnpm-lock.yaml generado en el servidor: --delete no lo borra
# mientras no exista en el repo local (si existe localmente, se copia normalmente).
# Las estructuras de los datapacks viven en un "data/" que SÍ va al servidor; rsync usa
# la primera regla que calza, así que esa inclusión debe ir antes de excluir data/.
# .env.* (por ejemplo .env.deploy, con contraseñas y el service token) tampoco sale de
# esta máquina; .env.example sí se copia.
# (No poner comentarios entre las líneas del comando: cortan la continuación con "\".)
rsync -az --delete \
  --filter 'P /pnpm-lock.yaml' \
  --exclude 'node_modules/' \
  --exclude '.git/' \
  --include '/infra/minecraft/datapacks/*/data/' \
  --exclude 'data/' \
  --exclude 'dist/' \
  --exclude '.astro/' \
  --exclude '.env' \
  --include '.env.example' \
  --exclude '.env.*' \
  --exclude '*.log' \
  -e "$RSYNC_RSH" \
  "$REPO_ROOT/" "$TARGET:$REMOTE_PATH/"

echo "==> Preparando .env en el servidor (solo si no existe)"
"${SSH[@]}" "$TARGET" "cd '$REMOTE_PATH' && if [ ! -f .env ]; then cp .env.example .env && echo 'Se creó .env desde .env.example (LLM en modo mock). Edítalo en el servidor para poner claves.'; else echo '.env ya existe: no se modifica.'; fi"

if [ "${DEPLOY_TUNNEL:-0}" = "1" ]; then
  # Sin token, cloudflared se reinicia en bucle y el sitio (y el SSH por Cloudflare) se cae.
  if ! "${SSH[@]}" "$TARGET" "cd '$REMOTE_PATH' && grep -Eq '^TUNNEL_TOKEN=.*[A-Za-z0-9]' .env"; then
    echo "DEPLOY_TUNNEL=1 pero el .env del servidor no tiene TUNNEL_TOKEN (ver docs/CLOUDFLARE.md)." >&2
    exit 1
  fi
fi

echo "==> Construyendo y levantando: $COMPOSE up -d --build"
if [ "$CF_ACCESS" = "1" ]; then
  # Si `up` recrea cloudflared, la conexión SSH (que entra por el túnel) se corta. La salida
  # va primero a un archivo del servidor para que compose no muera al escribir en una
  # conexión cerrada y termine igual; se muestra al final.
  if ! "${SSH[@]}" "$TARGET" "cd '$REMOTE_PATH' && log=\$(mktemp) && { $COMPOSE up -d --build </dev/null >\"\$log\" 2>&1; s=\$?; cat \"\$log\"; rm -f \"\$log\"; exit \$s; }"; then
    echo "Falló '$COMPOSE up -d --build', o se cortó la conexión SSH (¿se recreó cloudflared?)." >&2
    echo "Si fue el corte, el despliegue sigue en el servidor: espera un minuto y vuelve a correr el script." >&2
    exit 1
  fi
else
  "${SSH[@]}" "$TARGET" "cd '$REMOTE_PATH' && $COMPOSE up -d --build"
fi

# "up" no recrea un contenedor cuando solo cambió un archivo de configuración montado,
# y rsync reemplaza el archivo (inodo nuevo), así que el montaje de mediamtx.yml sigue
# viendo la versión vieja hasta reiniciar. El video se corta unos segundos.
echo "==> Reiniciando mediamtx para que tome infra/mediamtx/mediamtx.yml"
"${SSH[@]}" "$TARGET" "cd '$REMOTE_PATH' && $COMPOSE restart mediamtx"
echo "    Nota: si cambiaste infra/minecraft/config/ (bukkit.yml) o infra/caddy/Caddyfile, aplica el cambio en el servidor con:"
echo "      docker compose restart minecraft    (o: docker compose restart web)"

echo "==> Estado de los contenedores"
"${SSH[@]}" "$TARGET" "cd '$REMOTE_PATH' && $COMPOSE ps"

if [ "${DEPLOY_SMOKE:-0}" = "1" ]; then
  echo "==> Verificación post-despliegue (scripts/smoke.sh)"
  "${SSH[@]}" "$TARGET" "cd '$REMOTE_PATH' && bash scripts/smoke.sh"
else
  echo
  echo "Listo. Para verificar toda la cadena, en el servidor:"
  echo "  cd $REMOTE_PATH && bash scripts/smoke.sh"
fi
