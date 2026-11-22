#!/usr/bin/env bash
# Copia origin/main al repo público de la hackathon, para que tenga lo mismo que este.
#
#   bash scripts/mirror.sh
#
# Qué hace:
#   1. `git fetch` de origin/main (lo que está en GitHub, NO tu carpeta de trabajo).
#   2. Si el otro repo ya está en ese commit, no hace nada.
#   3. Si no, empuja ese commit a su rama main. Nunca fuerza: si alguien commiteó directo
#      en el otro repo, falla y avisa (hay que traer ese cambio a este repo primero).
#
# Solo viaja la rama main. Las ramas de trabajo se quedan en este repo, que es privado;
# el otro es público.
#
# Para mantenerlo al día sin acordarse, cualquiera de estas dos:
#   - DEPLOY_MIRROR=1 en .env.deploy: scripts/deploy-main.sh lo corre en cada vuelta.
#   - Un loop aparte:  while true; do bash scripts/mirror.sh; sleep 120; done
#
# Configuración (variables de entorno, opcionales):
#   MIRROR_URL     repo de destino (por defecto, el del equipo en la organización de la hackathon)
#   MIRROR_BRANCH  rama a copiar (por defecto: main)
#
# Códigos de salida: 0 = al día o copiado; 1 = error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIRROR_URL="${MIRROR_URL:-git@github.com:platanus-hack/platanus-hack-26-cl-team-8.git}"
BRANCH="${MIRROR_BRANCH:-main}"

if ! git -C "$REPO_ROOT" fetch --quiet origin "$BRANCH"; then
  echo "ERROR: no se pudo hacer git fetch de origin/$BRANCH." >&2
  exit 1
fi
LOCAL_SHA="$(git -C "$REPO_ROOT" rev-parse "origin/$BRANCH")"

if ! REMOTE_LINE="$(git ls-remote "$MIRROR_URL" "refs/heads/$BRANCH")"; then
  echo "ERROR: no se pudo leer $MIRROR_URL (¿tienes acceso por SSH a ese repo?)." >&2
  exit 1
fi
REMOTE_SHA="${REMOTE_LINE%%[[:space:]]*}"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "ESPEJO AL DÍA: $MIRROR_URL ya está en ${LOCAL_SHA:0:7}."
  exit 0
fi

if ! git -C "$REPO_ROOT" push --quiet "$MIRROR_URL" "refs/remotes/origin/$BRANCH:refs/heads/$BRANCH"; then
  echo "ERROR: no se pudo copiar ${LOCAL_SHA:0:7} a $MIRROR_URL." >&2
  echo "Si el otro repo tiene commits que este no tiene, tráelos primero a origin/$BRANCH (con un PR)" >&2
  echo "y vuelve a correr este script. No se fuerza el push a propósito." >&2
  exit 1
fi
echo "ESPEJO COPIADO: $MIRROR_URL pasó de ${REMOTE_SHA:0:7} a ${LOCAL_SHA:0:7}."
