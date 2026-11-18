"""Export the navigation's simple line icons as transparent PNGs (Pillow)."""
from pathlib import Path
from math import cos, sin, radians
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / 'miniprogram/images/tab-bar'
OUT.mkdir(parents=True, exist_ok=True)
SCALE = 6


def export(name, color, suffix=''):
    image = Image.new('RGBA', (64 * SCALE, 64 * SCALE))
    draw = ImageDraw.Draw(image)
    width = 4.5 * SCALE

    def line(points, closed=False):
        points = [(round(x * SCALE), round(y * SCALE)) for x, y in points]
        draw.line(points + ([points[0]] if closed else []), fill=color, width=round(width), joint='curve')
        for x, y in points:
            r = width / 2
            draw.ellipse((x-r, y-r, x+r, y+r), fill=color)

    def arc(cx, cy, rx, ry, start, end):
        return [(cx + rx*cos(radians(a)), cy + ry*sin(radians(a)))
                for a in range(start, end + 1, 5)]

    if name == 'home':
        line([(8, 26), (32, 7), (56, 26), (56, 56), (39, 56), (39, 37),
              (25, 37), (25, 56), (8, 56)], closed=True)
    elif name == 'market':
        line([(13, 32), (13, 56), (51, 56), (51, 32)])
        line([(8, 25), (14, 7), (50, 7), (56, 25)])
        line([(8, 25), (8, 28)] + arc(16, 28, 8, 8, 0, 180)[::-1] +
             arc(32, 28, 8, 8, 0, 180)[::-1] + arc(48, 28, 8, 8, 0, 180)[::-1] + [(56, 25)])
    elif name == 'tasks':
        line([(23, 12), (11, 12), (11, 55), (53, 55), (53, 12), (41, 12)])
        line([(23, 7), (41, 7), (41, 20), (23, 20)], closed=True)
        line([(22, 37), (30, 45), (44, 29)])
    elif name == 'profile':
        line(arc(32, 19, 13, 13, 0, 360))
        line(arc(32, 56, 23, 24, 180, 360))
    elif name in ('messages', 'replies'):
        line([(15, 10), (49, 10)] + arc(49, 17, 7, 7, 270, 360) +
             [(56, 39)] + arc(49, 39, 7, 7, 0, 90) +
             [(27, 46), (15, 56), (15, 46)] + arc(15, 39, 7, 7, 90, 180) +
             [(8, 17)] + arc(15, 17, 7, 7, 180, 270), closed=True)
        for x in (23, 32, 41):
            r = 2 * SCALE
            draw.ellipse((x*SCALE-r, 28*SCALE-r, x*SCALE+r, 28*SCALE+r), fill=color)
    elif name == 'posts':
        draw.rounded_rectangle((10*SCALE, 8*SCALE, 54*SCALE, 56*SCALE), radius=9*SCALE, outline=color, width=round(width))
        line([(22, 24), (42, 24)])
        line([(22, 36), (35, 36)])
    elif name == 'bookmarks':
        line([(17, 8), (47, 8), (47, 56), (32, 45), (17, 56)], closed=True)
    elif name == 'reposts':
        line([(12, 14), (12, 43)] + arc(19, 43, 7, 7, 90, 180)[::-1] + [(36, 50)])
        line([(4, 22), (12, 14), (20, 22)])
        line([(28, 14), (45, 14)] + arc(45, 21, 7, 7, 270, 360) + [(52, 50)])
        line([(44, 42), (52, 50), (60, 42)])
    image.resize((128, 128), Image.Resampling.LANCZOS).save(OUT / f'{name}{suffix}.png')


for icon in ('home', 'market', 'tasks', 'profile', 'messages', 'posts', 'replies', 'reposts', 'bookmarks'):
    export(icon, '#777C88')
    export(icon, '#4775FA', '-active')
