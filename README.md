# Arena de prompts

Simulación para la **Platanus Hackathon 2026** (track Simulaciones).

Dos agentes LLM se enfrentan en un duelo PvP dentro de una arena de Minecraft. El comportamiento de cada agente lo define un **prompt escrito por una persona**. La pregunta que responde la simulación:

> **¿Qué pasa si el prompt A pelea contra el prompt B?**

Un sitio web transmite la pelea en vivo (video + telemetría en tiempo real), deja que cualquiera edite los dos prompts, inicie o detenga una pelea, y muestra el historial de resultados. Es experimental: no hay cuentas ni salas, **todos ven la misma pelea**.

Todo corre en un servidor casero con Docker Compose y se publica a internet con un Cloudflare Tunnel.

> **Importante:** este repo fue generado sin ejecutar nada. Lee la sección [Estado: código generado sin ejecutar](#estado-código-generado-sin-ejecutar) antes de asumir que algo funciona.

## Arquitectura

```
                         Internet
                            |
                    Cloudflare (TLS)
                            |
                  +-------------------+
                  |    cloudflared    |   perfil "tunnel" de compose
                  +---------+---------+
                            | http://web:80
                  +---------v---------+
   navegador ---> |   web  (Caddy)    |   también en http://<servidor>:8080
                  |  /       Astro    |
                  |  /api/*  ---------+---------------+
                  |  /live/* -----+   |               |
                  +---------------|---+               |
                                  |                   |
                     HLS :8888    |                   |  HTTP + WS :8787
                  +---------------v---+     +---------v-----------------+
                  |     mediamtx      |     |       orchestrator        |
                  |   RTMP  ->  HLS   |     |  API, estado, historial   |
                  +---------^---------+     |  2 agentes (mineflayer)   |
                            |               |  cada uno con su LLM      |
               RTMP :1935   |               +----+-----------------+----+
               live/arena   |                    |                 |
                  +---------+---------+   RCON :25575        2 bots :25565
                  |      camera       |          |                 |
                  | bot espectador +  |     +----v-----------------v----+
                  | render + ffmpeg   +---->|         minecraft         |
                  +-------------------+     |  Paper 1.20.4, offline    |
                        bot :25565          +---------------------------+
```

| Servicio | Imagen / código | Qué hace |
|---|---|---|
| `minecraft` | `itzg/minecraft-server` (Paper 1.20.4) | Mundo plano sin mobs, modo offline, RCON activado. |
| `orchestrator` | `apps/orchestrator` | Dueño de la pelea: prepara la arena por RCON, conecta a los dos agentes, lleva el estado, decide el ganador, guarda el historial y emite eventos por websocket. |
| `camera` | `apps/camera` | Bot espectador que renderiza la arena y la empuja por RTMP a MediaMTX. |
| `mediamtx` | `bluenviron/mediamtx` | Convierte el RTMP en HLS de baja latencia. |
| `web` | `apps/web` + Caddy | Sitio estático (Astro) y proxy inverso de un solo origen. |
| `cloudflared` | `cloudflare/cloudflared` | Túnel de salida hacia Cloudflare (opcional). |

Rutas públicas (un solo origen, todo pasa por Caddy):

| Ruta | Destino |
|---|---|
| `/` | Sitio estático de Astro |
| `/api/*` (incluye el websocket `/api/ws`) | `orchestrator:8787`, ruta sin cambios |
| `/live/*` | `mediamtx:8888`, ruta sin cambios. Playlist HLS: `/live/arena/index.m3u8` |

Más detalle (flujo de una pelea, protocolo de eventos, cómo agregar escenarios) en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Estructura del repo

```
.
├── apps/
│   ├── orchestrator/        API + ciclo de vida de la pelea (Node, tsx)
│   ├── camera/              Bot espectador + render + ffmpeg -> RTMP
│   └── web/                 Sitio Astro; su imagen final es Caddy
├── packages/
│   ├── protocol/            Contrato compartido: arena, estado, eventos, rutas de la API
│   ├── llm/                 Cliente LLM unificado (mock, openai, anthropic, openrouter)
│   └── agent/               El "peleador": percibir -> LLM -> actuar, sobre mineflayer
├── libs/
│   ├── env/                 loadEnv(): todas las variables de entorno y sus valores por defecto
│   └── tsconfig/            tsconfig base
├── infra/
│   ├── caddy/Caddyfile      Proxy inverso + estáticos
│   ├── mediamtx/mediamtx.yml  RTMP -> HLS
│   └── minecraft/config/    Archivos que se copian al servidor de Minecraft (bukkit.yml)
├── scripts/
│   ├── local-check.mjs      Revisión previa para desarrollo local (pnpm local:check)
│   ├── deploy.sh            rsync + docker compose up en el servidor
│   └── smoke.sh             Verificación post-despliegue (PASS/FAIL por eslabón)
├── docs/ARQUITECTURA.md
├── docker-compose.yml       Stack completo (servidor)
├── docker-compose.dev.yml   Puertos extra para desarrollo local
└── .env.example
```

Es un monorepo de pnpm workspaces. Los paquetes exportan TypeScript directamente y las apps de Node corren con `tsx`: no hay paso de build para el código de Node.

## Desarrollo local

Para programar en tu máquina. Docker corre lo pesado (Minecraft, MediaMTX y, si quieres video, la cámara); el orquestador y la web corren en tu máquina con recarga en caliente.

Requisitos: **Node 22+**, **pnpm 10+** (`npm i -g pnpm@10`), **Docker con Compose v2** y unos 4 GB de RAM libres. Usa `pnpm`, no `npm`: el repo depende de `workspace:*`. En Windows funciona con Docker Desktop (los comandos de abajo son scripts de `pnpm` y Node, no de bash).

```bash
git clone https://github.com/storrealbac/phack2026.git
cd phack2026

pnpm local:check      # revisa Node, pnpm y Docker, y crea .env desde .env.example
pnpm local:install    # instala dependencias (todo menos la cámara, que solo corre en Docker)
pnpm local:infra      # levanta Minecraft + MediaMTX en Docker
pnpm dev              # orquestador (8787) + web (4321), con recarga en caliente
```

Abre **http://localhost:4321** y aprieta "Iniciar pelea". Con el `.env` por defecto (`LLM_PROVIDER=mock`) no se necesita ninguna clave.

El primer `pnpm local:infra` descarga Paper y genera el mundo: puede tardar un par de minutos. Mientras tanto el orquestador reintenta RCON solo; una pelea iniciada antes de que Minecraft esté listo termina con error. Mira el avance con `pnpm local:logs`.

### Ver la pelea

Hay tres formas, de la más simple a la más pesada:

1. **Sin video.** El marcador, los pensamientos de cada agente y el feed de eventos funcionan sin la cámara. El reproductor muestra "sin señal".
2. **Con un cliente de Minecraft.** Java Edition **1.20.4**, Multijugador → `localhost:25565`. Es la forma más fiel de ver el duelo y no depende de la cámara.
3. **Con el video de la web.** `pnpm local:camera` construye y levanta la cámara en Docker. Es la pieza más frágil del proyecto (dependencias nativas de render); si la imagen no construye, sigue con las opciones 1 o 2 y revisa [apps/camera/README.md](apps/camera/README.md).

Para probar el reproductor sin la cámara, publica una señal de prueba con ffmpeg:

```bash
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -c:v libx264 -preset veryfast \
  -tune zerolatency -pix_fmt yuv420p -g 30 -f flv rtmp://localhost:1935/live/arena
```

### Comandos

| Comando | Qué hace |
|---|---|
| `pnpm local:check` | Revisa requisitos y puertos, y crea `.env` si falta. |
| `pnpm local:install` | `pnpm install` sin `@phack/camera` (evita compilar `gl` y `canvas` en tu máquina). |
| `pnpm local:infra` | Minecraft + MediaMTX en Docker, con los puertos en `127.0.0.1`. |
| `pnpm local:camera` | Construye y levanta la cámara en Docker (video). |
| `pnpm dev` | Orquestador y web a la vez. También existen `pnpm dev:orchestrator` y `pnpm dev:web`. |
| `pnpm local:logs` | Logs de los contenedores. |
| `pnpm local:down` | Detiene los contenedores (el mundo se conserva). |
| `pnpm typecheck` / `pnpm test` | Tipos y tests de todos los paquetes. |
| `pnpm docker:up` / `pnpm docker:down` | El stack completo en Docker, igual que en el servidor: **http://localhost:8080**. Sin recarga en caliente. |

### Cómo está conectado

| Pieza | Dónde corre | Puerto en tu máquina |
|---|---|---|
| Web (`astro dev`) | tu máquina | `4321`. Su proxy de Vite manda `/api` a `8787` y `/live` a `8888`, igual que Caddy en producción. |
| Orquestador + los dos agentes | tu máquina | `8787` |
| Minecraft | Docker | `25565` (juego) y `25575` (RCON) |
| MediaMTX | Docker | `8888` (HLS) y `1935` (RTMP) |
| Cámara | Docker | ninguno: habla con Minecraft y MediaMTX por la red de compose |

Los puertos de desarrollo los agrega [docker-compose.dev.yml](docker-compose.dev.yml), que se usa encima de `docker-compose.yml`. Todos quedan solo en `127.0.0.1`.

Variables de entorno: el orquestador lee el `.env` de la raíz al arrancar (`libs/env`), el mismo archivo que usa Docker Compose. Una variable definida en tu terminal gana sobre el archivo, y una línea vacía (`LLM_MODEL=`) deja el valor por defecto. Fuera de Docker los hosts apuntan a `127.0.0.1` por defecto, así que no hay que tocar nada. Si cambias el `.env`, reinicia `pnpm dev`; si cambias `RCON_PASSWORD` o `MC_VERSION`, vuelve a correr `pnpm local:infra` para recrear Minecraft.

El historial de peleas en este modo queda en `apps/orchestrator/data/` (ignorado por git).

### Si algo falla

| Síntoma | Qué revisar |
|---|---|
| `pnpm local:install` no resuelve una versión | Las versiones se eligieron sin poder instalarlas. Corrige el rango en el `package.json` que indique el error. Cuando instale, **commitea el `pnpm-lock.yaml`**. |
| El orquestador repite errores de RCON | Minecraft aún está arrancando (`pnpm local:logs`), o `RCON_PASSWORD` cambió después de crear el contenedor. |
| "Connection throttled" al entrar el segundo agente | No se aplicó `infra/minecraft/config/bukkit.yml`. Revisa los logs de `minecraft`. |
| La web carga pero dice "desconectado" | El orquestador no está corriendo o falló al arrancar: mira la salida de `pnpm dev`. |
| Puerto ocupado (`8888` suele ser Jupyter) | `pnpm local:check` dice cuál. Cierra el otro programa o cambia el puerto en `docker-compose.dev.yml` (y `DEV_HLS_TARGET` para la web). |
| Quieres partir de cero | `docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v` borra el mundo de Minecraft. |

Este repo se escribió sin ejecutarlo: quien lo corra primero va a encontrar errores. El orden recomendado para ir arreglándolos está en [Estado: código generado sin ejecutar](#estado-código-generado-sin-ejecutar).

## Inicio rápido (servidor, todo en Docker)

Requisitos en el servidor: Docker con Compose v2, unos 6 GB de RAM libres, y salida a internet (el primer arranque descarga Paper y las imágenes).

```bash
cp .env.example .env          # opcional: sin .env también levanta, en modo mock
docker compose up -d --build
docker compose ps             # espera a que minecraft, orchestrator y web estén "healthy"
bash scripts/smoke.sh         # verifica toda la cadena
```

Después abre `http://<ip-del-servidor>:8080`.

Con la configuración por defecto (`LLM_PROVIDER=mock`) los agentes usan un LLM simulado: sirve para probar la cadena completa sin claves ni costo.

Comandos útiles:

```bash
docker compose logs -f orchestrator        # qué está pasando en la pelea
docker compose logs -f camera mediamtx     # problemas de video
docker compose exec minecraft rcon-cli     # consola del servidor de Minecraft
docker compose down                        # detener todo (los volúmenes se conservan)
```

Para entrar a mirar con un cliente real de Minecraft (Java 1.20.4): el puerto 25565 solo se publica en el loopback del servidor, así que hay que abrir un túnel SSH (`ssh -L 25565:127.0.0.1:25565 usuario@servidor`) y conectarse a `localhost`.

## Configurar el proveedor de LLM

En `.env`:

```bash
LLM_PROVIDER=anthropic        # mock | openai | anthropic | openrouter
LLM_MODEL=                    # vacío = modelo por defecto del proveedor (ver packages/llm)
ANTHROPIC_API_KEY=...         # solo la clave del proveedor que uses
OPENAI_API_KEY=
OPENROUTER_API_KEY=
```

Luego `docker compose up -d` (recrea los contenedores cuyo entorno cambió).

- `LLM_PROVIDER` y `LLM_MODEL` son el valor por defecto de ambos agentes. Desde la web se puede elegir proveedor y modelo por agente; si se elige uno sin clave configurada, la pelea falla con un error claro.
- Cada agente decide cada `AGENT_TICK_MS` milisegundos (1500 por defecto), y una pelea dura como máximo `MATCH_DURATION_SECONDS` (180). Una pelea completa son del orden de 2 × 180 / 1,5 = **240 llamadas al LLM**. El sitio no tiene autenticación: cualquiera con el link puede iniciar peleas, así que ponle un límite de gasto a la clave.
- La lista completa de variables está en [.env.example](.env.example) y su fuente de verdad en `libs/env/src/index.ts`.

## Cloudflare Tunnel

1. En el panel de Cloudflare: **Zero Trust → Networks → Tunnels → Create a tunnel**, tipo **Cloudflared**.
2. Copia el **token** del túnel (el valor largo que aparece después de `--token` en el comando de instalación) y pégalo en `.env`:
   ```bash
   TUNNEL_TOKEN=eyJ...
   ```
3. En el túnel, pestaña **Public Hostname → Add a public hostname**:
   - Subdomain / Domain: el que quieras (por ejemplo `arena.tudominio.cl`).
   - Service: tipo **HTTP**, URL **`web:80`** (es decir, `http://web:80`).
4. Levanta el stack con el perfil del túnel:
   ```bash
   docker compose --profile tunnel up -d
   ```
5. Revisa `docker compose logs cloudflared`: debe registrar conexiones con Cloudflare. El sitio queda en `https://arena.tudominio.cl`.

Cloudflare termina TLS; Caddy solo habla HTTP en el puerto 80. Los websockets funcionan por el túnel sin configuración adicional. No hay que abrir puertos en el router.

## Despliegue

Desde tu máquina (solo usa `rsync` y `ssh`; no construye ni ejecuta nada localmente):

```bash
bash scripts/deploy.sh usuario@servidor /home/usuario/phack2026
```

O con variables:

```bash
DEPLOY_HOST=servidor DEPLOY_USER=usuario DEPLOY_PATH=/home/usuario/phack2026 \
DEPLOY_TUNNEL=1 DEPLOY_SMOKE=1 bash scripts/deploy.sh
```

El script:

1. Copia el repo con `rsync` (excluye `node_modules`, `.git`, `data`, `dist` y `.env`). Un `pnpm-lock.yaml` generado en el servidor no se borra; aun así, cópialo a tu máquina y commitéalo cuando exista.
2. Si en el servidor no hay `.env`, lo crea desde `.env.example` (modo mock). **Las claves se editan en el servidor**, nunca viajan desde tu máquina.
3. Corre `docker compose up -d --build` (con `--profile tunnel` si `DEPLOY_TUNNEL=1`).
4. Reinicia `mediamtx` para que tome `infra/mediamtx/mediamtx.yml` (el video se corta unos segundos). Los cambios en `infra/minecraft/config/` o `infra/caddy/Caddyfile` se aplican a mano: `docker compose restart minecraft` / `docker compose restart web`.
5. Con `DEPLOY_SMOKE=1`, corre `scripts/smoke.sh` en el servidor.

La web y la API levantan sin esperar a Minecraft: en el primer arranque (descarga de Paper y generación del mundo) el sitio muestra "sin señal" y el orquestador reintenta RCON hasta que el servidor responda. Iniciar una pelea antes de eso termina con error.

`scripts/smoke.sh` revisa, con una línea PASS/FAIL por eslabón: contenedores sanos, RCON, `/api/health`, `/api/state`, upgrade de websocket, playlist HLS con segmentos, y una pelea completa iniciada por la API que llega a `finished` y aparece en `/api/matches`. Para que esa pelea sea corta, baja `MATCH_DURATION_SECONDS` (por ejemplo a 30) mientras pruebas.

## Estado: código generado sin ejecutar

Todo este repo (código, Dockerfiles, compose, scripts) fue **escrito sin ejecutar absolutamente nada**: no se corrió `pnpm install`, ni `tsc`, ni tests, ni `docker build`, ni un solo contenedor. No existe `pnpm-lock.yaml`. Las APIs de terceros se revisaron leyendo documentación, no probándolas. **Hay que asumir que la primera ejecución va a fallar en algún punto**; lo razonable es avanzar en este orden, arreglando cada paso antes de seguir.

### Checklist de la primera ejecución (en orden)

Hazlo en el servidor, no en un equipo que no aguante la carga.

1. **`pnpm install`** en la raíz. Puede fallar por versiones de dependencias que no existen (se eligieron de memoria). Corrige los rangos y **commitea el `pnpm-lock.yaml`** que se genere.
2. **`pnpm typecheck`**. Espera errores de tipos, sobre todo en las fronteras entre paquetes (`@phack/llm`, `@phack/agent`, `@phack/protocol`) y en los usos de mineflayer.
3. **`pnpm test`** (solo hay tests de lógica pura, si es que hay).
4. **`docker compose config`**: valida la sintaxis y la interpolación del compose.
5. **`docker compose up -d minecraft`** y esperar a `healthy`. Revisar en los logs que sea Paper 1.20.4, mundo plano, y que los comandos de `RCON_CMDS_STARTUP` no den error. Probar `docker compose exec minecraft rcon-cli list`.
6. **`docker compose up -d mediamtx`** y revisar que el log no reclame por claves desconocidas en `infra/mediamtx/mediamtx.yml` (la imagen es `latest`; las claves cambian entre versiones).
7. **`docker compose up -d --build orchestrator`**. Probar `/api/health` y `/api/state` desde dentro de la red, y que los agentes logren entrar al servidor.
8. **`docker compose up -d --build web`** y abrir `http://<servidor>:8080`: sitio, `/api/health` a través de Caddy, y el websocket.
9. **`docker compose up -d --build camera`**. Es el paso más difícil (ver abajo). Verificar `/live/arena/index.m3u8`.
10. **`bash scripts/smoke.sh`** con `LLM_PROVIDER=mock` y `MATCH_DURATION_SECONDS=30`.
11. Recién entonces: poner una clave real de LLM, y después el túnel (`--profile tunnel`).

### Qué es más probable que haya que arreglar

De más a menos probable:

1. **Cámara: dependencias nativas.** Renderizar Minecraft sin pantalla dentro de Docker depende de módulos nativos (`canvas`, `gl` / headless-gl) que necesitan librerías del sistema (Mesa, Xvfb, Cairo, Pango, toolchain de compilación) y de `ffmpeg`. Lo típico: que `pnpm install` no compile `gl`/`canvas` en la imagen, que pnpm 10 bloquee sus scripts de build (ver `onlyBuiltDependencies` en `pnpm-workspace.yaml`), que falte un display virtual, o que el render por software sea demasiado lento para los FPS pedidos (bajar `CAMERA_WIDTH`/`CAMERA_HEIGHT`/`CAMERA_FPS`). Si la cámara no funciona, **el resto del sistema sigue funcionando**: la web muestra telemetría sin video.
2. **Cámara: parámetros de ffmpeg y HLS.** MediaMTX corta segmentos en keyframes: la cámara debe emitir H.264 con un keyframe por segundo (GOP = FPS) o la latencia se dispara. Si LL-HLS da problemas en algún reproductor, cambiar `hlsVariant` a `fmp4` en `infra/mediamtx/mediamtx.yml`.
3. **Versiones de dependencias y lockfile.** Ver paso 1 del checklist.
4. **Agentes (mineflayer).** Conexión en modo offline a 1.20.4, pathfinding, combate y detección de daño/muerte están escritos contra la documentación, sin probar. Es donde más pueden aparecer errores de comportamiento (no de compilación).
5. **Orquestador ↔ RCON.** Los comandos para construir la arena, teletransportar, dar kits y cambiar modos de juego no se han probado contra un servidor real. La arena está en `y=64` (ver `ARENA` en `packages/protocol`), muy por encima del suelo del mundo plano: es una plataforma flotante que el orquestador debe construir. El compose deja los chunks de la arena cargados con `forceload` para que `/fill` funcione aunque no haya jugadores.
6. **Argumentos de build de la web.** El compose pasa `PUBLIC_API_BASE` y `PUBLIC_HLS_URL` como `build.args`. Si `apps/web` usa otros nombres de `PUBLIC_*`, hay que alinearlos en `docker-compose.yml` y `.env.example` (con los valores por defecto, mismo origen, no debería importar).
7. **Imagen de la web.** El healthcheck de `web` asume una imagen final basada en `caddy:alpine` (usa `wget`) con el sitio en `/srv`. El compose monta `infra/caddy/Caddyfile` sobre `/etc/caddy/Caddyfile`, así que manda el Caddyfile del repo.
8. **Infra escrita contra documentación:** nombres de variables de `itzg/minecraft-server` (en especial `COPY_CONFIG_DEST=/data` para el `bukkit.yml` que desactiva el `connection-throttle`; sin eso el segundo agente puede ser rechazado con "Connection throttled"), y la sintaxis del Caddyfile.
9. **Cloudflare + LL-HLS.** Si el video se ve bien en `:8080` pero mal a través del túnel, probar `hlsVariant: fmp4`.

Lo que **sí** se verificó contra la documentación oficial al escribir la infraestructura: nombres de las variables de `itzg/minecraft-server`, el punto de montaje `/config`, `RCON_CMDS_STARTUP`, y las claves de `mediamtx.yml` de la rama principal de MediaMTX.

### Correcciones de la revisión estática que siguen sin probar

Tres revisiones por lectura encontraron problemas que se corrigieron, **también sin ejecutar nada**. Cada punto de esta lista es una suposición razonable, no un hecho comprobado:

- **Node 22 en el orquestador.** La imagen pasó de `node:20-slim` a `node:22-slim` porque mineflayer y minecraft-protocol actuales declaran `node >= 22`. No se comprobó que fastify, tsx y el resto corran bien en 22 (deberían), ni que mineflayer fallara realmente en 20. `apps/web` sigue en Node 20.
- **Muerte falsa al empezar la pelea siguiente.** Tras un KO el perdedor se desconectaba antes de reaparecer y el servidor lo guardaba muerto. Ahora el agente espera 400 ms antes de salir si está muerto (mineflayer reaparece solo) y el orquestador ignora daño y muertes fuera de la fase `running`, además de reiniciar el daño infligido al comenzar. No se verificó que 400 ms alcancen ni que Paper conserve al jugador muerto entre sesiones.
- **Anthropic.** `max_tokens` subió a 4096 y se envía `output_config: { effort: "low" }`, porque `claude-haiku-5-5` piensa por defecto y esos tokens cuentan contra el tope. Si un modelo rechaza el parámetro con un 400, el cliente reintenta sin él. El historial se reenvía **sin** los bloques de razonamiento; no se confirmó que la API lo acepte siempre. Si la primera pelea real devuelve un 400 por eso, hay que conservar esos bloques o desactivar el razonamiento para ese modelo.
- **OpenAI.** Con el proveedor `openai` se envía `reasoning_effort: "none"` junto con las tools, porque la documentación de `gpt-6-luna` dice que Chat Completions solo admite function calling así. Si el modelo elegido no conoce el parámetro (400), se reintenta sin él. Con OpenRouter **no** se envía: el modelo por defecto `openai/gpt-6-luna` podría no devolver tool calls por esa vía; si pasa, elige otro modelo o pásalo en `packages/llm/src/openai.ts`. La detección del 400 busca el nombre del parámetro en el cuerpo del error, lo que tampoco se probó contra las APIs reales.
- **LLM mock.** El turno ahora usa un contador por cliente (antes se estancaba al recortarse el historial). La vida del rival puede llegar siempre como `null` desde mineflayer; en ese caso el mock defensivo solo alterna entre golpear y alejarse, nunca "remata".
- **Peleas que fallan al prepararse.** Ya no emiten el evento `match_end` (no entran al historial); la web se entera por el evento `state` y por el mensaje de log. Si existe algún test del orquestador que esperaba `match_end` en ese caso, va a fallar y hay que ajustarlo.
- **Compose.** Los montajes llevan `:ro,z` (SELinux en Fedora/RHEL; debería ser inofensivo en Debian/Ubuntu). `orchestrator` y `camera` ya no esperan a que Minecraft esté `healthy`: dependen de sus propios reintentos, que no se han visto funcionar. Las variables `CAMERA_ORBIT_SECONDS`, `CAMERA_VIEW_DISTANCE`, `CAMERA_BITRATE_KBPS` y `CAMERA_SILENT_AUDIO` ahora llegan al contenedor de la cámara.
- **Scripts.** `deploy.sh` reinicia `mediamtx` en cada despliegue (no se comprobó que la cámara retome sola la publicación RTMP después) y protege el `pnpm-lock.yaml` del servidor con una regla de filtro de rsync (`P /pnpm-lock.yaml`). `smoke.sh` corta la espera y reporta un solo FAIL cuando la pelea termina sin llegar a `running`. Ninguno de los dos scripts se ha corrido, ni siquiera con `bash -n`.
