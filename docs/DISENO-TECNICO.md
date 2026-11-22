# Diseño técnico de Prompt Arena

Prompt Arena es una **simulación multiagente en tiempo real**: dos agentes autónomos, cada uno dirigido por un modelo de lenguaje distinto y por un prompt escrito por una persona, compiten dentro de un entorno físico tridimensional y no determinista (un servidor de Minecraft Java 1.20.4). El sistema reúne en una sola cadena de procesamiento la inferencia de LLM con invocación de herramientas, el control motor a 10 Hz sobre un motor de física, la orquestación del mundo por un canal administrativo, la transmisión de video de baja latencia, la telemetría sincronizada con ese video y un marco de evaluación estadística de modelos.

Este documento describe la arquitectura, los algoritmos y las decisiones de ingeniería de cada capa. La descripción operativa (comandos, despliegue, API) está en el [README](../README.md), en [ARQUITECTURA.md](ARQUITECTURA.md) y en [TORNEO.md](TORNEO.md).

| Dimensión | Valor |
|---|---|
| Código | ≈ 47 000 líneas de TypeScript estricto en un monorepo de pnpm (3 aplicaciones, 3 paquetes, 2 librerías) |
| Pruebas | 891 casos en 61 suites de vitest, sin dependencia de Minecraft ni de red |
| Servicios en ejecución | 7 (Minecraft, orquestador, cámara, cliente renderizado por GPU, MediaMTX, Caddy, cloudflared) |
| Frecuencias de control | Cuerpo del agente a 10 Hz; física del servidor a 20 Hz; deliberación asíncrona limitada solo por la latencia del modelo (piso de 300 ms) |
| Latencia de video | LL-HLS con segmentos de 1 s y partes de 200 ms |

---

## 1. Topología del sistema

El sistema se organiza en un **plano de control** (estado de la pelea, decisiones de los agentes, comandos al mundo) y un **plano de medios** (video), que son independientes entre sí: la caída de uno no degrada al otro.

```
               ┌──────────────────────── plano de control ────────────────────────┐
 navegador ──▶ Caddy / Worker ──/api──▶ orquestador ──RCON──▶ Minecraft (Paper 1.20.4)
     ▲                │                    │  ▲                     ▲
     │                │                    │  └── 2 agentes (mineflayer) ─┘ protocolo MC
     │                │                    └──▶ Vercel AI Gateway (N modelos)
     │                └──/live──▶ MediaMTX ◀──RTMP── ffmpeg/NVENC ◀── cliente MC (VirtualGL)
     │                                                                   ▲
     └──────────── LL-HLS + WebSocket ───── plano de medios ──────── bot cámara (/spectate)
```

- **Origen único.** Todo el tráfico público entra por un proxy inverso (Caddy en el servidor, o un Worker de Cloudflare en el borde). No hay CORS, ni URLs absolutas, ni superficie de ataque cruzada entre orígenes.
- **Conectividad sin ingreso.** En el despliegue en el borde, el Worker alcanza al orquestador y a MediaMTX por **Workers VPC** sobre un túnel saliente (QUIC) sin hostname público ni reglas de ingress: los puertos internos solo son alcanzables desde el propio Worker. El acceso SSH de despliegue pasa por Cloudflare Access con tokens de servicio.
- **Aislamiento del mundo.** El servidor de Minecraft corre en modo offline y su RCON nunca se publica; los bots y el orquestador lo alcanzan solo por la red interna de compose.

---

## 2. Contrato tipado como fuente única de verdad

`packages/protocol` es un **contrato isomórfico**: los mismos esquemas zod se ejecutan en Node (orquestador, agentes, cámara, CLI del torneo) y en el navegador (web y Worker). De él se derivan los tipos estáticos, la validación en tiempo de ejecución y las rutas de la API.

- **Un dato, tres proyecciones.** Un kit es un dato declarativo (`KITS[id]`) del que se derivan, sin duplicación, los comandos RCON que lo entregan, las herramientas que se ofrecen al LLM (`kitToolNames`) y el inventario que dibuja la web. Es imposible que la interfaz, el mundo y el espacio de acción del agente diverjan.
- **Evolución de esquemas retrocompatible.** Cada campo nuevo entra con un valor por defecto en el esquema, y los datos persistidos de versiones anteriores se migran al leerlos (`migrateStoredConfig`). Un historial de semanas atrás valida contra el contrato actual sin pasos de migración explícitos.
- **Tipos de dominio refinados.** `KitSlot`, por ejemplo, solo admite los nombres de casilla que existen en el juego; un error de tipeo en un kit es un error de compilación, no un fallo silencioso en producción.

---

## 3. Arquitectura cognitiva del agente

Cada agente (`packages/agent`) es un sistema de control **jerárquico de dos frecuencias**: una capa deliberativa asíncrona (el LLM) emite intenciones de alto nivel, y una capa reactiva síncrona (el "cuerpo") las traduce en control motor continuo. Esta separación es la que permite que un modelo que tarda un segundo en responder siga combatiendo con precisión de décimas de segundo.

### 3.1 Bucle deliberativo

```
 observación ──▶ ventana de contexto ──▶ LLM (tool calling) ──▶ plan de acciones ──▶ cuerpo
      ▲                                                                                 │
      └──────────────────────────── retroalimentación del mundo ◀──────────────────────┘
```

- **Deliberación no bloqueante.** El bucle decide en cuanto el modelo responde, con un piso de 300 ms entre decisiones que solo existe para evitar bucles de reintento ante fallos instantáneos. El rendimiento del agente queda acotado por la latencia real de cada modelo, no por un reloj artificial: la velocidad de inferencia se convierte en una variable experimental medible.
- **Planes multi-acción.** Una respuesta puede invocar hasta ocho herramientas; `ActionPlan` las encola y el cuerpo las consume en orden. Las acciones de duración abierta (`approach`, `attack`, `retreat`, `move`, `shoot`, `wait`) reciben un horizonte temporal implícito cuando no son las últimas, garantizando el progreso de la cola.
- **Exclusión por generación (fencing).** `RoundGate` asigna a cada llamada al LLM un número de generación. Si entre la petición y la respuesta la ronda se pausa o se reinicia, la generación avanza y la respuesta obsoleta se descarta sin ejecutarse. Es el mismo patrón de *fencing tokens* que usan los sistemas distribuidos para impedir que un líder depuesto escriba.
- **Preempción por eventos.** `HearWake` interrumpe la espera entre decisiones cuando llega un mensaje del rival, y encadena una decisión inmediata si el mensaje llegó durante una inferencia en curso. El invariante es estricto: nunca hay dos decisiones concurrentes por agente, y nunca se decide más rápido de lo que responde el modelo.
- **Tolerancia a fallos de inferencia.** Cada llamada tiene un `AbortController` con plazo de 60 s. Los errores se clasifican (`classifyLlmError`) en transitorios (429, 5xx, red, timeout) y definitivos (401/402/403), una distinción que el torneo usa para separar fallos de infraestructura de derrotas legítimas.

### 3.2 Percepción volumétrica y compresión sin pérdida

En cada decisión el agente recibe una **instantánea volumétrica** del entorno: un cilindro horizontal de radio configurable (8 a 64 bloques) que cubre toda la altura útil de la arena, más el estado del rival, las entidades cercanas (proyectiles, objetos), el inventario vivo, los efectos activos y el estado de cualquier construcción en curso.

Serializar ese volumen bloque a bloque saturaba la ventana de contexto: en una muestra real, el mapa era el 90 % de los bytes de la observación. La solución es un formato propio, `cuboids-v1`:

- **Descomposición en ortoedros maximales.** `packCells` recorre las celdas en orden lexicográfico (y, z, x) y expande cada semilla de forma voraz en tres ejes sucesivos (fila → plano → volumen) mientras la etiqueta sea homogénea. Es una variante tridimensional del *greedy meshing* de los motores de vóxeles.
- **Etiquetas compuestas.** Cada celda se codifica como `material × 2 + modificable`, de modo que dos regiones del mismo material pero con distinto permiso de edición nunca se fusionan. Los materiales se indexan contra una paleta con propiedades de colisión y peligro.
- **Semántica epistémica explícita.** El formato distingue entre lo que se sabe sólido, lo que se sabe vacío (el aire es implícito: lo que está dentro de la cobertura y no figura en ninguna región) y lo **desconocido** (celdas que el cliente no recibió). El agente nunca recibe terreno inferido ni supuesto.
- **Línea de visión.** `lineOfSight` y `faceInSight` trazan rayos contra la rejilla de vóxeles para distinguir la posición conocida del rival de su visibilidad efectiva.

La compresión es **sin pérdida**: conserva cada bloque y cada hueco dentro del radio. Medida en reproducción offline sobre transcripciones reales (102 decisiones en cuatro partidas), reduce el contexto medio por llamada de 184 756 a 27 578 bytes, un **85,1 % menos**, sin reducir el radio de percepción ni la libertad de construcción.

### 3.3 Gestión de la ventana de contexto

- **Asimetría temporal.** La observación actual va íntegra; las anteriores se reducen a resúmenes de vida, posición, recursos, acción y resultado (`summarizeObservation`). El modelo conserva la *trayectoria* sin volver a pagar por mapas ya vistos.
- **Recorte que preserva invariantes del protocolo.** `trimHistory` aplica un doble presupuesto (12 mensajes y 6000 bytes) eliminando **turnos completos** desde el inicio, de modo que nunca queda un resultado de herramienta huérfano de su llamada: los proveedores rechazan secuencias con pares rotos.
- **Perfilado de contexto.** Cada decisión registra un `contextProfile` con los bytes UTF-8 de cada componente (prompt de sistema, definiciones de herramientas, observación, historial y cada campo de la observación), separado de los tokens reales que informa el proveedor. `pnpm profile:context` reproduce las optimizaciones sobre transcripciones antiguas para aislar el efecto de cada una.
- **Conocimiento condicionado.** El conocimiento táctico de PvP vive en un documento markdown seccionado (`knowledge/pvp.md`); `knowledgeFor(kit)` inyecta en el prompt de sistema solo las secciones pertinentes a las herramientas del kit. Un agente sin arco no paga tokens por la teoría del arco.

### 3.4 Control motor y modelado físico

El cuerpo es una **máquina de estados** que corre cada 100 ms sobre la física de mineflayer y ejecuta la intención vigente con modelos físicos explícitos, todos implementados como funciones puras y verificados sin Minecraft:

- **Balística de proyectiles con compensación de blanco móvil.** `computeAim` adelanta la posición horizontal del rival según su velocidad estimada y eleva la mira para compensar la caída parabólica de la flecha (velocidad de salida ≈ 57 bloques/s, gravedad de 20 bloques/s²).
- **Estimación de velocidad.** `estimateVelocity` deriva la velocidad del rival de muestras de posición fechadas, la suaviza con la estimación anterior y descarta los desplazamientos por encima de 15 bloques/s como teletransportes (perlas), no como movimiento.
- **Trayectoria de perlas de ender.** `pearlRange` integra la trayectoria con gravedad y arrastre aerodinámico por tick (0,03 y 0,99), y `pearlPitch` resuelve el problema inverso: el ángulo de lanzamiento que hace caer la perla a una distancia y un desnivel dados, dentro del rango de cabeceo admisible. El lanzamiento se sincroniza con el siguiente tick de física para que el servidor reciba la mira antes que el proyectil.
- **Golpe crítico en fase con el salto.** `critStep` reproduce la condición de crítico de Minecraft 1.20.4 (atacante en caída, sin carrera, arma recargada) y programa el salto unos 300 ms antes de que termine la recarga del arma, de modo que el ápice del salto coincida con la disponibilidad del golpe. Si la ventana se pierde, degrada a un golpe normal para no romper el ritmo.
- **Geometría táctica.** Desplazamiento lateral perpendicular a la línea de enfrentamiento con reflexión en los muros, órbita angular alrededor del rival, mantenimiento de distancia y retirada acotada a la región jugable (`tactics.ts`, `geometry.ts`), con soporte para regiones jugables disjuntas (islas flotantes).
- **Construcción por planos libres.** `build` acepta un plano arbitrario de hasta 512 celdas que diseña el propio modelo. `ConstructionPlan` resuelve dónde ubicar el cuerpo para cada colocación, verifica la cara de apoyo y su visibilidad, **confirma cada bloque leyendo el mundo** (un rechazo del servidor nunca se cuenta como éxito) y expone estados `active`/`paused`/`blocked`/`complete` con el motivo del bloqueo. Reenviar el mismo plano es idempotente: conserva el avance.
- **Correcciones de bajo nivel al protocolo.** `storeAttributes` duplica los atributos de entidad con y sin espacio de nombres, porque Paper 1.20.4 los envía con `minecraft:` y la física de mineflayer los busca sin él, de modo que la velocidad de movimiento que simula el cliente coincide con la que aplica el servidor.

---

## 4. Orquestador: autoridad de estado y coordinación

`apps/orchestrator` es la **única autoridad de estado** del sistema. Todos los demás componentes son proyecciones de ese estado o productores de eventos hacia él.

### 4.1 Modelo de consistencia

- **Instantánea + deltas.** El evento `state` transporta el estado completo y es la verdad; `thought`, `action`, `damage` y el resto son deltas para la interfaz. La pérdida de un delta se corrige sola con la siguiente instantánea, lo que da **convergencia eventual sin cursores ni retransmisión**: un cliente que se reconecta queda al día con un solo mensaje.
- **Difusión con regulación de caudal.** El `Hub` limita las instantáneas a una cada 250 ms, salvo en las transiciones de fase, que se emiten de inmediato. El canal WebSocket es estrictamente servidor → cliente; toda mutación entra por HTTP, se valida con zod y su efecto vuelve a todos los clientes por difusión.
- **Ciclo de vida como máquina de estados.** `idle → preparing → running → finished`, con la cuenta regresiva modelada como un instante absoluto (`countdownEndsAt`) en vez de una fase: cada cliente la dibuja contra el reloj del servidor.

### 4.2 Orquestación del mundo por RCON

- **Canal serializado con reconexión perezosa.** `RconClient` mantiene una cola estrictamente ordenada (un comando a la vez) con reconexión automática; el orquestador puede arrancar antes que el servidor de Minecraft y converge solo.
- **Generación procedural declarativa.** Las arenas se describen como funciones puras que devuelven listas de comandos, verificables en pruebas sin servidor. La Arena Platanus se reconstruye desde cero en cada pelea, incluido el logo rasterizado del piso, emitido como un `/fill` por tramo contiguo de cada fila (codificación por longitud de serie).
- **Mapas sembrados.** Chunk Battle compone dos islas flotantes a partir de estructuras NBT empaquetadas en un datapack propio; una **semilla** determina el tema de cada isla y las capas mineralógicas de su núcleo, y las operaciones masivas se trocean en volúmenes de ≤ 32 768 bloques para respetar el límite del servidor. Toda colocación se sanea retirando bloques administrativos y fluidos.
- **Verificación de efectos secundarios.** RCON no falla ante un comando inválido: responde con texto. `prepareFighter` analiza cada respuesta y emite una advertencia estructurada cuando el servidor no confirmó la entrega de un objeto o efecto.

### 4.3 Arbitraje conversacional entre agentes

En el modo de chat, los agentes deliberan en paralelo pero hablan **por turnos**, como personas. `Conversation` implementa un árbitro de la palabra:

- Exclusión mutua sobre la palabra, con una pausa entre hablantes de 250 ms más hasta 150 ms de *jitter* aleatorio, y de 500 ms si repite el mismo hablante.
- Un búfer de capacidad uno por lado con semántica **última escritura gana**: si el agente cambia de idea antes de hablar, la frase nueva reemplaza a la pendiente.
- Equidad: cuando ambos esperan, habla primero quien no habló último.
- Caducidad: una frase que esperó más de 10 s ya no es pertinente y se descarta.
- La duración de cada turno es la del audio real cuando existe y, si no, una estimación por longitud ajustada a la velocidad de la voz.

### 4.4 Síntesis de voz especulativa

`SpeechService` convierte los mensajes en audio con ElevenLabs sin bloquear nunca la pelea:

- **Síntesis diferida y desacoplada.** `request()` devuelve un identificador de inmediato y la síntesis continúa en segundo plano; la web pide el audio por ese id y la espera queda oculta bajo el retraso natural del video (~1,5 s). El audio se solicita solo cuando la frase obtiene el turno: una frase reemplazada o caducada no consume créditos.
- **Caché direccionada por contenido.** El mismo texto con la misma voz se sintetiza una sola vez (hasta 1000 audios con expulsión por antigüedad).
- **Contrapresión y disyuntores.** Como máximo cuatro solicitudes concurrentes; reintento único ante 429; un disyuntor de 10 minutos ante clave rechazada o falta de créditos; un presupuesto de créditos consultado periódicamente que silencia a los agentes por debajo de un umbral.
- **Precalentamiento.** Al preparar una pelea con voz, el servidor sintetiza y descarta una palabra por voz para absorber el arranque en frío del proveedor (medido en 5 a 6 s frente a medio segundo en caliente).

### 4.5 Persistencia y trazabilidad

- **Transcripción de escritura anticipada.** Cada pelea se registra en un JSONL de solo anexado, escrito en serie mientras ocurre: si el proceso cae, queda todo lo sucedido hasta ese instante. Cada decisión guarda la observación exacta que vio el modelo y su respuesta literal, incluidas las llamadas a herramientas inexistentes o no ofrecidas. Es una traza completa y reproducible del comportamiento del modelo.
- **Escrituras atómicas** (archivo temporal + renombrado) para la configuración y el estado del torneo, y lectores tolerantes a líneas truncadas.
- **Exclusión entre procesos** mediante un archivo de bloqueo con PID, con detección de bloqueos huérfanos por verificación de vida del proceso.
- **Validación de identificadores** como UUID antes de construir rutas de archivo, cerrando la puerta a recorridos de directorio.

### 4.6 Gobernanza dinámica de modelos

El orquestador descarga periódicamente el catálogo público de Vercel AI Gateway, filtra los modelos con capacidad de invocar herramientas bajo un techo de precio (1 USD/M tokens de entrada, 5 USD/M de salida), agrupa versiones por línea de producto y elige una por línea. La lista se impone en el servidor al guardar un prompt y otra vez al iniciar la pelea, con degradación al último catálogo válido y, en última instancia, a una lista fija.

### 4.7 Explicación y juicio automáticos

- **"Por qué ganó".** Al terminar, un LLM redacta una explicación en una frase a partir de un resumen estadístico de la pelea; si no hay modelo disponible, `fallbackExplanation` la genera de forma determinista desde las mismas estadísticas.
- **Juez LLM.** `judge.ts` evalúa la transcripción con una rúbrica fija de 0 a 10 por criterio, recortando la transcripción por los extremos para respetar la ventana del juez.

---

## 5. Sincronización de telemetría con el video

El video llega al navegador con varios segundos de retraso respecto del estado; mostrar la telemetría en cuanto llega haría que el marcador anuncie un golpe antes de que se vea. La web **alinea los eventos con el instante que efectivamente se está mostrando en pantalla**:

- **Estimación del desfase de reloj.** Cada evento trae su marca de tiempo del servidor. La diferencia entre esa marca y el reloj local está siempre sesgada a la baja por la latencia de red, así que la mejor estimación es el **máximo** de las muestras recientes (el evento que viajó más rápido). El máximo en ventana deslizante se mantiene en tiempo amortizado constante con una cola monótona decreciente.
- **Reloj de presentación del video.** El instante en pantalla se obtiene, en orden de preferencia, de las marcas `PROGRAM-DATE-TIME` del playlist HLS (hls.js), de la distancia al borde en vivo, o de la fecha de inicio del HLS nativo de Safari.
- **Reprogramación de eventos.** Cada evento se libera cuando el reloj de presentación alcanza su marca de tiempo traducida, de modo que golpes, pensamientos y audio aparecen en sincronía con la imagen.
- La reconexión del WebSocket usa retroceso exponencial con *jitter* aleatorio.

---

## 6. Plano de medios

### 6.1 Cliente real renderizado por GPU

El video no es un render aproximado: es el **cliente oficial de Minecraft** ejecutándose sin monitor sobre una pantalla virtual (Xvfb), con aceleración OpenGL por GPU mediante VirtualGL, capturado por ffmpeg y codificado en H.264 por hardware (NVENC) a 30 fps. El cliente entra como espectador y queda acoplado con `/spectate` a un bot cámara; dirigir la cámara es mover ese bot. MediaMTX reempaqueta el RTMP como LL-HLS con partes de 200 ms, y el sistema se recupera solo si el cliente es expulsado o el servidor de medios se reinicia.

### 6.2 Render por software de respaldo

Sin GPU, la cámara renderiza ella misma con three.js sobre WebGL sin cabeza (headless-gl), lee el framebuffer con `gl.readPixels` y lo entrega crudo (RGBA) a ffmpeg por la entrada estándar, con inversión vertical por filtro. Las marcas de tiempo se asignan por reloj de pared y un filtro de cadencia duplica cuadros para entregar un caudal constante: si el render se retrasa, el video sigue en tiempo real en lugar de acelerarse o acumular atraso. Un perro guardián reinicia ffmpeg si deja de consumir cuadros, con reintentos de retroceso adaptativo.

### 6.3 Dirección de cámara

`director.ts` es la cinemática de la cámara, en funciones puras:

- Punto de mira en el centroide de los peleadores, con casos degenerados para uno o ninguno.
- **Suavizado exponencial independiente de la tasa de cuadros** (constante de tiempo τ: con τ = 0,5 s recorre ~63 % de la distancia cada medio segundo), para que el movimiento no dependa del rendimiento del render.
- Encuadre automático por campo de visión que mantiene a todos los sujetos en cuadro (en el modo de render propio).
- **Cuantización angular a 256 pasos**, la resolución con que el protocolo de Minecraft transmite la orientación, para no emitir rotaciones que el servidor redondearía.
- Montaje alternado entre plano de seguimiento y plano general con tiempos configurables.

---

## 7. Marco de evaluación estadística de modelos

Más allá de la pelea en vivo, el proyecto es un **banco de pruebas reproducible** para comparar modelos de lenguaje como agentes encarnados.

### 7.1 Rating de Bradley–Terry regularizado

`rating.ts` estima la fuerza de cada modelo con un modelo de **Bradley–Terry** en escala Elo (400 / ln 10 puntos por unidad natural), con empates a medio punto y la referencia (DeepSeek V4.1 Flash servido por Baseten) anclada en 1000:

- **Estimación MAP** con un prior gaussiano N(1000, σ²) sobre cada rating libre, que regulariza los modelos con pocas partidas y garantiza un óptimo único.
- **Optimización de Newton–Raphson con hessiano completo**, resuelta por factorización de **Cholesky** con búsqueda lineal; el objetivo es cóncavo, así que la convergencia es global.
- **Incertidumbre de Laplace**: errores estándar como la raíz de la diagonal de H⁻¹ en el óptimo, para la diferencia de cada modelo con la referencia.
- **Bootstrap por clusters** (escenario × semilla, IC 95 %) cuando hay al menos cinco clusters, que respeta la correlación entre partidas jugadas sobre el mismo terreno.
- **Determinismo e invariancia**: el ajuste opera sobre estadísticos suficientes agregados por pareja y ordenados por clave, por lo que el resultado no depende del orden de las partidas ni de la lista de modelos.

### 7.2 Diseño experimental

- **Calibración secuencial adaptativa.** Una ronda base enfrenta a cada candidato con la referencia; luego cada modelo se clasifica como `inside`, `outside` o `pending` según si su intervalo al 90 % cae dentro, fuera o a través de una banda de equivalencia de ±150 Elo. Solo los `pending` reciben rondas adicionales, emparejados preferentemente con rivales no jugados y cercanos en rating, bajo un presupuesto máximo del 50 % de la capacidad total. Es un esquema de muestreo secuencial que concentra el gasto donde reduce más incertidumbre.
- **Liga todos contra todos contrabalanceada.** Calendario por el método del círculo (n − 1 rondas, cada modelo a lo más una vez por ronda), con ida y vuelta por pareja (cada modelo juega de ambos lados) y la misma semilla en ambas piernas: en mapas sembrados, la pareja juega el mismo terreno con los lados intercambiados, neutralizando la ventaja posicional.
- **Identificadores estables e idempotencia.** Cada partida tiene un id canónico (`etapa:escenario:semilla:a~b:pierna`). Reanudar un torneo recalcula el calendario determinista desde la configuración congelada y omite los ids que ya tienen un intento válido: nunca se duplica una partida.
- **Versionado del benchmark por hash.** Al crear un torneo se congela un sha256 del prompt fijo, las herramientas, la geometría del escenario, la duración y el tick. Si el código cambia cualquiera de ellos, el torneo se niega a continuar: resultados de reglas distintas nunca se mezclan.
- **Congelamiento de la procedencia.** Ids exactos de los modelos, proveedor de inferencia, precios, nivel de razonamiento mínimo admitido por cada modelo y el catálogo crudo con su hash.
- **Separación entre fallo de infraestructura y resultado de juego.** Una partida se invalida si un bot se desconectó, si no llegó a ejecutarse o si un lado acumuló errores transitorios del proveedor (≥ 3 consecutivos o ≥ 20 % de sus llamadas). Esas partidas se reintentan y nunca contaminan el rating.
- **Control presupuestario predictivo.** Antes de cada partida se proyecta el siguiente intento con la media observada (o con la estimación del catálogo al inicio) contra los límites de tiempo, partidas y dólares; la ejecución se detiene antes de excederlos.
- **Simulador determinista.** `sim.ts` reproduce el torneo completo con ratings ocultos y un generador mulberry32 sembrado por (torneo, partida, intento), con duraciones y costos simulados para que los límites de reloj se comporten como en producción. Permite ensayar planes y probar el runner en milisegundos.
- **Análisis de velocidad.** `speed.ts` relaciona el Elo con la cadencia de decisión, la latencia (media ponderada y percentiles p50/p95) y la eficiencia, mediante la **correlación de rangos de Spearman**. La métrica principal, la fracción de decisiones de cada modelo dentro de la misma partida, es invariante a la duración porque ambos contendientes comparten el mismo intervalo.

### 7.3 Escenarios conductuales

Sobre el mismo motor se definen escenarios que miden comportamiento y no solo combate, con un prompt de sistema deliberadamente neutral (describe el mundo y las capacidades, nunca el objetivo ni el puntaje):

- **Dilema del prisionero iterado**, con tasas de cooperación, represalia y deserción en la última ronda, y horizonte conocido o desconocido para el agente.
- **Inyección de instrucciones** y **verificación** frente a avisos falsos, con tasas de exposición y de obediencia.
- **Persuasión y rendición** entre agentes que pueden hablarse.
- **Coherencia entre lo dicho y lo hecho**: `metrics.ts` detecta intenciones anunciadas en el razonamiento del agente y comprueba en una ventana de 8 s si la acción ejecutada las cumplió.

Las métricas cuantitativas se calculan en vivo de forma heurística y determinista; la capa cualitativa la aporta el juez LLM.

---

## 8. Ingeniería de calidad

- **Núcleo funcional, cáscara imperativa.** La lógica con decisiones (balística, críticos, compresión espacial, colas, árbitro conversacional, rating, calendario, resultado de la pelea, comandos de la arena) vive en funciones puras sin dependencias de mineflayer, RCON ni red. Los efectos quedan confinados a adaptadores delgados.
- **Relojes y E/S inyectables.** Los componentes temporales reciben un reloj abstracto y los clientes externos un `fetch` inyectado, lo que permite probar caducidades, pausas y reintentos de forma determinista.
- **891 casos de prueba** en 61 suites cubren desde la física de proyectiles hasta un torneo completo de punta a punta sobre el simulador.
- **Proveedor de LLM simulado** (`mock`) que recorre el espacio de herramientas sin red ni costo, para ejecutar la cadena completa en integración continua y en desarrollo.
- **Prueba de humo por eslabón** (`scripts/smoke.sh`): contenedores sanos, RCON, API, catálogo de modelos, actualización a WebSocket, playlist HLS con segmentos y una pelea completa iniciada por la API que debe llegar a `finished` y quedar en el historial.

---

## 9. Mapa del código

| Área | Ubicación | Piezas clave |
|---|---|---|
| Contrato | `packages/protocol/src` | `index.ts` (esquemas, kits, eventos, API), `bench.ts`, `tournament.ts`, `transcript.ts` |
| Inferencia | `packages/llm/src` | `vercel.ts` (AI Gateway, enrutamiento y costo), `mock.ts` |
| Agente | `packages/agent/src` | `fighter.ts`, `plan.ts`, `wake.ts`, `rounds.ts`, `spatial.ts`, `history.ts`, `aim.ts`, `crit.ts`, `tactics.ts`, `construction.ts` |
| Orquestación | `apps/orchestrator/src` | `match.ts`, `hub.ts`, `rcon.ts`, `arena.ts`, `conversation.ts`, `speech.ts`, `metrics.ts`, `judge.ts` |
| Evaluación | `apps/orchestrator/src/tournament` | `rating.ts`, `schedule.ts`, `runner.ts`, `benchmark.ts`, `catalog.ts`, `sim.ts`, `speed.ts` |
| Video | `apps/camera/src`, `infra/stream` | `director.ts`, `operator.ts`, `stage.ts`, `ffmpeg.ts`, `stream.sh` |
| Web | `apps/web/src`, `apps/web/worker` | `player.ts` (sincronía), `socket.ts`, Worker de borde |
