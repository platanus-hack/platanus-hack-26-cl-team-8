#!/usr/bin/env bash
# Verificación post-despliegue. Se corre EN EL SERVIDOR, desde la carpeta del repo,
# con el stack ya levantado (docker compose up -d --build).
#
# Revisa cada eslabón de la cadena e imprime una línea PASS/FAIL por cada uno:
#   contenedores -> RCON -> /api/health -> /api/state -> websocket -> HLS -> pelea completa
#
# Uso:
#   bash scripts/smoke.sh
#
# Variables opcionales:
#   BASE_URL            URL del sitio (por defecto http://127.0.0.1:$WEB_PORT, WEB_PORT leído de .env o 8080)
#   SMOKE_SKIP_MATCH    1 = no correr la pelea de prueba
#   SMOKE_FORCE_MOCK    1 = antes de la pelea, PISA los prompts de ambos lados con uno de
#                       prueba y proveedor "mock" (ojo: es la sala pública, todos lo ven)
#   SMOKE_MATCH_TIMEOUT segundos máximos de espera de la pelea
#                       (por defecto MATCH_DURATION_SECONDS del orquestador + 120)
#   SMOKE_HLS_TIMEOUT   segundos máximos de espera del video (por defecto 90)
#
# Dependencias: bash, curl, docker (compose v2) y utilidades básicas (grep, cut, head).
# Sale con código 0 solo si no hubo ningún FAIL.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

for bin in curl docker; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Falta '$bin' en este servidor." >&2
    exit 2
  fi
done

WEB_PORT_VALUE="${WEB_PORT:-}"
if [ -z "$WEB_PORT_VALUE" ] && [ -f .env ]; then
  WEB_PORT_VALUE="$(grep -E '^WEB_PORT=' .env | tail -n 1 | cut -d= -f2 || true)"
fi
WEB_PORT_VALUE="${WEB_PORT_VALUE:-8080}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${WEB_PORT_VALUE}}"
BASE_URL="${BASE_URL%/}"

HLS_TIMEOUT="${SMOKE_HLS_TIMEOUT:-90}"

PASSES=0
FAILS=0
WARNS=0

pass() {
  PASSES=$((PASSES + 1))
  echo "PASS  $1"
}

fail() {
  FAILS=$((FAILS + 1))
  echo "FAIL  $1"
}

warn() {
  WARNS=$((WARNS + 1))
  echo "WARN  $1"
}

info() {
  echo "      $1"
}

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

# http_get URL [max_segundos] -> imprime el código HTTP; deja el cuerpo en $BODY_FILE.
http_get() {
  : >"$BODY_FILE"
  # -L: MediaMTX responde el playlist HLS con un 302 a "?cookieCheck=1" antes del 200.
  curl -s -L -o "$BODY_FILE" -w '%{http_code}' --max-time "${2:-10}" "$1" 2>/dev/null || true
}

# http_send METODO URL [json] -> imprime el código HTTP; deja el cuerpo en $BODY_FILE.
http_send() {
  : >"$BODY_FILE"
  if [ -n "${3:-}" ]; then
    curl -s -o "$BODY_FILE" -w '%{http_code}' --max-time 30 -X "$1" \
      -H 'Content-Type: application/json' --data "$3" "$2" 2>/dev/null || true
  else
    curl -s -o "$BODY_FILE" -w '%{http_code}' --max-time 30 -X "$1" "$2" 2>/dev/null || true
  fi
}

# Extrae el primer valor string de una clave JSON del cuerpo guardado (sin jq).
json_string() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$BODY_FILE" | head -n 1 | cut -d'"' -f4 || true
}

body_snippet() {
  head -c 300 "$BODY_FILE" | tr '\n' ' ' || true
}

echo "Arena de prompts — verificación en ${BASE_URL}"
echo

# ---------------------------------------------------------------------------
echo "[1/7] Contenedores"
# servicio:tiene_healthcheck
for entry in minecraft:yes mediamtx:no orchestrator:yes camera:no web:yes; do
  svc="${entry%%:*}"
  has_health="${entry##*:}"
  cid="$(docker compose ps -q "$svc" 2>/dev/null | head -n 1 || true)"
  if [ -z "$cid" ]; then
    fail "contenedor $svc: no existe (¿corriste docker compose up -d --build?)"
    continue
  fi
  status="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo desconocido)"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo none)"
  if [ "$status" != "running" ]; then
    fail "contenedor $svc: estado '$status' (ver: docker compose logs --tail 50 $svc)"
  elif [ "$has_health" = "yes" ] && [ "$health" != "healthy" ]; then
    fail "contenedor $svc: corriendo pero health='$health' (ver: docker compose logs --tail 50 $svc)"
  else
    pass "contenedor $svc: running (health=$health)"
  fi
done

# ---------------------------------------------------------------------------
echo "[2/7] RCON de Minecraft"
# rcon-cli viene en la imagen de itzg y usa la contraseña del propio contenedor.
rcon_out="$(docker compose exec -T minecraft rcon-cli list 2>&1 || true)"
if echo "$rcon_out" | grep -qi "players online"; then
  pass "RCON responde: $(echo "$rcon_out" | head -n 1)"
else
  fail "RCON no responde: $(echo "$rcon_out" | head -n 1)"
fi

# ---------------------------------------------------------------------------
echo "[3/7] API: /api/health"
code="$(http_get "$BASE_URL/api/health")"
if [ "$code" = "200" ] && grep -q '"ok"' "$BODY_FILE"; then
  pass "/api/health -> 200 $(body_snippet)"
else
  fail "/api/health -> HTTP $code $(body_snippet)"
fi

# ---------------------------------------------------------------------------
echo "[4/7] API: /api/state"
code="$(http_get "$BASE_URL/api/state")"
phase="$(json_string phase)"
if [ "$code" = "200" ] && [ -n "$phase" ]; then
  pass "/api/state -> 200 (phase=$phase)"
else
  fail "/api/state -> HTTP $code, sin campo phase: $(body_snippet)"
fi

# ---------------------------------------------------------------------------
echo "[5/7] Websocket: /api/ws"
# Un 101 es suficiente: después curl se queda esperando y lo corta --max-time.
ws_code="$(curl -s -o /dev/null -w '%{http_code}' --http1.1 --max-time 4 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$BASE_URL/api/ws" 2>/dev/null || true)"
if [ "$ws_code" = "101" ]; then
  pass "/api/ws -> 101 Switching Protocols"
else
  fail "/api/ws -> HTTP $ws_code (se esperaba 101)"
fi

# ---------------------------------------------------------------------------
echo "[6/7] Video HLS: /live/arena/index.m3u8"
hls_url="$BASE_URL/live/arena/index.m3u8"
hls_ok=0
hls_code="000"
waited=0
while [ "$waited" -le "$HLS_TIMEOUT" ]; do
  hls_code="$(http_get "$hls_url" 8)"
  if [ "$hls_code" = "200" ] && grep -q '#EXTM3U' "$BODY_FILE"; then
    hls_ok=1
    break
  fi
  sleep 3
  waited=$((waited + 3))
done

if [ "$hls_ok" = "1" ]; then
  pass "playlist principal -> 200 (tras ${waited}s)"
  if grep -q '#EXTINF' "$BODY_FILE"; then
    pass "el playlist principal ya contiene segmentos"
  else
    # Playlist multivariante: el primer URI que no es comentario apunta al playlist de medios.
    variant="$(grep -v '^#' "$BODY_FILE" | tr -d '\r' | grep -E '\.m3u8' | head -n 1 || true)"
    if [ -z "$variant" ]; then
      fail "el playlist principal no tiene segmentos ni variantes: $(body_snippet)"
    else
      case "$variant" in
        http://* | https://*) variant_url="$variant" ;;
        /*) variant_url="$BASE_URL$variant" ;;
        *) variant_url="$BASE_URL/live/arena/$variant" ;;
      esac
      seg_ok=0
      vcode="000"
      waited=0
      while [ "$waited" -le 30 ]; do
        vcode="$(http_get "$variant_url" 8)"
        if [ "$vcode" = "200" ] && grep -q '#EXTINF' "$BODY_FILE"; then
          seg_ok=1
          break
        fi
        sleep 3
        waited=$((waited + 3))
      done
      if [ "$seg_ok" = "1" ]; then
        segs="$(grep -c '#EXTINF' "$BODY_FILE" || true)"
        pass "playlist de medios ($variant) -> 200 con $segs segmentos"
      else
        fail "playlist de medios ($variant) -> HTTP $vcode sin segmentos"
      fi
    fi
  fi
else
  fail "playlist principal -> HTTP $hls_code tras ${HLS_TIMEOUT}s (¿la cámara está publicando? docker compose logs --tail 50 camera mediamtx)"
fi

# ---------------------------------------------------------------------------
echo "[7/7] Pelea completa"
if [ "${SMOKE_SKIP_MATCH:-0}" = "1" ]; then
  info "omitida (SMOKE_SKIP_MATCH=1)"
else
  provider="$(docker compose exec -T orchestrator printenv LLM_PROVIDER 2>/dev/null | tr -d '\r\n' || true)"
  duration="$(docker compose exec -T orchestrator printenv MATCH_DURATION_SECONDS 2>/dev/null | tr -d '\r\n' || true)"
  case "$duration" in
    '' | *[!0-9]*) duration=180 ;;
  esac
  MATCH_TIMEOUT="${SMOKE_MATCH_TIMEOUT:-$((duration + 120))}"

  if [ "$provider" = "mock" ]; then
    info "LLM_PROVIDER=mock: la pelea no consume ninguna API"
  else
    warn "LLM_PROVIDER='${provider:-desconocido}': esta pelea de prueba SÍ puede llamar a un LLM real (usa SMOKE_FORCE_MOCK=1 o SMOKE_SKIP_MATCH=1 para evitarlo)"
  fi

  code="$(http_get "$BASE_URL/api/state")"
  phase="$(json_string phase)"
  if [ "$phase" = "preparing" ] || [ "$phase" = "running" ]; then
    fail "ya hay una pelea en curso (phase=$phase): espera a que termine o detenla con POST /api/match/stop, y vuelve a correr este script"
  else
    if [ "${SMOKE_FORCE_MOCK:-0}" = "1" ]; then
      for side in red blue; do
        code="$(http_send PUT "$BASE_URL/api/prompts/$side" '{"prompt":"Prueba de humo: acércate al rival y atácalo.","provider":"mock"}')"
        if [ "$code" = "200" ]; then
          pass "prompt de $side fijado a proveedor mock"
        else
          fail "PUT /api/prompts/$side -> HTTP $code $(body_snippet)"
        fi
      done
    fi

    code="$(http_send POST "$BASE_URL/api/match/start")"
    match_id="$(json_string id)"
    case "$code" in
      2??)
        if [ -n "$match_id" ]; then
          pass "POST /api/match/start -> $code (id=$match_id)"
        else
          fail "POST /api/match/start -> $code pero la respuesta no trae id: $(body_snippet)"
        fi
        ;;
      *)
        fail "POST /api/match/start -> HTTP $code $(body_snippet)"
        match_id=""
        ;;
    esac

    if [ -n "$match_id" ]; then
      info "esperando el fin de la pelea (máx. ${MATCH_TIMEOUT}s; la pelea dura hasta ${duration}s)"
      saw_running=0
      saw_finished=0
      in_history=0
      last_phase=""
      waited=0
      while [ "$waited" -le "$MATCH_TIMEOUT" ]; do
        code="$(http_get "$BASE_URL/api/state")"
        phase="$(json_string phase)"
        state_id="$(json_string id)"
        if [ -n "$phase" ] && [ "$phase" != "$last_phase" ]; then
          info "t=${waited}s phase=$phase"
          last_phase="$phase"
        fi
        if [ "$state_id" = "$match_id" ]; then
          if [ "$phase" = "running" ]; then
            saw_running=1
          fi
          if [ "$phase" = "finished" ]; then
            saw_finished=1
          fi
        fi
        code="$(http_get "$BASE_URL/api/matches")"
        if [ "$code" = "200" ] && grep -q "\"$match_id\"" "$BODY_FILE"; then
          in_history=1
        fi
        if [ "$saw_finished" = "1" ] && [ "$in_history" = "1" ]; then
          break
        fi
        # Si ya está en el historial pero el estado pasó de largo (p. ej. volvió a idle), no seguir esperando.
        if [ "$in_history" = "1" ] && [ "$phase" != "running" ] && [ "$phase" != "preparing" ]; then
          break
        fi
        # Terminó sin llegar a 'running' (falló al prepararse): esas peleas no se guardan
        # en el historial, así que no tiene sentido seguir esperando.
        if [ "$saw_finished" = "1" ] && [ "$saw_running" = "0" ] && [ "$phase" = "idle" ]; then
          break
        fi
        sleep 3
        waited=$((waited + 3))
      done

      if [ "$saw_running" = "0" ] && [ "$saw_finished" = "1" ] && [ "$in_history" = "0" ]; then
        fail "la pelea falló al prepararse: terminó sin llegar a 'running' (ver: docker compose logs --tail 100 orchestrator)"
      else

      if [ "$saw_running" = "1" ]; then
        pass "la pelea llegó a 'running'"
      else
        warn "no se alcanzó a observar la fase 'running' (puede haber sido muy corta o haber fallado al preparar)"
      fi

      if [ "$saw_finished" = "1" ]; then
        pass "la pelea llegó a 'finished' (tras ${waited}s)"
      elif [ "$in_history" = "1" ]; then
        pass "la pelea terminó (está en el historial; el estado ya no mostraba 'finished')"
      else
        fail "la pelea no llegó a 'finished' en ${MATCH_TIMEOUT}s (última fase: ${last_phase:-desconocida}; ver: docker compose logs --tail 100 orchestrator)"
      fi

      if [ "$in_history" = "1" ]; then
        code="$(http_get "$BASE_URL/api/matches")"
        # El historial viene con la más reciente primero: el primer "reason" es el de esta pelea.
        reason="$(json_string reason)"
        pass "la pelea $match_id aparece en /api/matches (motivo del resultado más reciente: ${reason:-?})"
        if [ "$reason" = "error" ]; then
          warn "la pelea más reciente terminó con motivo 'error': revisa docker compose logs --tail 100 orchestrator"
        fi
      else
        fail "la pelea $match_id no aparece en /api/matches"
      fi

      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "Resumen: $PASSES PASS, $FAILS FAIL, $WARNS WARN"
if [ "$FAILS" -gt 0 ]; then
  echo "Hay eslabones rotos. Revisa las líneas FAIL de arriba, en orden: el primero suele explicar los siguientes."
  exit 1
fi
echo "Toda la cadena funciona."
