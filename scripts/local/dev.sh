#!/usr/bin/env bash
# Levanta el stack completo en esta máquina, SIN Docker. Ver scripts/local/dev.mjs.
#
#   bash scripts/local/dev.sh                 # todo: minecraft, mediamtx, orchestrator, camera, web
#   bash scripts/local/dev.sh --tunnel        # + túnel de Cloudflare (para el sitio desplegado)
#   bash scripts/local/dev.sh --skip=camera   # todo menos la cámara
#   bash scripts/local/dev.sh minecraft       # solo los servicios nombrados

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/local/env.sh
source "$ROOT/scripts/local/env.sh"
phack_use_node22

cd "$ROOT"
exec node scripts/local/dev.mjs "$@"
