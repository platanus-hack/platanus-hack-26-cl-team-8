# Se carga con `source` desde los otros scripts de scripts/local/.
#
# Deja Node 22 primero en el PATH. El proyecto necesita Node 22 (no 20 ni 24):
# mineflayer exige >= 22 y "gl" (headless-gl, que usa la cámara) solo publica
# binarios precompilados hasta Node 22; con Node 24 intenta compilar y falla.

phack_use_node22() {
  if node -v 2>/dev/null | grep -q '^v22\.'; then
    return 0
  fi
  local dir found=""
  for dir in "$HOME"/.nvm/versions/node/v22.*/bin /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin; do
    if [ -x "$dir/node" ]; then
      found="$dir"
    fi
  done
  if [ -z "$found" ]; then
    echo "Se necesita Node 22 y no se encontró. Instálalo con: nvm install 22" >&2
    return 1
  fi
  PATH="$found:$PATH"
  export PATH
}
