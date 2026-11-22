#!/usr/bin/env python3
"""Arma las láminas del demo en un solo archivo que funciona sin internet.

    python3 scripts/demo_slides.py

Lee docs/demo/slides.src.html y escribe docs/demo/slides.html con todo adentro: las dos
fuentes del sitio, el código QR y los datos de la última liga. Lo único que pide red al
presentar es la lámina en vivo, que muestra el sitio.

Los datos de la liga están aquí abajo, copiados del leaderboard. Si se corre otra liga, se
actualizan a mano y se vuelve a correr este script.
"""
import base64
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
FONTS = os.path.join(ROOT, "apps", "web", "node_modules")
DEMO = os.path.join(ROOT, "docs", "demo")

# Liga del 22 de noviembre de 2026 (liga-9-modelos-20261122-0258): 216 peleas válidas.
# elo, lo, hi: rating y su intervalo. ms: mediana por decisión. usd: costo por victoria.
LEAGUE = {
    "date": "22 de noviembre",
    "fights": 216,
    "red": 47,
    "blue": 53,
    "labelLeft": ["Gemini 3.8 Flash", "Claude Haiku 5.5", "Qwen 3.8 Flash", "GLM 5.3 Flash"],
    "rows": [
        {"name": "MiniMax-M3.1-Flash", "short": "MiniMax M3.1", "elo": 1287, "lo": 1124, "hi": 1449, "ms": 1081, "usd": 0.0119},
        {"name": "GPT-6 Luna (Fast)", "short": "GPT-6 Luna", "elo": 1155, "lo": 1007, "hi": 1302, "ms": 1397, "usd": 0.0185},
        {"name": "Gemini 3.8 Flash", "short": "Gemini 3.8 Flash", "elo": 1104, "lo": 959, "hi": 1249, "ms": 2334, "usd": 0.0554},
        {"name": "Muse Ember", "short": "Muse Ember", "elo": 1088, "lo": 943, "hi": 1232, "ms": 1156, "usd": 0.0160},
        {"name": "MiMo V2.6 Flash", "short": "MiMo V2.6", "elo": 1055, "lo": 911, "hi": 1199, "ms": 1244, "usd": 0.0115},
        {"name": "Claude Haiku 5.5", "short": "Claude Haiku 5.5", "elo": 1005, "lo": 860, "hi": 1150, "ms": 2409, "usd": 0.0253},
        {"name": "DeepSeek V4.1 Flash", "short": "DeepSeek V4.1", "elo": 1000, "lo": 1000, "hi": 1000, "ms": 815, "usd": 0.1278, "ref": True},
        {"name": "Qwen 3.8 Flash", "short": "Qwen 3.8 Flash", "elo": 656, "lo": 461, "hi": 851, "ms": 3838, "usd": 0.0205},
        {"name": "GLM 5.3 Flash", "short": "GLM 5.3 Flash", "elo": 372, "lo": 87, "hi": 657, "ms": 12856, "usd": 0.0234},
    ],
}


def font_face(family, path, weight):
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    return (
        f'@font-face {{ font-family: "{family}"; font-weight: {weight}; font-display: block; '
        f'src: url("data:font/woff2;base64,{data}") format("woff2"); }}'
    )


def main():
    with open(os.path.join(DEMO, "slides.src.html")) as f:
        html = f.read()

    fonts = "\n".join([
        font_face("Silkscreen", os.path.join(FONTS, "@fontsource", "silkscreen", "files", "silkscreen-latin-400-normal.woff2"), "400"),
        font_face("Instrument Sans", os.path.join(FONTS, "@fontsource-variable", "instrument-sans", "files", "instrument-sans-latin-wght-normal.woff2"), "400 700"),
    ])
    with open(os.path.join(ROOT, "docs", "marca", "qr-prompt-arena.svg")) as f:
        qr = re.sub(r' width="[^"]*" height="[^"]*"', "", f.read().strip(), count=1)

    for token, value in (
        ("/*FONTS*/", fonts),
        ("<!--QR-->", qr),
        ("/*DATA*/", "const LEAGUE = " + json.dumps(LEAGUE, ensure_ascii=False) + ";"),
    ):
        assert token in html, f"falta {token} en slides.src.html"
        html = html.replace(token, value, 1)
    html = html.replace(
        "Este archivo es la FUENTE: el que se abre para\n  presentar es slides.html, que arma",
        "Este archivo se genera: la fuente es slides.src.html y lo arma",
    )

    out = os.path.join(DEMO, "slides.html")
    with open(out, "w") as f:
        f.write(html)
    print(f"Láminas escritas en docs/demo/slides.html ({len(html) // 1024} KB)")


if __name__ == "__main__":
    main()
