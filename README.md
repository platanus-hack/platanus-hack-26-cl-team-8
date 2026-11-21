# Arena de prompts

Simulación para la **Platanus Hackathon 2026** (track Simulaciones).

Dos agentes LLM se enfrentan en un duelo PvP dentro de una arena de Minecraft. El comportamiento de cada agente lo define un **prompt escrito por una persona**. La pregunta que responde la simulación:

> **¿Qué pasa si el prompt A pelea contra el prompt B?**

Un sitio web transmite la pelea en vivo (video + telemetría en tiempo real), deja que cualquiera edite los dos prompts, inicie o detenga una pelea, y muestra el historial de resultados. Es experimental: no hay cuentas ni salas, **todos ven la misma pelea**.

Todo corre en un servidor casero con Docker Compose y se publica a internet con un Cloudflare Tunnel.

> **Estado:** el stack completo corre en el servidor casero (pelea real con LLM, video en vivo y web). Qué se probó y qué no está en [Estado](#estado).

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
| `camera` | `apps/camera` | Bot cámara. Alterna entre seguir la pelea y una toma general; el cliente real de Minecraft ve lo que él ve. (Con `CAMERA_MODE=viewer` renderiza él mismo, sin GPU.) |
| `phack-stream` | `infra/stream` (servicio del host, fuera de Docker) | El cliente real de Minecraft, renderizado por la GPU y capturado con ffmpeg, publicado por RTMP a MediaMTX. Es el video que se ve en la web. |
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
│   ├── llm/                 Cliente LLM unificado (mock, vercel, openai, anthropic, openrouter, gateway)
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
| `pnpm local:install` falla | Usa pnpm 10 o superior y Node 22+. Las versiones están fijadas en `pnpm-lock.yaml`; si agregas una dependencia, commitea el lockfile actualizado. |
| El orquestador repite errores de RCON | Minecraft aún está arrancando (`pnpm local:logs`), o `RCON_PASSWORD` cambió después de crear el contenedor. |
| "Connection throttled" al entrar el segundo agente | No se aplicó `infra/minecraft/config/bukkit.yml`. Revisa los logs de `minecraft`. |
| La web carga pero dice "desconectado" | El orquestador no está corriendo o falló al arrancar: mira la salida de `pnpm dev`. |
| Puerto ocupado (`8888` suele ser Jupyter) | `pnpm local:check` dice cuál. Cierra el otro programa o cambia el puerto en `docker-compose.dev.yml` (y `DEV_HLS_TARGET` para la web). |
| Quieres partir de cero | `docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v` borra el mundo de Minecraft. |

Qué está probado y qué no: ver [Estado](#estado).

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

## Correr en local sin Docker (macOS)

Para desarrollar en un Mac sin Docker, cada servicio del compose corre como proceso nativo. Sirve como entorno de desarrollo y de respaldo; el despliegue "de verdad" sigue siendo el compose en el servidor.

```bash
pnpm local:setup        # una vez: Java 21, mediamtx, ffmpeg, cloudflared, Node 22, pnpm install, .env
pnpm local              # minecraft + mediamtx + orchestrator + camera + web
```

Después abre `http://localhost:4321` (`astro dev`, que hace de proxy hacia `/api` y `/live` igual que Caddy).

```bash
pnpm local --skip=camera            # todo menos la cámara
pnpm local minecraft mediamtx       # solo los servicios nombrados
pnpm local --tunnel                 # + el túnel de Cloudflare (ver "Web en Cloudflare")
```

- **Modo maqueta para diseñar la web sin backend:** `pnpm local web` y abrir `http://localhost:4321/?mock`. La página se llena con una pelea de mentira en bucle (golpes, pensamientos, eventos, prompts) y un video de relleno, sin orquestador, Minecraft ni transmisión. Variantes: `?mock=idle`, `?mock=preparing`, `?mock=finished`; `&signal=off` para ver el reproductor en "Sin señal"; `&static` para dejar todo quieto; `&delay=4000` para simular un video atrasado 4 s y probar que el marcador lo espera. Los botones "Iniciar pelea" y "Detener" cambian de fase localmente. Los datos están en `apps/web/src/scripts/mock.ts`; solo existe en `astro dev` (o compilando con `PUBLIC_MOCK=1`).
- **Node 22, no 20 ni 24.** mineflayer exige Node >= 22 y `gl` (headless-gl, el render de la cámara) solo publica binarios precompilados hasta Node 22: con Node 24 intenta compilar y falla. `scripts/local/*.sh` buscan un Node 22 de nvm o de Homebrew y lo ponen primero en el `PATH`; si corres `pnpm install` a mano, hazlo con Node 22 activo (`nvm use`).
- **Todo escucha solo en `127.0.0.1`**: el servidor de Minecraft está en modo offline y la API no tiene autenticación, así que nada queda expuesto a la red local.
- El servidor de Minecraft (jar de Paper, mundo, `server.properties` generado) vive en `.local/minecraft/`, y el historial del orquestador en `.local/data/`. Ambas carpetas están fuera de git. Para empezar de cero, borra `.local/`.
- Las variables salen de `.env`, igual que en Docker. Los hosts internos (`MC_HOST`, `RCON_HOST`, `RTMP_URL`…) los fija `scripts/local/dev.mjs` apuntando a `127.0.0.1`.
- Para apuntar las apps locales a un servidor de Minecraft remoto (por ejemplo el servidor casero por Tailscale), no levantes `minecraft` aquí y define `MC_HOST`, `RCON_HOST` y `RTMP_URL` en el entorno.

## Configurar el proveedor de LLM

En `.env`:

```bash
LLM_PROVIDER=vercel           # mock | vercel | openai | anthropic | openrouter | gateway
LLM_MODEL=                    # vacío = modelo por defecto del proveedor (ver packages/llm)
VERCEL_API_KEY=vck_...        # solo la clave del proveedor que uses
AI_GATEWAY_API_KEY=           # proveedor "gateway"
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
```

`vercel` y `gateway` son los dos **Vercel AI Gateway**: una sola clave para modelos de cualquier laboratorio. `vercel` usa el SDK `ai` y `VERCEL_API_KEY` (por defecto `deepseek/deepseek-v4.1-flash-1017-fast`); `gateway` usa la API compatible con OpenAI y `AI_GATEWAY_API_KEY` (por defecto `anthropic/claude-haiku-5.5`). Los modelos se nombran `creador/modelo` (por ejemplo `openai/gpt-6-luna`), así que desde la web se puede enfrentar un modelo contra otro cambiando solo el campo "modelo" de cada agente.

Luego `docker compose up -d` (recrea los contenedores cuyo entorno cambió).

- `LLM_PROVIDER` y `LLM_MODEL` son el valor por defecto de ambos agentes. Desde la web se puede elegir proveedor y modelo por agente; si se elige uno sin clave configurada, la pelea falla con un error claro.
- Cada agente decide cada `AGENT_TICK_MS` milisegundos (1500 por defecto), y una pelea dura como máximo `MATCH_DURATION_SECONDS` (180). Una pelea completa son del orden de 2 × 180 / 1,5 = **240 llamadas al LLM**. El sitio no tiene autenticación: cualquiera con el link puede iniciar peleas, así que ponle un límite de gasto a la clave.
- La lista completa de variables está en [.env.example](.env.example) y su fuente de verdad en `libs/env/src/index.ts`.

## Web en Cloudflare (Worker + túnel privado)

La web también se puede publicar como un **Worker de Cloudflare** (`apps/web/wrangler.jsonc`), sin exponer el servidor a internet:

```
navegador --> Worker "phack2026-web" (Cloudflare)
                |  /        assets estáticos (apps/web/dist)
                |  /api/*   --+
                |  /live/*  --+--> Workers VPC --> túnel "phack2026-local" --> cloudflared
                                                                                  |
                                                         127.0.0.1:8787 (orquestador)
                                                         127.0.0.1:8888 (HLS de MediaMTX)
```

`apps/web/worker/index.ts` cumple el rol de Caddy: sirve el sitio y hace de proxy de `/api/*` y `/live/*`. El orquestador y MediaMTX se alcanzan por [Workers VPC](https://developers.cloudflare.com/workers-vpc/): el túnel **no tiene hostname público** ni reglas de ingress, solo el Worker puede llegar a esos puertos.

```bash
pnpm deploy:web                     # astro build + wrangler deploy (usa el login de `wrangler login`)
pnpm local --tunnel                 # en la máquina de la arena: stack + cloudflared
```

Recursos ya creados en la cuenta de Cloudflare (sus IDs están en `apps/web/wrangler.jsonc`):

| Recurso | Nombre | Apunta a |
|---|---|---|
| Túnel | `phack2026-local` | la máquina donde corra `cloudflared` |
| VPC service | `phack2026-api` | `http://127.0.0.1:8787` |
| VPC service | `phack2026-live` | `http://127.0.0.1:8888` |

`127.0.0.1` se resuelve en la máquina que corre `cloudflared`, así que el túnel debe correr donde estén el orquestador y MediaMTX, con esos puertos alcanzables en loopback. Requiere `cloudflared` >= 2025.7.0 con transporte QUIC (UDP 7844 de salida).

## Cloudflare Tunnel (alternativa: hostname público hacia Caddy)

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

### Despliegue automático cuando cambia `main`

`scripts/deploy-main.sh` despliega `origin/main` solo si cambió desde el último despliegue (compara con el commit anotado en el servidor). Copia el commit exacto, no tu carpeta de trabajo. Los datos del servidor van en `.env.deploy` (ignorado por git): `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, y opcionalmente `DEPLOY_PASSWORD` y `DEPLOY_SUDO=1` si el usuario necesita `sudo` para Docker.

```bash
bash scripts/deploy-main.sh            # despliega si hay commits nuevos
bash scripts/deploy-main.sh --force    # despliega aunque no haya cambios
```

Para dejarlo corriendo solo desde Claude Code:

```
/loop 2m Ejecuta `bash scripts/deploy-main.sh` y responde con una sola línea con su resultado. No edites archivos ni intentes arreglar nada; si falla, muestra el error tal cual.
```

La web y la API levantan sin esperar a Minecraft: en el primer arranque (descarga de Paper y generación del mundo) el sitio muestra "sin señal" y el orquestador reintenta RCON hasta que el servidor responda. Iniciar una pelea antes de eso termina con error.

`scripts/smoke.sh` revisa, con una línea PASS/FAIL por eslabón: contenedores sanos, RCON, `/api/health`, `/api/state`, upgrade de websocket, playlist HLS con segmentos, y una pelea completa iniciada por la API que llega a `finished` y aparece en `/api/matches`. Para que esa pelea sea corta, baja `MATCH_DURATION_SECONDS` (por ejemplo a 30) mientras pruebas.

## Transmisión con el cliente real de Minecraft

El video de la web sale del juego de verdad, no de un render aparte:

```text
Xvfb (pantalla virtual) -> cliente de Minecraft, dibujado por la GPU (VirtualGL)
  -> ffmpeg captura la pantalla y codifica H.264 (NVENC) -> RTMP -> MediaMTX -> HLS -> web
```

El cliente entra al servidor como el espectador `Camarografo`. El contenedor `camera` lo monta (`/spectate`) en el bot `Camara` y mueve ese bot: lo que hace el bot es lo que se ve.

Se instala una sola vez en el servidor (Fedora, GPU NVIDIA con su driver):

```bash
sudo bash infra/stream/install.sh
```

Eso instala Xvfb, VirtualGL y xdotool, descarga el cliente desde Mojang (unos 850 MB) y deja corriendo el servicio `phack-stream`. Necesitas una licencia de Minecraft Java; el servidor de la arena es offline, así que el cliente entra sin iniciar sesión.

```bash
systemctl status phack-stream      # estado
journalctl -u phack-stream -f      # logs de la transmisión
docker compose logs -f camera      # logs del bot cámara
```

Sin GPU, pon `CAMERA_MODE=viewer` en `.env`: el contenedor `camera` vuelve a renderizar por software y no hace falta `phack-stream`. Las variables `STREAM_*` están en `.env.example`.

## Estado

Verificado el 21 de noviembre de 2026 en el servidor casero (Fedora 44, Docker 29, 12 CPU, 16 GB), con el stack completo de `docker-compose.yml`:

| Qué | Resultado |
|---|---|
| `pnpm install --frozen-lockfile` + `pnpm typecheck` | Limpio en todos los paquetes (la cámara no se incluyó en el typecheck). |
| `pnpm test` | 98 tests pasan (`libs/env`, `packages/llm`, `packages/agent`, `apps/orchestrator`). |
| Imágenes Docker | Construyen las tres: `orchestrator`, `web` y `camera` (con `gl` y `canvas`). |
| Minecraft | Paper 1.20.4 en modo offline, RCON, `bukkit.yml` sincronizado, chunks de la arena con `forceload`. |
| Pelea en modo `mock` | Completa: los dos agentes entran, pelean, uno gana por KO y queda en el historial. |
| Pelea con LLM real | Completa con `LLM_PROVIDER=vercel` y `deepseek/deepseek-v4.1-flash-1017-fast`: cada agente decide con tool calls y explica su razón. |
| Web | Sitio, API y websocket a través de Caddy en el puerto 8080. |
| Video | El cliente real de Minecraft corre en el servidor sin monitor (RTX 3080 vía VirtualGL), ffmpeg lo captura y codifica con la GPU a 30 fps, y MediaMTX entrega HLS: en la web se ven armaduras, armas, flechas, golpes y nombres. Se recupera solo si expulsan al cliente o se reinicia MediaMTX. |
| Tests y typecheck de la cámara | 24 tests pasan y `tsc --noEmit` queda limpio, corridos dentro de la imagen `camera`. |

### Lo que no se ha probado

- **Cloudflare Tunnel** (`--profile tunnel`) y el video LL-HLS a través del túnel.
- **Los otros proveedores** (`openai`, `anthropic`, `openrouter`) contra sus APIs reales. Solo tienen tests con `fetch` simulado.
- **`scripts/deploy.sh` tal cual**: asume que el usuario SSH puede usar `docker` sin `sudo`.
- **La cámara fuera de Docker**, y el modo `CAMERA_MODE=viewer` después de agregar el modo `client`.
- **La transmisión tras un reinicio completo del servidor** (que `phack-stream` parta solo al encender) y en otra distribución que no sea Fedora.
- **Empates y victorias por tiempo**: todas las peleas de prueba terminaron por KO en menos de 30 segundos.

### Limitaciones conocidas

- **Cámara del cliente real.** Son dos y se alternan: la que sigue a los peleadores (parada en un punto, gira para mirarlos) y la general (estática, desde arriba). Sin pelea se muestra la general; con pelea, 20 s de una y 6 s de la otra (`CAMERA_FOLLOW_SECONDS`, `CAMERA_WIDE_SECONDS`). El campo de visión es fijo (`STREAM_FOV`): no hay zoom. El video no lleva audio.
- **Render sin GPU (`CAMERA_MODE=viewer`).** prismarine-viewer no dibuja armaduras, ítems en la mano, flechas ni animaciones de ataque, y todos los jugadores usan la misma skin. Es el respaldo para máquinas sin GPU y lo que se usa en desarrollo local.
- **Vida del rival.** Cada agente ve la vida del otro solo si mineflayer la recibe del servidor; puede llegar como `null`.
- **Peleas cortas.** Con el kit actual (espada y armadura de hierro) un duelo dura 15 a 30 segundos, es decir, unas 8 a 10 decisiones por agente. Para peleas más largas hay que ajustar el kit en `apps/orchestrator/src/arena.ts`.
- **Sin autenticación.** Cualquiera con el link puede cambiar prompts e iniciar peleas, y cada pelea gasta llamadas al LLM. Ponle un límite de gasto a la clave.
- **Suspensión y red del servidor.** Si el equipo se suspende o pierde la red, el stream se corta. Desactiva la suspensión automática.
