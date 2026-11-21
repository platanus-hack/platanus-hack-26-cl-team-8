<!--
Conocimiento avanzado de PvP de Minecraft Java 1.20.4 que reciben los agentes en su
prompt de sistema (sección "CONOCIMIENTO DE PVP", ver ../knowledge.ts).

Formato:
- Cada sección empieza con "## Título".
- Un comentario "requiere: tool1, tool2" justo debajo del título hace que la sección solo
  llegue a los agentes cuyo kit ofrece alguna de esas herramientas (ver kitToolNames).
  Sin comentario, la sección llega siempre.
- El cuerpo son viñetas "- ". No dejes líneas en blanco dentro de una sección.

Escríbelo como conocimiento, no como órdenes: el objetivo del agente lo deciden solo las
instrucciones de su entrenador. Cada idea va traducida a lo que el agente puede hacer con
sus herramientas: el cuerpo ya espera la recarga del arma, apunta el arco adelantando al
rival y carga cada flecha a tope, pero no salta.
-->

## Ritmo del combate cuerpo a cuerpo
- Cada arma tiene una recarga: un golpe dado antes de tiempo hace mucho menos daño. Tu cuerpo ya espera la recarga, así que pegar no se acelera repitiendo attack.
- Después de recibir daño, un luchador queda medio segundo inmune: un segundo golpe dentro de ese medio segundo solo cuenta si es más fuerte que el primero, y solo por la diferencia. Dos atacantes rápidos no suman daño; importa la calidad de cada golpe.
- Cada golpe empuja al que lo recibe (retroceso). El primer golpe de una carrera empuja bastante más. Por eso quien acierta primero suele llevarse el intercambio: el empujón saca al otro de su alcance (~3 bloques) y tiene que volver a acercarse mientras recibe el siguiente golpe.
- Contra la pared de vidrio el retroceso no te separa: quien queda acorralado recibe golpe tras golpe sin poder alejarse. Salir de una esquina (move con "circle" o "goto" hacia "center") vale más que seguir pegando desde ahí.
- La espada pega rápido y con daño medio; el hacha pega lento pero cada golpe quita más, y además le quita el escudo al rival unos segundos. Si tienes las dos, elige con el argumento "weapon" de attack según el rival.

## Golpes críticos
- Un crítico hace 1.5 veces el daño normal. Solo ocurre si el atacante está cayendo (después del punto más alto de un salto o al bajar de un bloque), no está en el agua, el arma está recargada y no viene corriendo: un golpe a la carrera da más retroceso en vez de crítico.
- Tu cuerpo no salta, así que no puedes buscar críticos a voluntad. La única forma es pegar mientras caes de algo más alto, por ejemplo al bajar de una torre o un escalón sobre el rival.
- La altura es ventaja: quien está arriba puede caer pegando; quien está abajo no. Si el rival está sobre bloques y tú abajo, romperle el apoyo (dig) o rodear suele ser mejor que pegarle desde abajo.

## Moverse cuando te atacan
- Caminar en línea recta hacia atrás frente a alguien con espada es lo peor: llega corriendo, pega y te empuja, y vuelve a alcanzarte. Para alejarte, retreat o move "keep" con distancia; para no recibir golpes limpios, move "strafe" o "circle" (moverse de lado hace fallar al que ataca de frente).
- Contra flechas, el movimiento lateral (strafe) es la mejor defensa sin escudo: quien dispara apunta adelantándose a tu movimiento, y los cambios de dirección lo hacen fallar. Acercarte en línea recta le regala disparos fáciles.
- Romper la línea de visión (detrás de un muro de bloques o de una torre) corta los disparos del todo: revisa "opponentVisible" y "lineOfSight".
- Comer, beber y romper bloques te dejan quieto. Hacerlo a pocos bloques del rival es recibir golpes gratis: primero toma distancia o cobertura.
- Del mismo modo, el rival es vulnerable cuando se queda quieto (comiendo, bebiendo, construyendo, rompiendo): son buenos momentos para acercarte o disparar.
- Una caída de más de 3 bloques hace daño. Bajar de una torre alta sin agua cuesta vida.

## Leer la pelea
- Compara tu vida con la del rival antes de entrar a un intercambio. Con menos vida y el mismo equipo, un intercambio cuerpo a cuerpo directo suele salir mal; antes cabe curarse, cambiar la distancia o usar otro recurso.
- Lo que se gasta no vuelve. Cuenta lo que le queda al rival (flechas que dispara, comidas, perlas): un rival sin flechas ya no te amenaza a distancia, y uno sin comida no puede recuperarse.
- Que el rival se aleje con poca vida suele significar que va a curarse: es el momento de presionarlo, no de esperarlo.
- Cambiar de plan tiene un costo: cortar una acción a medias (comer, cargar el arco, construir) la desperdicia. Termina lo que vale la pena terminar.

## Arco y flechas
<!-- requiere: shoot -->
- Tu cuerpo carga cada flecha al máximo (~1 s), apunta adelantándose al movimiento del rival y compensa la caída de la flecha. Una flecha a carga completa puede ser crítica y es la que más daño hace.
- El arco funciona mejor a media y larga distancia (más de 5 bloques). Cuerpo a cuerpo es malo: mientras cargas, el rival te pega. Si se acerca a 3 o 4 bloques, cambia a attack o aléjate primero.
- Es más fácil acertarle a un rival que viene en línea recta hacia ti o que está quieto que a uno que se mueve de lado. Dispara cuando avanza, come, bebe o construye.
- Las flechas no atraviesan bloques ni escudos levantados de frente. Contra un rival con escudo, disparar de frente gasta flechas; rodéalo o espera a que lo baje.
- Con move "keep" y una distancia de 8 a 12 bloques puedes alternar disparos y retirada contra un rival solo cuerpo a cuerpo (kiting). El retroceso de cada flecha, y más con Empuje, lo vuelve a alejar.
- Disparar desde arriba (una torre) da más alcance y deja al rival sin cubrirse fácil.

## Escudo
<!-- requiere: shield -->
- El escudo levantado bloquea todo el daño que llega por delante (golpes y flechas); lo que llega por la espalda pasa entero. Tarda un instante (~0.25 s) en empezar a bloquear después de levantarlo.
- Con el escudo arriba no atacas y te mueves lento. attack con "guard": true lo baja justo para cada golpe y lo vuelve a subir mientras el arma recarga: es la forma más segura de intercambiar golpes.
- Un golpe de hacha deja el escudo inservible unos 5 segundos. Si el rival lleva hacha, el escudo no te salva de ella: cuenta esos segundos sin protección.
- Contra un rival con arco, levantar el escudo mientras carga y bajarlo para avanzar entre disparos te deja acercarte casi sin daño.
- Contra un rival con escudo: rodéalo (move "circle") para pegarle por el costado o la espalda, usa hacha si tienes, o espera a que lo baje para atacar.

## Perlas de ender
<!-- requiere: pearl -->
- La perla te lleva a donde cae y te quita unos 5 de vida al llegar (la mitad con Caída de pluma IV; menos también con Protección). Úsala cuando la ventaja de llegar valga más que esa vida.
- Para atacar: cierra de golpe la distancia contra un rival con arco o contra alguien que se queda quieto comiendo o bebiendo, sin pasar por la lluvia de flechas.
- Para escapar: con poca vida, acorralado contra el muro, encerrado en bloques o pisando lava, "away" te saca y te da tiempo para curarte. Después de escapar, el rival va a perseguirte: aprovecha la distancia para comer o beber de inmediato.
- Para tomar posición: caer detrás del rival o sobre una zona alta.
- Una perla obvia es predecible: si el rival te ve venir puede esperarte justo donde caes. Lanzarla cuando el rival está ocupado sale mejor.
- No las gastes todas temprano: una perla guardada es una salida de emergencia, y el rival lo sabe.

## Lava
<!-- requiere: lava -->
- Estar en lava quita unos 4 de vida cada medio segundo y prende fuego. Al salir, el fuego sigue quemando hasta unos 15 segundos (1 de vida por segundo) salvo que te apagues con agua o tengas resistencia al fuego.
- La lava se extiende despacio y solo unos 3 bloques alrededor. Sirve para cortar el camino del rival, obligarlo a rodear o hacerlo retroceder, y para quemarlo mientras persigue.
- Combina bien con alejarte: si te persigue cuerpo a cuerpo, la lava entre los dos lo obliga a cruzarla (y quemarse) o a dar la vuelta.
- La lava es peligrosa para ti también: no pelees dentro de la zona donde la pusiste, y recuerda dónde quedó (aparece en "world").
- El agua apaga el fuego, y la lava que toca agua se vuelve piedra. Un rival con cubo de agua o resistencia al fuego anula buena parte de la lava.

## Agua
<!-- requiere: water -->
- El agua corre unos 7 bloques por el piso, empuja a quien está dentro y frena su avance. Entre tú y un rival que te persigue, le corta el impulso y te da distancia.
- Dentro del agua nadie consigue golpes críticos y todos se mueven lento.
- Vaciarla a tus pies anula el daño de caída (al bajar de una torre o tras una perla larga) y apaga el fuego al instante: es la respuesta a la lava, a Aspecto ígneo o a flechas con Fuego.
- Un cubo se vacía una sola vez. Guardarlo para cuando te prendan fuego o caigas desde alto suele servir más que usarlo de entrada.

## Construir y romper bloques
<!-- requiere: build, dig -->
- Un muro de 2 bloques de alto detiene flechas y no se puede trepar: el rival tiene que rodearlo o romperlo, y romper lo deja quieto.
- Una torre de 2 o 3 bloques te da altura: disparas con ventaja y el rival cuerpo a cuerpo no te alcanza sin romper la base o subir. Ojo: bajar desde más de 3 bloques hace daño.
- Encerrarte en bloques te da unos segundos para comer o beber a salvo; el rival tiene que romperlos para llegar. Encerrado, tampoco puedes atacar: es una pausa, no una defensa permanente.
- Construir lleva tiempo y te deja ocupado: hacerlo con el rival encima casi nunca funciona. Construye con distancia de por medio o cuando él está ocupado.
- La madera se rompe en ~3 s a mano y rápido con hacha; la roca solo con pico. Un muro de roca frena mucho más a un rival sin pico.
- Romper los bloques del rival (dig "between") le quita la cobertura; romper la base de su torre lo obliga a bajar.

## Comida y curación
<!-- requiere: eat, drink, throw -->
- La vida vuelve sola de a poco solo con la comida alta (18 o más); con la comida a 20 vuelve más rápido. Por debajo, comer es lo que hace volver la vida.
- Comer tarda ~1.6 s y te deja quieto: hazlo con distancia, detrás de cobertura o justo después de empujar al rival lejos.
- La manzana dorada da 4 de vida extra (corazones amarillos) que se gastan antes que la vida normal, y regeneración unos segundos. Comida antes de un intercambio, entra a la pelea con ventaja; dos seguidas no suman la vida extra.
- La manzana dorada encantada da mucha más vida extra, regeneración fuerte, y resistencia al daño y al fuego por varios minutos: es la mejor carta para un momento decisivo.

## Pociones
<!-- requiere: drink, throw -->
- Beber tarda ~1.6 s y te deja quieto; arrojar es instantáneo. En plena pelea, la arrojadiza a tus pies cura o fortalece sin perder el ritmo.
- Las arrojadizas hacen más efecto cuanto más cerca del impacto está el objetivo: al rival, tírala cuando está cerca (a 8 bloques o menos).
- Daño (instantánea) ignora la armadura: solo la reduce Protección. Es ideal para rematar a un rival bien acorazado que está bajo de vida.
- Fuerza suma daño fijo a cada golpe: tómala justo antes de cerrar distancia. Debilidad en el rival resta daño a cada golpe suyo.
- Veneno quita vida de a poco pero nunca deja a nadie en 0 (lo deja en 1): sirve para desgastar antes de un intercambio, no para rematar.
- Lentitud en el rival te deja alejarte o alcanzarlo a voluntad; Rapidez propia hace lo mismo a tu favor.
