# Cámara espectadora: bot de Minecraft + render headless (three / headless-gl) + ffmpeg.
# El CONTEXTO de build es la RAÍZ del repo:
#   docker build -f apps/camera/Dockerfile .
#
# ¿Por qué Node 22 y no Node 20 como el resto de las apps?
#  - mineflayer (>= 4.3x) declara "engines": node >= 22.
#  - headless-gl ("gl" 8.x) publica binarios precompilados solo para las versiones LTS
#    vigentes de Node; con Node 22 se descarga el binario y no hay que compilar ANGLE
#    (compilarlo toma muchos minutos y bastante RAM).
# Debian (bookworm) y no Alpine: los binarios precompilados de "canvas" y "gl" son glibc.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# - ffmpeg: codifica H.264 (libx264) y publica por RTMP.
# - xvfb + xauth: servidor X virtual; headless-gl necesita un DISPLAY aunque no haya pantalla.
# - libgl1-mesa-dri (+ libegl1, libgles2): OpenGL por software (llvmpipe). No se usa GPU.
# - tini: PID 1 real. xvfb-run como PID 1 se queda esperando para siempre una señal de Xvfb.
# - git + ca-certificates: pnpm baja node-canvas-webgl directo desde GitHub.
# - fonts-liberation: fuente (alias de Arial) para los nombres sobre los jugadores.
# - build-essential, python3, pkg-config y los paquetes -dev: plan B. Solo se usan si no hay
#   binario precompilado de "canvas" o "gl" para esta plataforma y hay que compilarlos
#   (node-gyp). Además arrastran las librerías de runtime (cairo, pango, X11, GLEW...).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git tini \
      ffmpeg \
      xvfb xauth \
      libgl1-mesa-dri libegl1 libgles2 \
      fonts-liberation fontconfig \
      build-essential python3 pkg-config \
      libx11-dev libxext-dev libxi-dev libgl1-mesa-dev libglu1-mesa-dev libglew-dev \
      libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libpixman-1-dev \
 && rm -rf /var/lib/apt/lists/*

RUN npm i -g pnpm@10

WORKDIR /repo
COPY . .

# Sin lockfile todavía, por eso no va --frozen-lockfile.
# El filtro "@phack/camera..." instala solo esta app y los paquetes del workspace de los
# que depende (@phack/env, @phack/protocol, @phack/tsconfig), no la web ni el orquestador.
# Los scripts de instalación de "canvas" y "gl" están permitidos en pnpm-workspace.yaml.
RUN pnpm install --filter "@phack/camera..."

# Fuerza render por software aunque el host tenga GPU a medias configurada.
ENV NODE_ENV=production \
    LIBGL_ALWAYS_SOFTWARE=1 \
    GALLIUM_DRIVER=llvmpipe

# -g: reenvía SIGTERM a todo el grupo (xvfb-run, Xvfb, pnpm, node), así `docker stop` es limpio.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
# -a: usa el primer DISPLAY libre (sobrevive a reinicios del contenedor con locks viejos en /tmp).
# La pantalla virtual solo necesita existir; el tamaño real del video lo fija CAMERA_WIDTH/HEIGHT.
CMD ["xvfb-run", "-a", "-s", "-ac -screen 0 1280x1024x24", "pnpm", "--filter", "@phack/camera", "start"]
