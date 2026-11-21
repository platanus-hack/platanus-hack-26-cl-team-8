#!/usr/bin/env bash
# Despliega origin/main en el servidor SOLO si cambió desde el último despliegue.
# Pensado para correrse en un loop (cada par de minutos) desde tu máquina:
#
#   bash scripts/deploy-main.sh            # despliega si origin/main tiene commits nuevos
#   bash scripts/deploy-main.sh --force    # despliega aunque no haya cambios
#
# Qué hace:
#   1. `git fetch` y compara origin/main con el commit anotado en el servidor (.deployed-sha).
#   2. Si son distintos, exporta ese commit exacto con `git archive` (NO tu carpeta de
#      trabajo: los cambios sin commitear no viajan) y lo copia con rsync.
#   3. En el servidor: `docker compose up -d --build`, y reinicia los servicios cuya
#      configuración montada cambió (mediamtx, web, minecraft) y la transmisión del host
#      (servicio phack-stream) si cambió infra/stream.
#   4. Anota el commit desplegado.
#
# En tu máquina solo corre git, rsync y ssh. Todo lo pesado ocurre en el servidor.
#
# Configuración: variables de entorno o un archivo `.env.deploy` en la raíz del repo
# (ignorado por git):
#   DEPLOY_HOST      host o IP del servidor (obligatorio)
#   DEPLOY_USER      usuario SSH
#   DEPLOY_PATH      carpeta en el servidor (por defecto: phack2026, relativa al home)
#   DEPLOY_PASSWORD  contraseña SSH (opcional; requiere `sshpass`). Sin ella se usa tu llave SSH.
#   DEPLOY_SUDO      1 = correr docker con sudo (usa DEPLOY_PASSWORD). Por defecto 0.
#   DEPLOY_BRANCH    rama a desplegar (por defecto: main)
#   DEPLOY_TUNNEL    1 = levantar también el perfil "tunnel" (cloudflared)
#
# Códigos de salida: 0 = sin cambios o desplegado; 2 = servidor inalcanzable; 1 = error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$REPO_ROOT/.env.deploy" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.deploy"
  set +a
fi

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

HOST="${DEPLOY_HOST:-}"
REMOTE_PATH="${DEPLOY_PATH:-phack2026}"
BRANCH="${DEPLOY_BRANCH:-main}"
USE_SUDO="${DEPLOY_SUDO:-0}"
PASSWORD="${DEPLOY_PASSWORD:-}"

if [ -z "$HOST" ]; then
  echo "ERROR: falta DEPLOY_HOST (defínelo en .env.deploy o en el entorno)." >&2
  exit 1
fi
case "$REMOTE_PATH" in
  *"'"*)
    echo "ERROR: DEPLOY_PATH no puede contener comillas simples." >&2
    exit 1
    ;;
esac
TARGET="$HOST"
[ -n "${DEPLOY_USER:-}" ] && TARGET="${DEPLOY_USER}@${HOST}"

for bin in git rsync ssh tar; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: falta '$bin' en esta máquina." >&2
    exit 1
  fi
done

SSH_OPTS=(-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20)
SSH=(ssh "${SSH_OPTS[@]}")
RSYNC_RSH="ssh ${SSH_OPTS[*]}"
if [ -n "$PASSWORD" ]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "ERROR: DEPLOY_PASSWORD está definido pero falta 'sshpass' en esta máquina." >&2
    exit 1
  fi
  export SSHPASS="$PASSWORD"
  SSH=(sshpass -e "${SSH[@]}")
  RSYNC_RSH="sshpass -e $RSYNC_RSH"
fi
if [ "$USE_SUDO" = "1" ] && [ -z "$PASSWORD" ]; then
  echo "ERROR: DEPLOY_SUDO=1 necesita DEPLOY_PASSWORD." >&2
  exit 1
fi

# remote CMD -> corre CMD en la carpeta del proyecto, como el usuario SSH.
remote() {
  "${SSH[@]}" "$TARGET" "cd '$REMOTE_PATH' && $1"
}

# remote_docker CMD -> igual, pero con permisos para usar docker (sudo si DEPLOY_SUDO=1).
remote_docker() {
  local cmd="cd '$REMOTE_PATH' && $1"
  if [ "$USE_SUDO" = "1" ]; then
    printf '%s\n' "$PASSWORD" | "${SSH[@]}" "$TARGET" "sudo -S -p '' sh -c $(printf '%q' "$cmd")"
  else
    "${SSH[@]}" "$TARGET" "$cmd"
  fi
}

# ---------- 1. ¿Hay algo nuevo? ----------

if ! git -C "$REPO_ROOT" fetch --quiet origin "$BRANCH"; then
  echo "ERROR: no se pudo hacer git fetch de origin/$BRANCH." >&2
  exit 1
fi
NEW_SHA="$(git -C "$REPO_ROOT" rev-parse "origin/$BRANCH")"
NEW_SHORT="${NEW_SHA:0:7}"

if ! OLD_SHA="$("${SSH[@]}" "$TARGET" "mkdir -p '$REMOTE_PATH' && cat '$REMOTE_PATH/.deployed-sha' 2>/dev/null || true" 2>/dev/null)"; then
  echo "SERVIDOR NO RESPONDE: no se pudo conectar a $TARGET (origin/$BRANCH está en $NEW_SHORT)."
  exit 2
fi
OLD_SHA="$(printf '%s' "$OLD_SHA" | tr -d '[:space:]')"

if [ "$OLD_SHA" = "$NEW_SHA" ] && [ "$FORCE" = "0" ]; then
  echo "SIN CAMBIOS: el servidor ya está en $NEW_SHORT."
  exit 0
fi

# ---------- 2. Copiar el commit exacto ----------

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
git -C "$REPO_ROOT" archive "$NEW_SHA" | tar -x -C "$TMP_DIR"

# Archivos que cambiaron desde el último despliegue (para saber qué reiniciar).
# Si no se conoce el commit anterior, se asume que cambió toda la configuración.
CHANGED="infra/mediamtx/ infra/caddy/ infra/minecraft/ infra/stream/"
if [ -n "$OLD_SHA" ] && git -C "$REPO_ROOT" cat-file -e "$OLD_SHA^{commit}" 2>/dev/null; then
  CHANGED="$(git -C "$REPO_ROOT" diff --name-only "$OLD_SHA" "$NEW_SHA")"
fi

# --delete borra en el servidor lo que ya no existe en el repo; lo excluido no se toca.
rsync -az --delete \
  --exclude '.env' \
  --exclude '.deployed-sha' \
  --exclude 'data/' \
  --exclude 'node_modules/' \
  -e "$RSYNC_RSH" \
  "$TMP_DIR/" "$TARGET:$REMOTE_PATH/"

remote "[ -f .env ] || cp .env.example .env"

# ---------- 3. Reconstruir y levantar ----------

COMPOSE="docker compose"
[ "${DEPLOY_TUNNEL:-0}" = "1" ] && COMPOSE="docker compose --profile tunnel"

BUILD_LOG="$TMP_DIR/build.log"
if ! remote_docker "$COMPOSE up -d --build" >"$BUILD_LOG" 2>&1; then
  echo "ERROR: falló '$COMPOSE up -d --build' al desplegar $NEW_SHORT. Últimas líneas:"
  tail -n 15 "$BUILD_LOG"
  exit 1
fi

# `up` no recrea un contenedor cuando solo cambió un archivo de configuración montado.
RESTART=""
case "$CHANGED" in *infra/mediamtx/*) RESTART="$RESTART mediamtx" ;; esac
case "$CHANGED" in *infra/caddy/*) RESTART="$RESTART web" ;; esac
case "$CHANGED" in *infra/minecraft/*) RESTART="$RESTART minecraft" ;; esac
if [ -n "$RESTART" ]; then
  remote_docker "$COMPOSE restart$RESTART" >>"$BUILD_LOG" 2>&1 || {
    echo "ERROR: se desplegó $NEW_SHORT pero falló el reinicio de:$RESTART"
    tail -n 8 "$BUILD_LOG"
    exit 1
  }
fi

# La transmisión (cliente real de Minecraft) corre en el host como servicio systemd, fuera
# de Docker: se reinicia si cambió su script. Si no está instalada, solo se avisa.
STREAM_NOTE=""
case "$CHANGED" in
  *infra/stream/*)
    if remote "test -f /etc/systemd/system/phack-stream.service"; then
      if remote_docker "systemctl restart phack-stream" >>"$BUILD_LOG" 2>&1; then
        STREAM_NOTE=" Transmisión reiniciada."
      else
        STREAM_NOTE=" AVISO: no se pudo reiniciar el servicio phack-stream (necesita sudo: DEPLOY_SUDO=1)."
      fi
    else
      STREAM_NOTE=" AVISO: falta instalar la transmisión en el servidor: sudo bash infra/stream/install.sh"
    fi
    ;;
esac

# ---------- 4. Anotar el commit desplegado ----------

remote "printf '%s\n' '$NEW_SHA' > .deployed-sha"

FROM="${OLD_SHA:0:7}"
echo "DESPLEGADO: ${FROM:-(primer despliegue)} -> $NEW_SHORT$([ -n "$RESTART" ] && echo " (reiniciados:$RESTART)")."
[ -n "$STREAM_NOTE" ] && echo "${STREAM_NOTE# }"
