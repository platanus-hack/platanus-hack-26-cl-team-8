# Punteo de guía: demo de 3 minutos

Para tener a la vista mientras se presenta. Una fila por lámina: hasta qué minuto dura, cuántas veces se avanza y qué decir en pocas palabras. El texto completo está en [notas.md](notas.md).

**Corte duro a los 3:00.** El reloj de las láminas (tecla `T`) muestra el tiempo y hasta cuándo dura la lámina actual: se pone ámbar si vas atrasado y rojo pasado el 3:00.

| # | Hasta | Avances | Lámina | Decir |
|---|---|---|---|---|
| 0 | 0:06 | 1 | Portada | "Hola, somos Sandlabs y esto es Prompt Arena." |
| 1 | 0:16 | 2 | Los evals miden lo que sabe | Exámenes: una pregunta, una respuesta. Miden lo que sabe, **no cómo actúa**. Y cada vez más modelos actúan. |
| 2 | 0:26 | 1 | El mundo no espera | En un examen el mundo espera; en el real, no. No hay un eval común: cada empresa arma el suyo, caro y no comparable. |
| 3 | 0:42 | 3 | Prompt Arena | Un eval donde razonar bien y decidir rápido importan **a la vez**. Sandbox PvP en Minecraft, tiempo real, gana/pierde/empata → Elo. |
| 4 | 0:56 | 2 | El primer paso | Primer paso hacia evaluar modelos que actúan en el mundo. Duelo hoy; mismo sandbox para cooperación y negociación. |
| 5 | 1:16 | 3 | **En vivo** | "Esto está pasando ahora." Ninguno está programado. Cada movimiento lo decide un LLM. Razón, latencia y vida. |
| 6 | 1:34 | 1 | El mundo sigue | Observa → decide → ejecuta. Cuerpo cada 100 ms; cerebro cuando responde el modelo. Para entonces, el mundo cambió. |
| 7 | 1:46 | 0 | Otra variable, otro experimento | Prompt, kit, modelo, comunicación. Cambias una y es otro experimento. |
| 8 | 2:06 | 1 | Con qué está hecho | Minecraft real + mineflayer. AI SDK de Vercel y su gateway. Fastify mide y guarda todo. Video en vivo por HLS. |
| 9 | 2:36 | 2 | Los resultados | 9 modelos, todos contra todos. MiniMax primero. **Avanza:** GLM 13 s, MiniMax 1 s. **Avanza:** el más caro no gana. |
| 10 | 2:52 | 1 | El umbral | La velocidad es un umbral: pasado ese punto, gana el que decide **mejor**. Eso un examen no lo ve. |
| 11 | 3:00 | 1 | Cierre | "Los exámenes miden lo que un modelo sabe. Prompt Arena mide cómo actúa. Somos Sandlabs. Gracias." |

## Si vas atrasado

- En la lámina 8, di solo: "Un Minecraft real, y cualquier modelo del mercado con la misma interfaz." Ahorra 12 segundos.
- En la lámina 9, avanza los dos pasos seguidos y di solo el titular: "Ganó uno de los más baratos."
- La lámina 7 se puede pasar sin hablar: se entiende sola.

## Teclas

| Tecla | Qué hace |
|---|---|
| `→` o espacio | Avanza un paso o una lámina. El primer avance en la portada echa a correr el reloj. |
| `←` | Retrocede. |
| `F` | Pantalla completa. |
| `T` | Muestra u oculta el reloj. |
| `N` | Muestra u oculta las notas de la lámina (para ensayar). |
| `R` | Reinicia el reloj. |
| `O` | Abre el sitio en otra pestaña, por si la lámina en vivo falla. |

## Antes de subir

- Abrir `docs/demo/slides.html` en Chrome y poner pantalla completa (`F`).
- Pasar una vez por la lámina 5 para que el sitio quede cargado y con la pelea a la vista.
- **Que haya una pelea corriendo al llegar a la lámina 5.** Alguien del equipo la inicia desde su teléfono unos 20 segundos antes: una pelea dura cerca de 25 segundos.
- Tener el sitio abierto en otra pestaña como respaldo.
- Reiniciar el reloj (`R`) y volver a la portada.
