# Arquitectura

Este documento describe el diseño según los contratos del repo: `packages/protocol/src/index.ts` (estado, eventos, API), `libs/env/src/index.ts` (configuración) y las interfaces de `@phack/llm` y `@phack/agent`. Si el código y este documento difieren, manda el código. El estado de lo que se ha probado está en el README.

## Piezas

| Pieza | Responsabilidad | No hace |
|---|---|---|
| `packages/protocol` | Tipos y esquemas zod compartidos: `ARENAS`/`arenaFor` (escenarios de arena; `ARENA` = el por defecto), `Side`, `AgentConfig`, `MatchState`, `MatchRecord`, `ArenaEvent`, `API_ROUTES`. Sin dependencias de Node: también se importa en el navegador. | Lógica. |
| `packages/llm` | `createLlmClient({ provider, model, apiKeys })` devuelve un `LlmClient` con un único método `complete({ messages, tools, signal })`. Proveedores: `mock`, `vercel` (Vercel AI Gateway, vía el SDK `ai`), `openai`, `anthropic`, `openrouter`, `gateway` (Vercel AI Gateway, vía su API compatible con OpenAI). | Saber de Minecraft. |
| `packages/agent` | `createFighter(opts)` devuelve un `Fighter` (`connect`, `start`, `stop`): un bot de mineflayer con el ciclo percibir → LLM → actuar. Informa lo que pasa a través de `FighterEvents`. | Teletransportarse, darse el kit o cambiar su modo de juego: eso lo hace el orquestador por RCON. |
| `apps/orchestrator` | Único dueño del estado. API HTTP + websocket, ciclo de vida de la pelea, RCON, decisión del ganador, historial en `DATA_DIR`. | Renderizar video. |
| `apps/camera` | Bot espectador (`CAMERA_USERNAME`) ubicado en la `camera`/`cameraWide` del escenario de `ARENA_SCENARIO`; renderiza y publica RTMP en `RTMP_URL`. | Conocer el estado de la pelea. |
| `apps/web` | Sitio Astro: reproductor HLS, telemetría en vivo por websocket, editor de prompts, botones de iniciar/detener, historial. | Guardar estado propio. |
| `infra/*` | Caddy (un solo origen), MediaMTX (RTMP → HLS), configuración de Minecraft. | |

Hay **una sola sala**: una pelea a la vez, los mismos prompts y el mismo video para todos los visitantes. No hay autenticación.

## Flujo de datos de una pelea

```
  web                  orchestrator                 minecraft            LLM
   |                        |                           |                 |
   |-- PUT /api/prompts/red>|  guarda los prompts       |                 |
   |<-- WS "prompts" -------|  PENDIENTES (próxima)     |                 |
   |                        |                           |                 |
   |-- POST /api/match/start|                           |                 |
   |                        | phase = preparing         |                 |
   |                        | congela prompts -> configs|                 |
   |                        |--- RCON: arena, limpieza ->|                |
   |                        |--- fighter.connect() x2 -->| (2 bots)       |
   |                        |--- RCON: tp, kit, gamemode>|                |
   |                        | phase = running           |                 |
   |                        | startedAt, endsAt         |                 |
   |<-- WS "state" ---------| fighter.start() x2        |                 |
   |                        |                           |                 |
   |                        |   cada AGENT_TICK_MS, por agente:           |
   |                        |     percibir (posición, vida, rival) <------|
   |                        |     llm.complete(messages, tools) --------->|
   |                        |     <-------- texto + toolCalls ------------|
   |                        |     ejecutar la herramienta ---->|          |
   |<-- WS thought/action --|   onThought / onAction    |                 |
   |<-- WS damage/death ----|   onDamageTaken / onDeath |                 |
   |<-- WS "state" (~4/s) --|   onStatus                |                 |
   |                        |                           |                 |
   |                        | fin: muerte, tiempo, stop o error           |
   |                        | fighter.stop() x2         |                 |
   |                        | phase = finished, result  |                 |
   |                        | guarda MatchRecord en DATA_DIR              |
   |<-- WS "match_end" -----|                           |                 |
   |-- GET /api/matches --->|                           |                 |
```

En paralelo y de forma independiente, el video:

```
minecraft --(protocolo MC)--> camera (bot espectador + render) --RTMP--> mediamtx --HLS--> Caddy /live/* --> navegador
```

La cámara no depende del orquestador ni del estado de la pelea: transmite la arena siempre. Si el video falla, la telemetría sigue funcionando, y al revés.

### Paso a paso

1. **Editar prompts.** `PUT /api/prompts/:side` con `{ prompt, provider?, model? }` (máx. `MAX_PROMPT_LENGTH` caracteres). Los prompts editados son los de la **próxima** pelea; el orquestador avisa a todos con un evento `prompts`. Editar durante una pelea no cambia la pelea en curso.
2. **Iniciar.** `POST /api/match/start`. Si ya hay una pelea en `preparing` o `running`, responde `409`. Si no, crea un `MatchState` nuevo en fase `preparing` y **congela** los prompts pendientes en `state.configs`.
3. **Preparar.** Por RCON el orquestador deja lista la arena del escenario `ARENA_SCENARIO` (ver [Escenarios de arena](#escenarios-de-arena)): carga con `forceload` el piso y ambas cámaras y la reconstruye o restaura entre peleas. Crea un `LlmClient` por agente (el `provider`/`model` del `AgentConfig`, o `LLM_PROVIDER`/`LLM_MODEL` si vienen vacíos) y un `Fighter` por lado con los nombres de `AGENT_USERNAMES`. Tras `connect()`, teletransporta a cada uno a `ARENA.spawns[side]`, le da el kit y fija el modo de juego.
4. **Pelear.** Fase `running`, con `startedAt` y `endsAt = startedAt + MATCH_DURATION_SECONDS`. Cada `Fighter` corre su ciclo cada `AGENT_TICK_MS`: arma una observación, llama al LLM con el prompt del usuario y las herramientas disponibles, y ejecuta lo que el LLM pide. Todo lo que ocurre vuelve al orquestador por `FighterEvents`, que actualiza `AgentStatus` (vida, comida, `damageDealt`, `decisions`, `lastThought`, `lastAction`) y lo retransmite por websocket.
5. **Terminar.** La pelea termina por una de estas razones (`WinReason`):

   | `reason` | Cuándo | `winner` |
   |---|---|---|
   | `kill` | Un agente muere. | El otro lado. |
   | `timeout_health` | Se acaba el tiempo y uno tiene más vida. | El de más vida. |
   | `draw` | Se acaba el tiempo con la misma vida (o mueren ambos). | `null` |
   | `stopped` | Alguien llamó a `POST /api/match/stop`. | `null` |
   | `error` | Falló algo (conexión, LLM sin clave, RCON). | `null` |

6. **Registrar.** El orquestador detiene a ambos `Fighter`, pasa a `finished`, guarda un `MatchRecord` en `DATA_DIR` (volumen `orchestrator-data`) y emite `match_end`. `GET /api/matches` devuelve los últimos 50, más recientes primero. Ese registro (prompts + estado final + resultado) es la **respuesta** de la simulación a "¿qué pasa si A pelea contra B?".

### Fases

```
idle --start--> preparing --> running --> finished --start--> preparing ...
                    |             |
                    +--- error ---+--> finished (reason = error | stopped)
```

## Protocolo de eventos

Websocket `GET /api/ws`, solo servidor → cliente. Cada mensaje es un JSON con un campo discriminante `type` y un `at` (epoch en ms). El esquema autoritativo es `ArenaEventSchema`; en el cliente se valida con `parseArenaEvent(raw)`, que devuelve `null` si el mensaje no calza (el cliente lo ignora).

| `type` | Campos | Cuándo se emite |
|---|---|---|
| `state` | `state: MatchState` | Al conectar el websocket y cada vez que cambia el estado (como máximo ~4 por segundo). Es el estado completo: un cliente que se conecta tarde queda al día con un solo mensaje. |
| `prompts` | `prompts: { red, blue }` (`AgentConfig`) | Cuando alguien edita los prompts de la próxima pelea. |
| `thought` | `side`, `text` | Texto que produjo el LLM de ese agente en una decisión. |
| `action` | `side`, `tool`, `args`, `result` | El agente ejecutó una herramienta; `result` es el resultado en texto. |
| `damage` | `side` (quien **recibió** el daño), `amount`, `health` | Un agente perdió vida. |
| `death` | `side` | Un agente murió. |
| `match_end` | `record: MatchRecord` | La pelea terminó y quedó guardada. |
| `log` | `level` (`info`/`warn`/`error`), `text` | Mensajes para humanos (en español). |

Criterios de diseño:

- **`state` es la verdad; el resto son deltas para la interfaz.** Si se pierde un `thought` o un `damage`, el siguiente `state` corrige los números. La web no necesita reconstruir nada a partir de los deltas.
- **No hay mensajes cliente → servidor.** Toda acción (editar, iniciar, detener) va por HTTP, y su efecto vuelve a todos por el websocket.
- **Reconexión simple:** al reconectar llega un `state` completo. No hay cursores ni reenvío de eventos perdidos.

### API HTTP

| Método y ruta | Respuesta |
|---|---|
| `GET /api/health` | `{ ok: true }` |
| `GET /api/state` | `MatchState` |
| `GET /api/prompts` | `{ red: AgentConfig, blue: AgentConfig }` |
| `PUT /api/prompts/:side` | Cuerpo `UpdatePromptBody` → `AgentConfig` |
| `POST /api/match/start` | `MatchState` (`409` si ya hay una pelea en curso) |
| `POST /api/match/stop` | `MatchState` |
| `GET /api/matches` | `MatchRecord[]` (más recientes primero, máx. 50) |

Las rutas están en `API_ROUTES` para que la web y el orquestador no las escriban a mano.

## Red y despliegue

- Un solo origen público, servido por Caddy (`infra/caddy/Caddyfile`): `/` estáticos, `/api/*` al orquestador, `/live/*` a MediaMTX. Sin CORS ni URLs absolutas en la web.
- Dentro de la red de compose los servicios se hablan por nombre: `minecraft:25565` (juego), `minecraft:25575` (RCON), `mediamtx:1935` (RTMP), `mediamtx:8888` (HLS), `orchestrator:8787`, `web:80`.
- Hacia afuera solo se publica `web` (puerto 8080 del servidor). Minecraft se publica solo en `127.0.0.1` del servidor y RCON no se publica.
- El servidor de Minecraft corre en modo offline: los bots entran con nombre de usuario plano. Por eso **no debe quedar expuesto a internet**.
- `infra/minecraft/config/bukkit.yml` desactiva el `connection-throttle` de Bukkit: los dos agentes se conectan desde la misma IP (el contenedor del orquestador) casi al mismo tiempo, y con el valor por defecto el segundo sería rechazado.
- Video: la cámara publica H.264 por RTMP en `live/arena`; MediaMTX lo sirve como LL-HLS con segmentos de 1 s y partes de 200 ms (`infra/mediamtx/mediamtx.yml`). `hlsAlwaysRemux: true` hace que el playlist exista apenas publica la cámara. Caddy marca los `.m3u8` con `Cache-Control: no-store`.

## Escenarios de arena

La variable `ARENA_SCENARIO` elige el mapa; su valor es también el nombre del mundo del servidor (`LEVEL` en `docker-compose.yml`, `level-name` en `scripts/local/minecraft.sh`), así que cada escenario tiene su propio mundo y cambiar de uno a otro no pisa el otro. Los datos (centro, radio jugable, spawns, cámaras) están en `ARENAS` de `packages/protocol`; el orquestador, la cámara y el prompt del agente usan `arenaFor(ARENA_SCENARIO)`. `ARENA` sigue exportado y es el escenario por defecto.

| Escenario | Mundo | Preparación entre peleas |
| --- | --- | --- |
| `platanus` (por defecto) | Vacío (void: flat con una capa de aire y bioma `the_void`), lo crea el servidor. | `apps/orchestrator/src/platanus.ts` construye todo desde cero: limpia a aire el volumen de la arena, piso de concreto negro de 57×45 centrado en (0, 64, 0), el isotipo de Platanus (`platanus-logo.txt`, 41×41: `Y` concreto amarillo, `C` concreto blanco) con un `/fill` por tramo contiguo de cada fila, muros de vidrio de 5 bloques sobre el borde y **sin techo**. Luego elimina ítems, flechas y orbes de experiencia. Spawns a x = ±16, z = 0. |
| `pizza-spleef-2` | Importado una sola vez de `infra/minecraft/worlds/pizza-spleef-2.zip`, solo cuando es el escenario activo. | Comprueba un bloque del mapa (detecta un mundo equivocado), restaura la pizza desde su plantilla mediana original y limpia restos del combate. Radio 25; el borde da al vacío. |

En Docker, `itzg/minecraft-server` copia `WORLD` a `/data/$LEVEL` si esa carpeta no existe; por eso el `entrypoint` del servicio `minecraft` define `WORLD` solo cuando `LEVEL` es `pizza-spleef-2` (con un `WORLD` fijo, el primer arranque de `platanus` importaría la pizza). `GENERATOR_SETTINGS` solo afecta a mundos nuevos: el mapa importado trae los suyos.

En ambos casos el primer comando que toca chunks se reintenta mientras el servidor responda que la zona no cargó. La cámara se ubica en +Z mirando al norte: el lado rojo (x negativo) queda a la izquierda, igual que en la web.

## Cómo agregar un escenario nuevo

Hoy hay dos escenarios de arena (ver arriba) con las mismas reglas: duelo 1 contra 1. Un "escenario" es la combinación de **mapa + kit + reglas de victoria + herramientas disponibles para los agentes**. Para agregar otro (por ejemplo: arena con lava, duelo solo con arcos, o 2 contra 2), estos son los puntos de extensión, en el orden recomendado:

1. **Describirlo en el contrato (`packages/protocol`).**
   - Agregar el id a `ARENA_SCENARIOS` y su entrada a `ARENAS` (centro, radio, spawns por lado, cámaras; `kind: "built"` si se construye por RCON o `"template"` si se restaura de una plantilla del mapa). Repetir el id en el `z.enum` de `ARENA_SCENARIO` (`libs/env`), en `scripts/local/minecraft.sh` y, si trae mapa propio, en el `entrypoint` de `docker-compose.yml`.
   - Agregar `scenario` a `MatchStateSchema` y `MatchRecordSchema` **con `.default("duelo")`**, para que el historial ya guardado siga validando.
   - Si el escenario tiene otras formas de ganar, ampliar `WinReasonSchema`.

2. **Construir el mapa y el kit (`apps/orchestrator`).**
   - Sacar los comandos RCON de preparación (construcción de la arena, kits, modos de juego, limpieza) a una función por escenario, por ejemplo `setupScenario(rcon, scenario)`, y una `teardownScenario` si deja cosas en el mundo.
   - Si el mapa crece, ampliar el área del `forceload` en `RCON_CMDS_STARTUP` (`docker-compose.yml`).

3. **Definir las reglas de victoria (`apps/orchestrator`).**
   - Aislar la decisión del ganador en una función pura `(estado, evento) -> MatchResult | null` por escenario. Es el mejor candidato a tests con vitest: no necesita Minecraft.

4. **Ajustar lo que el agente puede hacer (`packages/agent`).**
   - Las herramientas que ve el LLM son `ToolDef[]`. Un escenario puede quitar o agregar herramientas (por ejemplo, sin arco) y agregar contexto a la observación (por ejemplo, "hay lava a 3 bloques").
   - Mantener la interfaz `Fighter` (`connect`/`start`/`stop`) y `FighterEvents` sin cambios: así el orquestador no necesita saber qué escenario corre cada agente. Lo propio del escenario entra como un campo opcional nuevo en `FighterOptions`.

5. **Elegirlo desde la API y la web.**
   - Aceptar un cuerpo opcional en `POST /api/match/start`, por ejemplo `{ scenario?: ScenarioId }`, validado con zod; sin cuerpo, el escenario por defecto.
   - En `apps/web`, un selector junto al botón de iniciar, y mostrar el escenario en el historial.

6. **Cámara (`apps/camera`).**
   - Hoy mira un punto fijo (`ARENA.camera` hacia `ARENA.center`). Si el escenario nuevo vive en otro lugar del mundo, lo más simple es que el orquestador **teletransporte al bot de la cámara por RCON** al preparar la pelea, en vez de que la cámara conozca los escenarios.

7. **Verificación.** Agregar a `scripts/smoke.sh` una pelea en modo mock por cada escenario.

Regla general: **todo lo que cruza entre procesos se define primero en `packages/protocol`**, con un valor por defecto que mantenga compatibles los datos antiguos. Más de dos agentes (equipos, todos contra todos) es un cambio mayor: `Side` y los objetos `{ red, blue }` están en todo el contrato, y habría que pasarlos a listas.
