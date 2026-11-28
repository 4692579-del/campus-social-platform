const SWEEP_MS = 1450;
const GRAIN_LIFE_MS = 860;
const UPWARD_ROOM = 190;
const MAX_TILES = 3800;
const WHITE_GRAINS = ['#d8dde4', '#dfe3e9', '#d1d7df'];
const COLOR_SAMPLES = [[.5, .5], [.2, .2], [.8, .2], [.2, .8], [.8, .8]];

function noise(x, y, seed) {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed) * 43758.5453123;
  return value - Math.floor(value);
}

function gust(x, y, seed) {
  const col = Math.floor(x), row = Math.floor(y);
  const u = x - col, v = y - row;
  const top = noise(col, row, seed) * (1 - u) + noise(col + 1, row, seed) * u;
  const bottom = noise(col, row + 1, seed) * (1 - u) + noise(col + 1, row + 1, seed) * u;
  return top * (1 - v) + bottom * v;
}

function tileColors(data, width, x, y, w, h) {
  let white = true, opaque = false;
  for (const [u, v] of COLOR_SAMPLES) {
    const index = (Math.floor(y + h * v) * width + Math.floor(x + w * u)) * 4;
    if (data[index + 3] < 20) continue;
    const r = data[index], g = data[index + 1], b = data[index + 2];
    opaque = true;
    if (Math.min(r, g, b) < 240 || Math.max(r, g, b) - Math.min(r, g, b) > 10) {
      return { white: false, opaque };
    }
  }
  return { white, opaque };
}

function fragmentTiles(capture, area, random = Math.random) {
  const { width, height, data } = capture;
  const sx = area.width / width, sy = area.height / height;
  const step = Math.max(5.4, Math.sqrt(area.width * area.height / MAX_TILES));
  const seed = random() * 10000;
  const tiles = [];
  let first = Infinity, last = -Infinity;
  for (let y = 0; y < height;) {
    const h = Math.min(height - y, Math.max(1, Math.round(step * (.82 + random() * .40) / sy)));
    for (let x = 0; x < width;) {
      const w = Math.min(width - x, Math.max(1, Math.round(h * sy / sx * (.63 + random() * .77))));
      const nx = (x + w / 2) / width, ny = (y + h / 2) / height;
      const localX = nx * area.width, localY = ny * area.height;
      const drift = gust(localX / 54, localY / 49, seed) - .5;
      const order = nx + drift * .29 + (random() - .5) * .13 + (ny - .5) * .10;
      first = Math.min(first, order);
      last = Math.max(last, order);

      const { white, opaque } = tileColors(data, width, x, y, w, h);
      const life = (white ? 310 : 420) + 215 * random() + 195 * nx;
      tiles.push({
        x, y, w, h, order, life, white,
        visible: opaque && (!white || random() >= .44),
        gray: WHITE_GRAINS[Math.floor(random() * WHITE_GRAINS.length)],
        vx: 42 + 53 * random(), vy: 52 + 87 * random(), phase: random() * Math.PI * 2,
      });
      x += w;
    }
    y += h;
  }
  for (const tile of tiles) {
    const progress = (tile.order - first) / (last - first || 1);
    tile.start = 12 + (SWEEP_MS - 12) * progress;
  }
  return tiles.sort((a, b) => a.start - b.start);
}

function createSandFrame(context, canvas, capture, area, random) {
  const { surface, width, height } = capture;
  const remaining = wx.createOffscreenCanvas({ type: '2d', width, height });
  const fixed = remaining.getContext('2d');
  fixed.drawImage(surface, 0, 0, width, height);
  return {
    context, surface, remaining, fixed, area, canvasWidth: canvas.width, canvasHeight: canvas.height,
    tiles: fragmentTiles(capture, area, random), released: 0, flying: [],
    sx: area.width / width, sy: area.height / height,
  };
}

function paintSand(frame, time) {
  const { context, surface, remaining, fixed, area, tiles, flying, sx, sy } = frame;
  // Each release removes exactly the source rectangle used by the airborne tile.
  // Clearing the backing canvas is irreversible. Nothing translates the remaining image.
  while (frame.released < tiles.length && tiles[frame.released].start <= time) {
    const tile = tiles[frame.released++];
    fixed.clearRect(tile.x, tile.y, tile.w, tile.h);
    if (tile.visible) flying.push(tile);
  }
  context.clearRect(0, 0, frame.canvasWidth, frame.canvasHeight);
  if (frame.released < tiles.length) {
    context.drawImage(remaining, 0, area.offset, area.width, area.height);
  }

  let alive = 0;
  for (const tile of flying) {
    const t = (time - tile.start) / tile.life;
    if (t >= 1) continue;
    flying[alive++] = tile;
    const drift = t * (.44 + .56 * t);
    const lift = t * (.58 + .42 * t);
    const sway = (Math.sin(tile.phase + t * 9) - Math.sin(tile.phase)) * 5 * t;
    const shrink = 1 - .83 * t ** .76;
    const x = (tile.x + tile.w / 2) * sx + tile.vx * drift + sway;
    const y = (tile.y + tile.h / 2) * sy + area.offset - tile.vy * lift;
    const w = tile.w * sx * shrink, h = tile.h * sy * shrink;
    if (x - w / 2 >= area.width || y + h / 2 <= 0) continue;
    const opacity = 1 - t ** 2.1;
    if (tile.white) {
      const tint = Math.min(1, t * 9);
      if (tint < 1) {
        context.globalAlpha = opacity * (1 - tint);
        context.drawImage(surface, tile.x, tile.y, tile.w, tile.h, x - w / 2, y - h / 2, w, h);
      }
      context.globalAlpha = opacity * .66 * tint;
      context.fillStyle = tile.gray;
      context.fillRect(x - w / 2, y - h / 2, w, h);
    } else {
      context.globalAlpha = opacity;
      context.drawImage(surface, tile.x, tile.y, tile.w, tile.h, x - w / 2, y - h / 2, w, h);
    }
  }
  flying.length = alive;
  context.globalAlpha = 1;
}

module.exports = { SWEEP_MS, GRAIN_LIFE_MS, UPWARD_ROOM, createSandFrame, paintSand };
