# Prompt Arena

Simulación para la **Platanus Hackathon 2026** (track Simulaciones).

Dos agentes LLM se enfrentan en un duelo PvP dentro de una arena de Minecraft. El comportamiento de cada agente lo define un **prompt escrito por una persona**. La pregunta que responde la simulación:

> **¿Qué pasa si el prompt A pelea contra el prompt B?**

Un sitio web transmite la pelea en vivo (video + telemetría en tiempo real), deja que cualquiera edite los dos prompts, elija el kit y el modelo de cada lado, inicie o detenga una pelea, y muestra el historial de resultados. Es experimental: no hay cuentas ni salas, **todos ven la misma pelea**.

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
│   ├── protocol/            Contrato compartido: arena, kits, estado, eventos, rutas de la API
│   ├── llm/                 Cliente LLM unificado (mock y vercel)
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
| Un peleador entra sin un objeto o un efecto de su kit | Busca el aviso "El servidor no confirmó un comando del kit" en los eventos de la web o en la salida del orquestador: trae el comando y lo que respondió Minecraft. |
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
- El servidor de Minecraft (jar de Paper, mundo, `server.properties` generado) vive en `.local/minecraft/`, y el historial y las transcripciones del orquestador en `.local/data/`. Ambas carpetas están fuera de git. Para empezar de cero, borra `.local/`.
- Las variables salen de `.env`, igual que en Docker. Los hosts internos (`MC_HOST`, `RCON_HOST`, `RTMP_URL`…) los fija `scripts/local/dev.mjs` apuntando a `127.0.0.1`.
- Para apuntar las apps locales a un servidor de Minecraft remoto (por ejemplo el servidor casero por Tailscale), no levantes `minecraft` aquí y define `MC_HOST`, `RCON_HOST` y `RTMP_URL` en el entorno.

## Kits y herramientas

Cada lado elige su **kit** en el editor de su prompt: un desplegable y, debajo, el inventario completo del kit elegido. El kit se guarda junto con el prompt (campo `kit` de `AgentConfig`) y, igual que el prompt, vale para la **próxima** pelea. Si no se elige ninguno, es el Clásico.

| Kit | Armadura | Barra de objetos | Efecto | Además de las herramientas comunes |
|---|---|---|---|---|
| **Clásico** (`classic`, por defecto) | Hierro | Espada de hierro, arco, 4 filetes, 16 flechas | — | `shoot` |
| **Arquero** (`archer`) | Malla | Espada de piedra, arco con Empuje I, 4 filetes, 32 flechas | — | `shoot` |
| **Tanque** (`tank`) | Peto y grebas de diamante, casco y botas de hierro | Espada de piedra, 4 filetes | — | — |
| **Berserker** (`berserker`) | Peto y grebas de hierro, casco y botas de malla | Hacha de diamante, 4 filetes | Velocidad I | — |
| **Enderman** (`ender`) | Peto y grebas de hierro, casco y botas de malla; botas con Caída de pluma IV | Espada de diamante, 4 perlas de ender, 4 filetes | — | `pearl` |
| **Constructor** (`builder`) | Hierro | Espada de hierro, arco, 2 manzanas doradas, 16 tablones de roble, 8 flechas | — | `shoot`, `build` |

El Arquero no es más rápido que los demás: su fuerza es que cada flecha empuja lejos al rival (Empuje I) y que le sobra munición. Cuerpo a cuerpo es débil: lleva espada de piedra y armadura de malla.

Las herramientas son lo único que el LLM puede hacer en cada decisión. Todos los kits tienen `approach` (acercarse), `attack` (cuerpo a cuerpo con la espada o el hacha), `retreat` (alejarse), `eat` (comer un filete o una manzana dorada) y `wait` (esperar). Las demás dependen de lo que trae el kit, y al LLM solo se le ofrecen las del suyo:

| Herramienta | Qué hace | Necesita |
|---|---|---|
| `shoot` | Se detiene, apunta, carga el arco cerca de 1 segundo y dispara. | Arco y flechas. |
| `pearl` | Lanza una perla de ender y se teletransporta donde cae. Con `target: "rival"` cae junto al rival y pasa a atacar; con `target: "away"` cae lejos, al otro lado de la arena, y ahí come si le falta comida y tiene con qué (si no, queda en espera). Cada perla quita unos 2,5 de vida al caer y hay 5 segundos de recarga entre una y otra. | Perlas de ender. |
| `build` | Levanta un muro de 3 de ancho y 2 de alto entre el agente y su rival: frena las flechas y obliga al rival a rodearlo. Gasta hasta 6 bloques, tarda 1 a 2 segundos y tiene 4 segundos de recarga. | Tablones. |

- El prompt de sistema de cada agente describe su kit (objetos, efectos y cómo funciona cada herramienta), así que el prompt de la persona no tiene que explicarlo.
- El daño que un agente se hace con su propia perla no se le suma al rival como daño causado.
- La arena tiene una tapa invisible sobre los muros, para que nadie salga con una perla: el mundo es plano y la arena flota unos 125 bloques sobre el suelo, así que salir sería caer al vacío. Los tablones que queden puestos se borran al terminar la pelea.
- Al entregar el kit, el orquestador revisa lo que el servidor de Minecraft responde a cada comando. Si no lo confirma (un objeto o un slot que el servidor no acepta), la pelea sigue, pero queda un aviso en el registro de eventos y en el log del orquestador.
- Cuando los dos peleadores ya tienen su kit hay una cuenta regresiva de 3 segundos (`COUNTDOWN_SECONDS`). Dentro del juego no se muestra nada: el orquestador publica en el estado el instante en que termina (`countdownEndsAt`) y la web la dibuja sobre el video.
- Los kits están en `KITS` (`packages/protocol/src/index.ts`); las herramientas de cada uno se deducen de sus objetos (`kitToolNames`, en `packages/agent/src/tools.ts`).

## Comunicación entre agentes

Se elige por pelea en la web (`GET`/`PUT /api/settings`, campo `comms`) y vale desde la próxima:

- `none`: no hay comunicación.
- `thoughts`: cada agente lee la mente del otro. El `reason` de cada decisión del rival le llega en el campo `rivalThoughts` de su observación.
- `chat`: pueden hablarse. Todas las herramientas aceptan un argumento opcional `say`; lo dicho se ve en la web (evento `message`) y le llega al rival en `rivalMessages`. Su `reason` sigue siendo privado.

### Qué hace y qué no hace el sistema con los mensajes

Cada agente elige el contenido y el idioma. Se le piden mensajes breves y el sistema los espacia:

- **Solo limpieza técnica** (`cleanMessage`, en `packages/agent/src/comms.ts`): unifica los saltos de línea, cambia tabuladores por espacios, quita caracteres de control (deja `\n`), recorta los espacios de los extremos y corta en `MAX_AGENT_MESSAGE_LENGTH` (500) caracteres, contados por punto de código para no partir un emoji. Ese tope existe para que una respuesta desbocada no llene la pantalla; un mensaje nunca se corta dos veces.
- **Ritmo de conversación.** Cada agente puede enviar un mensaje cada 4 segundos. Durante la pausa, la observación incluye `sayCooldown` con los segundos restantes. Si intenta hablar antes, la acción se ejecuta y su resultado avisa que el mensaje no se envió; el mensaje no entra a la conversación ni queda pendiente. Esto también aplica a las acciones en cola.
- **No reescribe el contenido.** No junta espacios ni líneas, no corrige, no resume, no revisa el contenido y no hace cumplir nada de lo que se digan. No filtra repetidos: dos mensajes iguales separados por la pausa llegan los dos.
- **No se pierde nada.** Lo que llega del rival sale de la bandeja recién cuando responde el LLM que lo vio: si esa llamada falla o se corta, va de nuevo en la próxima observación. La bandeja guarda hasta 12 líneas.
- **Memoria de la conversación.** En modo `chat` la observación trae también `conversation`: los últimos 12 mensajes de los dos lados (`from`: `"tú"` o `"rival"`), el más viejo primero, porque el historial de turnos que ve el LLM es corto.
- **Brevedad.** El prompt y las herramientas piden una sola frase de hasta 10 palabras, hablar solo para aportar algo nuevo y permitir acciones en silencio. Esa longitud es una instrucción al modelo; no se recortan frases por palabras. El contenido y qué creerle al rival siguen siendo decisión del agente.
- El proveedor `mock` no tiene modelo detrás: contesta con una frase fija cuando el rival le dijo algo y, si no, habla más o menos un turno de cada cuatro. Sirve para ver el modo `chat` sin claves.

## Qué puede hacer un agente en cada respuesta

Cada respuesta del modelo puede llamar una herramienta, varias o ninguna:

- **Varias**: se ejecutan en orden, cada una cuando termina la anterior (hasta 8 por respuesta). Las que no terminan solas (`approach`, `attack`, `retreat`, `move`, `shoot`, `shield`, `wait`) duran lo que diga su argumento `seconds`; sin él, 2 segundos si hay otra después, o hasta que se reemplacen si es la última. Lo que queda en cola va en `queuedActions` de la observación.
- **Ninguna**: no cambia nada. El cuerpo sigue con lo que hacía y con lo que quedaba en cola; el texto de la respuesta, si hay, se muestra como pensamiento.
- Una respuesta que llama herramientas reemplaza lo que quedaba en cola de la anterior.

El `reason` de cada herramienta y las respuestas sin herramientas también se piden en una frase de hasta 10 palabras, sin repetir lo anterior. El idioma lo decide el agente. El marcador cuenta una decisión por respuesta del modelo, haga lo que haga. En la transcripción con `?format=text`, las respuestas sin herramienta o con varias quedan anotadas.

## Modo por rondas

En la web, **Formato de la partida** elige entre una sola pelea y una serie de **hasta 5 rondas** (`mode` en `PUT /api/settings`: `single` o `rounds`); vale desde la próxima partida.

- Una ronda termina cuando uno de los dos muere, cuando uno **se rinde** (herramienta `surrender`, que solo existe en este modo) o, con el límite de tiempo encendido, cuando se acaba el tiempo de la ronda: ahí la gana quien tenga más vida, y con la misma vida la ronda queda empatada.
- La serie termina cuando al que va abajo ya no le alcanzan las rondas que quedan (3-0, 3-1…) o después de la quinta. Gana quien haya ganado más rondas; con las mismas, empate.
- Entre rondas los dos vuelven a su lugar con la vida completa y los efectos permanentes de su kit, y se quitan los bloques puestos. **El inventario no se repone**: lo que un agente gasta en una ronda no vuelve en las siguientes (se cambia con `ROUNDS_REFILL_KIT` en `apps/orchestrator/src/match.ts`). El historial de mensajes del modelo y la conversación entre agentes siguen de una ronda a otra.
- Cada agente sabe cómo va la serie: su observación trae `round`, `roundsWon`, `roundsLost` y `roundsDrawn`, y el prompt describe las reglas de la serie, sin decirle qué hacer con eso.

En el marcador hay un cuadro por ronda bajo el reloj, del color de quien la ganó; el historial muestra el marcador de la serie y cada ronda.

## Límite de tiempo

En la web, junto al modo de comunicación, hay un interruptor **Límite de tiempo** (`timer` en `PUT /api/settings`); vale desde la próxima pelea.

- **Encendido** (por defecto): la pelea dura `MATCH_DURATION_SECONDS` y, si nadie cae, gana quien tenga más vida.
- **Apagado**: la pelea no se acaba sola. Sigue hasta que uno caiga o alguien la detenga; el reloj de la web cuenta hacia arriba y al agente se le dice que no hay límite.

Para que una pelea olvidada no gaste tokens toda la noche, el servidor detiene (sin ganador) las peleas sin límite que pasan de `MATCH_MAX_SECONDS` (30 minutos por defecto; `0` quita el tope).

## Prompts marcados

En la sección **Historial** de la web cada pelea muestra el prompt de cada lado, y cualquiera puede **marcarlo** con etiquetas y una nota. Marcar guarda ese prompt aparte, tal como peleó: su texto, modelo y kit, contra quién, con qué ajustes y cómo le fue. Se puede marcar a mitad de pelea; el resultado se completa cuando termina.

- **Evaluar**: al filtrar por una etiqueta se ve cuántos de esos prompts ganaron y perdieron, y cada pelea tiene su transcripción.
- **Replicar**: «Cargar en Rojo» o «Cargar en Azul» deja el prompt, su modelo y su kit en ese editor, como cambios sin guardar.

El historial solo recuerda las últimas 50 peleas; lo marcado queda en `DATA_DIR/flags.json` aunque la pelea ya no esté entre ellas. Rutas: `GET /api/flags`, y `PUT` / `DELETE /api/matches/:id/flags/:side` (cuerpo `{ tags, note }`, hasta 8 etiquetas).

## Transcripciones

Cada pelea deja su transcripción completa en `DATA_DIR/transcripts/<id>.jsonl`: una entrada por línea, en el orden en que pasó, escrita mientras la pelea ocurre (si el servidor se cae, queda lo que alcanzó a pasar). Parte con `start` (configs con el proveedor, modelo y kit reales, ajustes, el prompt de sistema completo de cada agente, tick y duración) y trae las fases, cada decisión, lo que pensó, dijo e hizo cada agente, el daño, los cambios de estado, el registro de eventos, el resultado (`end`) y el "por qué ganó" (`explanation`). También quedan las peleas que fallaron o se detuvieron antes de empezar. El formato es `TranscriptEntrySchema`, en `packages/protocol`.

Cada `decision` guarda la observación que vio el LLM y su respuesta tal cual llegó: el texto y todas las llamadas a herramientas, también las que no se ejecutaron o nombran una herramienta que no existe. Ahí queda lo que el modelo intentó hacer aunque el juego no se lo ofreciera.

Para leerla, el id es el de la pelea en `/api/matches` (o el `id` de `/api/state` para la que está en curso):

```bash
curl http://localhost:8787/api/matches/<id>/transcript              # JSONL, tal cual
curl "http://localhost:8787/api/matches/<id>/transcript?format=text" # resumen para leer
```

El JSONL es el registro completo. Con `?format=text` sale un resumen legible (quién vio, pensó, dijo e hizo qué, con el tiempo desde que empezó el duelo), sin las observaciones enteras ni los cambios de estado. Funciona también con la pelea en curso. Un id que no es un UUID responde 400, y una pelea sin transcripción, 404.

## Configurar el proveedor de LLM

En `.env`:

```bash
LLM_PROVIDER=vercel           # mock | vercel
LLM_MODEL=                    # vacío = modelo por defecto del proveedor (ver packages/llm)
VERCEL_API_KEY=vck_...
```

Hay una sola conexión a modelos reales: `vercel`, el **Vercel AI Gateway** a través del SDK `ai`. Una sola clave (`VERCEL_API_KEY`) sirve para modelos de cualquier laboratorio, que se nombran `creador/modelo` (por ejemplo `openai/gpt-6-luna`). El modelo por defecto es `deepseek/deepseek-v4.1-flash-1017-fast`. `mock` es el LLM simulado: no usa clave ni llama a ninguna API.

Luego `docker compose up -d` (recrea los contenedores cuyo entorno cambió).

- `LLM_PROVIDER` y `LLM_MODEL` son el valor por defecto de ambos agentes. Desde la web cada lado elige "Por defecto del servidor", "Simulado" o un modelo de la lista de permitidos, así que se puede enfrentar un modelo contra otro. Si se elige un modelo real y falta `VERCEL_API_KEY`, la pelea falla con un error claro.
- **Solo modelos baratos.** Un modelo está permitido si su precio de catálogo no pasa de **1 USD por millón de tokens de entrada y 5 USD por millón de tokens de salida** (`MODEL_PRICE_CAP`, en `packages/protocol`). El orquestador descarga el catálogo público de Vercel AI Gateway, lo filtra y sirve el resultado en `GET /api/models`; la web solo ofrece esa lista, con el precio de cada modelo, y ya no deja escribir un id a mano. Si no logra descargar el catálogo, responde una lista fija (`source: "fallback"`). El modelo por defecto del servidor siempre está permitido.
- La lista se hace cumplir en el servidor: `PUT /api/prompts/:side` responde `400` si el modelo no está permitido, y al iniciar una pelea se revisa otra vez. Si el modelo guardado dejó de estar permitido, ese agente pelea con el modelo por defecto del servidor y queda un aviso en el registro de eventos.
- Cada agente decide cada `AGENT_TICK_MS` milisegundos (1500 por defecto), y una pelea dura como máximo `MATCH_DURATION_SECONDS` (180). Una pelea completa son del orden de 2 × 180 / 1,5 = **240 llamadas al LLM**. El sitio no tiene autenticación: cualquiera con el link puede iniciar peleas, así que ponle un límite de gasto a la clave.
- La lista completa de variables está en [.env.example](.env.example) y su fuente de verdad en `libs/env/src/index.ts`.
- **Si vienes de una versión anterior:** los proveedores `openai`, `anthropic`, `openrouter` y `gateway` ya no existen. Con uno de ellos en `LLM_PROVIDER`, el orquestador y la cámara no arrancan: antes de desplegar, deja `LLM_PROVIDER=vercel` (o `mock`) y la clave en `VERCEL_API_KEY` en el `.env` del servidor. Los datos guardados se siguen leyendo: un prompt o una pelea del historial con `gateway` pasa a `vercel`, y con los otros tres conserva su texto y queda con el proveedor por defecto.

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

El Worker lleva dentro el contrato de `packages/protocol` y se despliega aparte del orquestador. Cuando el contrato cambia (proveedores, kits, rutas de la API), despliega primero el orquestador y la web justo después: mientras las dos versiones no coinciden, la web puede descartar el estado o los valores por defecto que no entiende.

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

`scripts/smoke.sh` revisa, con una línea PASS/FAIL por eslabón: contenedores sanos, RCON, `/api/health`, `/api/state`, `/api/models` con al menos un modelo, upgrade de websocket, playlist HLS con segmentos, y una pelea completa iniciada por la API que llega a `finished` y aparece en `/api/matches`. Para que esa pelea sea corta, baja `MATCH_DURATION_SECONDS` (por ejemplo a 30) mientras pruebas.

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
| `pnpm test` | Pasan los tests de `libs/env`, `packages/llm`, `packages/agent` y `apps/orchestrator`. |
| Imágenes Docker | Construyen las tres: `orchestrator`, `web` y `camera` (con `gl` y `canvas`). |
| Minecraft | Paper 1.20.4 en modo offline, RCON, `bukkit.yml` sincronizado, chunks de la arena con `forceload`. |
| Pelea en modo `mock` | Completa: los dos agentes entran, pelean, uno gana por KO y queda en el historial. |
| Pelea con LLM real | Completa con `LLM_PROVIDER=vercel` y `deepseek/deepseek-v4.1-flash-1017-fast`: cada agente decide con tool calls y explica su razón. |
| Web | Sitio, API y websocket a través de Caddy en el puerto 8080. |
| Video | El cliente real de Minecraft corre en el servidor sin monitor (RTX 3080 vía VirtualGL), ffmpeg lo captura y codifica con la GPU a 30 fps, y MediaMTX entrega HLS: en la web se ven armaduras, armas, flechas, golpes y nombres. Se recupera solo si expulsan al cliente o se reinicia MediaMTX. |
| Tests y typecheck de la cámara | Los tests pasan y `tsc --noEmit` queda limpio, corridos dentro de la imagen `camera`. |

Los kits, las herramientas `pearl` y `build`, la lista de modelos permitidos y la cuenta regresiva se agregaron después de esa verificación: la tabla describe el estado anterior, con el kit Clásico.

### Lo que no se ha probado

- **Los kits nuevos en una pelea real.** Las peleas de prueba fueron todas con el kit Clásico. Falta ver en el servidor los otros cinco kits, la perla de ender y el muro, y el balance entre kits: sale de las fórmulas de daño de Minecraft 1.20.4, no de peleas medidas.
- **La lista de modelos permitidos** contra el catálogo real, y cómo se comporta cada modelo barato en una pelea: solo se probó `deepseek/deepseek-v4.1-flash-1017-fast`.
- **Cloudflare Tunnel** (`--profile tunnel`) y el video LL-HLS a través del túnel.
- **`scripts/deploy.sh` tal cual**: asume que el usuario SSH puede usar `docker` sin `sudo`.
- **La cámara fuera de Docker**, y el modo `CAMERA_MODE=viewer` después de agregar el modo `client`.
- **La transmisión tras un reinicio completo del servidor** (que `phack-stream` parta solo al encender) y en otra distribución que no sea Fedora.
- **Empates y victorias por tiempo**: todas las peleas de prueba terminaron por KO en menos de 30 segundos.

### Limitaciones conocidas

- **Cámara del cliente real.** Son dos y se alternan: la que sigue a los peleadores (parada en un punto, gira para mirarlos) y la general (estática, desde arriba). Sin pelea se muestra la general; con pelea, 20 s de una y 6 s de la otra (`CAMERA_FOLLOW_SECONDS`, `CAMERA_WIDE_SECONDS`). El campo de visión es fijo (`STREAM_FOV`): no hay zoom. El video no lleva audio.
- **Render sin GPU (`CAMERA_MODE=viewer`).** prismarine-viewer no dibuja armaduras, ítems en la mano, flechas ni animaciones de ataque, y todos los jugadores usan la misma skin. Es el respaldo para máquinas sin GPU y lo que se usa en desarrollo local.
- **Vida del rival.** Cada agente ve la vida del otro solo si mineflayer la recibe del servidor; puede llegar como `null`.
- **Peleas cortas.** Con el kit Clásico un duelo dura 15 a 30 segundos, es decir, unas 8 a 10 decisiones por agente. Para peleas más largas hay que ajustar los kits en `KITS` (`packages/protocol/src/index.ts`).
- **Efectos y absorción.** La Velocidad I del Berserker no muestra partículas en el video: se ve en el panel del kit de la web. La vida extra de la manzana dorada no cuenta como vida, ni en el marcador ni para decidir quién gana por tiempo.
- **Sin autenticación.** Cualquiera con el link puede cambiar prompts e iniciar peleas, y cada pelea gasta llamadas al LLM. Ponle un límite de gasto a la clave.
- **Suspensión y red del servidor.** Si el equipo se suspende o pierde la red, el stream se corta. Desactiva la suspensión automática.
