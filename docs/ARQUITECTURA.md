# Arquitectura

Este documento describe el diseño según los contratos del repo: `packages/protocol/src/index.ts` (estado, eventos, API), `libs/env/src/index.ts` (configuración) y las interfaces de `@phack/llm` y `@phack/agent`. Si el código y este documento difieren, manda el código. El estado de lo que se ha probado está en el README.

## Piezas

| Pieza | Responsabilidad | No hace |
|---|---|---|
| `packages/protocol` | Tipos y esquemas zod compartidos: `ARENA`, `Side`, `AgentConfig`, `MatchState`, `MatchRecord`, `ArenaEvent`, `API_ROUTES`. Sin dependencias de Node: también se importa en el navegador. | Lógica. |
| `packages/llm` | `createLlmClient({ provider, model, apiKeys })` devuelve un `LlmClient` con un único método `complete({ messages, tools, signal })`. Proveedores: `mock`, `vercel` (AI Gateway, vía el SDK `ai`), `openai`, `anthropic`, `openrouter`. | Saber de Minecraft. |
| `packages/agent` | `createFighter(opts)` devuelve un `Fighter` (`connect`, `start`, `stop`): un bot de mineflayer con el ciclo percibir → LLM → actuar. Informa lo que pasa a través de `FighterEvents`. | Teletransportarse, darse el kit o cambiar su modo de juego: eso lo hace el orquestador por RCON. |
| `apps/orchestrator` | Único dueño del estado. API HTTP + websocket, ciclo de vida de la pelea, RCON, decisión del ganador, historial en `DATA_DIR`. | Renderizar video. |
| `apps/camera` | Bot espectador (`CAMERA_USERNAME`) ubicado en `ARENA.camera`; renderiza y publica RTMP en `RTMP_URL`. | Conocer el estado de la pelea. |
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
3. **Preparar.** Por RCON el orquestador deja la arena lista (centro `ARENA.center`, radio `ARENA.radius`, muros de `ARENA.wallHeight`). Crea un `LlmClient` por agente (el `provider`/`model` del `AgentConfig`, o `LLM_PROVIDER`/`LLM_MODEL` si vienen vacíos) y un `Fighter` por lado con los nombres de `AGENT_USERNAMES`. Tras `connect()`, teletransporta a cada uno a `ARENA.spawns[side]`, le da el kit y fija el modo de juego.
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

## Cómo agregar un escenario nuevo

Hoy existe un solo escenario: duelo 1 contra 1 en una arena circular cerrada. Un "escenario" es la combinación de **mapa + kit + reglas de victoria + herramientas disponibles para los agentes**. Para agregar otro (por ejemplo: arena con lava, duelo solo con arcos, o 2 contra 2), estos son los puntos de extensión, en el orden recomendado:

1. **Describirlo en el contrato (`packages/protocol`).**
   - Agregar un identificador, por ejemplo `ScenarioIdSchema = z.enum(["duelo", "lava"])`, y un registro `SCENARIOS` con lo que hoy está fijo en `ARENA`: centro, radio, spawns por lado, posición de la cámara.
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
