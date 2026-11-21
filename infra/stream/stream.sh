#!/usr/bin/env bash
# Transmisión oficial de la arena: el cliente REAL de Minecraft, capturado en el servidor.
#
#   Xvfb (pantalla virtual) -> cliente de Minecraft renderizado por la GPU (VirtualGL)
#   -> ffmpeg captura la pantalla (x11grab) y codifica H.264 -> RTMP -> MediaMTX -> web.
#
# El cliente entra al servidor como espectador con el usuario STREAM_CLIENT_USERNAME. El
# contenedor `camera` (CAMERA_MODE=client) lo monta en el bot cámara y mueve ese bot: lo que
# se ve en el video es lo que "ve" el bot.
#
# Corre en el HOST (no en Docker), como servicio systemd `phack-stream`; lo instala
# infra/stream/install.sh. A mano:  bash infra/stream/stream.sh
#
# Configuración: variables de entorno, o el `.env` de la raíz del repo (solo se leen las
# claves de la lista de abajo). Todas tienen valor por defecto.
#   STREAM_HOME             carpeta con el juego y el lanzador (~/.local/share/phack-stream)
#   STREAM_CLIENT_USERNAME  usuario del cliente (Camarografo)
#   STREAM_FOV              campo de visión vertical en grados, 30 a 110 (40)
#   STREAM_DISPLAY          pantalla virtual (:99)
#   STREAM_ENCODER          h264_nvenc (GPU NVIDIA) | libopenh264 | libx264 (h264_nvenc)
#   STREAM_HUD              1 = deja visibles los títulos del juego (cuenta regresiva,
#                           ganador); 0 = oculta toda la interfaz. El chat nunca se muestra. (1)
#   STREAM_GPU              1 = renderiza con la GPU vía VirtualGL; 0 = por software (1)
#   STREAM_MC_HOST/PORT     servidor de Minecraft visto desde el host (127.0.0.1:25565)
#   STREAM_RTMP_URL         destino RTMP visto desde el host (rtmp://127.0.0.1:1935/live/arena)
#   MC_VERSION, CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS, CAMERA_BITRATE_KBPS

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Lee del .env solo las claves que usa este script (sin pisar las que ya vengan del entorno).
read_env_file() {
  local file="$1" key value
  [ -f "$file" ] || return 0
  for key in STREAM_HOME STREAM_CLIENT_USERNAME STREAM_FOV STREAM_DISPLAY STREAM_ENCODER STREAM_HUD \
    STREAM_GPU STREAM_MC_HOST STREAM_MC_PORT STREAM_RTMP_URL MC_VERSION CAMERA_WIDTH CAMERA_HEIGHT \
    CAMERA_FPS CAMERA_BITRATE_KBPS; do
    [ -n "${!key:-}" ] && continue
    value="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
    [ -n "$value" ] && export "$key=$value"
  done
  return 0
}
read_env_file "$REPO_ROOT/.env"

STREAM_HOME="${STREAM_HOME:-$HOME/.local/share/phack-stream}"
USERNAME="${STREAM_CLIENT_USERNAME:-Camarografo}"
FOV="${STREAM_FOV:-40}"
DISPLAY_ID="${STREAM_DISPLAY:-:99}"
ENCODER="${STREAM_ENCODER:-h264_nvenc}"
SHOW_HUD="${STREAM_HUD:-1}"
USE_GPU="${STREAM_GPU:-1}"
MC_HOST="${STREAM_MC_HOST:-127.0.0.1}"
MC_PORT="${STREAM_MC_PORT:-25565}"
RTMP_URL="${STREAM_RTMP_URL:-rtmp://127.0.0.1:1935/live/arena}"
VERSION="${MC_VERSION:-1.20.4}"
WIDTH="${CAMERA_WIDTH:-1280}"
HEIGHT="${CAMERA_HEIGHT:-720}"
FPS="${CAMERA_FPS:-30}"
BITRATE="${CAMERA_BITRATE_KBPS:-4500}"

PMC="$STREAM_HOME/venv/bin/portablemc"
GAME_DIR="$STREAM_HOME/game"
MAIN_DIR="$STREAM_HOME/main"
CLIENT_LOG="$STREAM_HOME/client.log"
# Si el cliente lleva este tiempo abierto sin haber entrado al mundo, se reinicia.
JOIN_TIMEOUT_SECONDS=150
RESTART_DELAY_SECONDS=5

say() { printf '%s [stream] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

for bin in Xvfb xdotool ffmpeg; do
  command -v "$bin" >/dev/null 2>&1 || { say "ERROR: falta '$bin'. Corre infra/stream/install.sh."; exit 1; }
done
[ -x "$PMC" ] || { say "ERROR: falta el lanzador en $PMC. Corre infra/stream/install.sh."; exit 1; }
if [ "$USE_GPU" = "1" ] && ! command -v vglrun >/dev/null 2>&1; then
  say "ERROR: STREAM_GPU=1 pero falta 'vglrun' (VirtualGL). Corre infra/stream/install.sh."
  exit 1
fi

XVFB_PID=""
CLIENT_PID=""
FFMPEG_PID=""

stop_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  # El cliente es un árbol (lanzador -> java): se termina el grupo completo.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
}

cleanup() {
  local code="$1"
  trap - EXIT INT TERM
  say "Cerrando la transmisión."
  stop_pid "$FFMPEG_PID"
  stop_pid "$CLIENT_PID"
  stop_pid "$XVFB_PID"
  exit "$code"
}
trap 'cleanup $?' EXIT
trap 'cleanup 0' INT TERM

# setsid: cada pieza en su propio grupo de procesos, para poder terminarla entera.
start_xvfb() {
  local lock="/tmp/.X${DISPLAY_ID#:}-lock"
  if [ -f "$lock" ] && ! kill -0 "$(tr -d ' ' <"$lock" 2>/dev/null)" 2>/dev/null; then
    rm -f "$lock" "/tmp/.X11-unix/X${DISPLAY_ID#:}"
  fi
  setsid Xvfb "$DISPLAY_ID" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp >"$STREAM_HOME/xvfb.log" 2>&1 &
  XVFB_PID=$!
  for _ in $(seq 1 50); do
    [ -S "/tmp/.X11-unix/X${DISPLAY_ID#:}" ] && return 0
    kill -0 "$XVFB_PID" 2>/dev/null || break
    sleep 0.2
  done
  say "ERROR: Xvfb no partió en $DISPLAY_ID. Revisa $STREAM_HOME/xvfb.log"
  return 1
}

# options.txt se reescribe en cada arranque: es la configuración de la "cámara".
write_options() {
  mkdir -p "$GAME_DIR"
  # Minecraft guarda el FOV normalizado: 0.0 = 70°, -1.0 = 30°, 1.0 = 110°.
  local fov
  fov="$(awk -v f="$FOV" 'BEGIN { v = (f - 70) / 40; if (v < -1) v = -1; if (v > 1) v = 1; printf "%.4f", v }')"
  cat >"$GAME_DIR/options.txt" <<OPTIONS
pauseOnLostFocus:false
fov:$fov
fovEffectScale:0.0
renderDistance:8
simulationDistance:5
entityDistanceScaling:1.0
guiScale:2
maxFps:$((FPS * 2))
enableVsync:false
fullscreen:false
graphicsMode:1
particles:0
ao:true
bobView:false
skipMultiplayerWarning:true
joinedFirstServer:true
onboardAccessibility:false
tutorialStep:none
narrator:0
soundCategory_master:0.0
chatVisibility:2
OPTIONS
}

start_client() {
  : >"$CLIENT_LOG"
  local -a cmd=("$PMC" --main-dir "$MAIN_DIR" --output machine start
    --mc-dir "$GAME_DIR" --jvm-policy mojang
    --resolution "${WIDTH}x${HEIGHT}"
    --join-server "$MC_HOST" --join-server-port "$MC_PORT"
    -u "$USERNAME" "$VERSION")
  if [ "$USE_GPU" = "1" ]; then
    # VirtualGL manda el render a la GPU y copia el resultado a la pantalla virtual.
    # VGL_EGLLIB / VGL_GLLIB: sin ellas el VirtualGL de Fedora no encuentra las librerías
    # cuando el programa (java) las carga a mano.
    DISPLAY="$DISPLAY_ID" VGL_EGLLIB="${VGL_EGLLIB:-/usr/lib64/libEGL.so.1}" VGL_GLLIB="${VGL_GLLIB:-/usr/lib64/libGL.so.1}" \
      setsid vglrun -d egl "${cmd[@]}" >"$CLIENT_LOG" 2>&1 &
  else
    DISPLAY="$DISPLAY_ID" setsid "${cmd[@]}" >"$CLIENT_LOG" 2>&1 &
  fi
  CLIENT_PID=$!
}

client_joined() { grep -q "joined the game\|Loaded [0-9]* advancements" "$CLIENT_LOG" 2>/dev/null; }

# El cliente no se cierra cuando lo desconectan: se queda en una pantalla de error.
client_disconnected() {
  grep -q "Client disconnected with reason\|Couldn't connect to server\|Connection refused\|Disconnected from server\|Failed to connect to the server" \
    "$CLIENT_LOG" 2>/dev/null
}

hide_hud() {
  local window
  window="$(DISPLAY="$DISPLAY_ID" xdotool search --name "Minecraft" 2>/dev/null | head -n 1)"
  [ -n "$window" ] || return 1
  DISPLAY="$DISPLAY_ID" xdotool windowfocus "$window" >/dev/null 2>&1
  sleep 0.5
  DISPLAY="$DISPLAY_ID" xdotool key F1 >/dev/null 2>&1
}

start_ffmpeg() {
  local gop="$FPS"
  local -a video
  case "$ENCODER" in
    h264_nvenc)
      video=(-c:v h264_nvenc -preset p4 -tune ll -rc cbr -bf 0 -strict_gop 1 -no-scenecut 1) ;;
    libx264)
      video=(-c:v libx264 -preset veryfast -tune zerolatency -sc_threshold 0) ;;
    *)
      video=(-c:v "$ENCODER") ;;
  esac
  # Un keyframe por segundo: MediaMTX corta segmentos HLS de 1 s.
  setsid ffmpeg -hide_banner -loglevel warning -nostats \
    -f x11grab -draw_mouse 0 -framerate "$FPS" -video_size "${WIDTH}x${HEIGHT}" -i "$DISPLAY_ID" \
    "${video[@]}" -pix_fmt yuv420p -g "$gop" -keyint_min "$gop" \
    -b:v "${BITRATE}k" -maxrate "${BITRATE}k" -bufsize "$((BITRATE * 2))k" \
    -an -f flv "$RTMP_URL" >"$STREAM_HOME/ffmpeg.log" 2>&1 &
  FFMPEG_PID=$!
}

mkdir -p "$STREAM_HOME"
say "Transmisión: Minecraft $VERSION como $USERNAME -> $RTMP_URL (${WIDTH}x${HEIGHT} a $FPS fps, $ENCODER, FOV $FOV°)."
start_xvfb || exit 1

while true; do
  write_options
  say "Abriendo el cliente de Minecraft..."
  start_client
  started_at=$SECONDS
  joined=0
  hud_done=0
  reason=""

  while true; do
    sleep 2
    if ! kill -0 "$XVFB_PID" 2>/dev/null; then
      say "ERROR: se cayó la pantalla virtual (Xvfb)."
      exit 1
    fi
    if ! kill -0 "$CLIENT_PID" 2>/dev/null; then
      reason="el cliente se cerró"
      break
    fi
    if client_disconnected; then
      reason="el servidor desconectó al cliente"
      break
    fi
    if [ "$joined" = "0" ]; then
      if client_joined; then
        joined=1
        say "El cliente entró al servidor."
        # Deja que cargue el mundo antes de empezar a transmitir.
        sleep 3
        if [ "$SHOW_HUD" != "1" ] && [ "$hud_done" = "0" ]; then
          hide_hud && hud_done=1
        fi
        start_ffmpeg
        say "ffmpeg publicando en $RTMP_URL."
      elif [ $((SECONDS - started_at)) -ge "$JOIN_TIMEOUT_SECONDS" ]; then
        reason="el cliente no entró al servidor en $JOIN_TIMEOUT_SECONDS s"
        break
      fi
    elif ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
      say "ffmpeg se cerró ($(tail -n 1 "$STREAM_HOME/ffmpeg.log" 2>/dev/null)); se relanza."
      sleep "$RESTART_DELAY_SECONDS"
      start_ffmpeg
    fi
  done

  say "Reiniciando la transmisión: $reason. Últimas líneas del cliente:"
  grep -v "^download\|^install" "$CLIENT_LOG" 2>/dev/null | tail -n 3 | cut -c1-300
  stop_pid "$FFMPEG_PID"
  FFMPEG_PID=""
  stop_pid "$CLIENT_PID"
  CLIENT_PID=""
  sleep "$RESTART_DELAY_SECONDS"
done
