#!/usr/bin/env bash
# Servidor de Minecraft LOCAL, sin Docker: Paper corriendo directo sobre Java.
# Equivale al servicio "minecraft" de docker-compose.yml (mismas opciones).
#
#   bash scripts/local/minecraft.sh
#
# Todo queda en .local/minecraft/ (ignorado por git): el jar, el mundo y la config.
# server.properties se REESCRIBE en cada arranque a partir de las variables de entorno,
# así que los cambios se hacen en .env, no en ese archivo.
#
# Variables (las mismas de .env.example):
#   MC_VERSION     versión de Paper (por defecto 1.20.4)
#   MC_MEMORY      heap de la JVM (por defecto 1G)
#   MC_PORT        puerto del juego (25565)
#   RCON_PORT      puerto de RCON (25575)
#   RCON_PASSWORD  contraseña de RCON (phack-rcon)
#   ARENA_SCENARIO platanus (mundo vacío, por defecto) o pizza-spleef-2 (mapa del ZIP).
#                  Si no está en el entorno se toma del .env de la raíz, igual que el
#                  orquestador; es también el nombre del mundo (level-name).
#   JAVA_BIN       ruta a `java` si no es la de Homebrew (openjdk@21) ni la del PATH

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_DIR="$ROOT/.local/minecraft"

MC_VERSION="${MC_VERSION:-1.20.4}"
MC_MEMORY="${MC_MEMORY:-1G}"
MC_PORT="${MC_PORT:-25565}"
RCON_PORT="${RCON_PORT:-25575}"
RCON_PASSWORD="${RCON_PASSWORD:-phack-rcon}"

# El escenario debe coincidir con el del orquestador, que lee el .env: se toma de ahí si falta.
if [ -z "${ARENA_SCENARIO:-}" ] && [ -f "$ROOT/.env" ]; then
  ARENA_SCENARIO="$(sed -n 's/^ARENA_SCENARIO=//p' "$ROOT/.env" | tail -n 1 | tr -d "\"' \r")"
fi
ARENA_SCENARIO="${ARENA_SCENARIO:-platanus}"
case "$ARENA_SCENARIO" in
  platanus | pizza-spleef-2) ;;
  *)
    echo "ARENA_SCENARIO inválido: \"$ARENA_SCENARIO\" (usa platanus o pizza-spleef-2)" >&2
    exit 1
    ;;
esac

# ---------- Java ----------

find_java() {
  if [ -n "${JAVA_BIN:-}" ]; then
    echo "$JAVA_BIN"
    return
  fi
  local candidate
  for candidate in \
    /opt/homebrew/opt/openjdk@21/bin/java \
    /usr/local/opt/openjdk@21/bin/java \
    /opt/homebrew/opt/openjdk/bin/java; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  # En macOS /usr/bin/java existe siempre pero es un stub: solo sirve si hay un JDK instalado.
  if command -v java >/dev/null 2>&1 && java -version >/dev/null 2>&1; then
    command -v java
    return
  fi
  return 1
}

if ! JAVA="$(find_java)"; then
  echo "No se encontró Java. Instálalo con: brew install openjdk@21" >&2
  exit 1
fi

mkdir -p "$SERVER_DIR"
cd "$SERVER_DIR"

# ---------- Mundo compartido con Docker ----------

# Un mundo por escenario: platanus/ (vacío, lo crea el servidor) y pizza-spleef-2/.
# La pizza se importa una sola vez y solo si es el escenario activo; el mundo anterior
# (world/) se conserva para poder volver atrás.
if [ "$ARENA_SCENARIO" = pizza-spleef-2 ] && [ ! -f "$SERVER_DIR/pizza-spleef-2/level.dat" ]; then
  WORLD_STAGING="$(mktemp -d "$SERVER_DIR/.world-import.XXXXXX")"
  trap 'rm -rf "$WORLD_STAGING"' EXIT
  unzip -q "$ROOT/infra/minecraft/worlds/pizza-spleef-2.zip" -d "$WORLD_STAGING"
  mv "$WORLD_STAGING/Pizza Spleef 2" "$SERVER_DIR/pizza-spleef-2"
  rm -rf "$WORLD_STAGING"
  trap - EXIT
  echo "[minecraft] Mapa Pizza Spleef 2 importado."
fi

# ---------- Paper ----------

JAR="paper-$MC_VERSION.jar"
if [ ! -f "$JAR" ]; then
  echo "[minecraft] Descargando Paper $MC_VERSION…"
  # API de descargas de PaperMC (v3): devuelve la URL y el sha256 del último build.
  meta="$(curl -fsSL -H 'User-Agent: phack2026-local-dev' \
    "https://fill.papermc.io/v3/projects/paper/versions/$MC_VERSION/builds/latest")"
  read -r url sha < <(printf '%s' "$meta" | python3 -c '
import json, sys
d = json.load(sys.stdin)["downloads"]["server:default"]
print(d["url"], d["checksums"]["sha256"])')
  # Bucle con -C -: reanuda donde quedó si la conexión se corta (curl --retry trunca el archivo).
  tries=0
  until curl -fL --progress-bar -C - -o "$JAR.part" "$url"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
      echo "[minecraft] No se pudo descargar Paper desde $url" >&2
      exit 1
    fi
    sleep 2
  done
  got="$(shasum -a 256 "$JAR.part" | cut -d" " -f1)"
  if [ "$got" != "$sha" ]; then
    rm -f "$JAR.part"
    echo "[minecraft] El sha256 del jar no coincide (esperado $sha, obtenido $got)." >&2
    exit 1
  fi
  mv "$JAR.part" "$JAR"
fi

# ---------- Configuración ----------

echo "eula=true" > eula.txt

# bukkit.yml del repo: desactiva el connection-throttle (los bots salen todos de la misma IP).
cp "$ROOT/infra/minecraft/config/bukkit.yml" bukkit.yml

# Mundo vacío (void). Solo aplica al crear un mundo nuevo (platanus): el mapa importado de
# la pizza trae sus ajustes en su level.dat.
GENERATOR_SETTINGS='{"layers"\:[{"block"\:"minecraft\:air","height"\:1}],"biome"\:"minecraft\:the_void"}'

# server-ip=127.0.0.1: el servidor está en modo offline (sin cuentas de Mojang), así que
# NO debe quedar expuesto a la red. Juego y RCON escuchan solo en loopback.
cat > server.properties <<EOF
# Generado por scripts/local/minecraft.sh en cada arranque. No editar: cambia .env.
server-ip=127.0.0.1
server-port=$MC_PORT
online-mode=false
motd=Prompt Arena - Platanus Hackathon 2026 (local)
enable-rcon=true
rcon.port=$RCON_PORT
rcon.password=$RCON_PASSWORD
broadcast-rcon-to-ops=false
level-name=$ARENA_SCENARIO
level-type=minecraft\:flat
generator-settings=$GENERATOR_SETTINGS
generate-structures=false
spawn-animals=false
spawn-monsters=false
spawn-npcs=false
allow-nether=false
difficulty=normal
pvp=true
gamemode=survival
spawn-protection=0
view-distance=6
simulation-distance=4
max-players=10
allow-flight=true
enable-command-block=false
EOF

echo "[minecraft] Paper $MC_VERSION con $("$JAVA" -version 2>&1 | head -n 1) (heap $MC_MEMORY)"
echo "[minecraft] Escenario $ARENA_SCENARIO (mundo $SERVER_DIR/$ARENA_SCENARIO)"
echo "[minecraft] Juego en 127.0.0.1:$MC_PORT, RCON en 127.0.0.1:$RCON_PORT"

# exec: las señales (Ctrl+C, SIGTERM) llegan directo a la JVM, que guarda el mundo y sale.
exec "$JAVA" "-Xms$MC_MEMORY" "-Xmx$MC_MEMORY" -XX:+UseG1GC \
  -Dcom.mojang.eula.agree=true \
  -jar "$JAR" --nogui
