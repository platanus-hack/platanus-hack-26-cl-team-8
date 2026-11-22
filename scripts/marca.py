#!/usr/bin/env python3
"""Genera las piezas de la marca Prompt Arena (docs/MARCA.md).

    python3 scripts/marca.py

Escribe los SVG en apps/web/public/brand/ y el favicon en apps/web/public/favicon.svg.
Los PNG se sacan de estos SVG con cualquier navegador, al tamaño que se indica:
  project-logo.png (1000 x 1000) <- brand/logo.svg     og.png (1200 x 630) <- brand/og.svg
  apple-touch-icon.png (180), icon-192.png, icon-512.png <- brand/icono.svg
  favicon-32.png <- brand/icono-simple.svg

Todo sale de una grilla de píxeles. El isotipo son dos cuadrados de 5 x 5 píxeles, rojo y
azul, separados por un tercio de su lado: los dos agentes, frente a frente. Cada uno tiene
un píxel vacío en la segunda fila, del lado del rival: se están mirando. En tamaños chicos
(menos de 48 px) el píxel no se distingue y se usa la versión simple, que es la de la barra
del sitio. El nombre va en Silkscreen, la fuente de píxeles del sitio, dibujado como
rectángulos para que el SVG no dependa de tener la fuente.
"""
import os

RED, BLUE, BG, TEXT = "#ff5d5d", "#6a8dff", "#101113", "#edece8"
WORD = [
 "###...###....##...#...#..###...###.......##...###...###..#...#...##.",
 "#..#..#..#..#..#..##.##..#..#...#.......#..#..#..#..#....##..#..#..#",
 "###...###...#..#..#.#.#..###....#.......####..###...###..#.#.#..####",
 "#.....#.#...#..#..#...#..#......#.......#..#..#.#...#....#..##..#..#",
 "#.....#..#...##...#...#..#......#.......#..#..#..#..###..#...#..#..#",
]
PROMPT = [r[:34] for r in WORD]; ARENA = [r[40:] for r in WORD]
# Para la tarjeta que se ve al compartir el enlace: la frase y el dominio, también en Silkscreen.
TAG_A = [
 "###....##....###.......##....###..###..#...#..###..###...###......###...###......#...##....",
 "#..#..#..#..#.........#..#..#.....#....##..#...#...#....#.........#..#..#........#..#..#...",
 "#..#..#..#...##.......####..#.##..###..#.#.#...#...###...##.......#..#..###......#..####...",
 "#..#..#..#.....#......#..#..#..#..#....#..##...#...#.......#......#..#..#........#..#..#...",
 "###....##...###.......#..#...##...###..#...#...#...###..###.......###...###......#..#..#..#",
]  # DOS AGENTES DE IA.
TAG_B = [
 "#..#..#...#......###...#..#..###..#.....##.......###..#...#......#...#..#..#...#..###...##...###....##...###..###...",
 "#..#..##..#......#..#..#..#..#....#....#..#......#....##..#......##.##..#..##..#..#....#..#..#..#..#..#..#.....#....",
 "#..#..#.#.#......#..#..#..#..###..#....#..#......###..#.#.#......#.#.#..#..#.#.#..###..#.....###...####..###...#....",
 "#..#..#..##......#..#..#..#..#....#....#..#......#....#..##......#...#..#..#..##..#....#..#..#.#...#..#..#.....#....",
 ".##...#...#......###....##...###..###...##.......###..#...#......#...#..#..#...#..###...##...#..#..#..#..#.....#...#",
]  # UN DUELO EN MINECRAFT.
DOMAIN = [
 "###...###....##...#...#..###...###........##...###...###..#...#...##.......###..#",
 "#..#..#..#..#..#..##.##..#..#...#........#..#..#..#..#....##..#..#..#.....#.....#",
 "###...###...#..#..#.#.#..###....#...###..####..###...###..#.#.#..####......##...#",
 "#.....#.#...#..#..#...#..#......#........#..#..#.#...#....#..##..#..#........#..#",
 "#.....#..#...##...#...#..#......#........#..#..#..#..###..#...#..#..#..#..###...#",
]  # PROMPT-ARENA.SI
MUTED = "#8d9098"

def n(v): return f"{v:g}"

def glyphs(rows, x, y, u, fill):
    d = []
    for j, row in enumerate(rows):
        i = 0
        while i < len(row):
            if row[i] == "#":
                k = i
                while k < len(row) and row[k] == "#": k += 1
                d.append(f"M{n(x+i*u)} {n(y+j*u)}h{n((k-i)*u)}v{n(u)}h{n(-(k-i)*u)}z")
                i = k
            else: i += 1
    return f'<path fill="{fill}" d="{"".join(d)}"/>'

def block(x, y, s, fill, eye_col=None):
    """Un cuadrado; con eye_col (0..4), un píxel vacío (de verdad: se ve el fondo) en la segunda fila."""
    d = f"M{n(x)} {n(y)}h{n(s)}v{n(s)}h{n(-s)}z"
    if eye_col is not None:
        e = s / 5
        d += f"M{n(x+eye_col*e)} {n(y+e)}v{n(e)}h{n(e)}v{n(-e)}z"
    return f'<path fill="{fill}" fill-rule="evenodd" d="{d}"/>'

def mark(x, y, s, eyes=True, g=None):
    g = s / 3 if g is None else g
    return block(x, y, s, RED, 3 if eyes else None) + block(x + s + g, y, s, BLUE, 1 if eyes else None)

def svg(w, h, body, bg=None, title="Prompt Arena"):
    r = f'<rect width="{n(w)}" height="{n(h)}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n(w)} {n(h)}" width="{n(w)}" height="{n(h)}" '
            f'shape-rendering="crispEdges" role="img" aria-label="{title}"><title>{title}</title>{r}{body}</svg>\n')

P = {}
# Logo principal, cuadrado de 1000: isotipo del ancho de "PROMPT" y el nombre en dos líneas.
t = 20; s = 291; g = 98                      # 2*291 + 98 = 680 = 34 píxeles de 20 (lado : separación = 3 : 1)
P["logo.svg"] = svg(1000, 1000, mark(160, 175, s, True, g) + glyphs(PROMPT, 160, 566, t, TEXT) + glyphs(ARENA, 160, 726, t, TEXT), BG)
# Ícono: solo el isotipo sobre el fondo. Con miradas (grande) y simple (chico, favicon).
P["icono.svg"] = svg(1000, 1000, mark(150, 350, 300, True, 100), BG)
P["icono-simple.svg"] = svg(32, 32, mark(4, 11, 10, False, 4), BG)     # favicon, 16 a 32 px: coordenadas enteras
# Isotipo suelto, sin fondo.
P["isotipo.svg"] = svg(700, 300, mark(0, 0, 300, True, 100))
P["isotipo-simple.svg"] = svg(700, 300, mark(0, 0, 300, False, 100))
# Horizontal: isotipo + nombre en una línea (altura del isotipo = 5 píxeles del nombre). Oscuro y claro.
u = 20
def horizontal(text_fill, bg=None, pad=0):
    return svg(12*u + 4*u + 68*u + 2*pad, 5*u + 2*pad, mark(pad, pad, 5*u, True, 2*u) + glyphs(WORD, pad + 16*u, pad, u, text_fill), bg)
P["horizontal.svg"] = horizontal(TEXT)                 # para fondos oscuros
P["horizontal-claro.svg"] = horizontal(BG)             # para fondos claros
P["nombre.svg"] = svg(68*u, 5*u, glyphs(WORD, 0, 0, u, TEXT))
# Tarjeta para compartir (1200 x 630): isotipo, nombre, la frase y el dominio. Se pasa a PNG (og.png).
P["og.svg"] = svg(1200, 630,
    mark(80, 80, 180, True, 60)
    + glyphs(DOMAIN, 1120 - 81*4, 80, 4, MUTED)
    + glyphs(WORD, 80, 325, 15, TEXT)
    + glyphs(TAG_A, 80, 455, 5, MUTED) + glyphs(TAG_B, 80, 500, 5, MUTED), BG)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps", "web", "public")
os.makedirs(os.path.join(ROOT, "brand"), exist_ok=True)
for name, content in P.items():
    with open(os.path.join(ROOT, "brand", name), "w") as f:
        f.write(content)
with open(os.path.join(ROOT, "favicon.svg"), "w") as f:
    f.write(P["icono-simple.svg"])
print("Marca escrita en apps/web/public/brand/:", ", ".join(sorted(P)))
