# Arquitectura

Este documento describe el diseño según los contratos del repo: `packages/protocol/src/index.ts` (estado, eventos, API), `libs/env/src/index.ts` (configuración) y las interfaces de `@phack/llm` y `@phack/agent`. Si el código y este documento difieren, manda el código. El estado de lo que se ha probado está en el README.

## Piezas

| Pieza | Responsabilidad | No hace |
|---|---|---|
| `packages/protocol` | Tipos y esquemas zod compartidos: `ARENAS`/`arenaFor` (escenarios de arena; `ARENA` = el por defecto), `Side`, `KITS`, `AgentConfig`, `MatchState`, `MatchRecord`, `ArenaEvent`, `API_ROUTES`, `MODEL_PRICE_CAP`. Sin dependencias de Node: también se importa en el navegador. | Lógica. |
| `packages/llm` | `createLlmClient({ provider, model, apiKeys })` devuelve un `LlmClient` con un único método `complete({ messages, tools, signal })`. Proveedores: `vercel` (Vercel AI Gateway, vía el SDK `ai`) y `mock` (guion fijo, sin red, para pruebas). | Saber de Minecraft. |
| `packages/agent` | `createFighter(opts)` devuelve un `Fighter` (`connect`, `start`, `stop`): un bot de mineflayer con el ciclo percibir → LLM → actuar. Recibe su kit en `opts.kit` y ofrece al LLM solo las herramientas de ese kit. Informa lo que pasa a través de `FighterEvents`. | Teletransportarse, darse el kit o cambiar su modo de juego: eso lo hace el orquestador por RCON. |
| `apps/orchestrator` | Único dueño del estado. API HTTP + websocket, ciclo de vida de la pelea, RCON, decisión del ganador, historial en `DATA_DIR`, lista de modelos permitidos. | Renderizar video. |
| `apps/camera` | Bot espectador (`CAMERA_USERNAME`) ubicado en la `camera`/`cameraWide` del escenario de `ARENA_SCENARIO`; renderiza y publica RTMP en `RTMP_URL`. | Conocer el estado de la pelea. |
| `apps/web` | Sitio Astro: reproductor HLS, telemetría en vivo por websocket, editor de prompts (con el kit y el modelo de cada lado), botones de iniciar/detener, historial. | Guardar estado propio. |
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
   |                        | countdownEndsAt = ahora + 3 s               |
   |<-- WS "state" ---------| espera la cuenta regresiva|                 |
   |                        | phase = running           |                 |
   |                        | countdownEndsAt = null    |                 |
   |                        | startedAt, endsAt         |                 |
   |<-- WS "state" ---------| fighter.start() x2        |                 |
   |                        |                           |                 |
   |                        |   en bucle (≥ AGENT_TICK_MS), por agente:   |
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

1. **Editar prompts.** `PUT /api/prompts/:side` con `{ prompt, provider?, model?, kit? }` (máx. `MAX_PROMPT_LENGTH` caracteres). El kit va junto con el prompt; sin `kit`, o con un id desconocido, vale `DEFAULT_KIT`. Un modelo que no está en la lista de permitidos se rechaza con `400` (ver [Modelos permitidos](#modelos-permitidos)). Los prompts editados son los de la **próxima** pelea; el orquestador avisa a todos con un evento `prompts`. Editar durante una pelea no cambia la pelea en curso.
2. **Iniciar.** `POST /api/match/start`. Si ya hay una pelea en `preparing` o `running`, responde `409`. Si no, crea un `MatchState` nuevo en fase `preparing` y **congela** los prompts pendientes en `state.configs`.
3. **Preparar.** Por RCON el orquestador deja lista la arena del mapa de la pelea (el pedido al iniciar, el de los ajustes o `ARENA_SCENARIO`; ver [Escenarios de arena](#escenarios-de-arena-mapas)): carga con `forceload` el piso y ambas cámaras y la reconstruye o restaura entre peleas. Crea un `LlmClient` por agente (el `provider`/`model` del `AgentConfig`, o `LLM_PROVIDER`/`LLM_MODEL` si vienen vacíos; si el modelo ya no está permitido, el modelo por defecto del servidor) y un `Fighter` por lado con los nombres de `AGENT_USERNAMES` y el kit de su `AgentConfig`. Tras `connect()`, teletransporta a cada uno a los `spawns[side]` del escenario, le da su kit y fija el modo de juego.
4. **Cuenta regresiva.** Con los dos peleadores listos, el orquestador pone `state.countdownEndsAt = ahora + COUNTDOWN_SECONDS` (3 segundos), envía el `state` de inmediato y espera hasta ese instante. La fase sigue siendo `preparing` y dentro del juego no se muestra nada: la web dibuja el "3, 2, 1" a partir de `countdownEndsAt`. La pausa cubre además la invulnerabilidad inicial de un jugador que acaba de entrar al mundo. Si la pelea se detiene o falla durante la cuenta, `countdownEndsAt` vuelve a `null` y la pelea no empieza.
5. **Pelear.** Fase `running`, con `startedAt` y `endsAt = startedAt + MATCH_DURATION_SECONDS`; en esa misma actualización `countdownEndsAt` vuelve a `null`. Cada `Fighter` corre su ciclo en cuanto termina el anterior, con una pausa mínima de `AGENT_TICK_MS` (300 ms por defecto): arma una observación, llama al LLM con el prompt del usuario y las herramientas de su kit, y ejecuta lo que el LLM pide. Todo lo que ocurre vuelve al orquestador por `FighterEvents`, que actualiza `AgentStatus` (vida, comida, `damageDealt`, `decisions`, `lastThought`, `lastAction`) y lo retransmite por websocket.
6. **Terminar.** La pelea termina por una de estas razones (`WinReason`):

   | `reason` | Cuándo | `winner` |
   |---|---|---|
   | `kill` | Un agente muere. | El otro lado. |
   | `timeout_health` | Se acaba el tiempo y uno tiene más vida. | El de más vida. |
   | `draw` | Se acaba el tiempo con la misma vida (o mueren ambos). | `null` |
   | `stopped` | Alguien llamó a `POST /api/match/stop`. | `null` |
   | `error` | Falló algo (conexión, LLM sin clave, RCON). | `null` |

7. **Registrar.** El orquestador detiene a ambos `Fighter`, pasa a `finished`, guarda un `MatchRecord` en `DATA_DIR` (volumen `orchestrator-data`) y emite `match_end`. También borra de la arena los tablones que hayan quedado puestos. `GET /api/matches` devuelve los últimos 50, más recientes primero. Ese registro (prompts + estado final + resultado) es la **respuesta** de la simulación a "¿qué pasa si A pelea contra B?".

### Fases

```
idle --start--> preparing --> running --> finished --start--> preparing ...
                    |             |
                    +--- error ---+--> finished (reason = error | stopped)
```

La cuenta regresiva no es una fase aparte: es el final de `preparing`, y se reconoce porque `MatchState.countdownEndsAt` tiene valor (epoch en ms del instante en que empieza la pelea). En `idle`, `running` y `finished` es siempre `null`. El campo lleva `null` por defecto en el esquema, así que un estado de un servidor más antiguo sigue validando. Quien dibuja la cuenta tiene que restar contra el reloj del servidor (el `at` de los eventos), no contra el reloj local.

## Kits y herramientas

Un kit es un dato puro de `packages/protocol`: `KITS[id]` trae nombre, descripción, objetos (`slot`, `item`, `count`, `label`, encantamientos) y efectos permanentes. De ese mismo dato salen las tres cosas que tienen que coincidir: lo que la web dibuja, lo que el orquestador entrega por RCON y las herramientas que el agente ofrece al LLM.

| Kit (`KitId`) | Armadura | Barra de objetos | Efecto |
|---|---|---|---|
| `classic` "Clásico" (por defecto) | Hierro | Espada de hierro, arco, 4 filetes, 16 flechas | — |
| `archer` "Arquero" | Malla | Espada de piedra, arco con Empuje I, 4 filetes, 32 flechas | — |
| `tank` "Tanque" | Peto y grebas de diamante, casco y botas de hierro | Espada de piedra, 4 filetes | — |
| `berserker` "Berserker" | Peto y grebas de hierro, casco y botas de malla | Hacha de diamante, 4 filetes | Velocidad I |
| `ender` "Enderman" | Peto y grebas de hierro, casco y botas de malla; botas con Caída de pluma IV | Espada de diamante, 4 perlas de ender, 4 filetes | — |
| `builder` "Constructor" | Hierro | Espada de hierro, arco, 2 manzanas doradas, 16 tablones de roble, 8 flechas | — |

Todos usan la misma convención de barra: `hotbar.0` el arma cuerpo a cuerpo, `hotbar.1` el arco o las perlas, `hotbar.2` la comida, `hotbar.3` los bloques y `hotbar.8` las flechas. El tipo `KitSlot` solo acepta los nombres de slot que existen en el juego: la armadura, la mano secundaria, `hotbar.0` a `hotbar.8` e `inventory.0` a `inventory.26`.

- **Contrato.** `AgentConfig.kit` es opcional y tolerante: si falta (registros viejos) o trae un id desconocido, `kitOf(config)` devuelve `DEFAULT_KIT`. Así el historial ya guardado sigue validando.
- **Entrega (`apps/orchestrator`).** Al preparar a cada peleador, después de limpiar su inventario y sus efectos, el orquestador manda un `item replace entity <bot> <slot> with minecraft:<item>` por objeto y un `effect give <bot> minecraft:<efecto> infinite` por efecto. Como cada objeto va a un slot fijo, la barra del juego es la misma que muestra la web. Un slot o un objeto mal escrito no hace fallar el comando por RCON (el servidor solo responde con un texto de error), así que `prepareFighter` revisa cada respuesta: si no es la de un comando que funcionó ("Replaced a slot…", "Applied effect…"), emite un `log` de nivel `warn` con el comando y la respuesta, y la pelea sigue.
- **Herramientas (`packages/agent`).** `kitToolNames(kit)` deduce las herramientas de los objetos del kit, y esas se le ofrecen al LLM; `build` está disponible para todos, porque `dig` permite recoger materiales de construcciones existentes. Si el LLM llama a una que su kit no tiene, recibe un resultado que le dice cuáles puede usar y sigue con lo que estaba haciendo. Lo mismo pasa con una herramienta que en ese momento no se puede usar (comer con la barra de comida llena, disparar sin flechas, una perla en recarga): el resultado dice por qué y el agente no cambia de modo. El prompt de sistema lleva una sección con el contenido del kit y cómo funciona cada herramienta.

| Herramienta | Kits | Qué hace |
|---|---|---|
| `approach` | Todos | Camina hacia el rival hasta quedar a unos 2 bloques, sin atacar. |
| `attack` | Todos | Cuerpo a cuerpo con la espada o el hacha, respetando la recarga del arma que tiene en la mano (el hacha pega más fuerte y más lento). Argumento opcional `seconds`. |
| `retreat` | Todos | Se aleja del rival sin salir de la arena. |
| `shoot` | Los que traen arco y flechas: `classic`, `archer`, `builder` | Se detiene, apunta, carga cerca de 1 segundo y dispara. |
| `eat` | Todos | Come un filete (solo si la barra de comida no está llena) o una manzana dorada (siempre). Tarda cerca de 2 segundos. |
| `pearl` | `ender` | Lanza una perla de ender y se teletransporta donde cae. `target: "rival"` (por defecto) cae junto al rival y pasa a atacar; `target: "away"` cae lejos, al otro lado de la arena, y ahí come si le falta comida y tiene con qué (si no, queda en espera). Recarga de 5 segundos. |
| `build` | Todos; necesita bloques en el inventario actual | Ejecuta un plano libre `blocks: [{x,y,z,material}, ...]` (hasta 512 celdas ordenadas). El cuerpo busca dónde colocarse y confirma cada bloque en el mundo. Sin `blocks`, retoma el plano; con uno nuevo, lo reemplaza. Otra acción lo pausa. Sin formas fijas ni recarga artificial. |
| `move` | Todos | Incluye `style: "goto", position: {x,y,z}` para destinos libres además de los movimientos tácticos. |
| `dig` | Todos | Permite `position: {x,y,z}` para elegir un bloque concreto a su alcance, además de `between` y `nearest`. |
| `wait` | Todos | Se queda quieto mirando al rival. |

Lo que estas dos herramientas nuevas cambian fuera del agente:

- **Daño propio.** Caer con una perla quita vida. `FighterEvents.onDamageTaken(amount, health, bySelf)` avisa con `bySelf = true` cuando el daño viene de la perla del propio agente; el orquestador emite igual el evento `damage`, pero no lo suma al `damageDealt` del rival.
- **Observación.** Mientras dura la recarga, la observación del agente incluye `pearlCooldown` (segundos que faltan). Construir no tiene recarga artificial.
- **Arena.** La arena no tiene techo: los muros de vidrio miden 6 bloques y arriba queda abierto. El mundo es vacío, así que quien saliera por encima (con una perla o apilando bloques) caería al vacío. Al terminar la pelea se borran los bloques que hayan quedado dentro.

Para agregar un kit: sumar su id a `KIT_IDS` y su entrada a `KITS`. Los comandos RCON, la lista de herramientas y el panel de la web salen de ahí. Solo hay que tocar más código si trae un objeto sin ícono en la web o una mecánica que ninguna herramienta cubre.

## Protocolo de eventos

Websocket `GET /api/ws`, solo servidor → cliente. Cada mensaje es un JSON con un campo discriminante `type` y un `at` (epoch en ms). El esquema autoritativo es `ArenaEventSchema`; en el cliente se valida con `parseArenaEvent(raw)`, que devuelve `null` si el mensaje no calza (el cliente lo ignora).

| `type` | Campos | Cuándo se emite |
|---|---|---|
| `state` | `state: MatchState` | Al conectar el websocket y cada vez que cambia el estado (como máximo ~4 por segundo). Es el estado completo: un cliente que se conecta tarde queda al día con un solo mensaje. |
| `prompts` | `prompts: { red, blue }` (`AgentConfig`) | Cuando alguien edita los prompts de la próxima pelea. |
| `thought` | `side`, `text` | Texto que produjo el LLM de ese agente en una decisión. |
| `action` | `side`, `tool`, `args`, `result` | El agente ejecutó una herramienta; `result` es el resultado en texto. |
| `damage` | `side` (quien **recibió** el daño), `amount`, `health` | Un agente perdió vida, también cuando se la quitó su propia perla de ender. |
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
| `PUT /api/prompts/:side` | Cuerpo `UpdatePromptBody` (`{ prompt, provider?, model?, kit? }`) → `AgentConfig` (`400` si el modelo no está permitido) |
| `POST /api/match/start` | `MatchState` (`409` si ya hay una pelea en curso) |
| `POST /api/match/stop` | `MatchState` |
| `GET /api/matches` | `MatchRecord[]` (más recientes primero, máx. 50) |
| `GET /api/defaults` | `ServerDefaults`: proveedor del servidor y modelo por defecto de cada proveedor |
| `GET /api/models` | `ModelsResponse`: los modelos que se pueden elegir |

Las rutas están en `API_ROUTES` para que la web y el orquestador no las escriban a mano.

### Modelos permitidos

Solo se puede pelear con modelos baratos. El tope es `MODEL_PRICE_CAP`: **1 USD por millón de tokens de entrada y 5 USD por millón de tokens de salida**, según el precio del catálogo público de Vercel AI Gateway. Un modelo justo en el tope está permitido.

- **De dónde sale la lista.** El orquestador descarga el catálogo al arrancar, sin esperar la descarga para empezar a atender, y lo vuelve a descargar cada cierto tiempo. Se queda con los modelos de lenguaje que aceptan herramientas y no pasan del tope. Si la descarga falla, conserva la última lista buena; si nunca hubo una, usa una lista fija.
- **`GET /api/models`** responde `{ models, source, updatedAt }`. Cada modelo trae `id` (`creador/modelo`), `name`, `inputPrice` y `outputPrice`, estos dos en dólares **por token**. `source` es `"catalog"` (lista viva) o `"fallback"` (lista fija); `updatedAt` es el momento de la última descarga buena, o `null`.
- **Dónde se hace cumplir.** En `PUT /api/prompts/:side`: si viene un modelo, el proveedor que va a usar ese lado no es `mock` y el modelo no está en la lista, responde `400`. Con proveedor `mock` el modelo se descarta. Y otra vez al iniciar la pelea: si el modelo guardado dejó de estar permitido, ese agente usa el modelo por defecto del servidor y se emite un `log` de nivel `warn`.
- **El modelo por defecto del servidor** siempre está permitido, para que "Por defecto del servidor" nunca quede bloqueado.
- **La web** arma su selector con esta ruta ("Por defecto del servidor", "Simulado" y la lista, con el precio de cada modelo). No consulta el catálogo de Vercel por su cuenta ni deja escribir un id a mano.

Los datos guardados con los proveedores que ya no existen se convierten al leerlos (`migrateStoredConfig`): `gateway` pasa a `vercel`, y `openai`, `anthropic` y `openrouter` quedan sin proveedor, es decir, con el del servidor. El texto del prompt y el historial se conservan.

## Red y despliegue

- Un solo origen público, servido por Caddy (`infra/caddy/Caddyfile`): `/` estáticos, `/api/*` al orquestador, `/live/*` a MediaMTX. Sin CORS ni URLs absolutas en la web.
- Dentro de la red de compose los servicios se hablan por nombre: `minecraft:25565` (juego), `minecraft:25575` (RCON), `mediamtx:1935` (RTMP), `mediamtx:8888` (HLS), `orchestrator:8787`, `web:80`.
- Hacia afuera solo se publica `web` (puerto 8080 del servidor). Minecraft se publica solo en `127.0.0.1` del servidor y RCON no se publica.
- El servidor de Minecraft corre en modo offline: los bots entran con nombre de usuario plano. Por eso **no debe quedar expuesto a internet**.
- `infra/minecraft/config/bukkit.yml` desactiva el `connection-throttle` de Bukkit: los dos agentes se conectan desde la misma IP (el contenedor del orquestador) casi al mismo tiempo, y con el valor por defecto el segundo sería rechazado.
- Video: la cámara publica H.264 por RTMP en `live/arena`; MediaMTX lo sirve como LL-HLS con segmentos de 1 s y partes de 200 ms (`infra/mediamtx/mediamtx.yml`). `hlsAlwaysRemux: true` hace que el playlist exista apenas publica la cámara. Caddy marca los `.m3u8` con `Cache-Control: no-store`.

## Escenarios de arena (mapas)

Ojo con el nombre: aquí "escenario" es el **mapa** (`ArenaScenarioId`: `platanus`, `chunk-battle`, `pizza-spleef-2`). Los escenarios de benchmark (`SCENARIO_IDS`: `duel`, `dilemma`, `surrender`, `injection`, `verify`, en `MatchSettings.scenario`) son otra cosa: reglas de puntaje que se juegan en cualquier mapa.

**Hoy hay un solo mapa en juego**: `SELECTABLE_ARENA_SCENARIOS` solo tiene `platanus`, así que la web no muestra el selector, la API y el torneo rechazan los demás y la cámara no sigue cambios de mapa. Lo que sigue sobre Chunk Battle y el cambio de mapa por pelea describe código que quedó sin uso, por si se vuelve a habilitar.

El mapa es **por pelea**. Los datos (centro, radio jugable, spawns, cámaras, geometría) están en `ARENAS` de `packages/protocol`. Platanus y Chunk Battle son los **seleccionables** (`SELECTABLE_ARENA_SCENARIOS`): se construyen por RCON en el mismo mundo vacío `arena` (`ARENA_WORLD`), en lugares distintos, así que cambiar de mapa entre peleas es instantáneo (sin reiniciar ni plugins). Pizza Spleef 2 es un mapa importado con su propio mundo y solo se usa poniéndolo en `ARENA_SCENARIO`.

`ARENA_SCENARIO` es el mapa **por defecto** y además decide el mundo del servidor: `platanus` o `chunk-battle` → `arena`; `pizza-spleef-2` → `pizza-spleef-2` (`entrypoint` del servicio `minecraft` en `docker-compose.yml`, `level-name` en `scripts/local/minecraft.sh`). `availableArenaScenarios(ARENA_SCENARIO)` da los que ese servidor puede construir (con la pizza, solo la pizza); `GET /api/defaults` los entrega en `arenas` (y el por defecto en `arena`).

De dónde sale el mapa de una pelea, en orden: el cuerpo de `POST /api/match/start` (`StartMatchBody { arena? }`, validado con zod: solo seleccionables), el ajuste `MatchSettings.arena` (lo guarda el selector **Mapa** de la web con `PUT /api/settings`; `null` = el por defecto) y, si no, `ARENA_SCENARIO`. Un mapa pedido que el servidor no tiene es un 400 (`ArenaUnavailableError`); uno guardado en los ajustes que ya no está (cambió `ARENA_SCENARIO`) se ignora con un aviso. El torneo lo pasa a `runOnce({ arena, seed })` desde el `MatchSpec`. El mapa y la semilla reales quedan en `MatchState.arena`/`seed`, en `MatchRecord.arena`/`seed` y en la entrada `start` de la transcripción. En una serie por rondas, todas las rondas usan el mismo mapa **y la misma semilla** (las mismas islas).

En el orquestador, `planArena(mapa, semilla)` (`apps/orchestrator/src/arena.ts`) arma el plan de la pelea (`ArenaSetup`: mapa, semilla, spawns reales e islas) y `applyWorldRules`, `buildArena`, `prepareFighter`, `resetFighterForRound` y `resetArenaForRound` lo reciben. El luchador recibe el `ArenaScenario` de la pelea en `FighterOptions.arena` (geometría, islas y volumen construible) y el prompt de sistema lo describe; nadie lee `ARENA_SCENARIO` en caliente durante una pelea.

| Mapa | Mundo | Preparación entre peleas |
| --- | --- | --- |
| `platanus` (la única en juego) | `arena`: vacío (void: flat con una capa de aire y bioma `the_void`), lo crea el servidor. | `apps/orchestrator/src/platanus.ts` construye todo desde cero: limpia a aire el volumen de la arena y una franja de 16 bloques a su alrededor (el mundo se guarda entre peleas: así no quedan a la vista restos de una arena anterior más grande), piso de piedra lisa de 25×25 centrado en (0, 64, 0) (23×23 caminables, un poco menos que la arena original), el logo de Platanus de 15×15 (`FLOOR_LOGO_ROWS` en `packages/protocol/src/logo.ts`, el mismo que dibuja la maqueta de la web) con un `/fill` por tramo contiguo de cada fila, la marca de concreto rojo y azul de cada spawn, y muros de vidrio de 6 bloques sobre la fila del borde, **sin techo** (nada de `barrier`). Luego elimina ítems, flechas y orbes de experiencia. Spawns a x = ±8, z = 0. Entre rondas solo borra lo colocado. |
| `chunk-battle` | `arena` (el mismo), centrado en (1000, 64, 0). | `apps/orchestrator/src/chunkbattle.ts`: dos islas flotantes, roja al oeste y azul al este, con superficies de 20×20 (núcleo de 16×16 + cornisa) separadas por **al menos 6 bloques de vacío** en x (los bordes de las islas temáticas son irregulares: en algunas filas el hueco es mayor). Sin muros: caer = KO. Limpia a aire todo el volumen (`clearBox`) en `/fill` troceados de ≤ 32768 bloques, mata las entidades que no son jugadores y, por isla: piso de bedrock bajo el núcleo, 32 capas de mineral (`phack:layer/1..25`) en el núcleo, la isla temática (`phack:chunk/<tema>`, la azul girada 180°) encima, y retira bloques prohibidos (command/structure block, spawner, barrier, light, jigsaw) y fluidos. La **semilla** decide el tema de cada isla (dos distintos de 10) y las capas; sin semilla (peleas de la web) se sortea. La roja siempre es la oeste: la ida y la vuelta de una pareja del torneo juegan las mismas islas con lados cambiados. Spawns sobre la superficie real de cada isla, mirando a la otra. Entre rondas se rehacen las mismas islas (el puente no sigue): los peleadores esperan arriba con caída lenta, que se les quita al terminar. |
| `pizza-spleef-2` | Propio, importado una sola vez de `infra/minecraft/worlds/pizza-spleef-2.zip`, solo cuando es el `ARENA_SCENARIO`. | Comprueba un bloque del mapa (detecta un mundo equivocado), restaura la pizza desde su plantilla mediana original y limpia restos del combate. Radio 25; el borde da al vacío. |

**Estructuras de Chunk Battle.** Vienen del mapa "Chunk Battle" (Minecraft 1.20.4, DataVersion 3700) que descargó el usuario; se copiaron solo los `.nbt` necesarios (10 islas temáticas de 22×48×22, sin `chuk_spawner`, y las 25 capas de 16×1×16) al datapack `infra/minecraft/datapacks/phack-chunkbattle/` (`pack_format` 26, namespace `phack`). Nada del mapa original se ejecuta. El núcleo de cada isla temática viene vacío (`structure_void`) y se rellena con las capas, igual que el generador original. `structures.json`, en el mismo datapack, guarda por tema el bloque de suelo del spawn (columna más cercana al centro con suelo firme, dos de aire encima, cielo abierto y sin lava cerca) y el alto de la columna central; lo lee el orquestador (y entra en el hash del benchmark). Se colocan con `place template phack:<id> x y z [none|180]` (con 180 la estructura gira en torno al punto, así que ese punto es su esquina máxima). Si falta el datapack, `buildArena` falla con un mensaje que lo dice.

**Bloques en Chunk Battle.** Los agentes usan las mismas tools `build` y `dig` de siempre. Con islas, el volumen construible (`arenaBuildBounds` en `packages/agent/src/construction.ts`) abarca las dos islas y el hueco desde 4 bloques bajo el suelo nominal, así que un plano de 6 bloques a la altura del suelo cruza el hueco (cada bloque se apoya en el anterior y el cuerpo avanza sobre lo puesto). `dig` rompe también el terreno de las islas (`isBreakable(nombre, "terrain")`); en Platanus y la pizza, solo lo colocado. La lista negra `ADMIN_BLOCKS` (`packages/agent/src/items.ts`: barrier, bedrock, bloques de comandos, structure block/void, jigsaw, light, portales y su marco, end gateway, reinforced deepslate, spawner) nunca se rompe ni se coloca, en ningún mapa. Como el hueco no se cruza sin bloques, `kitForArena` (`packages/protocol`) suma a un kit que no los trae 32 de roca y un pico de hierro en casillas libres, igual para ambos lados; lo que el kit ya trae no se toca y en los demás mapas el kit va igual.

En Docker, `itzg/minecraft-server` copia `WORLD` a `/data/$LEVEL` si esa carpeta no existe; por eso el `entrypoint` define `WORLD` solo para `pizza-spleef-2` (con un `WORLD` fijo, el primer arranque de `arena` importaría la pizza), y `DATAPACKS=/datapacks/phack-chunkbattle` solo para `arena` (la imagen lo copia a `/data/arena/datapacks` en cada arranque). En local, `scripts/local/minecraft.sh` copia el datapack en cada arranque. `GENERATOR_SETTINGS` solo afecta a mundos nuevos: el mapa importado trae los suyos. Los mundos viejos (`/data/platanus`) quedan sin uso.

Cada comando de construcción que toca chunks (el primero y los siguientes: el forceload los carga de a poco) se reintenta mientras el servidor responda que la zona no cargó. Las cámaras se ubican en +Z mirando al norte: el lado rojo (x negativo) queda a la izquierda, igual que en la web; en Chunk Battle encuadran ambas islas y el hueco. La cámara (`apps/camera/src/arena.ts`) pregunta el mapa de la pelea en curso a `GET /api/state` del orquestador (`CAMERA_ORCHESTRATOR_URL`; en Docker, `http://orchestrator:8787`) y, si el orquestador no tiene pelea (torneo por CLI), mira por RCON dónde están los agentes; al cambiar de mapa salta a sus tomas.

## Benchmarks

El tablero vive en `/bench` y se arma con `GET /api/bench?scenario=&min=`. La lógica pura está en `packages/protocol/src/bench.ts` y lo que se mide en cada ronda, en `apps/orchestrator/src/metrics.ts`.

- **Ajustes** (`PUT /api/settings`):
  - `rounds`: 1 es una pelea suelta; 2 o más, una serie;
  - `scenario`: duelo, dilema del prisionero, persuasión o inyección;
  - `horizon`, `seriesWin` y `refillKit`: horizonte, cómo se gana la serie y si se repone el kit;
  - `judge` y `rules`: juez LLM y reglas de cada lado.
- **Prompt de sistema genérico (no tocarlo para un caso de prueba)**: solo describe la arena, al otro agente y lo que se puede hacer y cómo (herramientas, kit, capacidades, percepción, comunicación y la mecánica de las rondas). No dice qué hacer, ni cómo se gana, ni el puntaje, ni las rondas, ni reglas, ni cómo comportarse. **Cualquier especificación del caso a medir va en el prompt del agente**, que escribe la persona o un pre-ajuste. Los ajustes `scenario`, `horizon`, `seriesWin`, `refillKit` y `rules` solo definen cómo cuenta el servidor los puntos y qué mide; en la web los fijan los pre-ajustes, y "Volver a un duelo libre" los restablece. La observación de una serie trae solo `round`, `maxRounds` (si se sabe) y los puntos, y al reanudar se cuenta con hechos cómo terminó la ronda (quién cayó, quién se rindió, quién tenía más vida), sin decir quién la "ganó".
- **Pre-ajustes** (`BENCH_PRESETS` en `packages/protocol/src/presets.ts`): configuraciones guardadas. Cada una fija escenario, rondas, comunicación, reglas, prompts y kits, y deja el modelo de cada lado como estaba (el espejo copia el de Rojo en Azul).
  - `POST /api/presets/:id` la carga; con `{ start: true }` además la ejecuta.
  - Con el id `todos` se corre la batería completa: `PresetRunner` empieza cada partida cuando termina la anterior y se corta si una partida se detiene o falla.
  - `POST /api/presets/stop` corta la batería.
- **Borrar el historial**: `DELETE /api/history` con `{ "confirm": "BORRAR" }`.
  - Mueve `matches.jsonl` a `DATA_DIR/archive/`, así que se puede recuperar, y deja el tablero en cero.
  - No se puede con una pelea o una batería en curso.
  - La web pide dos confirmaciones antes de llamarlo.

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
   - Las herramientas que ve el LLM son `ToolDef[]` y hoy dependen del kit (`kitToolNames`). Un escenario puede limitar los kits que se pueden elegir, quitar o agregar herramientas (por ejemplo, sin arco) y agregar contexto a la observación (por ejemplo, "hay lava a 3 bloques").
   - Mantener la interfaz `Fighter` (`connect`/`start`/`stop`) y `FighterEvents` sin cambios: así el orquestador no necesita saber qué escenario corre cada agente. Lo propio del escenario entra como un campo opcional nuevo en `FighterOptions`.

5. **Elegirlo desde la API y la web.**
   - Aceptar un cuerpo opcional en `POST /api/match/start`, por ejemplo `{ scenario?: ScenarioId }`, validado con zod; sin cuerpo, el escenario por defecto.
   - En `apps/web`, un selector junto al botón de iniciar, y mostrar el escenario en el historial.

6. **Cámara (`apps/camera`).**
   - Hoy mira un punto fijo (`ARENA.camera` hacia `ARENA.center`). Si el escenario nuevo vive en otro lugar del mundo, lo más simple es que el orquestador **teletransporte al bot de la cámara por RCON** al preparar la pelea, en vez de que la cámara conozca los escenarios.

7. **Verificación.** Agregar a `scripts/smoke.sh` una pelea en modo mock por cada escenario.

Regla general: **todo lo que cruza entre procesos se define primero en `packages/protocol`**, con un valor por defecto que mantenga compatibles los datos antiguos. Más de dos agentes (equipos, todos contra todos) es un cambio mayor: `Side` y los objetos `{ red, blue }` están en todo el contrato, y habría que pasarlos a listas.

### Contexto espacial y recursos del agente

Cada decisión recibe un snapshot nuevo del entorno dentro de un cilindro horizontal centrado en el agente, con toda la altura útil de la arena. `AGENT_OBSERVATION_RADIUS=16` configura su radio en bloques (admite 8–64); se pasa tanto en desarrollo local como en Docker. El contexto general de la arena y los límites modificables (`buildBounds`) se conservan independientemente del radio.

`world.format="cuboids-v1"` describe el mismo volumen sin enumerar por separado miles de bloques iguales. `palette` identifica materiales, colisión y peligros; cada entrada de `regions` es `[x0,y0,z0,x1,y1,z1,indiceMaterial,modificable]`, una caja de celdas con extremos inclusivos. `modificable=1` permite romper esa región, `0` protege la arena. Los permisos distintos nunca se fusionan, aunque el material sea el mismo. `unknown` usa cajas `[x0,y0,z0,x1,y1,z1]` de celdas no recibidas. La compresión conserva cada bloque y hueco dentro del radio; no reconstruye piso ni celdas desconocidas a partir de suposiciones.

Solo las celdas dentro de `world.bounds` **y** el radio de `world.coverage` que no figuran en `regions` ni `unknown` son aire conocido. Fuera de cobertura no se afirma nada del terreno. Es información de bloques recibida por el cliente, incluso detrás de obstáculos dentro del radio; no una imagen desde sus ojos. `nearbyEntities` incluye agentes, proyectiles y objetos tirados dentro del mismo radio. La posición del rival sigue disponible por separado en `opponentState`, que distingue ubicación conocida de línea libre de bloques sólidos (`lineOfSight`/`opponentVisible`).

`resources` describe el inventario vivo por casilla, con cantidades, encantamientos, desgaste, usos que implementan las herramientas y restricciones de inventario/vida/comida/recarga. El alcance y el terreno se validan al actuar: un uso disponible no garantiza que se pueda ejecutar desde la posición actual. `equipment` y `effects` agregan equipo puesto y efectos activos. El prompt pide reconsiderar los recursos y posibles combinaciones en cada decisión, sin fijar un objetivo distinto de las instrucciones del usuario ni pedir una narración de su deliberación.

`construction` informa estado (`active`, `paused`, `blocked`, `complete`), avance, motivo del bloqueo y celdas pendientes. El modelo elige geometría, materiales y orden de apoyos. El ejecutor se acerca para colocar, pero no inventa apoyos ni coloca dentro de un agente; puede necesitar que el modelo revise el plano, camine a otra posición o construya primero una escalera. Un obstáculo detiene el plano y permite reintentarlo con `build {}`. Reenviar exactamente el mismo plano conserva su avance; para reparar uno ya completo se envía un plano con las celdas a reparar. Se conservan los bloques que alcanzaron a colocarse al interrumpir. La lectura del mundo confirma cada colocación; los rechazos no se cuentan como éxito.

Ejemplo de llamada (las coordenadas deben elegirse usando la observación actual):

```json
{"blocks":[{"x":0,"y":65,"z":2,"material":"oak_planks"},{"x":0,"y":66,"z":2,"material":"red_wool"}],"reason":"Combino materiales para cubrir este lado y conservar una salida."}
```

Las transcripciones existentes guardan la observación completa, las llamadas y sus resultados: permiten revisar qué información recibió cada modelo y si reconsideró su equipo. El mock genera un plano explícito de demostración; no evalúa creatividad ni comprensión espacial de un LLM real. Las llamadas admiten hasta 60 s para no cortar respuestas con planos grandes; las acciones físicas continúan entre decisiones.

### Profiling del contexto

Cada decisión nueva guarda `contextProfile` en la transcripción: bytes UTF-8 del contexto normalizado, separados en prompt de sistema, definiciones de herramientas, observación actual, historial y campos de la observación. `tokensIn` y `tokensOut` siguen siendo los valores reales del proveedor: los bytes no se presentan como tokens ni como dólares. Los lectores siguen aceptando transcripciones anteriores sin ese perfil.

El modelo recibe la observación actual completa en el formato compacto. En el historial se guardan resúmenes de vida, posición, recursos restantes, acción y resultado, además del progreso de construcción y mensajes recientes; se omiten mapas, manuales de objetos y listas de bloques pendientes ya repetidas. El historial se limita a 12 mensajes y 6000 bytes, eliminando turnos completos para conservar las parejas de llamadas y resultados de herramientas. Un turno con un plano enorme puede salir entero del historial; el plano vigente y su progreso permanecen en la observación actual y en el ejecutor.

Para analizar una transcripción descargada de `GET /api/matches/:id/transcript`, sin llamar al LLM:

```bash
pnpm profile:context /ruta/absoluta/pelea.jsonl
pnpm profile:context /ruta/absoluta/pelea.jsonl --json
pnpm profile:context /ruta/absoluta/pelea-antigua.jsonl --assert-reduction=0.80
```

El script reporta los tokens históricos medidos y reproduce por separado la compresión del mapa, el resumen del historial y ambos cambios. Mide bytes del contexto normalizado, no el payload HTTP del SDK. Las transcripciones antiguas no guardaban los IDs ni todos los resultados exactos de cada request: el replay usa los mismos placeholders en sus cuatro variantes y conserva el prompt original para aislar las dos optimizaciones. En transcripciones nuevas, `measured.recordedContextBytes` muestra el perfil registrado por el agente. El ahorro facturado requiere comparar también el uso que informe el proveedor después del despliegue.

Muestra real analizada el 21 de noviembre de 2026: 22 decisiones, 1.587.691 tokens de entrada (media 72.168, p90 92.794, máximo 107.493) y 3788 de salida. En la última observación, el mapa era el 90% de sus bytes y contenía 1832 bloques de piso, paredes y techo.

| Replay sobre las mismas 22 decisiones | Media de contexto por llamada | p90 |
|---|---:|---:|
| Formato anterior | 176.661 bytes | 227.485 bytes |
| Solo compresión del mapa | 41.087 bytes | 49.227 bytes |
| Solo resumen del historial | 60.453 bytes | 72.805 bytes |
| Ambos cambios | 26.842 bytes | 29.069 bytes |

La reducción media del replay es 84,8%. Conserva el radio de 16 bloques, las coordenadas, el inventario actual y la libertad de construcción. Estos resultados son offline: no se gastaron llamadas adicionales ni se atribuyen tokens futuros al proveedor.

La comprobación adicional sobre cuatro partidas (102 decisiones) suma 7.712.080 tokens de entrada históricos y 19.154 de salida. El replay ponderado por llamadas pasa de 184.756 a 27.578 bytes por llamada: 85,1% menos contexto. Por partida, la reducción va de 79,7% a 85,6%; la muestra más corta tiene ocho decisiones y todavía no acumulaba todo el historial.
