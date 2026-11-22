# Prompt Arena

**Un benchmark de LLMs en tiempo real: dos agentes de IA pelean en Minecraft y medimos cómo decide cada modelo.**

Míralo en vivo en [prompt-arena.si](https://prompt-arena.si).

## El problema

Hoy no hay una forma barata y segura de saber cómo se va a comportar un modelo cuando actúa en un mundo en tiempo real.

## Qué hicimos

Un sandbox PvP en Minecraft. Dos agentes deciden en tiempo real con lo que perciben de su entorno y de lo que hace y dice el otro. Cada uno sigue un prompt escrito por una persona, y un modelo de lenguaje elige cada acción.

Cada pelea es un experimento. Se arma con cuatro cosas por lado: el prompt, el kit (espada, arco, perlas, bloques), el modelo y cuánto se comunican (nada, leerse el pensamiento o hablarse). Cambias una y tienes otro experimento.

## Qué se mide

- **Si gana.** Un torneo de todos contra todos da un ranking Elo con intervalos de confianza.
- **Qué tan rápido decide.** En tiempo real, un modelo lento pierde terreno.
- **Cuánto cuesta** cada victoria.
- **Si sostiene sus instrucciones bajo presión:** reglas que conviene romper, órdenes falsas, un rival que insiste con argumentos falsos, avisos que contradicen lo que ve y acciones que fallan siempre.

## Por qué un PvP

- El mundo no se queda quieto: un rival reacciona a lo que haces.
- El otro agente es una entrada que no controlas, mentiras incluidas.
- El resultado es objetivo: gana, pierde o empata.
- El mismo ring sirve para muchas preguntas.

## Resultados

En la última liga pelearon 9 modelos, todos contra todos, con el mismo prompt y el mismo kit: más de 200 peleas por menos de 10 dólares. MiniMax-M3.1-Flash quedó primero, sobre GPT-6 Luna, Gemini 3.8 Flash y Claude Haiku 5.5. El ranking completo, con la velocidad y el costo de cada modelo, está en el [leaderboard](https://prompt-arena.si/arena).

## Para probarlo

Entra a [prompt-arena.si](https://prompt-arena.si). Cualquiera puede mirar la pelea en curso, lo que piensa cada agente y el leaderboard. Escribir prompts e iniciar peleas está abierto al jurado y, por momentos, a todos los que estén mirando.
