# Bottom navigation SVGs

Source: https://github.com/phosphor-icons/core (MIT), retrieved 2026-11-20.
License: https://github.com/phosphor-icons/core/blob/main/LICENSE

| App asset | Phosphor icon |
| --- | --- |
| home | house |
| bell | bell |
| search | magnifying-glass |

Default variants use assets/bold/<name>-bold.svg; house and bell selected
variants use assets/fill/<name>-fill.svg. Search selected now reuses its bold
outline path in theme blue with an extra 4-unit outline stroke (256-unit
viewBox), preserving its hollow lens. Source path geometry is retained. Fixed fills
replace currentColor for WeChat image rendering: #4B5058 (default),
#4775FA (selected). No runtime library dependency is required.


The paper-plane assets reuse the local post interaction SVG at
`images/interface/paper-plane-muted.svg`, rather than a Phosphor icon.
The default retains both original paths with #4B5058 outlines; the selected
variant fills the original silhouette with #4775FA and draws its inner fold
in white. Both navigation variants use a 2.25-unit stroke in the 24-unit
viewBox, matching the 24-unit weight of the 256-unit Phosphor bold icons.
Navigation strokes scale with the icon, without non-scaling-stroke.
The post interaction asset itself is unchanged.
Market/storefront and tasks/clipboard-text navigation assets were removed
with their pages.


The separate compose action uses `plus-blue.svg`, derived from the existing
local `images/interface/plus-white.svg` geometry with theme-blue strokes.
It is not a Phosphor navigation asset.
