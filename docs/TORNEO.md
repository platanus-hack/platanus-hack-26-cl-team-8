# Torneo de modelos

Arena 1v1 de agentes LLM sobre el benchmark de siempre (pelea PvP en Minecraft; el entorno
decide gana A, gana B o empate). Responde dos preguntas:

1. ¿Qué modelos de Vercel AI Gateway juegan parecido a **DeepSeek V4.1 Flash** (servido por
   Baseten)? → **calibración** contra la referencia con una banda de ±150 Elo.
2. Entre ellos, ¿cuál es el ranking y quién le gana a quién? → **liga** todos contra todos.

Comandos en el [README](../README.md#torneo-de-modelos). Este documento explica qué hace
cada etapa, qué se guarda y cómo leer los resultados.

## Piezas

```
packages/protocol/src/tournament.ts        contrato con la web (tipos + BENCHMARK_PROMPT + rutas)
apps/orchestrator/src/tournament/
  catalog.ts     catálogo del gateway → una versión por línea → modelos congelados
  rating.ts      Bradley–Terry regularizado (Elo), Laplace, bootstrap por clusters, matriz, calibración
  schedule.ts    parejas, ids estables, ida/vuelta, round robin, capacidad, vista previa del plan
  benchmark.ts   versión del benchmark (hash de prompt + escenario + tools + duración + tick)
  store.ts       DATA_DIR/tournaments/<id>/…, escritura atómica, lock de proceso, validAttempts
  runner.ts      calibración base → adaptativa → liga; límites; reintentos; pausa/reanudación
  sim.ts         MatchRunner simulado (ratings ocultos + RNG con semilla)
  minecraft.ts   MatchRunner real sobre MatchManager.runOnce
  report.ts      TournamentReport (lo que dibujan la web y el CLI)
  speed.ts       velocidad y eficiencia por modelo junto al Elo (pnpm tournament speed)
  cli.ts         pnpm tournament <plan|create|run|pause|status|leaderboard|speed|list>
apps/orchestrator/src/server.ts            GET /api/tournaments… y 409 en "Iniciar pelea" con lock vivo
apps/web/src/pages/arena.astro             leaderboard (/arena)
```

## 1. Catálogo y modelos congelados

`plan` y `create` descargan `https://ai-gateway.vercel.sh/v1/models` y, por cada modelo
elegido, `…/models/<id>/endpoints` (público, sin clave, sin gastar créditos).

- **Líneas:** los ids se agrupan por línea quitando versión, snapshot `-MMDD` y rutas
  (`-fast`, `-ultrafast`, `-highspeed`, `-ultraspeed`, `-free`, `-batch`). GPT Luna ≠ GPT
  Terra; Gemini Flash ≠ Gemini Flash-Lite. `-batch` se descarta siempre.
- **Una versión por línea:** la más reciente por `released`. Dentro de esa versión se
  prefiere exactamente `-fast`, luego otras rápidas, luego la base y al final `-free`.
- **Misma lista que la web:** antes de agrupar se descartan los modelos que pasan de `MODEL_PRICE_CAP` (la referencia se salta el tope), igual que `GET /api/models`, que a su vez sirve la referencia + las mismas versiones por línea (`rosterOf` en `apps/orchestrator/src/models.ts`). Una línea prioritaria cara aparece omitida como "no está en el catálogo".
- **Compatibilidad:** texto de entrada y salida y tool use. Si la versión más reciente no
  sirve (o no hay proveedor disponible) la línea se **omite con su motivo**; nunca se cae a
  una versión vieja.
- **Razonamiento:** `reasoning: "none"` cuando el modelo permite apagarlo. Si no (opciones
  de effort sin `none`, o endpoint con `reasoning.mandatory`), juega con el **nivel más bajo
  que acepta** (`minimal` o `low`). El nivel queda congelado por modelo en `tournament.json`
  y se muestra en el plan y en el leaderboard; su latencia extra se ve en la latencia por decisión.
- **Prioridad:** GPT Luna, Gemini Flash, Claude Haiku, Qwen Flash, GLM Flash, MiMo Flash,
  MiniMax Flash, Muse Ember. Sus 8 cupos son suyos: una línea automática solo entra si
  `--max-candidates` es mayor que 8, y una prioritaria omitida deja su cupo vacío (no lo
  llena un modelo cualquiera). Las que no caben quedan como *overflow* (no son omisiones).
- **Referencia:** `deepseek/deepseek-v4.1-flash-1017-fast`, proveedor `vercel`, enrutado con
  `providerOptions.gateway = { order: ["baseten"], only: ["baseten"] }`. Los demás modelos
  quedan fijados al endpoint disponible con mejor uptime en la última hora.

Al crear se congela todo en `tournament.json`: ids exactos, proveedor de inferencia,
precios, catálogo (sha256 + `catalog.json` crudo), límites, regla de calibración y
**versión del benchmark**. Un `run` posterior usa exactamente eso. Si el código cambió el
prompt fijo, las tools del agente, la geometría del escenario (en Chunk Battle también los
metadatos de las islas), la duración o el tick, el hash ya no coincide y `run` se niega con
un mensaje claro: hay que crear otro torneo. El id es `pvp-<escenario>-v2+<hash>`: `v2` marca
el mapa por partida (Platanus o Chunk Battle en el mismo mundo, con la semilla de la
partida decidiendo las islas) y, en Chunk Battle, los bloques y el pico que el mapa suma al
kit para cruzar con `build`/`dig` (los torneos `v1` ya no se reanudan).

Con el catálogo del 21-11-2026 y el plan por defecto entran las 8 prioritarias: GPT-6 Luna
Fast, Claude Haiku 5.5, Qwen 3.8 Flash y MiMo V2.6 Flash con razonamiento apagado; Gemini
3.8 Flash, GLM 5.3 Flash y MiniMax M3.1 Flash con `low`, y Muse Ember con `minimal`.

## 2. Partidas

- Cada partida tiene un id estable `stage:escenario:s<semilla>:<a>~<b>:<ida|vuelta>` (a < b
  por key). La **ida** pone a A en rojo; la **vuelta**, en azul.
- **Mapa y semilla.** El escenario del torneo (`--scenario platanus|chunk-battle`, o `--map`,
  en `plan` y `create`; por defecto `ARENA_SCENARIO`) y la semilla de cada `MatchSpec` llegan
  a la pelea real (`MatchManager.runOnce({ arena, seed })`), que construye ese mapa por RCON sin
  reiniciar Minecraft. En Platanus la semilla solo etiqueta réplicas (el estado inicial es el
  mismo). En **Chunk Battle** decide las islas (tema de cada lado y capas de mineral del
  núcleo): la ida y la vuelta comparten islas con los lados cambiados, así que la pareja
  juega ambas posiciones del mismo terreno. `run` se niega si el servidor carga otro mundo
  (p. ej. `ARENA_SCENARIO=pizza-spleef-2` con un torneo de Platanus).
- Ambos lados usan `BENCHMARK_PROMPT`, el mismo tick y la misma duración (60 s), sin
  explicación del resultado. Cada partida crea agentes nuevos (sin memoria entre partidas).
- **Latencia por decisión:** desde que el agente recibe el estado hasta que entrega una
  acción válida.
- **Válida vs infraestructura.** Una partida es `infra` si no llegó a "running", si un bot
  se desconectó, si terminó en `error`/`stopped`, o si un lado tuvo errores de LLM
  reintentables (429, 5xx, red, timeout) ≥ 3 seguidos o ≥ 20 % de sus llamadas, o si un
  lado tuvo errores de LLM y ninguna respuesta (clave, créditos o permisos: 401/402/403). Las `infra`
  se reintentan hasta `maxAttempts` (3) y **nunca** entran al rating; sí cuentan reloj y
  gasto. Perder por las reglas (morir, quedar con menos vida) es una partida válida.
- **Costo:** el que informa el gateway; si no informa, tokens × precio congelado.

## 3. Calibración

1. **Ronda base** (obligatoria, semilla 1): cada candidato contra DeepSeek y al menos un
   cruce con otro candidato, ida y vuelta.
2. **Evaluación:** Bradley–Terry con DeepSeek fijo en 1000 sobre todas las partidas válidas
   de calibración. Para cada candidato, `diff = rating − 1000` e intervalo `diff ± z·se`
   (z = 1.645, 90 %):
   - `inside`: el intervalo cae entero dentro de ±150 → mismo nivel.
   - `outside`: el intervalo no toca la banda → claramente mejor o peor.
   - `pending`: el intervalo cruza un borde → faltan partidas.
3. **Rondas adaptativas** (semilla 1 + ronda): solo para los `pending`, priorizando rivales
   no jugados y cercanos en rating, mientras la calibración completa no pase de
   `calibrationShare` (50 %) de la capacidad. Sin presupuesto, quedan `pending`.
4. **Entran a la liga:** los `inside` y los `pending` cuya estimación puntual cae dentro de
   la banda (provisionales). Si no cabe una semilla completa de la liga, se recorta a los n
   más cercanos a DeepSeek; los demás quedan como "clasificado, fuera por presupuesto".

En el reporte, `CalibrationRow.lo/hi` están en **escala de diferencia** (no de rating).

## 4. Liga oficial

Al terminar la calibración se congelan en `state.json` los modelos y las semillas de la
liga (desde 1000, nunca compartidas con la calibración). El calendario es semilla por
semilla: una semilla completa (todas las parejas, ida y vuelta) antes de la siguiente.
Con 10 modelos: 45 parejas, 90 partidas por semilla.

**El rating oficial sale solo de las partidas válidas de la liga:** Bradley–Terry
regularizado (prior gaussiano, `--prior-sd`) en escala Elo, V = 1, E = 0.5, D = 0, DeepSeek
fijo en 1000. Es determinista e independiente del orden de las partidas. El intervalo es
por bootstrap de clusters (escenario + semilla, 95 %) cuando hay ≥ 5 clusters; si no, por
Laplace (±1.96·se). El ranking se marca **provisional** si algún modelo tiene < 20
partidas válidas de liga, si hay < 3 semillas completas o < 5 clusters.

La matriz es fila-vs-columna con `(V + 0.5·E) / válidas`; una celda sin partidas es `null`
(se ve "—"), distinta de 50 %.

## 5. Presupuesto, pausa y reanudación

- **Límites:** reloj (`--max-minutes`, suma de duraciones de todos los intentos repartida
  entre los servidores), partidas válidas (`--max-matches`), USD (`--max-usd`) y
  concurrencia. Antes de cada partida se proyecta el siguiente intento con la **media
  observada** (o la estimación del catálogo si aún no hay ninguno); si no cabe, se para con
  el motivo en `stopReason`.
- **Pausa:** Ctrl+C en el `run` o `pnpm tournament pause <id>` (crea `PAUSE` en la carpeta
  del torneo) ⇒ termina la partida en curso, guarda y sale. Un segundo Ctrl+C corta la
  partida en curso; ese intento no se registra.
- **6 fallos de infra seguidos** pausan el torneo (algo está caído).
- **Reanudar** (`run <id>` otra vez) recalcula el calendario determinista desde la config y
  el estado congelados y salta los matchId que ya tienen un intento válido: nunca duplica.
- **Lock:** `DATA_DIR/tournaments/.lock` con el pid del `run`. Un solo `run` a la vez; el
  orquestador responde 409 a "Iniciar pelea" mientras el pid siga vivo. Un lock de un pid
  muerto se ignora.
- **Concurrencia > 1** exige un servidor de Minecraft por partida; por ahora el modo real
  solo acepta 1 (el simulado acepta cualquiera).

## 5b. Velocidad por modelo (solo lectura)

`pnpm tournament speed <id>` (o `--dir <carpeta>` con `tournament.json`, `attempts.jsonl` y
`state.json` sueltos, p. ej. descargados del servidor) junta cada modelo con su Elo oficial y
lo que ya guardan los intentos: decisiones, latencia, inválidas, tokens, daño y costo. No
cambia el torneo ni el rating, y se puede correr con la liga en curso. `--stage league`
(por defecto), `calibration` o `all`; `--json` da el `SpeedReport` crudo.

- **Parte de las decisiones** (`decisionShare`): mis decisiones / las de los dos en la misma
  partida, promediada. Es la medida de velocidad que no depende de la duración: los dos
  pelearon el mismo tiempo. 50 % = igual de rápido que el rival.
- **Decisiones por minuto de pelea** (`decisionsPerFightMin`): exacta, con la duración real de
  la pelea (`fightMs`); solo en ligas desde la versión sin tope de 1,5 s.
- **Decisiones por minuto de reloj** (`decisionsPerWallMin`): aproximada. `startedAt`/`endedAt`
  de un intento incluyen preparar la arena, conectar los bots y la cuenta regresiva, así que
  subestima.
- **Latencia**: media exacta (ponderada por decisiones) y mediana de los p50/p95 de cada partida.
- **Correlación** de Spearman entre el Elo y cada métrica. Con 9 modelos es indicativa, no
  prueba de causa.

El cálculo es puro (`buildSpeedReport` en `apps/orchestrator/src/tournament/speed.ts`): se puede
sumar al `TournamentReport` o servir en una ruta propia para el leaderboard de la web.

## 6. Archivos

```
DATA_DIR/tournaments/
  .lock                 { pid, id, startedAt } mientras corre un run
  <id>/
    tournament.json     TournamentConfig congelada (se escribe una vez)
    catalog.json        catálogo crudo descargado
    attempts.jsonl      MatchAttempt por línea, append-only (reintentos = varias líneas)
    state.json          RunnerState: liga congelada, rondas adaptativas, parada, pausa
    PAUSE               (opcional) pedido de pausa
    matches.jsonl       MatchRecord de cada pelea que llegó a empezar (métricas por ronda incluidas)
    transcripts/<recordId>.jsonl   transcripción completa: cada observación, respuesta del LLM,
                        reason, acción y evento
```

Desde la liga sin tope de 1,5 s, cada intento trae además `recordId` (para cruzarlo con su
registro y su transcripción), `fightMs` (duración real de la pelea, sin la preparación) y, por
lado, `latenciesMs` (la latencia de cada decisión, en orden). Las ligas de antes no los traen:
solo guardaban el resumen de `attempts.jsonl`. El registro y la transcripción van en la
carpeta del torneo, no en el historial de la web, para no mezclarse con sus peleas en `/bench`.
Una transcripción pesa del orden de cientos de KB: unas 300 partidas son unos cientos de MB.

Por cada matchId cuenta solo el **primer** intento válido (`validAttempts`). `DATA_DIR`
relativo se resuelve desde `apps/orchestrator` (igual que el orquestador en `pnpm dev`).
En Docker el orquestador usa `/data`: para que la web vea un torneo corrido desde el host,
apunta `DATA_DIR` al mismo volumen.

## 7. Modo simulado

`--simulate` congela los mismos modelos (sin consultar endpoints) con `clientProvider:
"mock"` y corre con `sim.ts`: cada modelo tiene un rating oculto derivado de su key, cada
intento usa un RNG sembrado con (torneo, matchId, intento), hay empates, y las duraciones,
costos y latencias son simuladas (≈ 60 s de pelea + 20 s de preparación), así que los
límites de reloj se comportan como en una corrida real aunque termine en segundos. Sirve
para ensayar el plan y para los tests (`pnpm --filter @phack/orchestrator test`).

## 8. API (solo lectura)

| Ruta | Respuesta |
|---|---|
| `GET /api/tournaments` | `TournamentSummary[]`, el más reciente primero |
| `GET /api/tournaments/:id` | `TournamentReport` (404 si no existe) |
| `GET /api/tournaments/:id/pairs/:a/:b` | `MatchAttempt[]` de la pareja, válidos e infra, ambas etapas, en cualquier orden de a/b; las keys van con `encodeURIComponent` (traen `/`) |
