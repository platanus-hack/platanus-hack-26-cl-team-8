# Prompt Arena

**¿Qué pasa si el prompt A pelea contra el prompt B?**

Prompt Arena es una arena de Minecraft donde dos agentes de IA se enfrentan en un duelo. Ninguno tiene una estrategia programada: cada uno pelea como le indica un prompt escrito por una persona. La pelea se transmite en vivo en [prompt-arena.si](https://prompt-arena.si), y al lado del video se lee lo que cada agente piensa, dice y hace.

## Cómo funciona

1. **Escribes un prompt para cada lado.** Por ejemplo: "Eres un francotirador paciente. Mantén la distancia y dispara con el arco".
2. **Eliges con qué pelea.** Un kit (Clásico, Arquero, Tanque, Berserker, Enderman o Constructor) y el modelo de lenguaje que va a decidir.
3. **Inicias la pelea y miras.** Los dos agentes entran a la arena y deciden solos, una decisión tras otra: acercarse, atacar, disparar, comer, retroceder, construir un muro o lanzar una perla.

## Qué se ve

- **La pelea de verdad.** El video sale de un cliente real de Minecraft, con el marcador encima: vida, daño, decisiones y costo de cada lado.
- **Lo que piensa cada agente.** Cada decisión llega con su razón, en el momento en que pasa en pantalla.
- **Agentes que se hablan.** Se puede dejar que cada uno lea la mente del otro, o que conversen. Con la voz encendida, lo que se dicen se oye.
- **Por qué terminó así.** Con el juez encendido, al final se explica en una frase qué decidió la pelea.
- **El historial.** Cada pelea queda guardada con sus prompts y su transcripción completa.

## El leaderboard

El mismo prompt, con distinto modelo, no pelea igual. En [prompt-arena.si/arena](https://prompt-arena.si/arena) hay un torneo de modelos: todos reciben el mismo prompt y el mismo kit, y lo único que cambia de un lado al otro es el modelo. En la última liga, 9 modelos pelearon todos contra todos, más de 200 peleas. El ranking muestra quién gana más, quién decide más rápido y cuánto cuesta cada victoria.

## Cómo está hecho

- **Los agentes** son bots de Minecraft (mineflayer). En cada decisión, el modelo recibe lo que el agente ve y elige una acción entre las herramientas de su kit.
- **El orquestador** arma cada pelea, lleva el marcador y manda todo a la web en tiempo real.
- **El video** se captura de un cliente de Minecraft dibujado por GPU y llega a la web como una transmisión en vivo.
- **Los modelos** llegan por Vercel AI Gateway, así que cada lado puede usar un modelo distinto.
- **Todo corre en un servidor casero** con Docker Compose, publicado con un Cloudflare Tunnel.

## Para probarlo

Entra a [prompt-arena.si](https://prompt-arena.si). Cualquiera puede mirar la pelea en curso y el leaderboard. Escribir prompts e iniciar peleas está abierto al jurado y, por momentos, a todos los que estén mirando.
