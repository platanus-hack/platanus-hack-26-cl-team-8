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
#   DEPLOY_TUNNEL  1 = levantar también el perfil "tunnel" (cloudflared)
#   DEPLOY_SMOKE   1 = correr scripts/smoke.sh en el servidor al terminar
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

COMPOSE="docker compose"
if [ "${DEPLOY_TUNNEL:-0}" = "1" ]; then
  COMPOSE="docker compose --profile tunnel"
fi

echo "==> Destino: ${TARGET}:${REMOTE_PATH} (puerto SSH ${SSH_PORT})"

echo "==> Creando la carpeta remota"
ssh -p "$SSH_PORT" "$TARGET" "mkdir -p '$REMOTE_PATH'"

echo "==> Sincronizando archivos"
# --delete borra en el servidor lo que ya no existe en el repo. Lo excluido
# (.env, data, node_modules) NO se toca en el destino.
# La regla "P" protege el pnpm-lock.yaml generado en el servidor: --delete no lo borra
# mientras no exista en el repo local (si existe localmente, se copia normalmente).
rsync -az --delete \
  --filter 'P /pnpm-lock.yaml' \
  --exclude 'node_modules/' \
  --exclude '.git/' \
  # Las estructuras de los datapacks viven en un "data/" que SÍ va al servidor; rsync usa
  # la primera regla que calza, así que esta inclusión debe ir antes de excluir data/.
  --include '/infra/minecraft/datapacks/*/data/' \
  --exclude 'data/' \
  --exclude 'dist/' \
  --exclude '.astro/' \
  --exclude '.env' \
  --exclude '*.log' \
  -e "ssh -p $SSH_PORT" \
  "$REPO_ROOT/" "$TARGET:$REMOTE_PATH/"

echo "==> Preparando .env en el servidor (solo si no existe)"
ssh -p "$SSH_PORT" "$TARGET" "cd '$REMOTE_PATH' && if [ ! -f .env ]; then cp .env.example .env && echo 'Se creó .env desde .env.example (LLM en modo mock). Edítalo en el servidor para poner claves.'; else echo '.env ya existe: no se modifica.'; fi"

echo "==> Construyendo y levantando: $COMPOSE up -d --build"
ssh -p "$SSH_PORT" "$TARGET" "cd '$REMOTE_PATH' && $COMPOSE up -d --build"

# "up" no recrea un contenedor cuando solo cambió un archivo de configuración montado,
# y rsync reemplaza el archivo (inodo nuevo), así que el montaje de mediamtx.yml sigue
# viendo la versión vieja hasta reiniciar. El video se corta unos segundos.
echo "==> Reiniciando mediamtx para que tome infra/mediamtx/mediamtx.yml"
ssh -p "$SSH_PORT" "$TARGET" "cd '$REMOTE_PATH' && $COMPOSE restart mediamtx"
echo "    Nota: si cambiaste infra/minecraft/config/ (bukkit.yml) o infra/caddy/Caddyfile, aplica el cambio en el servidor con:"
echo "      docker compose restart minecraft    (o: docker compose restart web)"

echo "==> Estado de los contenedores"
ssh -p "$SSH_PORT" "$TARGET" "cd '$REMOTE_PATH' && $COMPOSE ps"

if [ "${DEPLOY_SMOKE:-0}" = "1" ]; then
  echo "==> Verificación post-despliegue (scripts/smoke.sh)"
  ssh -p "$SSH_PORT" "$TARGET" "cd '$REMOTE_PATH' && bash scripts/smoke.sh"
else
  echo
  echo "Listo. Para verificar toda la cadena, en el servidor:"
  echo "  cd $REMOTE_PATH && bash scripts/smoke.sh"
fi
