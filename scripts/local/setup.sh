#!/usr/bin/env bash
# Prepara esta máquina (macOS con Homebrew) para correr el stack SIN Docker.
# Es idempotente: se puede correr de nuevo después de un `git pull`.
#
#   bash scripts/local/setup.sh
#
# Instala lo que falte:
#   - Java 21 (openjdk@21)  servidor de Minecraft (Paper)
#   - mediamtx              RTMP -> HLS
#   - ffmpeg                codifica el video de la cámara
#   - cloudflared           túnel hacia Cloudflare (solo para el sitio desplegado)
#   - Node 22 (vía nvm)     ver scripts/local/env.sh
#   - dependencias de pnpm
# y crea `.env` desde `.env.example` si no existe.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/local/env.sh
source "$ROOT/scripts/local/env.sh"

step() { printf '\n==> %s\n' "$1"; }

# ---------- Homebrew ----------

if ! command -v brew >/dev/null 2>&1; then
  echo "Este script usa Homebrew (https://brew.sh). Instálalo o instala a mano: Java 21, mediamtx, ffmpeg, cloudflared." >&2
  exit 1
fi

step "Paquetes de Homebrew"
for formula in openjdk@21 mediamtx ffmpeg cloudflared; do
  if brew list --versions "$formula" >/dev/null 2>&1; then
    echo "ok       $formula"
  else
    echo "instalar $formula"
    brew install "$formula"
  fi
done

# ---------- Node 22 ----------

step "Node 22"
if ! phack_use_node22 2>/dev/null; then
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # nvm es una función de shell: hay que cargarla. No cambia la versión por defecto.
    # shellcheck disable=SC1091
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 22
  else
    brew install node@22
  fi
  phack_use_node22
fi
echo "ok       node $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Falta pnpm. Instálalo con: brew install pnpm (o corepack enable pnpm)" >&2
  exit 1
fi

# ---------- Dependencias ----------

step "pnpm install"
pnpm install

# ---------- .env ----------

step ".env"
if [ -f .env ]; then
  echo "ok       .env ya existe (no se toca)"
else
  cp .env.example .env
  echo "creado   .env desde .env.example (modo mock: sin claves de LLM)"
fi

cat <<'EOF'

Listo. Para levantar todo:

  pnpm local              # minecraft + mediamtx + orchestrator + camera + web
  pnpm local --tunnel     # lo mismo + el túnel de Cloudflare

Sitio local: http://localhost:4321
EOF
