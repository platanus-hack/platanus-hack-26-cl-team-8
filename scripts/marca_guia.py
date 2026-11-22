#!/usr/bin/env python3
"""Arma la guía de marca de Prompt Arena como una página lista para imprimir en PDF.

    python3 scripts/marca_guia.py

Escribe docs/marca/guia-de-marca.html: nueve páginas A4 apaisadas. El PDF
(docs/marca/Prompt-Arena-guia-de-marca.pdf) es esa página impresa desde un navegador, con
"gráficos de fondo" activado y sin márgenes. Usa las mismas piezas que scripts/marca.py y
las fuentes del sitio (las de node_modules de apps/web: hay que tener las dependencias
instaladas para que se vean bien).
"""
import os
import re

import marca

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "docs", "marca")
FONTS = "../../apps/web/node_modules"

P = marca.build()
RED, BLUE, BG, TEXT = marca.RED, marca.BLUE, marca.BG, marca.TEXT


def inline(name, cls=""):
    """Un SVG de la marca, sin tamaño propio: lo pone el CSS."""
    svg = re.sub(r' width="[^"]*" height="[^"]*"', "", P[name].strip(), count=1)
    return svg.replace("<svg ", f'<svg class="{cls}" ', 1)


def pixels(rows, cls="px"):
    """Un dibujo de píxeles (filas de '#' o 'x') como SVG en el color del texto."""
    rects = "".join(
        f'<rect x="{x}" y="{y}" width="1" height="1"/>'
        for y, row in enumerate(rows)
        for x, ch in enumerate(row)
        if ch in "#x"
    )
    return (
        f'<svg class="{cls}" viewBox="0 0 {len(rows[0])} {len(rows)}" shape-rendering="crispEdges" '
        f'fill="currentColor" aria-hidden="true">{rects}</svg>'
    )


FIGHT = ["........xxx", ".......xxxx", "......xxxx.", ".....xxxx..", "xx..xxxx...", ".xxxxxx....",
         "..xxxx.....", "..xxxx.....", ".xxx.xx....", "xxx...x....", "xx........."]
TROPHY = ["...........", "..xxxxxxx..", "xxxxxxxxxxx", "x.xxxxxxx.x", "xxxxxxxxxxx", "..xxxxxxx..",
          "...xxxxx...", "....xxx....", ".....x.....", "....xxx....", "..xxxxxxx.."]
EYE = ["...xxxxx...", ".xx.....xx.", "x...xxx...x", "x...xxx...x", ".xx.....xx.", "...xxxxx..."]


def rgb(hex_color):
    h = hex_color.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def luminance(hex_color):
    def channel(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(v) for v in rgb(hex_color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


COLORS = [
    ("Rojo", RED, "El lado rojo: su nombre, su vida, sus pensamientos."),
    ("Azul", BLUE, "El lado azul: lo mismo, del otro lado."),
    ("Fondo", BG, "El fondo del sitio y del logo."),
    ("Texto", TEXT, "El texto y el nombre sobre fondo oscuro."),
    ("Ámbar", "#e8b84a", "Lo que no es de ningún lado: el equipo, la referencia, los avisos."),
]


def swatch(name, value, use):
    r, g, b = rgb(value)
    ratio = contrast(value, BG)
    on_bg = "" if value == BG else f"<span>Contraste: {ratio:.1f} a 1</span>".replace(".", ",")
    return (
        f'<div class="swatch"><i style="background:{value}"></i><b>{name}</b><code>{value.upper()}</code>'
        f"<span>RGB {r}, {g}, {b}</span>{on_bg}<p>{use}</p></div>"
    )


# Construcción del isotipo: la grilla de 5 x 5 de cada cuadrado y la separación de un tercio.
S, G, E = 300, 100, 60
grid = "".join(
    f'<path d="M{x0 + k * E} 0v{S}M{x0} {k * E}h{S}" stroke="rgba(16,17,19,.45)" stroke-width="2" fill="none"/>'
    for x0 in (0, S + G)
    for k in range(1, 5)
)
BUILD = (
    '<svg class="build" viewBox="-10 -10 720 420" role="img" aria-label="El isotipo sobre una grilla de 5 por 5">'
    f'<path fill="{RED}" fill-rule="evenodd" d="M0 0h{S}v{S}h-{S}zM{3 * E} {E}v{E}h{E}v-{E}z"/>'
    f'<path fill="{BLUE}" fill-rule="evenodd" d="M{S + G} 0h{S}v{S}h-{S}zM{S + G + E} {E}v{E}h{E}v-{E}z"/>'
    f"{grid}"
    f'<g stroke="{TEXT}" stroke-width="2" fill="none"><path d="M0 330v20M{S} 330v20M0 340h{S}"/>'
    f'<path d="M{S + G} 330v20M{S} 340h{G}"/><path d="M{2 * S + G} 330v20M{S + G} 340h{S}"/></g>'
    f'<g class="dim"><text x="{S / 2}" y="388" text-anchor="middle">5 píxeles</text>'
    f'<text x="{S + G / 2}" y="388" text-anchor="middle">1/3</text>'
    f'<text x="{S + G + S / 2}" y="388" text-anchor="middle">5 píxeles</text></g></svg>'
)

# Área de respeto: alrededor del logo queda libre, como mínimo, la separación entre los cuadrados.
CLEAR = (
    '<svg class="clear" viewBox="0 0 900 500" role="img" aria-label="Área de respeto del isotipo">'
    '<rect x="2" y="2" width="896" height="496" fill="none" stroke="#5e6169" stroke-width="2" stroke-dasharray="10 8"/>'
    f'<path fill="{RED}" fill-rule="evenodd" d="M100 100h300v300h-300zM280 160v60h60v-60z"/>'
    f'<path fill="{BLUE}" fill-rule="evenodd" d="M500 100h300v300h-300zM560 160v60h60v-60z"/>'
    '<g fill="rgba(232,184,74,.28)"><rect x="400" y="100" width="100" height="300"/><rect x="0" y="200" width="100" height="100"/>'
    '<rect x="800" y="200" width="100" height="100"/><rect x="400" y="0" width="100" height="100"/><rect x="400" y="400" width="100" height="100"/></g>'
    '<g class="dim"><text x="450" y="262" text-anchor="middle">x</text><text x="50" y="262" text-anchor="middle">x</text>'
    '<text x="850" y="262" text-anchor="middle">x</text><text x="450" y="62" text-anchor="middle">x</text><text x="450" y="462" text-anchor="middle">x</text></g></svg>'
)


def wrong(body, caption):
    """Un uso incorrecto: la pieza mal hecha, tachada, y por qué no."""
    return (
        f'<figure class="wrong"><div class="wrong__art">{body}<svg class="strike" viewBox="0 0 100 100" preserveAspectRatio="none">'
        f'<path d="M0 100L100 0" stroke="#edece8" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg></div>'
        f"<figcaption>{caption}</figcaption></figure>"
    )


def bad_mark(left=RED, right=BLUE, extra="", attrs=""):
    return (
        f'<svg viewBox="0 0 700 300" {attrs}>'
        f'<path fill="{left}" fill-rule="evenodd" d="M0 0h300v300h-300zM180 60v60h60v-60z"/>'
        f'<path fill="{right}" fill-rule="evenodd" d="M400 0h300v300h-300zM460 60v60h60v-60z"/>{extra}</svg>'
    )


WRONGS = "".join([
    wrong('<svg viewBox="0 0 700 300"><rect width="300" height="300" rx="70" fill="#ff5d5d"/><rect x="400" width="300" height="300" rx="70" fill="#6a8dff"/>'
          '<rect x="180" y="60" width="60" height="60" fill="#101113"/><rect x="460" y="60" width="60" height="60" fill="#101113"/></svg>',
          "No se redondean las esquinas."),
    wrong(bad_mark("#6fcf8e", "#e8b84a"), "No se cambian los colores."),
    wrong(bad_mark(BLUE, RED), "No se invierte el orden: el rojo va a la izquierda."),
    wrong(bad_mark(attrs='preserveAspectRatio="none" style="height:46%"'), "No se estira ni se aplasta."),
    wrong('<svg viewBox="0 0 700 300"><defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a8a"/><stop offset="1" stop-color="#c8323c"/></linearGradient>'
          '<linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a9c0ff"/><stop offset="1" stop-color="#3550c8"/></linearGradient></defs>'
          '<rect width="300" height="300" fill="url(#g1)"/><rect x="400" width="300" height="300" fill="url(#g2)"/>'
          '<rect x="180" y="60" width="60" height="60" fill="#101113"/><rect x="460" y="60" width="60" height="60" fill="#101113"/></svg>',
          "Sin degradados, sombras ni brillos."),
    wrong(bad_mark(extra='<rect x="120" y="180" width="120" height="60" fill="#101113"/><rect x="460" y="180" width="120" height="60" fill="#101113"/>'),
          "No se agregan rasgos: ni boca, ni cejas, ni un segundo ojo."),
])

PAGES = []


def page(title, body, cls=""):
    PAGES.append((title, body, cls))


page("", f'''
<div class="cover">
  {inline("logo.svg", "cover__logo")}
  <div class="cover__text">
    <p class="pixel muted">Guía de marca</p>
    <h1>Dos cuadrados que se miran.</h1>
    <p class="lead">Cómo se ve Prompt Arena y cómo usar sus piezas: el logo, los colores, la tipografía y las reglas que las mantienen iguales en todas partes.</p>
    <p class="muted small">Versión 1, noviembre de 2026</p>
  </div>
</div>''', "page--cover")

page("La idea", f'''
<div class="cols">
  <div class="stack">
    <h2>Los dos agentes, antes de pelear.</h2>
    <p>Prompt Arena es un duelo: dos agentes de IA, uno rojo y uno azul, en una arena de Minecraft. La marca muestra justo eso y nada más.</p>
    <p>El isotipo ya estaba en la barra del sitio: un cuadrado rojo y uno azul. Lo único que se le agregó es un píxel vacío en cada uno, del lado del rival. Con ese píxel, dos bloques pasan a ser dos personajes que se miran.</p>
    <p>Todo se construye sobre una grilla de píxeles, como el juego y como la fuente del sitio.</p>
  </div>
  <div class="stack">
    {BUILD}
    <ul class="facts">
      <li>Cada cuadrado es una grilla de 5 × 5 píxeles.</li>
      <li>La separación mide un tercio del lado.</li>
      <li>La mirada va en la segunda fila. Es un hueco de verdad: deja ver el fondo.</li>
      <li>El rojo siempre a la izquierda, como en el marcador de la pelea.</li>
    </ul>
  </div>
</div>''')

page("Las piezas", f'''
<div class="pieces">
  <figure><div class="tile">{inline("logo.svg")}</div><figcaption><b>Logo</b><code>logo.svg</code>Portadas, la página de votación, redes.</figcaption></figure>
  <figure><div class="tile">{inline("icono.svg")}</div><figcaption><b>Ícono</b><code>icono.svg</code>Avatares e íconos de 48 px o más.</figcaption></figure>
  <figure><div class="tile tile--small">{inline("icono-simple.svg")}</div><figcaption><b>Ícono simple</b><code>icono-simple.svg</code>Favicon y todo lo que mida menos de 48 px.</figcaption></figure>
  <figure class="wide"><div class="tile tile--pad">{inline("horizontal.svg")}</div><figcaption><b>Horizontal</b><code>horizontal.svg</code>Encabezados sobre fondo oscuro.</figcaption></figure>
  <figure class="wide"><div class="tile tile--pad tile--light">{inline("horizontal-claro.svg")}</div><figcaption><b>Horizontal claro</b><code>horizontal-claro.svg</code>Encabezados sobre fondo claro.</figcaption></figure>
</div>
<p class="note">También están el isotipo sin fondo (<code>isotipo.svg</code>, <code>isotipo-simple.svg</code>) y el nombre solo (<code>nombre.svg</code>). Todas las piezas salen de <code>python3 scripts/marca.py</code>; no se editan a mano.</p>''')

page("Tamaño y espacio", f'''
<div class="cols">
  <div class="stack">
    <h2>La mirada desaparece bajo 48 px.</h2>
    <div class="ladder">
      <figure style="width:42mm">{inline("logo.svg")}<figcaption>Logo</figcaption></figure>
      <figure style="width:25mm">{inline("icono.svg")}<figcaption>96 px</figcaption></figure>
      <figure style="width:12.5mm">{inline("icono.svg")}<figcaption>48</figcaption></figure>
      <figure style="width:8.5mm">{inline("icono-simple.svg")}<figcaption>32</figcaption></figure>
      <figure style="width:4.2mm">{inline("icono-simple.svg")}<figcaption>16</figcaption></figure>
    </div>
    <ul class="facts">
      <li>Desde 48 px: el ícono con las miradas.</li>
      <li>Bajo 48 px: el ícono simple, sin el píxel. Es el del favicon y el de la barra del sitio.</li>
      <li>El logo con el nombre no baja de 96 px de ancho en pantalla ni de 25 mm impreso.</li>
    </ul>
  </div>
  <div class="stack">
    <h2>Espacio libre alrededor.</h2>
    {CLEAR}
    <p>Alrededor del isotipo queda libre, como mínimo, la separación entre los dos cuadrados (x). Nada entra en ese espacio: ni texto, ni otros logos, ni el borde de la pieza.</p>
  </div>
</div>''')

page("Color", f'''
<div class="swatches">{"".join(swatch(*c) for c in COLORS)}</div>
<div class="cols cols--tight">
  <div class="stack">
    <h2>Rojo y azul significan "este lado".</h2>
    <p>Son los colores de los dos agentes y de nada más. No se usan para decorar, ni para errores, enlaces o botones. Lo que no pertenece a ningún lado va en ámbar o en el color del texto.</p>
  </div>
  <div class="stack">
    <h2>Cuánto de cada uno.</h2>
    <div class="ratio"><i style="flex:78;background:{BG};border:1px solid #2a2c31"></i><i style="flex:12;background:{TEXT}"></i><i style="flex:4;background:{RED}"></i><i style="flex:4;background:{BLUE}"></i><i style="flex:2;background:#e8b84a"></i></div>
    <p>El fondo oscuro manda. El texto es casi todo lo demás. Rojo y azul aparecen poco y siempre juntos, en partes iguales.</p>
  </div>
</div>''')

page("Tipografía", '''
<div class="cols">
  <div class="stack">
    <p class="type-pixel">Silkscreen</p>
    <p class="type-pixel type-pixel--small">ABCDEFGHIJKLMNÑOPQRSTUVWXYZ<br>0123456789 ¿? ¡! : .</p>
    <h2>Para el nombre y las etiquetas cortas.</h2>
    <ul class="facts">
      <li>El nombre "Prompt Arena", el reloj, "En vivo", los rótulos de las pestañas.</li>
      <li>Es una fuente de píxeles de 8 px: se usa en 16, 24, 32 o 48 px, para que cada píxel caiga entero.</li>
      <li>Nunca para un párrafo.</li>
    </ul>
  </div>
  <div class="stack">
    <p class="type-sans">Instrument Sans</p>
    <p class="type-sans type-sans--small">Eres un francotirador paciente. Mantén al menos 8 bloques de distancia y dispara con el arco.</p>
    <h2>Para todo el texto.</h2>
    <ul class="facts">
      <li>Los prompts, lo que piensa cada agente, las explicaciones y los datos.</li>
      <li>Peso normal para leer, 500 a 600 para títulos y nombres.</li>
      <li>Los números van tabulares cuando se alinean en columnas.</li>
    </ul>
  </div>
</div>''')

page("Interfaz", f'''
<div class="cols">
  <div class="stack">
    <h2>Plano y de esquinas rectas.</h2>
    <p>El sitio se ve como el marcador de un juego: bloques planos, bordes de un píxel y nada redondeado. Sin sombras, sin degradados, sin brillos.</p>
    <div class="ui">
      <div class="bar"><span class="bar__mark"><i></i><i></i></span><span class="pixel">Prompt Arena</span>
        <span class="tabs"><span class="tabs__on">{pixels(FIGHT)}Pelea</span><span>{pixels(TROPHY)}Leaderboard</span></span></div>
      <div class="tags"><span class="tag tag--live"><i></i>En vivo</span><span class="tag">{pixels(EYE, "px px--eye")}Espectador</span><span class="tag tag--amber">Invitado</span><span class="tag tag--amber">Equipo</span></div>
    </div>
    <p class="muted small">La barra del sitio, con el isotipo simple, y las etiquetas de estado.</p>
  </div>
  <div class="stack">
    <h2>Íconos de píxeles.</h2>
    <div class="icons">
      <figure>{pixels(FIGHT, "px px--big")}<figcaption>Pelea</figcaption></figure>
      <figure>{pixels(TROPHY, "px px--big")}<figcaption>Leaderboard</figcaption></figure>
      <figure>{pixels(EYE, "px px--big")}<figcaption>Espectador</figcaption></figure>
    </div>
    <ul class="facts">
      <li>Cada ícono se dibuja a mano en una grilla de 11 × 11.</li>
      <li>Los de navegación y estado van en un solo color, el del texto.</li>
      <li>Se muestran a un píxel de pantalla por píxel del dibujo, o al doble. Nunca a un tamaño intermedio.</li>
    </ul>
  </div>
</div>''')

page("Usos incorrectos", f'''
<div class="wrongs">{WRONGS}</div>
<p class="note">Sobre una foto o un video va el logo con su fondo (<code>logo.svg</code> o <code>icono.svg</code>), no el isotipo suelto.</p>''')

page("En uso", f'''
<div class="cols cols--uses">
  <div class="stack">
    <div class="card">{inline("og.svg")}</div>
    <p><b>La tarjeta al compartir.</b> Lo que muestran WhatsApp, Slack y otros al pegar un enlace del sitio (<code>og.png</code>, 1200 × 630).</p>
  </div>
  <div class="stack">
    <div class="uses">
      <figure><div class="phone">{inline("icono.svg")}</div><figcaption>Pantalla de inicio del teléfono</figcaption></figure>
      <figure><div class="browser"><span>{inline("icono-simple.svg")}Prompt Arena</span></div><figcaption>Pestaña del navegador</figcaption></figure>
    </div>
    <h2>Dónde está cada cosa.</h2>
    <ul class="facts">
      <li><code>apps/web/public/brand/</code>: todos los SVG.</li>
      <li><code>apps/web/public/</code>: el favicon, la tarjeta y los íconos en PNG.</li>
      <li><code>project-logo.png</code>: el logo de la entrega, 1000 × 1000.</li>
      <li><code>docs/MARCA.md</code>: esta guía, en corto.</li>
    </ul>
  </div>
</div>''')

CSS = f'''
@font-face {{ font-family: "Silkscreen"; src: url("{FONTS}/@fontsource/silkscreen/files/silkscreen-latin-400-normal.woff2") format("woff2"); font-weight: 400; }}
@font-face {{ font-family: "Instrument Sans"; src: url("{FONTS}/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2") format("woff2"); font-weight: 400 700; }}
@page {{ size: 297mm 210mm; margin: 0; }}
* {{ box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
html, body {{ margin: 0; background: #2a2c31; }}
body {{ font: 400 11.5pt/1.5 "Instrument Sans", system-ui, sans-serif; color: {TEXT}; }}
.page {{ position: relative; width: 297mm; height: 210mm; padding: 20mm 22mm 22mm; background: {BG}; overflow: hidden; break-after: page; display: flex; flex-direction: column; gap: 9mm; }}
.page:last-child {{ break-after: auto; }}
@media screen {{ .page {{ margin: 6mm auto; }} }}
svg {{ display: block; max-width: 100%; height: auto; }}
h1, h2, p, ul, figure {{ margin: 0; }}
.pixel {{ font: 400 12pt/1 "Silkscreen", monospace; }}
.muted {{ color: #8d9098; }}
.small {{ font-size: 9.5pt; }}
.page__head {{ display: flex; justify-content: space-between; align-items: baseline; font: 400 12pt/1 "Silkscreen", monospace; }}
.page__head span + span {{ color: #5e6169; }}
.page__foot {{ position: absolute; left: 22mm; right: 22mm; bottom: 10mm; display: flex; justify-content: space-between; align-items: center; font-size: 8.5pt; color: #5e6169; }}
.page__foot svg {{ width: 9mm; }}
h1 {{ font-size: 34pt; line-height: 1.08; font-weight: 500; letter-spacing: -0.01em; }}
h2 {{ font-size: 15pt; line-height: 1.2; font-weight: 600; }}
.lead {{ font-size: 13pt; color: #c9c8c4; max-width: 28em; }}
code {{ font: 400 9pt/1.2 ui-monospace, "SF Mono", Menlo, monospace; color: #c9c8c4; }}
.cols {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16mm; flex: 1; min-height: 0; }}
.cols--tight {{ flex: none; }}
.stack {{ display: flex; flex-direction: column; gap: 5mm; min-width: 0; }}
.facts {{ padding-left: 1.1em; display: grid; gap: 1.6mm; color: #c9c8c4; }}
.note {{ color: #8d9098; font-size: 10pt; max-width: 60em; }}
.cover {{ flex: 1; display: grid; grid-template-columns: 112mm 1fr; gap: 20mm; align-items: center; }}
.cover__text {{ display: grid; gap: 7mm; }}
.build {{ width: 100%; max-width: 118mm; }}
.build .dim text, .clear .dim text {{ font: 500 22px "Instrument Sans", sans-serif; fill: #8d9098; }}
.clear {{ width: 100%; max-width: 104mm; }}
.clear .dim text {{ font-size: 30px; fill: #e8b84a; }}
.pieces {{ display: grid; grid-template-columns: repeat(6, 1fr); gap: 7mm 8mm; }}
.pieces figure {{ grid-column: span 2; display: grid; gap: 3mm; align-content: start; }}
.pieces figure.wide {{ grid-column: span 3; }}
.pieces figcaption, .wrong figcaption {{ font-size: 9.5pt; color: #8d9098; display: grid; gap: 0.6mm; }}
.pieces figcaption b {{ color: {TEXT}; font-size: 11pt; font-weight: 600; }}
.tile {{ height: 50mm; display: grid; place-items: center; background: {BG}; border: 1px solid #2a2c31; }}
.tile svg {{ height: 100%; width: auto; }}
.tile--small svg {{ height: 14mm; }}
.tile--pad {{ height: 28mm; padding: 0 10mm; }}
.tile--pad svg {{ height: auto; width: 100%; }}
.tile--light {{ background: {TEXT}; border-color: {TEXT}; }}
.ladder {{ display: flex; align-items: flex-end; gap: 7mm; }}
.ladder figure {{ display: grid; gap: 2mm; flex: none; }}
.ladder figcaption, .icons figcaption, .uses figcaption {{ font-size: 8.5pt; color: #8d9098; white-space: nowrap; }}
.swatches {{ display: grid; grid-template-columns: repeat(5, 1fr); gap: 7mm; }}
.swatch {{ display: grid; gap: 1.4mm; align-content: start; font-size: 9pt; color: #8d9098; }}
.swatch i {{ display: block; height: 34mm; border: 1px solid #2a2c31; margin-bottom: 2mm; }}
.swatch b {{ color: {TEXT}; font-size: 12pt; font-weight: 600; }}
.swatch code {{ font: 400 12pt/1 "Silkscreen", monospace; color: {TEXT}; }}
.swatch p {{ color: #c9c8c4; font-size: 9.5pt; line-height: 1.35; margin-top: 1mm; }}
.ratio {{ display: flex; height: 12mm; gap: 0; }}
.ratio i {{ display: block; }}
.type-pixel {{ font: 400 36pt/1.1 "Silkscreen", monospace; }}
.type-pixel--small {{ font-size: 12pt; line-height: 1.6; color: #c9c8c4; }}
.type-sans {{ font-size: 38pt; line-height: 1.05; font-weight: 500; letter-spacing: -0.01em; }}
.type-sans--small {{ font-size: 13pt; line-height: 1.4; font-weight: 400; color: #c9c8c4; letter-spacing: 0; }}
.ui {{ display: grid; gap: 5mm; padding: 6mm; background: #262f45; }}
.bar {{ display: flex; align-items: center; gap: 4mm; white-space: nowrap; }}
.bar__mark {{ display: inline-flex; gap: 0.8mm; }}
.bar__mark i {{ width: 2.6mm; height: 2.6mm; background: {RED}; }}
.bar__mark i + i {{ background: {BLUE}; }}
.tabs {{ display: inline-flex; border: 1px solid #2a2c31; background: rgba(6, 7, 9, 0.6); font: 400 9pt/1 "Silkscreen", monospace; }}
.tabs span {{ display: inline-flex; align-items: center; gap: 1.8mm; padding: 2mm 3mm; }}
.tabs__on {{ background: #2a2c31; box-shadow: inset 0 -0.6mm 0 {TEXT}; }}
.px {{ width: 2.9mm; flex: none; }}
.px--eye {{ width: 5.2mm; }}
.px--big {{ width: 22mm; }}
.tags {{ display: flex; gap: 2mm; white-space: nowrap; }}
.tag {{ display: inline-flex; align-items: center; gap: 2mm; padding: 1.6mm 2.2mm; border: 1px solid rgba(237, 236, 232, 0.55); background: rgba(6, 7, 9, 0.6); font: 400 8pt/1 "Silkscreen", monospace; }}
.tag--live {{ border-color: rgba(255, 93, 93, 0.55); }}
.tag--live i {{ width: 2.4mm; height: 2.4mm; background: {RED}; }}
.tag--amber {{ color: #e8b84a; border-color: rgba(232, 184, 74, 0.55); }}
.icons {{ display: flex; gap: 14mm; align-items: flex-end; }}
.icons figure {{ display: grid; gap: 3mm; justify-items: start; }}
.icons figure:last-child .px--big {{ width: 22mm; }}
.wrongs {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 8mm 10mm; }}
.wrong {{ display: grid; gap: 3mm; }}
.wrong__art {{ position: relative; height: 42mm; display: grid; place-items: center; background: #08090b; border: 1px solid #2a2c31; padding: 8mm 14mm; }}
.wrong__art > svg:first-child {{ width: 100%; max-height: 100%; }}
.wrong .strike {{ position: absolute; inset: 0; width: 100%; height: 100%; max-width: none; }}
.wrong figcaption {{ color: #c9c8c4; font-size: 10.5pt; }}
.cols--uses {{ grid-template-columns: 1.25fr 1fr; }}
.card {{ border: 1px solid #2a2c31; }}
.uses {{ display: flex; gap: 12mm; align-items: flex-end; }}
.uses figure {{ display: grid; gap: 3mm; }}
.phone {{ width: 24mm; height: 24mm; border-radius: 5.4mm; overflow: hidden; border: 1px solid #2a2c31; }}
.browser {{ padding: 3mm 4mm; background: #191a1d; border: 1px solid #2a2c31; font-size: 10pt; }}
.browser span {{ display: inline-flex; align-items: center; gap: 2.4mm; }}
.browser svg {{ width: 4.2mm; }}
'''

total = len(PAGES)
sections = []
for number, (title, body, cls) in enumerate(PAGES, start=1):
    head = "" if not title else f'<header class="page__head"><span>{title}</span><span>{number} / {total}</span></header>'
    foot = "" if not title else f'<footer class="page__foot"><span>Prompt Arena, guía de marca</span>{inline("isotipo-simple.svg")}</footer>'
    sections.append(f'<section class="page {cls}">{head}{body}{foot}</section>')

HTML = f'''<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Prompt Arena, guía de marca</title>
<meta name="author" content="Prompt Arena">
<meta name="description" content="Guía de marca de Prompt Arena: logo, isotipo, colores, tipografía y reglas de uso.">
<style>{CSS}</style>
</head>
<body>
{"".join(sections)}
</body>
</html>
'''

os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "guia-de-marca.html"), "w") as f:
    f.write(HTML)
print(f"Guía escrita en docs/marca/guia-de-marca.html ({total} páginas, {len(HTML)} bytes)")
