"""Generate a consistent family of local SVG line icons for profile pages."""
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'miniprogram/images/interface'
OUT.mkdir(parents=True, exist_ok=True)

SHAPES = {
    'menu-two': ['<path d="M3 8h18M3 16h12"/>'],
    'ellipsis': ['<path d="M5 12h.01M12 12h.01M19 12h.01"/>'],
    'send': ['<path d="m22 2-7 20-4-9-9-4Z"/>', '<path d="M22 2 11 13"/>'],
    'message-square': ['<path d="M21 6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h1v4l5-4h6a3 3 0 0 0 3-3Z"/>', '<path d="M8 10h.01M12 10h.01M16 10h.01"/>'],
    'chart-bars': ['<path d="M5 20V10M10 20V4M15 20v-7M20 20V7"/>'],
    'message-circle': ['<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H9l-6 3 1.8-6A8.5 8.5 0 1 1 21 11.5Z"/>'],
    'repeat': ['<path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3"/>'],
    'heart': ['<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>'],
    'heart-broken': ['<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>', '<path d="m13 4-3 6 4 3-2 7"/>'],
    'alert-circle': ['<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>'],
    'feather': ['<path d="M20 3c3 3-1 9-6 12l-5 1 1-5C13 6 17 0 20 3ZM3 21 17 7M8 16H3m5 0v5"/>'],
    'globe': ['<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z"/>'],
    'x': ['<path d="m5 5 14 14M19 5 5 19"/>'],
    'user': [
        '<circle cx="12" cy="7" r="4"/>',
        '<path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    ],
    'bell': [
        '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21a2 2 0 0 0 4 0"/>',
    ],
    'reply-bubble': [
        '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5h-1L6 23v-5.8A8.5 8.5 0 1 1 21 11.5Z"/>',
    ],
    'users': [
        '<circle cx="9" cy="7" r="4"/>',
        '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    ],
    'search': [
        '<circle cx="10.5" cy="10.5" r="7"/>',
        '<path d="m16 16 5 5"/>',
    ],
    'shield-check': [
        '<path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7Z"/>',
        '<path d="m8 12 3 3 5-6"/>',
    ],
    'pen-square': [
        '<path d="m16 3 5 5-12 12-6 1 1-6ZM14 5l5 5M3 21h18"/>',
    ],
    'menu': ['<path d="M4 6h16M4 12h16M4 18h16"/>'],
    'user-plus': [
        '<circle cx="9" cy="7" r="4"/>',
        '<path d="M2 21v-2a7 7 0 0 1 14 0v2m3-14v6m-3-3h6"/>',
    ],
    'history': [
        '<path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7m2-4v5l3 2"/>',
    ],
    'settings': [
        '<path d="m10 3-.5 2a8 8 0 0 0-2 .9l-1.9-.6-2 3.4L5 10.2a8 8 0 0 0 0 3.6l-1.4 1.5 2 3.4 1.9-.6a8 8 0 0 0 2 .9l.5 2h4l.5-2a8 8 0 0 0 2-.9l1.9.6 2-3.4-1.4-1.5a8 8 0 0 0 0-3.6l1.4-1.5-2-3.4-1.9.6a8 8 0 0 0-2-.9L14 3Z"/>',
        '<circle cx="12" cy="12" r="3"/>',
    ],
    'help-circle': [
        '<circle cx="12" cy="12" r="9"/>',
        '<path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4m.1 3h.01"/>',
    ],
    'log-out': [
        '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5M21 12H9"/>',
    ],
    'album': [
        '<rect x="3" y="3" width="18" height="18" rx="2"/>',
        '<circle cx="8.5" cy="8.5" r="1.5"/>',
        '<path d="m21 15-5-5L5 21"/>',
    ],
    'id-card': [
        '<rect x="2" y="4" width="20" height="16" rx="2"/>',
        '<circle cx="8" cy="10" r="2"/>',
        '<path d="M5 16a3 3 0 0 1 6 0m4-7h4m-4 4h4"/>',
    ],
    'copy': [
        '<rect x="8" y="8" width="13" height="13" rx="2"/>',
        '<path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    ],
    'school': [
        '<path d="M3 10 12 3l9 7M5 9v12h14V9M9 21v-7h6v7"/>',
    ],
    'calendar': [
        '<rect x="3" y="5" width="18" height="16" rx="2"/>',
        '<path d="M8 3v4m8-4v4M3 11h18"/>',
    ],
    'location': [
        '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/>',
        '<circle cx="12" cy="10" r="2.5"/>',
    ],
    'at-sign': [
        '<circle cx="12" cy="12" r="4"/>',
        '<path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    ],
    'share': [
        '<path d="M12 16V3m-4 4 4-4 4 4M7 10H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2"/>',
    ],
    'chevron-left': ['<path d="m15 5-7 7 7 7"/>'],
    'chevron-right': ['<path d="m9 5 7 7-7 7"/>'],
    'chevron-down': ['<path d="m5 9 7 7 7-7"/>'],
}

for name, shapes in SHAPES.items():
    colors = [('', '#171B20')]
    if name in ('calendar', 'chevron-right', 'chevron-down', 'copy', 'message-circle', 'repeat', 'heart', 'heart-broken', 'alert-circle', 'share', 'chart-bars', 'send', 'ellipsis'):
        colors.append(('-muted', '#687580'))
    if name in ('album', 'bell', 'reply-bubble', 'search', 'message-square'):
        colors = [('', '#777C88'), ('-active', '#4775FA')]
    if name == 'message-square':
        colors.append(('-muted', '#687580'))
    if name in ('menu', 'search', 'chevron-left'):
        colors.append(('-white', '#FFFFFF'))
    if name == 'feather':
        colors.append(('-white', '#FFFFFF'))
    if name in ('repeat', 'globe'):
        colors.append(('-active', '#4775FA'))
    if name == 'heart':
        colors.append(('-active', '#E34B76'))
    if name == 'heart-broken':
        colors.append(('-active', '#687580'))
    if name == 'log-out':
        colors.append(('-danger', '#D84A4A'))
    # Keep stroke thickness fixed when the same SVG is displayed at different sizes.
    body = ''.join(shape.replace('/>', ' vector-effect="non-scaling-stroke"/>') for shape in shapes)
    for suffix, color in colors:
        variant_body = body
        if name == 'heart-broken' and suffix == '-active':
            variant_body = shapes[0].replace('/>', f' fill="{color}" vector-effect="non-scaling-stroke"/>') + shapes[1].replace('/>', ' stroke="#FFFFFF" vector-effect="non-scaling-stroke"/>')
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
               f'fill="none" stroke="{color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
               f'{variant_body}</svg>\n')
        (OUT / f'{name}{suffix}.svg').write_text(svg, encoding='utf-8')
