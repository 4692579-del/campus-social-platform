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


The paper-plane assets reuse the latest user-reference silhouette from
`images/post-actions/share.svg`, rather than a Phosphor icon. Its transform
is flattened to the navigation's 24-unit viewBox without changing the outline.
The default uses #4B5058 outlines; selected uses the same silhouette in
#4775FA fill with an inset white horizontal fold, preserving the blue edge.
Both navigation variants use 2.25-unit rounded strokes to match the bold
weight of the other navigation icons, retaining the common 44rpx icon box.
Navigation strokes scale with the icon, without non-scaling-stroke.
The feed interaction icon itself is unchanged.
Market/storefront and tasks/clipboard-text navigation assets were removed
with their pages.


The separate compose action uses `plus-blue.svg`, derived from the existing
local `images/interface/plus-white.svg` geometry with theme-blue strokes.
It is not a Phosphor navigation asset.
