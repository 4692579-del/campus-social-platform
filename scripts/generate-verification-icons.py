"""Export the rounded eight-point badge as reusable SVG and transparent PNG."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / 'miniprogram/images/verification'
OUT.mkdir(parents=True, exist_ok=True)
SIZE = 200
SCALE = 4

# Both states share the reference's rounded eight-point outline and tapered check.
# The check is a transparent cutout, so the icon works on white and tinted cards.
outline = [
    ('M', 89, 10), ('Q', 100, 0, 111, 10), ('L', 130, 29),
    ('L', 153, 29), ('Q', 175, 29, 175, 51), ('L', 175, 71),
    ('L', 190, 89), ('Q', 201, 101, 190, 113), ('L', 175, 130),
    ('L', 175, 153), ('Q', 175, 175, 153, 175), ('L', 130, 175),
    ('L', 111, 190), ('Q', 100, 201, 89, 190), ('L', 71, 175),
    ('L', 51, 175), ('Q', 29, 175, 29, 153), ('L', 29, 130),
    ('L', 10, 113), ('Q', 0, 101, 10, 89), ('L', 29, 71),
    ('L', 29, 51), ('Q', 29, 29, 51, 29), ('L', 71, 29), ('Z',),
]
check = [
    ('M', 59, 101), ('Q', 62, 97, 67, 101), ('L', 83, 116),
    ('Q', 87, 119, 91, 115), ('L', 148, 65),
    ('Q', 154, 60, 152, 67), ('L', 94, 138),
    ('Q', 90, 143, 86, 139), ('L', 59, 110), ('Q', 55, 105, 59, 101), ('Z',),
]


def polygon(commands):
    points = []
    current = (0, 0)
    for command in commands:
        if command[0] in ('M', 'L'):
            current = command[1:]
            points.append(current)
        elif command[0] == 'Q':
            start = current
            cx, cy, x, y = command[1:]
            for n in range(1, 33):
                t = n / 32
                points.append(((1-t)**2*start[0] + 2*(1-t)*t*cx + t*t*x,
                               (1-t)**2*start[1] + 2*(1-t)*t*cy + t*t*y))
            current = (x, y)
    return [(round(x*SCALE), round(y*SCALE)) for x, y in points]


def svg_path(commands):
    return ' '.join(command[0] + ' '.join(str(n) for n in command[1:]) for command in commands)

for name, color in [('unverified', '#8B949E'), ('verified', '#4775FA'), ('black', '#171B20')]:
    image = Image.new('RGBA', (SIZE*SCALE, SIZE*SCALE))
    draw = ImageDraw.Draw(image)
    draw.polygon(polygon(outline), fill=color)
    draw.polygon(polygon(check), fill=(0, 0, 0, 0))
    image.resize((128,128), Image.Resampling.LANCZOS).save(OUT / f'{name}.png')

    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">'
           f'<path d="{svg_path(outline)} {svg_path(check)}" fill="{color}" fill-rule="evenodd"/>'
           '</svg>')
    (OUT / f'{name}.svg').write_text(svg, encoding='utf-8')
