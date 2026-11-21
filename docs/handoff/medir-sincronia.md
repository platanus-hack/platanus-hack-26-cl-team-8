# Cómo medir la sincronía entre el video y los datos

Sirve para comprobar que las barras de vida, la cuenta regresiva y los pensamientos se ven al
mismo tiempo que la imagen, y para calibrar `PIPELINE_MS` (parámetro `?sync=<ms>` de la web o
variable de build `PUBLIC_STREAM_PIPELINE_MS`; por defecto 400).

La idea: se cambia la hora del juego a noche con RCON (la imagen se oscurece de golpe), se anota
la hora exacta del servidor en que se mandó, y en el navegador se mide cuándo se oscurece el
video. La diferencia es el atraso real de la imagen. Eso se compara con el atraso que la página
está aplicando a los datos.

## Medición hecha antes del cambio (commit `7572ae3`)

| Qué | Valor |
|---|---|
| Atraso real de la imagen (4 marcas) | 1552, 1421, 1434 y 1309 ms (promedio ~1430 ms) |
| Atraso que la página aplicaba a los datos (4 cambios de fase seguidos) | 242, 918, 1051 y 1871 ms |

Es decir, los datos iban entre 0,4 y 1,2 s adelantados a la imagen. Después del cambio
(commit `985dbdf`) falta repetir la medición.

## Paso 1: en el navegador

Abre el sitio, espera a que el video esté en vivo y pega esto en la consola:

```js
(() => {
  if (window.__m) window.__m.stop();
  const m = { offset: -Infinity, luma: [], sync: [] };
  // Reloj del servidor: el evento que viajó más rápido da la mejor estimación.
  const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/api/ws");
  ws.onmessage = (e) => {
    const now = Date.now();
    try {
      const ev = JSON.parse(e.data);
      if (typeof ev.at === "number") m.offset = Math.max(m.offset, ev.at - now);
    } catch {}
  };
  const video = document.getElementById("arena-video");
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 18;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const timer = setInterval(() => {
    ctx.drawImage(video, 0, 0, 32, 18);
    const d = ctx.getImageData(0, 0, 32, 18).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    m.luma.push([Date.now(), Math.round(s / (32 * 18))]);
    // Lo que la página cree que es el atraso en ese mismo instante.
    if (window.__arenaSync) m.sync.push([Date.now(), window.__arenaSync().delayMs, window.__arenaSync().source]);
  }, 20);
  m.stop = () => {
    clearInterval(timer);
    ws.close();
  };
  window.__m = m;
})();
```

## Paso 2: en el servidor

En la carpeta del proyecto (con permiso para usar Docker):

```bash
mark() { docker compose exec -T minecraft rcon-cli "$@" >/dev/null; echo "MARK $(date +%s%3N) $*"; }
mark time set 18000; sleep 3; mark time set 6000; sleep 3
mark time set 18000; sleep 3; mark time set 6000
```

Anota los cuatro números que imprime (hora del servidor en milisegundos).

## Paso 3: leer el resultado en el navegador

Reemplaza los cuatro números de `marks` por los del paso 2:

```js
(() => {
  const m = window.__m;
  const marks = [[0, "night"], [0, "day"], [0, "night"], [0, "day"]]; // <- números del paso 2
  const vals = m.luma.map((x) => x[1]);
  const mid = (Math.max(...vals) + Math.min(...vals)) / 2;
  const trans = [];
  for (let i = 1; i < m.luma.length; i++) {
    const a = m.luma[i - 1][1] > mid;
    const b = m.luma[i][1] > mid;
    if (a !== b) trans.push({ srv: Math.round(m.luma[i][0] + m.offset), to: b ? "day" : "night", t: m.luma[i][0] });
  }
  return marks.map(([t, kind]) => {
    const tr = trans.find((x) => x.to === kind && x.srv > t && x.srv < t + 15000);
    if (!tr) return null;
    const page = m.sync.find((s) => s[0] >= tr.t);
    return { atrasoReal: tr.srv - t, atrasoQueAplicaLaPagina: page ? Math.round(page[1]) : null, fuente: page ? page[2] : null };
  });
})();
```

## Cómo leerlo

- `atrasoReal` y `atrasoQueAplicaLaPagina` deberían diferir en menos de 100 ms.
- Si la página aplica menos atraso que el real (los datos se adelantan), sube `PIPELINE_MS` en esa
  diferencia; si aplica más, bájalo. Se puede probar sin recompilar abriendo el sitio con
  `?sync=<ms>`, y dejarlo fijo con la variable de build `PUBLIC_STREAM_PIPELINE_MS`.
- `fuente` debería decir `"dates"`. Si dice `"latency"`, la página no está pudiendo leer la hora de
  los cuadros (`hls.playingDate`) y usa una estimación peor; `"none"` significa que no hay video.
