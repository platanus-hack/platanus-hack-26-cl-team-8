# Handoff — Arena de prompts (21 nov 2026)

## Lo primero que tienes que hacer

Abrir el sitio, iniciar una pelea y mirar si la web se ve bien. El último commit de `main`
(`985dbdf`) está desplegado, compila y pasa los tests, pero **nadie lo ha visto funcionando**:
la sesión se cortó justo antes de esa revisión. Si algo se ve roto, la sección
"Si la web quedó rota" dice cómo volver atrás en un minuto.

## Estado en corto

| Commit en `main` | Qué trae | Compila y pasa tests | Probado en vivo |
|---|---|---|---|
| `7572ae3` | Sin títulos ni avisos dentro del juego | Sí | Sí: 6 cuadros del video sin ningún título |
| `84c5deb` | Kits, solo modelos baratos, solo Vercel AI | Sí (209 tests) | Sí, en parte (ver abajo) |
| `985dbdf` | Sincronía con el video, cuenta regresiva, pensamientos a los lados, ajustes de kits | Sí (234 tests) | **No** |

"Compila y pasa tests" = typecheck de los 6 paquetes, tests de `env`, `llm`, `agent` y
`orchestrator`, y `astro build` de la web, todo corrido en el servidor dentro de un contenedor
`node:22`. El paquete `camera` no se compiló en esa verificación (no se tocó; solo cambió
`libs/env`, que usa).

La rama `kits` de GitHub tiene el mismo contenido que `main` en dos commits "WIP". Ya no hace
falta: se puede borrar.

## Qué se pidió y dónde quedó cada cosa

### 1. Kits (hecho, probado en parte)
- Seis kits definidos en `packages/protocol/src/index.ts` (`KITS`): `classic`, `archer`, `tank`,
  `berserker`, `ender`, `builder`. Cada lado elige el suyo; va en el campo `kit` del prompt.
- Web: selector de kit en cada editor, con la descripción y el inventario dibujado abajo
  (`apps/web/src/scripts/inventory.ts`, `items.ts`, `pixelicons.ts`, `icons.ts`).
- Orquestador: `fighterKitCommands` y `prepareFighter` en `apps/orchestrator/src/arena.ts`
  (comandos `item replace` y `effect give` de Minecraft 1.20.4).
- Bot: dos herramientas nuevas en `packages/agent/src/`: `pearl` (perla de ender, hacia el rival o
  para escapar) y `build` (muro de 3x2 entre el bot y el rival). `tools.ts` ofrece al modelo solo
  las herramientas que su kit puede usar.
- **Probado en vivo con `84c5deb`:** el selector y el inventario se ven bien; en una pelea
  Enderman contra Constructor con el LLM simulado, los ítems llegaron y la perla teletransportó al
  bot a 1,8 bloques del rival. El techo invisible de la arena no se ve en el video.
- **Sin probar en vivo:** el muro de `build` (nunca se llegó a usar en la prueba), y todo lo que
  cambió después en `985dbdf`: Velocidad I del Berserker, perla apuntada por ticks, muro a 3
  bloques, `eat`/`shoot` que ya no dejan al bot quieto.

### 2. Solo modelos baratos (hecho y probado)
- El orquestador baja el catálogo público de Vercel AI Gateway, deja los modelos de hasta 1 USD
  por millón de tokens de entrada y 5 de salida, y los publica en `GET /api/models`
  (`apps/orchestrator/src/models.ts`). Hoy son 138.
- `PUT /api/prompts/:side` rechaza un modelo fuera de la lista (probado: `claude-opus-5.5`
  responde 400). Al empezar una pelea se vuelve a revisar.
- La web ya no deja escribir un id de modelo a mano.

### 3. Solo Vercel AI (hecho y probado)
- Se borraron las conexiones a OpenAI, Anthropic, OpenRouter y "gateway". Quedan `vercel` y
  `mock` (el LLM simulado que usan los tests y el smoke).
- Los datos guardados con proveedores viejos se migran al leerlos
  (`migrateStoredConfig` en `apps/orchestrator/src/store.ts`).
- El `.env` del servidor ya tiene `LLM_PROVIDER=vercel`. Un `.env` con un proveedor borrado hace
  que el orquestador y la cámara no arranquen.

### 4. Sincronía entre el video y los datos (escrito, sin probar)
- Problema medido antes del cambio: la imagen llega ~1,43 s tarde y la página retrasaba los
  datos entre 0,24 y 1,87 s, así que las barras se adelantaban hasta 1,2 s.
- Cambio: cada evento se aplica cuando la imagen llega a ese instante, usando la hora que trae
  cada cuadro del stream (`streamClock` / `videoServerNow` en `apps/web/src/scripts/player.ts`;
  la cola está en `main.ts`).
- Falta: repetir la medición y calibrar. El procedimiento completo, con el código para pegar,
  está en `docs/handoff/medir-sincronia.md`. Se calibra sin recompilar con `?sync=<ms>` en la URL
  (por defecto 400) y se deja fijo con la variable de build `PUBLIC_STREAM_PIPELINE_MS`.
  `docker-compose.yml` todavía no pasa esa variable al build de la web.
- En la consola del navegador, `__arenaSync()` muestra el atraso que la página está aplicando y de
  dónde lo saca (`source` debería decir `"dates"`).

### 5. Cuenta regresiva (escrito, sin probar)
- El estado de la pelea trae `countdownEndsAt` (protocolo y `apps/orchestrator/src/match.ts`).
- La web muestra 3, 2, 1, ¡Pelea! al centro, con un beep (`apps/web/src/scripts/countdown.ts`).
  Nada se muestra dentro del juego.

### 6. Pensamientos en vivo a los lados (escrito, sin probar)
- Una columna por agente sobre el video (Rojo a la izquierda, Azul a la derecha) con sus últimos
  5 pensamientos, efecto de máquina de escribir y la acción elegida
  (`apps/web/src/scripts/thoughts.ts`).
- Reemplaza los subtítulos que había en las esquinas de abajo. La lista "Eventos" sigue igual.
- Nadie lo ha visto dibujado: las posiciones se calcularon a mano.

## Pendientes, en orden

1. **Mirar la web con `985dbdf`** en escritorio y en un teléfono: columnas de pensamientos,
   cuenta regresiva, marcador y botón de iniciar sin taparse entre sí. Revisar la consola del
   navegador por errores.
2. **Medir y calibrar la sincronía** con `docs/handoff/medir-sincronia.md`.
3. **Pelea real con cada kit nuevo**, mirando la lista "Eventos": que el Berserker camine más
   rápido, que `build` levante el muro, que la perla con `target: "away"` funcione, y que no
   aparezcan avisos "El servidor no confirmó un comando del kit" (ver riesgos).
4. **Revisión de código de `985dbdf`.** Había cuatro revisores corriendo (tipos, lógica de pelea,
   web y API, sincronía e interfaz) y se cortaron antes de entregar nada. `84c5deb` tampoco tuvo
   revisión.
5. **Balance de los kits.** Los números son cálculo, no pruebas. Qué medir y qué perillas tocar
   está al final de `docs/handoff/critica-balance.md`.

Para después: el marcador no se adapta a pantallas angostas (ya era así antes); la torre de
`build` se recortó a propósito (solo hay muro); documentar `?sync` y
`PUBLIC_STREAM_PIPELINE_MS` en el README.

## Riesgos conocidos (dichos por los mismos agentes que escribieron el código)

- **Avisos del kit en cada pelea.** `prepareFighter` avisa si la respuesta de RCON no calza con
  `/Replaced a slot|Applied effect/i`. Ese texto se escribió de memoria. Si el servidor responde
  con otras palabras, cada pelea mostrará 8 a 10 avisos por lado aunque el kit llegue bien. Se
  arregla ajustando esa expresión en `apps/orchestrator/src/arena.ts`.
- **Velocidad I.** El arreglo depende de que el servidor mande el atributo con el nombre
  `minecraft:generic.movement_speed`. Si el Berserker no camina más rápido, mirar el listener
  `entity_update_attributes` en `packages/agent/src/fighter.ts`.
- **Sincronía en Safari.** Ese camino usa `getStartDate()` y no se probó.
- **Perla contra un muro propio.** Si la perla mueve al bot 2 bloques o menos no cuenta como
  aterrizaje, y el daño de la caída se le anota al rival.
- **Absorción.** Los corazones amarillos de la manzana dorada no cuentan en la vida que ve el
  marcador ni en el desempate por tiempo.
- **Columnas de pensamientos.** Se ocultan mientras se ve el cartel del ganador (decisión del
  agente, no pedida). Los últimos pensamientos quedan en "Eventos".

Las listas completas de dudas están en `docs/handoff/informe-ronda2-*.md`, sección 3 de cada uno.

## Cómo verificar un cambio (compilar y tests)

En cualquier máquina con Docker, desde la raíz del repo:

```bash
docker run --rm -e CI=1 -v "$PWD":/repo -w /repo node:22 bash -c '
npm i -g pnpm@10 >/dev/null 2>&1
pnpm install --frozen-lockfile --filter "!@phack/camera"
for p in @phack/protocol @phack/env @phack/llm @phack/agent @phack/orchestrator @phack/web; do
  pnpm --filter $p --if-present typecheck || exit 1
done
for p in @phack/env @phack/llm @phack/agent @phack/orchestrator; do pnpm --filter $p test || exit 1; done
pnpm --filter @phack/web build'
```

En Fedora con SELinux, el volumen va como `-v "$PWD":/repo:z`. El contenedor deja carpetas
`node_modules` y `.pnpm-store` que son de root.

## Despliegue

- Lo que entra a `main` se despliega solo: en el PC del dueño del servidor corre un loop que
  ejecuta `scripts/deploy-main.sh` cada 2 minutos. Ese script copia el commit de `origin/main` al
  servidor y hace `docker compose up -d --build`. Una pelea en curso se corta al desplegar.
- No corras `deploy-main.sh` a mano mientras ese loop esté andando: dos despliegues a la vez
  dejan contenedores a medio crear.
- El video lo produce un cliente real de Minecraft que corre en el servidor como servicio
  `phack-stream` (fuera de Docker; ver "Transmisión con el cliente real de Minecraft" en el
  README).
- La dirección del servidor y sus credenciales no están en el repo: pídeselas al dueño. Las
  claves viven solo en el `.env` del servidor.

## Si la web quedó rota

Volver al commit anterior, que sí se vio funcionando:

```bash
git revert 985dbdf
git push origin main
```

El loop lo despliega en unos minutos. Con eso se pierden la sincronía nueva, la cuenta regresiva,
los pensamientos a los lados y los ajustes de kits, pero quedan los kits, los modelos baratos y
solo Vercel AI. Los prompts guardados en el servidor siguen sirviendo.

## Cosas que quedaron en el servidor y en el PC del dueño

- En el servidor, los prompts guardados quedaron con kit Enderman (Rojo) y Constructor (Azul); el
  texto de los prompts no se tocó.
- En el servidor hay dos carpetas de prueba que se pueden borrar con sudo:
  `~/phack2026-wip` y `~/phack2026-wip2`.
- En el PC del dueño hay trabajo de otro agente sin subir (arena circular:
  `apps/orchestrator/src/arena.ts`, `circle.ts`, `circle.test.ts`, una palabra en
  `packages/agent/src/prompt.ts` y un zoom en `apps/camera/src/index.ts`). Toca las mismas zonas
  de `arena.ts` y `prompt.ts` que cambiaron en `main`, así que al traer `main` habrá que
  mezclarlo a mano.

## Documentos de apoyo (`docs/handoff/`)

| Archivo | Para qué |
|---|---|
| `01-spec-kits-modelos-proveedores.md` | Lo que se pidió a los agentes en la primera ronda |
| `02-spec-sincronia-cuenta-pensamientos.md` | Lo mismo para la segunda ronda, con las mediciones |
| `03-correcciones-de-los-criticos.md` | Los 14 ajustes de balance y robustez que se aplicaron |
| `diseno-kits.md` | Diseño completo de los kits y las herramientas, con las cuentas de daño |
| `critica-balance.md` | Qué pares de kits quedan disparejos y qué medir en las primeras peleas |
| `critica-factibilidad.md` | Trampas de mineflayer en 1.20.4 (atributos, perla, colocar bloques) |
| `informe-ronda2-orquestador.md`, `-agente.md`, `-web.md` | Qué cambió cada agente y de qué no está seguro |
| `medir-sincronia.md` | Procedimiento para medir y calibrar la sincronía |

Los specs e informes se escribieron para agentes: mencionan rutas de una carpeta temporal que ya
no existe. Lo que apuntaban está en esta misma carpeta.
