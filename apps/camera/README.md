# @phack/camera — cámara espectadora

> **Dos modos.** Con `CAMERA_MODE=client` (el oficial, por defecto en Docker Compose) este
> servicio no dibuja nada: solo vuela al bot cámara (`src/operator.ts`) y el video lo produce
> el cliente real de Minecraft (`infra/stream`, ver el README de la raíz). Todo lo que sigue
> describe el modo `CAMERA_MODE=viewer`: el render propio por software, que queda como
> respaldo para máquinas sin GPU y para desarrollo local. El punto de entrada es `src/main.ts`.

Un bot que entra al servidor de Minecraft como espectador, **dibuja el mundo sin pantalla
dentro de Node** y publica video real (H.264) hacia MediaMTX por RTMP. La web lo reproduce
como HLS en `/live/arena/index.m3u8`.

> Este componente es el más frágil del proyecto y **se escribió sin poder ejecutarlo**.
> Lo más probable es que la primera vez en el servidor haya que ajustar algo: la sección
> [Si algo falla](#si-algo-falla) está pensada para eso.

## Cómo funciona

```
servidor Minecraft ──(protocolo MC)──> mineflayer (bot "Camara", modo espectador)
                                            │ chunks, entidades, cambios de bloques
                                            ▼
                               prismarine-viewer (Viewer + WorldView)
                                            │ escena three.js 0.128
                                            ▼
                    THREE.WebGLRenderer sobre node-canvas-webgl / headless-gl
                    (OpenGL por software: Mesa llvmpipe, bajo Xvfb)
                                            │ gl.readPixels → RGBA crudo
                                            ▼
                          ffmpeg (stdin) → libx264 → FLV → RTMP_URL
                                            ▼
                                  MediaMTX → HLS → la web
```

1. `src/bot.ts` conecta el bot (`CAMERA_USERNAME`, sin física para que no se caiga) y por
   **RCON** ejecuta `gamemode spectator <cámara>` y `tp <cámara> <ARENA.camera>`. Cada 20 s
   revisa que siga ahí y en modo espectador; si no, lo repite.
2. `src/stage.ts` arma la escena. Está modelado sobre `lib/headless.js` de
   prismarine-viewer, pero con loop propio. El `WorldView` va centrado en `ARENA.center`,
   no en el bot. Sobre cada peleador flota un **rombo rojo o azul**, porque el viewer dibuja
   a todos los jugadores con la misma skin.
3. `src/director.ts` decide hacia dónde mirar: el punto medio entre los dos peleadores
   (`AGENT_USERNAMES`), con suavizado; si no están, el centro de la arena. La posición es
   fija y elevada (`ARENA.camera`) o una órbita lenta si se configura.
4. `src/index.ts` corre el loop a `CAMERA_FPS`: mueve la cámara, dibuja, lee los píxeles y
   se los pasa a ffmpeg.
5. `src/ffmpeg.ts` mantiene vivo a ffmpeg (`libx264`, `veryfast`, `zerolatency`,
   `yuv420p`, un keyframe por segundo, sin audio).

### Qué pasa cuando algo se cae

| Situación | Comportamiento |
| --- | --- |
| ffmpeg va más lento que el render | Solo hay un frame en vuelo. Mientras ffmpeg no lo consuma, los siguientes **se descartan** (ni siquiera se dibujan). No se acumula memoria. |
| El render va más lento que `CAMERA_FPS` | ffmpeg marca cada frame con la hora real y duplica frames para mantener el framerate. El video se ve menos fluido, pero no se atrasa. |
| ffmpeg termina (MediaMTX caído, red, etc.) | Se relanza solo, esperando 1 s, 2 s, 4 s… hasta 10 s. |
| ffmpeg se cuelga 15 s sin leer | Se mata y se relanza. |
| Expulsan o se desconecta el bot | Se reconecta (2 s, 4 s… hasta 15 s). El video sigue saliendo, con el cielo vacío. |
| 20 intentos de conexión fallidos seguidos | El proceso sale con código 1 y Docker lo reinicia. |
| No hay contexto WebGL, falta ffmpeg, versión de Minecraft no soportada, 60 frames fallidos seguidos, excepción no capturada | Sale con código 1. |

El video empieza a salir recién cuando el bot entra al mundo por primera vez.

## Variables de entorno

Las compartidas vienen de `@phack/env` (ahí están sus valores por defecto):

| Variable | Uso |
| --- | --- |
| `MC_HOST`, `MC_PORT`, `MC_VERSION` | Servidor de Minecraft (`minecraft`, `25565`, `1.20.4` en Docker). |
| `RCON_HOST`, `RCON_PORT`, `RCON_PASSWORD` | RCON, para el modo espectador y el teletransporte. |
| `CAMERA_USERNAME` | Nombre del bot (por defecto `Camara`). |
| `CAMERA_WIDTH`, `CAMERA_HEIGHT` | Tamaño del video. Se redondean hacia abajo a un número par. |
| `CAMERA_FPS` | Cuadros por segundo objetivo (1 a 60). |
| `RTMP_URL` | Destino, p. ej. `rtmp://mediamtx:1935/live/arena`. |

Propias de la cámara. **No están en `@phack/env`**: se leen directo de `process.env` en
`src/config.ts`, así que hay que pasarlas al contenedor de la cámara.

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `CAMERA_ORBIT_SECONDS` | `0` | Segundos que tarda una vuelta alrededor del centro de la arena, a la misma altura y distancia que `ARENA.camera`. `0` = cámara fija. Un valor razonable: `90`. |
| `CAMERA_VIEW_DISTANCE` | `4` | Radio, en chunks, que se dibuja alrededor del centro (2 a 12). Menos = menos CPU. |
| `CAMERA_BITRATE_KBPS` | `2500` | Bitrate del video. |
| `CAMERA_SILENT_AUDIO` | (vacío) | `1` agrega una pista AAC en silencio. Solo si algún reproductor se niega a reproducir video sin audio; hls.js no lo necesita. |

## Docker

El contexto de build es la raíz del repo:

```
docker build -f apps/camera/Dockerfile -t phack-camera .
```

Para el `docker-compose.yml` (que no pertenece a esta app), el servicio necesita más o menos:

```yaml
camera:
  build:
    context: .
    dockerfile: apps/camera/Dockerfile
  restart: unless-stopped
  depends_on: [minecraft, mediamtx]
  environment:
    MC_HOST: minecraft
    RCON_HOST: minecraft
    RCON_PASSWORD: ${RCON_PASSWORD}
    RTMP_URL: rtmp://mediamtx:1935/live/arena
    CAMERA_ORBIT_SECONDS: "0"
```

- `restart: unless-stopped` (o `always`) es **necesario**: la cámara sale con código 1 a
  propósito cuando no puede recuperarse.
- No hace falta `init: true`: la imagen ya usa `tini` como PID 1.
- La imagen usa **Node 22**, no 20 (motivos en el Dockerfile: mineflayer exige Node ≥ 22 y
  `gl` trae binarios precompilados para Node 22).
- No usa GPU. Todo el render es por software (Mesa llvmpipe), así que **consume CPU**.

## Limitaciones conocidas del render

prismarine-viewer es un visor simplificado, no el cliente de Minecraft:

- **No se ven** objetos en la mano, armaduras, flechas en vuelo, partículas, ni la animación
  de golpe. Los jugadores caminan y se mueven, pero el combate se entiende sobre todo por el
  movimiento y por la telemetría de la web.
- Todos los jugadores usan la skin por defecto. Por eso están los rombos de color.
- Iluminación plana: sin sombras, sin ciclo de día y noche, sin clima. Cielo celeste fijo.
- Sin HUD ni chat.
- Para 1.20.4 se usan las texturas y modelos de **1.20.1** (la versión más cercana que trae
  el visor). Los bloques nuevos de 1.20.3/1.20.4 podrían verse mal; pasto, piedra, madera y
  similares no tienen problema.
- El modelo de jugador puede fallar al cargar; en ese caso se ve una **caja magenta** en su
  lugar. La pelea se sigue pudiendo seguir.
- Render por software: en un servidor casero, 1280x720 puede dar bastante menos de 30 fps
  reales. El log `Video: X fps enviados a ffmpeg` cada 15 s dice cuánto está dando.
- HLS agrega varios segundos de retraso respecto de la telemetría por WebSocket.

## Si algo falla

Primero mirar el log: `docker compose logs -f camera`. Todas las líneas propias empiezan con
`[camara]`; las de ffmpeg con `[camara] WARN [ffmpeg]`.

1. **`pnpm install` falla al compilar `gl` o `canvas`.** No encontró binario precompilado y
   está compilando. El Dockerfile ya trae las herramientas; si falta una librería, el error
   de `node-gyp` la nombra: agregarla al `apt-get install`. Compilar `gl` toma varios minutos.
2. **`pnpm install` no logra bajar `node-canvas-webgl`.** Viene de GitHub
   (`github:PrismarineJS/node-canvas-webgl`), necesita `git` y salida a internet durante el build.
3. **`pnpm` avisa "Ignored build scripts: canvas, gl".** Los scripts de instalación están
   bloqueados. Deben estar permitidos en `pnpm-workspace.yaml` (`onlyBuiltDependencies` /
   `allowBuilds` con `canvas` y `gl`); ya lo están.
4. **`prismarine-viewer no logra resolver 'node-canvas-webgl/lib'` (o `'canvas'`).**
   prismarine-viewer los usa sin declararlos como dependencias. Con pnpm funciona gracias al
   hoisting interno, que viene activado. Si alguien lo desactivó (`hoist: false`), volver a
   activarlo o agregar en `pnpm-workspace.yaml`:
   ```yaml
   packageExtensions:
     prismarine-viewer:
       dependencies:
         canvas: "^3.1.0"
         node-canvas-webgl: "github:PrismarineJS/node-canvas-webgl"
   ```
5. **`No se pudo crear el contexto WebGL headless`.** No hay servidor X o no hay OpenGL.
   Verificar que el proceso corra bajo `xvfb-run` (el `CMD` del Dockerfile) y que esté
   `libgl1-mesa-dri`. Para probar dentro del contenedor:
   `xvfb-run -a node -e "console.log(require('gl')(64,64) ? 'ok' : 'sin contexto')"`
   (ejecutado desde `/repo/apps/camera`; si `require('gl')` no resuelve, usar la ruta
   dentro de `node_modules/.pnpm`).
6. **`No se pudo ubicar la cámara por RCON`.** Revisar `RCON_HOST`, `RCON_PORT`,
   `RCON_PASSWORD` y que el servidor tenga `ENABLE_RCON=true`. La cámara sigue reintentando;
   mientras tanto el bot queda en el spawn y en modo supervivencia (puede verse en la pelea y
   puede que la arena no se dibuje si el spawn queda lejos).
7. **El bot no conecta / lo expulsan.** `ONLINE_MODE=FALSE` en el servidor, versión 1.20.4,
   y que no haya otro jugador con el mismo `CAMERA_USERNAME`. Si lo expulsan por
   "Flying is not enabled", es que RCON no alcanzó a ponerlo en espectador: ver punto 6
   (o poner `ALLOW_FLIGHT=TRUE` en el servidor).
8. **`ffmpeg terminó (código 1...)` en bucle.** MediaMTX no está arriba, o no acepta publicar
   en esa ruta. Probar la URL: `rtmp://mediamtx:1935/live/arena`. El mensaje de ffmpeg de la
   línea anterior dice el motivo.
9. **Hay stream pero la imagen está negra o solo se ve cielo.** Los chunks no llegaron o se
   dibujan lejos: confirmar que la arena esté construida cerca de `ARENA.center`, que el bot
   esté en `ARENA.camera` (`/data get entity Camara Pos` por RCON), y subir
   `CAMERA_VIEW_DISTANCE`. Los chunks tardan unos segundos en aparecer después de conectar.
10. **La imagen sale cabeza abajo.** `gl.readPixels` entrega las filas de abajo hacia arriba
    y ffmpeg las da vuelta con `vflip`. Si se ve invertida, quitar `vflip` del filtro en
    `src/ffmpeg.ts`.
11. **Los colores rojo y azul salen intercambiados o raros.** Cambiar `rgba` por `bgra` en
    `-pix_fmt` de entrada, en `src/ffmpeg.ts`.
12. **Va a tirones / CPU al 100 %.** Bajar la carga, en este orden: `CAMERA_WIDTH=854` y
    `CAMERA_HEIGHT=480`; `CAMERA_FPS=20`; `CAMERA_VIEW_DISTANCE=3`.
13. **La web no reproduce pero ffmpeg no se queja.** Abrir `/live/arena/index.m3u8` directo.
    Si existe y no reproduce, probar `CAMERA_SILENT_AUDIO=1`.
14. **El contenedor se reinicia en bucle con `excepción no capturada`.** El stack del log
    dice de dónde viene. Si es de prismarine-viewer (por ejemplo al cargar una textura o
    una entidad), es un error del visor y no de la conexión.
15. **`Falló el render de un frame`.** Si se repite 60 veces seguidas el proceso sale. El
    mensaje trae el error de three / headless-gl.

## Desarrollo

```
pnpm --filter @phack/camera typecheck
pnpm --filter @phack/camera test      # solo la matemática de la cámara (src/director.ts)
```

Para correrla fuera de Docker hace falta Linux con `ffmpeg`, `xvfb` y Mesa, Node 22, y
lanzarla con `xvfb-run -a pnpm --filter @phack/camera start`.
