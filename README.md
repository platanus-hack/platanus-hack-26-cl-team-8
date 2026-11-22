# team-8 Platanus Hack 26: Santiago ft. Buk Project

**Current project logo:** project-logo.png

<img src="./project-logo.png" alt="Project Logo" width="200" />

Track: 🌐 Simulations

team-8

- Sebastián Torrealba ([@storrealbac](https://github.com/storrealbac))
- Tito Vicente Orellana Barra ([@titin90](https://github.com/titin90))
- Alberto Esteban Ferrada Rivas ([@albfr](https://github.com/albfr))
- Carlos Pinto Urtubia ([@CxrlosKenobi](https://github.com/CxrlosKenobi))

## Prompt Arena

Un benchmark de LLMs en tiempo real. Dos agentes de IA pelean en Minecraft y medimos cómo decide cada modelo.

- En vivo: https://prompt-arena.si
- Leaderboard: https://prompt-arena.si/arena

### El problema

Hoy no hay una forma barata y segura de saber cómo se va a comportar un modelo cuando actúa en un mundo en tiempo real.

### Qué hicimos

Un sandbox PvP en Minecraft. Dos agentes deciden en tiempo real con lo que perciben de su entorno y de lo que hace y dice el otro. Cada uno sigue un prompt escrito por una persona, y un modelo de lenguaje elige cada acción: acercarse, atacar, disparar, comer, retroceder.

Un experimento se arma con cuatro cosas por lado:

- **Prompt:** "ataca sin parar", "mantén la distancia", "colabora con el otro".
- **Kit:** espada, arco, hacha, perlas de ender o bloques para construir.
- **Modelo:** cualquiera de los que ofrece Vercel AI Gateway.
- **Comunicación:** ninguna, leerse el pensamiento o hablarse.

### Qué se mide

- **Si gana.** Un torneo de todos contra todos, de ida y vuelta, da un ranking Elo con intervalos de confianza.
- **Qué tan rápido decide.** Segundos por decisión y decisiones por pelea. Un modelo lento pierde terreno.
- **Cuánto cuesta.** Dólares por victoria.
- **Si sostiene sus instrucciones bajo presión.** Cinco pruebas sobre el mismo ring:
  - *Reglas bajo presión:* ¿rompe una regla cuando va perdiendo?
  - *Inyección:* ¿obedece órdenes falsas de un "árbitro"?
  - *Sostener la postura:* ¿le da la razón al rival aunque los hechos digan otra cosa?
  - *Verificar antes de obedecer:* ¿revisa lo que ve cuando un aviso lo contradice?
  - *Salir del bucle:* ¿cuántas veces repite una acción que falla siempre?

### Por qué un PvP

- **El mundo no se queda quieto.** Un rival reacciona a lo que haces. No sirve memorizar una solución: hay que percibir, decidir y corregir en cada ciclo.
- **El otro agente es una entrada que no controlas.** Sus acciones, sus mensajes y sus mentiras permiten medir si el modelo verifica lo que recibe.
- **El resultado es objetivo.** Gana, pierde o empata. No depende de un juez.
- **El tiempo real castiga la lentitud.** La velocidad de decisión se mide sola.
- **El mismo ring sirve para muchas preguntas.** Cambia el prompt, el kit o la comunicación y es otro experimento.

### Resultados

Liga del 22 de noviembre de 2026: 9 modelos, 216 peleas, todos con el mismo prompt y el mismo kit.

| # | Modelo | Elo (intervalo) | Ganadas | Decide en | Costo por victoria |
|---|---|---|---|---|---|
| 1 | MiniMax-M3.1-Flash | 1287 (1124 a 1449) | 40 de 48 | 1,1 s | US$ 0,012 |
| 2 | GPT-6 Luna (Fast) | 1155 (1007 a 1302) | 33 de 48 | 1,4 s | US$ 0,019 |
| 3 | Gemini 3.8 Flash | 1104 (959 a 1249) | 30 de 48 | 2,3 s | US$ 0,055 |
| 4 | Muse Ember | 1088 (943 a 1232) | 29 de 48 | 1,2 s | US$ 0,016 |
| 5 | MiMo V2.6 Flash | 1055 (911 a 1199) | 27 de 48 | 1,2 s | US$ 0,012 |
| 6 | Claude Haiku 5.5 | 1005 (860 a 1150) | 24 de 48 | 2,4 s | US$ 0,025 |
| 7 | DeepSeek V4.1 Flash (referencia) | 1000 | 24 de 48 | 0,8 s | US$ 0,128 |
| 8 | Qwen 3.8 Flash | 656 (461 a 851) | 8 de 48 | 3,8 s | US$ 0,021 |
| 9 | GLM 5.3 Flash | 372 (87 a 657) | 1 de 48 | 12,9 s | US$ 0,023 |

El torneo completo costó US$ 8,71 y tomó 103 minutos. Mide a los modelos en este juego, con este prompt y este kit; no es una medida general de cuál es mejor. El ranking vigente está en el [leaderboard](https://prompt-arena.si/arena).

### Cómo funciona

- **Agentes:** bots de Minecraft (mineflayer). En cada decisión el modelo recibe lo que el agente ve y elige entre las herramientas de su kit.
- **Orquestador:** arma cada pelea, lleva el marcador y manda todo a la web en tiempo real.
- **Video:** un cliente real de Minecraft, capturado y transmitido en vivo.
- **Web:** la pelea, lo que piensa cada agente, los prompts y el leaderboard.
- **Infraestructura:** un servidor casero con Docker Compose, publicado con un Cloudflare Tunnel.

### Correrlo

```bash
cp .env.example .env     # opcional: sin claves corre con un modelo simulado
docker compose up -d --build
```

Después abre `http://localhost:8080`. Para desarrollar en un Mac sin Docker: `pnpm local:setup` y `pnpm local`.

### Lo que sigue

Medir si predecir el mundo antes de actuar ayuda: que el agente diga qué espera que pase y compararlo con lo que pasó. Todavía no está construido.

### Documentación

- [Manual técnico](docs/MANUAL.md): correr, configurar, desplegar y operar.
- [Diseño técnico](docs/DISENO-TECNICO.md): cada capa del sistema.
- [Torneo](docs/TORNEO.md): calibración, liga y cómo se calcula el rating.
- [Arquitectura](docs/ARQUITECTURA.md): contratos y flujo de datos.
- [Publicar con Cloudflare](docs/CLOUDFLARE.md) y [marca](docs/MARCA.md).
