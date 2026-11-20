const BLUE = '#4775FA', GRAY = '#AAB0BC';
const CYCLE = 900, REFILL = 600, THRESHOLD = 72;
const clamp = n => Math.max(0, Math.min(1, Number(n) || 0));
const splitProgress = p => [0, 1, 2].map(i => clamp(clamp(p) * 3 - i));
const ease = p => 1 - Math.pow(1 - clamp(p), 3);
function waveOffset(elapsed, index) {
  const t = ((elapsed - index * 150) % CYCLE + CYCLE) % CYCLE;
  return t < 600 ? -36 * Math.pow(Math.sin(Math.PI * t / 600), 2) : 0;
}
function sample(start, curves) {
  const points = [start]; let from = start;
  for (const [a, b, end] of curves) {
    for (let i = 1; i <= 48; i++) {
      const t = i / 48, s = 1 - t;
      points.push([s ** 3 * from[0] + 3 * s ** 2 * t * a[0] + 3 * s * t ** 2 * b[0] + t ** 3 * end[0],
        s ** 3 * from[1] + 3 * s ** 2 * t * a[1] + 3 * s * t ** 2 * b[1] + t ** 3 * end[1]]);
    }
    from = end;
  }
  // 从字形之外开始/结束遮罩，进度前缘连续扫过圆润端点，不突然出现整块圆帽。
  const extension = (a, b) => { const d = Math.hypot(a[0] - b[0], a[1] - b[1]); return [a[0] + (a[0] - b[0]) * 72 / d, a[1] + (a[1] - b[1]) * 72 / d]; };
  points.unshift(extension(points[0], points[1])); points.push(extension(points[points.length - 1], points[points.length - 2]));
  let length = 0;
  return points.map((point, i) => { if (i) length += Math.hypot(point[0] - points[i - 1][0], point[1] - points[i - 1][1]); return { x: point[0], y: point[1], length }; });
}
const C_PATH = sample([307, 141], [
  [[269, 110], [227, 99], [181, 107]], [[100, 120], [48, 185], [48, 260]],
  [[48, 329], [100, 391], [175, 404]], [[225, 414], [273, 399], [309, 369]],
]);
const U_PATH = sample([436, 160], [
  [[436, 207], [436, 255], [436, 302]], [[436, 370], [474, 410], [535, 410]],
  [[596, 410], [634, 370], [634, 302]], [[634, 255], [634, 207], [634, 160]],
]);
function strokeProgress(ctx, path, progress, width) {
  if (!progress) return;
  const end = path[path.length - 1].length * progress;
  ctx.beginPath(); ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (b.length <= end) ctx.lineTo(b.x, b.y);
    else { const t = (end - a.length) / (b.length - a.length); ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t); break; }
  }
  ctx.lineWidth = width; ctx.lineCap = 'butt'; ctx.lineJoin = 'round'; ctx.stroke();
}
function drawC(ctx) {
  ctx.beginPath(); ctx.moveTo(307, 141); ctx.bezierCurveTo(269, 110, 227, 99, 181, 107);
  ctx.bezierCurveTo(100, 120, 48, 185, 48, 260); ctx.bezierCurveTo(48, 329, 100, 391, 175, 404);
  ctx.bezierCurveTo(225, 414, 273, 399, 309, 369); ctx.lineWidth = 96; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
}
function drawU(ctx) {
  ctx.beginPath(); ctx.moveTo(418, 160); ctx.bezierCurveTo(399, 160, 390, 172, 390, 190); ctx.lineTo(390, 304);
  ctx.bezierCurveTo(390, 396, 452, 452, 535, 452); ctx.bezierCurveTo(618, 452, 680, 396, 680, 304); ctx.lineTo(680, 190);
  ctx.bezierCurveTo(680, 171, 668, 160, 650, 160); ctx.lineTo(617, 160); ctx.bezierCurveTo(600, 160, 588, 172, 588, 190);
  ctx.lineTo(588, 302); ctx.bezierCurveTo(588, 347, 571, 368, 535, 368); ctx.bezierCurveTo(499, 368, 482, 347, 482, 302);
  ctx.lineTo(482, 190); ctx.bezierCurveTo(482, 171, 470, 160, 452, 160); ctx.closePath(); ctx.fill();
}
function drawI(ctx) {
  ctx.beginPath(); ctx.moveTo(734, 452); ctx.lineTo(734, 260); ctx.bezierCurveTo(734, 202, 769, 171, 814, 171);
  ctx.lineTo(852, 171); ctx.lineTo(852, 373); ctx.bezierCurveTo(852, 419, 823, 452, 777, 452); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(795, 78, 76, 0, Math.PI * 2); ctx.fill();
}
function eye(ctx, x) {
  ctx.beginPath(); ctx.moveTo(x, 57.5); ctx.arc(x + 10.5, 57.5, 10.5, Math.PI, 0);
  ctx.lineTo(x + 21, 82.5); ctx.arc(x + 10.5, 82.5, 10.5, 0, Math.PI); ctx.closePath(); ctx.fill();
}
function drawLogo(ctx, width, height, { progress = 0, refill = false, elapsed = null } = {}) {
  ctx.clearRect(0, 0, width, height);
  const scale = Math.min(width / 900, height / 2 / 470), parts = splitProgress(progress);
  const base = refill || elapsed !== null ? GRAY : BLUE, overlay = refill ? BLUE : GRAY;
  ctx.save(); ctx.translate((width - 900 * scale) / 2, (height - 470 * scale) / 2); ctx.scale(scale, scale);
  for (let i = 0; i < 3; i++) {
    ctx.save(); ctx.translate(0, elapsed === null ? 0 : waveOffset(elapsed, i)); ctx.fillStyle = base; ctx.strokeStyle = base;
    [drawC, drawU, drawI][i](ctx);
    ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = overlay; ctx.strokeStyle = overlay;
    if (elapsed === null) {
      if (i === 0) strokeProgress(ctx, C_PATH, parts[i], 140);
      else if (i === 1) strokeProgress(ctx, U_PATH, parts[i], 140);
      else if (parts[i]) ctx.fillRect(719, 0, 154, 453 * parts[i]);
    }
    ctx.globalCompositeOperation = 'source-over';
    if (i === 2) { ctx.fillStyle = '#fff'; eye(ctx, 752); eye(ctx, 798); }
    ctx.restore();
  }
  ctx.restore();
}
module.exports = { BLUE, GRAY, CYCLE, REFILL, THRESHOLD, clamp, ease, splitProgress, waveOffset, C_PATH, U_PATH, drawLogo };
