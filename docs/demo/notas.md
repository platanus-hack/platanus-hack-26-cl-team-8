# Notas por lámina: para estudiar el demo

Qué hay en pantalla en cada lámina, qué decir y por qué. El guion completo tiene unas 400 palabras: cabe en 3 minutos hablando a ritmo normal, sin correr. La versión corta para tener a la vista es [punteo.md](punteo.md).

Cómo nos evalúan: aspecto técnico 25 %, ambición 20 %, ejecución 20 %, impacto 20 % y originalidad 15 %. Son 3 minutos con corte duro, y después 2 minutos de preguntas.

## Tres datos que cambiaron respecto del borrador

El borrador del guion tenía tres cifras que no calzan con lo que hay. Las láminas ya van con las correctas.

- **"Más de 500 partidas".** La liga que se muestra tuvo 216 peleas. Las 500 salen de sumar las dos ligas (288 y 216). En pantalla dice 216: si dices 500, di "entre las dos ligas".
- **"Cada lado gana el 48 %".** En esta liga Rojo ganó el 47 % y Azul el 53 %. El argumento de justicia es otro y es más fuerte: cada pareja pelea de ida y vuelta, así que ningún modelo se queda con el lado bueno.
- **"Una cámara renderizada con Three.js".** El video del sitio sale de un cliente real de Minecraft, capturado con ffmpeg y transmitido por HLS con MediaMTX. La cámara con Three.js existe, pero es el respaldo para máquinas sin GPU.

---

## 0 · Portada (hasta 0:06)

**En pantalla:** negro. Al primer avance entran los dos cuadrados, se miran, y aparece el nombre.

**Decir:** "Hola, somos Sandlabs y esto es Prompt Arena."

**Clave:** el primer avance echa a correr el reloj. Avanza en cuanto termines la frase; no expliques nada aquí.

## 1 · Los evals miden lo que un modelo sabe (hasta 0:16)

**En pantalla:** la frase y una pregunta de examen que se responde sola. Dos avances: "No cómo actúa" y la línea de los agentes.

**Decir:** "Hoy los LLMs se evalúan con exámenes: una pregunta, una respuesta correcta. Eso mide lo que un modelo sabe, no cómo actúa. Y cada vez más modelos actúan: controlan agentes, herramientas y robots."

**Clave:** la pausa va antes de "no cómo actúa". Es la idea de todo el pitch y vuelve en el cierre.

## 2 · En un examen, el mundo espera (hasta 0:26)

**En pantalla:** dos escenas. En "Examen" el rival está en pausa mientras el modelo piensa. En "Mundo real" el rival se acerca y pega, y el agente pierde vida mientras piensa.

**Decir:** "En un examen, el mundo espera al modelo. En el mundo real no: mientras piensa, todo sigue moviéndose. Y no existe un eval común para eso: cada empresa arma el suyo, caro y no comparable."

**Clave:** deja que la animación haga el trabajo. Señala la vida que baja.

## 3 · Prompt Arena (hasta 0:42)

**En pantalla:** la definición y los dos agentes frente a frente. Tres avances, uno por dato.

**Decir:** "Por eso creamos Prompt Arena: un eval donde razonar bien y decidir rápido importan a la vez. Es un sandbox PvP en Minecraft: dos agentes deciden en tiempo real, y el resultado es objetivo. Gana, pierde o empata, y de ahí sale un ranking Elo."

**Clave:** "a la vez" es lo nuevo. Ni el más rápido ni el más inteligente gana por sí solo.

## 4 · El primer paso (hasta 0:56)

**En pantalla:** una escalera de tres peldaños: el duelo de hoy, lo que el mismo sandbox permite, y los world action models.

**Decir:** "Es el primer paso hacia evaluar modelos que actúan en el mundo, los world action models. Partimos por el duelo porque se puede medir de forma justa; el mismo sandbox sirve para cooperación y negociación."

**Clave:** esta lámina responde a ambición. No digas que ya medimos world action models: decimos que este es el trabajo previo.

## 5 · En vivo (hasta 1:16)

**En pantalla:** el sitio real, dentro de la lámina. Tres avances ponen las tres frases encima.

**Decir:** "Esto está pasando ahora. Son dos agentes peleando en tiempo real. Ninguno está programado: cada movimiento lo decide un modelo de lenguaje. Aquí se ve cada decisión con su razón, su latencia y la vida de cada uno."

**Clave:** tiene que haber una pelea corriendo. Una pelea dura unos 25 segundos, así que alguien del equipo la inicia desde su teléfono cuando empieza la lámina 4. Si no hay pelea, no te detengas: di la frase igual sobre la arena vacía y sigue.

**Si falla la red:** `O` abre el sitio en otra pestaña. Si tampoco carga, salta a la lámina 6 sin comentar.

## 6 · Mientras el modelo piensa, el mundo sigue (hasta 1:34)

**En pantalla:** el ciclo (observa, decide, ejecuta) y, al avanzar, dos líneas de tiempo: el cuerpo, con marcas seguidas, y el cerebro, con decisiones espaciadas.

**Decir:** "¿Cómo funciona? El agente observa su vida, la del rival, la distancia y su inventario; el modelo decide y el cuerpo ejecuta. El cuerpo reacciona cada 100 milisegundos. El cerebro decide cuando el modelo responde, y para entonces el mundo ya cambió."

**Clave:** es la lámina más técnica y vale para el 25 % de aspecto técnico. Los dos niveles de control son la decisión de diseño que hace que esto funcione con modelos lentos.

## 7 · Cambias una variable y es otro experimento (hasta 1:46)

**En pantalla:** cuatro casillas que van cambiando solas: prompt, kit, modelo y comunicación.

**Decir:** "Todo se configura: el prompt, el kit, el modelo y cuánto se comunican. Cambias una variable y tienes otro experimento."

**Clave:** es corta a propósito. Si vas atrasado, pásala sin hablar.

## 8 · Un Minecraft real y cualquier modelo del mercado (hasta 2:06)

**En pantalla:** cinco piezas en fila: mundo, cerebro, orquestador, video y web. Un avance muestra la infraestructura.

**Decir:** "Lo construimos sobre un servidor real de Minecraft, con mineflayer como cuerpo. El cerebro es el AI SDK de Vercel con su gateway: cualquier modelo, la misma interfaz. Un orquestador en Fastify corre las peleas, mide latencia y costo, y guarda cada decisión. El video sale en vivo por HLS."

**Clave:** no leas las cinco cajas. Nombra tres y sigue. Es la lámina que se recorta si falta tiempo.

## 9 · 9 modelos, todos contra todos (hasta 2:36)

**En pantalla:** la tabla de la liga: el Elo de cada modelo con su intervalo. Dos avances: aparece la velocidad y después el costo, con los datos que importan marcados.

**Decir:** "Pusimos a pelear a 9 modelos, todos contra todos, ida y vuelta. MiniMax quedó primero; GLM y Qwen, al fondo." *Avanza.* "En velocidad, GLM tarda 13 segundos por decisión y casi no alcanza a actuar; MiniMax responde en uno." *Avanza.* "Y en costo, MiniMax es de los más baratos; DeepSeek, el más caro por victoria, queda detrás."

**Clave:** señala cada dato mientras lo dices. Los marcados en ámbar son los que nombras.

**Los números, por si preguntan:** 216 peleas, 9 modelos, 3 semillas. MiniMax ganó 40 de 48. La liga completa costó US$ 8,71 y tomó 103 minutos. El modelo de referencia (DeepSeek V4.1 Flash) queda fijo en 1000.

## 10 · La velocidad es un umbral (hasta 2:52)

**En pantalla:** los modelos ordenados del que decide más rápido al más lento; el alto de cada columna es su Elo. A la derecha, la zona "demasiado lento". Un avance muestra la línea de justicia.

**Decir:** "El hallazgo: la velocidad es un umbral. Pasado ese punto, gana el que decide mejor, no el que decide más rápido. Eso un examen no lo puede ver."

**Clave:** es el resultado que justifica todo. El modelo más rápido (DeepSeek, 0,8 s) queda al medio; hasta unos 2,5 segundos por decisión el Elo no depende de la velocidad; pasado ese punto se cae.

## 11 · Cierre (hasta 3:00)

**En pantalla:** la frase de cierre y el código QR del sitio.

**Decir:** "Los exámenes miden lo que un modelo sabe. Prompt Arena mide cómo actúa. Somos Sandlabs. Gracias."

**Clave:** termina mirando al público, no a la pantalla. Deja la lámina puesta durante las preguntas: el QR sirve para que entren a mirar.

---

## Preguntas que pueden hacer

**¿Por qué Minecraft?**
Es un mundo físico que reacciona, barato de correr y que cualquiera entiende al verlo. Los agentes son bots de verdad en un servidor de verdad, no una simulación hecha a medida.

**¿Un duelo es una buena forma de medir?**
Un rival es un entorno que reacciona: no sirve memorizar una solución. El resultado es objetivo (gana, pierde o empata) y no depende de un juez. Y el tiempo real castiga la lentitud, así que la velocidad se mide sola.

**¿Cómo saben que el ranking no es ruido?**
Cada pareja pelea de ida y vuelta y con tres semillas. El rating es un Bradley-Terry en escala Elo y cada modelo tiene su intervalo de confianza. Los intervalos son anchos y lo mostramos: entre los seis primeros se traslapan. Lo que sí se distingue es que MiniMax queda claramente sobre la referencia, y Qwen y GLM claramente bajo ella.

**¿Mide inteligencia?**
No. Mide cómo actúa un modelo en este juego, con este prompt y este kit. No es una medida general de qué modelo es mejor.

**¿Qué más se puede medir?**
Ya hay cinco pruebas sobre el mismo ring: si rompe una regla cuando va perdiendo, si obedece órdenes falsas (inyección), si le da la razón a un rival que miente, si verifica antes de obedecer un aviso y si sale de un bucle cuando una acción falla siempre.

**¿Y los world action models?**
Es lo que sigue, no lo que hay. La idea es que el agente diga qué espera que pase antes de actuar y compararlo con lo que pasó. Todavía no está construido.

**¿Cuánto cuesta correrlo?**
La liga completa de 9 modelos costó US$ 8,71. Todo corre en un servidor casero.

**¿Puedo probarlo con mi prompt?**
Sí. La arena es una sola: todos ven la misma pelea y los mismos prompts, así que se prueba de a una persona. Un integrante del equipo le pasa el acceso de invitado o escribe el prompt que le dicten.
