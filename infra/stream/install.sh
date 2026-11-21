#!/usr/bin/env bash
# Instala la transmisión con el cliente real de Minecraft como servicio del sistema.
# Se corre UNA vez en el servidor, con sudo, desde la carpeta del proyecto:
#
#   sudo bash infra/stream/install.sh            # instala y arranca el servicio phack-stream
#   sudo bash infra/stream/install.sh --no-start # instala sin arrancarlo
#
# Qué hace:
#   1. Instala Xvfb, VirtualGL, xdotool y ffmpeg (Fedora: dnf).
#   2. Crea STREAM_HOME (por defecto ~/.local/share/phack-stream del usuario dueño del repo),
#      instala ahí el lanzador portablemc y descarga el cliente de Minecraft desde Mojang.
#   3. Crea y habilita el servicio systemd `phack-stream`, que corre infra/stream/stream.sh.
#
# Requisitos: GPU NVIDIA con su driver (para render y codificación), y una licencia de
# Minecraft Java de quien opera el servidor. El servidor de la arena corre en modo offline,
# por eso el cliente entra sin iniciar sesión.
#
# Después:  systemctl status phack-stream   |   journalctl -u phack-stream -f

set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "ERROR: corre este script con sudo." >&2
  exit 1
fi

START=1
[ "${1:-}" = "--no-start" ] && START=0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_USER="${STREAM_USER:-$(stat -c '%U' "$REPO_ROOT")}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
if [ -z "$RUN_HOME" ] || [ "$RUN_USER" = "root" ]; then
  echo "ERROR: no se pudo determinar el usuario dueño de $REPO_ROOT (define STREAM_USER)." >&2
  exit 1
fi
STREAM_HOME="${STREAM_HOME:-$RUN_HOME/.local/share/phack-stream}"
MC_VERSION="${MC_VERSION:-$(grep -E '^MC_VERSION=' "$REPO_ROOT/.env" 2>/dev/null | tail -n 1 | cut -d= -f2-)}"
MC_VERSION="${MC_VERSION:-1.20.4}"
PORTABLEMC_VERSION="5.0.6"

echo "==> Usuario: $RUN_USER   Carpeta del juego: $STREAM_HOME   Minecraft: $MC_VERSION"

echo "==> 1/3 Paquetes del sistema"
missing=()
for pkg in xorg-x11-server-Xvfb VirtualGL xdotool; do
  rpm -q "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
command -v ffmpeg >/dev/null 2>&1 || missing+=("ffmpeg-free")
command -v python3 >/dev/null 2>&1 || missing+=("python3")
if [ "${#missing[@]}" -gt 0 ]; then
  if ! command -v dnf >/dev/null 2>&1; then
    echo "ERROR: faltan ${missing[*]} y este sistema no usa dnf; instálalos a mano." >&2
    exit 1
  fi
  dnf install -y "${missing[@]}"
else
  echo "    ya estaban instalados."
fi

echo "==> 2/3 Lanzador y cliente de Minecraft (la primera vez descarga ~850 MB)"
as_user() { runuser -u "$RUN_USER" -- "$@"; }
as_user mkdir -p "$STREAM_HOME/game" "$STREAM_HOME/main"
if [ ! -x "$STREAM_HOME/venv/bin/portablemc" ]; then
  as_user python3 -m venv "$STREAM_HOME/venv"
  as_user "$STREAM_HOME/venv/bin/pip" install --quiet "portablemc==$PORTABLEMC_VERSION"
fi
# --dry: deja el juego instalado (jar, librerías, assets y el Java de Mojang) sin abrirlo.
as_user "$STREAM_HOME/venv/bin/portablemc" --main-dir "$STREAM_HOME/main" --output machine \
  start --mc-dir "$STREAM_HOME/game" --jvm-policy mojang --dry "$MC_VERSION" >/dev/null
echo "    cliente $MC_VERSION listo."

echo "==> 3/3 Servicio systemd phack-stream"
# ExecStart pasa por /usr/bin/bash: con SELinux, systemd no puede ejecutar directo un
# script que vive en /home.
cat >/etc/systemd/system/phack-stream.service <<UNIT
[Unit]
Description=Prompt Arena: transmision con el cliente real de Minecraft
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$REPO_ROOT
Environment=HOME=$RUN_HOME
Environment=STREAM_HOME=$STREAM_HOME
ExecStart=/usr/bin/bash $REPO_ROOT/infra/stream/stream.sh
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
if [ "$START" = "1" ]; then
  systemctl enable phack-stream >/dev/null 2>&1
  systemctl restart phack-stream
  echo "    servicio arrancado. Logs: journalctl -u phack-stream -f"
else
  systemctl enable phack-stream >/dev/null 2>&1
  echo "    servicio instalado (sin arrancar). Arráncalo con: systemctl start phack-stream"
fi
