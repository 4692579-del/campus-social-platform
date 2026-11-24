const DOCK_DURATION = 280;
const HANDOFF_TIMEOUT = 1000;
const SPRING_RATE = .022;
const FRAME_INTERVAL = 20;
const IMPACT_TIME = 200;
const COMPRESSION_TIME = 140;
const RECOVERY_TIME = 320;
const RECOVERY_START = IMPACT_TIME + COMPRESSION_TIME;
const DURATION = RECOVERY_START + RECOVERY_TIME;
const RECENTER_TIME = 200;
// Keep the peak compression at its exact time between 20ms samples.
const FRAME_TIMES = [
  ...Array.from({ length: Math.ceil(RECOVERY_START / FRAME_INTERVAL) }, (_, step) => step * FRAME_INTERVAL),
  ...Array.from({ length: Math.ceil(RECOVERY_TIME / FRAME_INTERVAL) }, (_, step) => RECOVERY_START + step * FRAME_INTERVAL),
  DURATION,
];
const STRETCH_LIMIT = .30;
const COMPRESSION_LIMIT = .21;
const HALF_CELL = 50;
// 与 index.wxss 的四等分导航格、10rpx 内边距和 44rpx 图标对应。
const CELL_WIDTH = 132.5;
const OUTER_EDGE_PADDING = 10 / CELL_WIDTH * 100;
const ICON_HALF_WIDTH = 22 / CELL_WIDTH * 100;
const LAST_TAB_CENTER = 300;

// 与 WXSS 的 cubic-bezier(.22, .75, .3, 1) 保持一致。
function ease(progress) {
  const cubic = (t, a, b) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  let low = 0, high = 1;
  for (let step = 0; step < 18; step++) {
    const middle = (low + high) / 2;
    if (cubic(middle, .22, .3) < progress) low = middle;
    else high = middle;
  }
  return progress <= 0 ? 0 : progress >= 1 ? 1 : cubic((low + high) / 2, .75, 1);
}

function springProgress(elapsed) {
  return 1 - (1 + SPRING_RATE * elapsed) * Math.exp(-SPRING_RATE * elapsed);
}

const IMPACT_PROGRESS = springProgress(IMPACT_TIME);

function smoothStep(progress) {
  return progress ** 2 * (3 - 2 * progress);
}

function springSample(from, to, initialVelocity, elapsed) {
  const distance = to - from;
  const decay = Math.exp(-SPRING_RATE * elapsed);
  const fraction = elapsed / IMPACT_TIME;
  // The momentum term preserves the incoming velocity and vanishes at the target.
  const momentum = elapsed * decay * (1 - fraction ** 2);
  const momentumRate = decay * ((1 - SPRING_RATE * elapsed) * (1 - fraction ** 2) - 2 * fraction ** 2);
  const progress = springProgress(elapsed) / IMPACT_PROGRESS;
  const progressRate = SPRING_RATE ** 2 * elapsed * decay / IMPACT_PROGRESS;
  return {
    position: from + distance * progress + initialVelocity * momentum,
    velocity: distance * progressRate + initialVelocity * momentumRate,
    progress, progressRate,
  };
}

function makeFrames(from, to, current) {
  const initialVelocity = current.velocity ?? 0;
  const direction = Math.sign(to - from) || Math.sign(initialVelocity);
  const shape = (position, velocity, scaleX) =>
    // Approximate a soft lens that redistributes its area instead of growing on impact.
    ({ position, velocity, scaleX, scaleY: 1 / scaleX });
  const stretch = velocity => STRETCH_LIMIT * Math.tanh(Math.abs(velocity) / .72);
  const impact = springSample(from, to, initialVelocity, IMPACT_TIME);
  const impactVelocity = Math.max(0, direction * impact.velocity);
  const contactOffset = Math.min(HALF_CELL * stretch(impactVelocity), Math.abs(to - from) * .25);
  const contactStretch = contactOffset / HALF_CELL;
  const hitsOuterEdge = (to === 0 && direction < 0) || (to === LAST_TAB_CENTER && direction > 0);
  const boundaryPadding = hitsOuterEdge ? OUTER_EDGE_PADDING : 0;
  const contactShift = direction * (boundaryPadding - contactOffset);
  const contactCenter = to + contactShift;
  const contactSpeed = Math.max(0, direction * (impact.velocity + contactShift * impact.progressRate));
  const impactStrength = Math.tanh(contactSpeed / .15);
  const compression = COMPRESSION_LIMIT * impactStrength;
  const overshoot = HALF_CELL * compression;

  return FRAME_TIMES.map(elapsed => {
    if (!elapsed) {
      return { ...shape(from, initialVelocity, current.scaleX ?? 1), scaleY: current.scaleY ?? 1 };
    }
    if (elapsed < IMPACT_TIME) {
      const frame = springSample(from, to, initialVelocity, elapsed);
      const position = frame.position + contactShift * frame.progress;
      const velocity = frame.velocity + contactShift * frame.progressRate;
      const retain = 1 - smoothStep(Math.min(1, elapsed / 40));
      const contactBlend = smoothStep(Math.max(0, (elapsed - 140) / (IMPACT_TIME - 140)));
      const width = stretch(velocity) * (1 - contactBlend) + contactStretch * contactBlend;
      const scaleX = 1 + width * (1 - retain) + ((current.scaleX ?? 1) - 1) * retain;
      const carriedHeight = (current.scaleY ?? 1) - 1 / (current.scaleX ?? 1);
      return { ...shape(position, velocity, scaleX), scaleY: 1 / scaleX + carriedHeight * retain };
    }
    const impactElapsed = elapsed - IMPACT_TIME;
    if (impactElapsed <= COMPRESSION_TIME) {
      const progress = impactElapsed / COMPRESSION_TIME;
      const travel = contactOffset + overshoot;
      // Match the incoming speed, then ease to rest at peak compression.
      const entrySlope = travel ? Math.min(3, contactSpeed * COMPRESSION_TIME / travel) : 0;
      const squeeze = smoothStep(progress) + entrySlope * progress * (1 - progress) ** 2;
      const speed = travel / COMPRESSION_TIME *
        (1 - progress) * (6 * progress + entrySlope * (1 - 3 * progress));
      // Keep the leading edge against the collision boundary as the rear catches up.
      return shape(contactCenter + direction * travel * squeeze, direction * speed,
        1 + contactStretch - (contactStretch + compression) * squeeze);
    }
    const progress = (impactElapsed - COMPRESSION_TIME) / RECOVERY_TIME;
    const remaining = 1 - smoothStep(progress);
    const recenter = Math.min(1, (impactElapsed - COMPRESSION_TIME) / RECENTER_TIME);
    const returnDistance = boundaryPadding + overshoot;
    const speed = -direction * returnDistance * 6 * recenter * (1 - recenter) / RECENTER_TIME;
    return shape(to + direction * returnDistance * (1 - smoothStep(recenter)), speed,
      1 - compression * remaining);
  });
}

function sampleFrames(frames, elapsed) {
  const step = FRAME_TIMES.findIndex(time => time >= elapsed);
  if (FRAME_TIMES[step] === elapsed) return frames[step];
  const start = frames[step - 1], end = frames[step];
  const mix = (elapsed - FRAME_TIMES[step - 1]) / (FRAME_TIMES[step] - FRAME_TIMES[step - 1]);
  return {
    position: start.position + (end.position - start.position) * mix,
    velocity: start.velocity + (end.velocity - start.velocity) * mix,
    scaleX: start.scaleX + (end.scaleX - start.scaleX) * mix,
    scaleY: start.scaleY + (end.scaleY - start.scaleY) * mix,
  };
}

function crossingTime(frames, clearance) {
  let previous = clearance(frames[0]);
  if (previous <= 0) return 0;
  for (let step = 1; step < frames.length; step++) {
    const next = clearance(frames[step]);
    if (next <= 0) {
      const start = FRAME_TIMES[step - 1];
      return Math.ceil(start + (FRAME_TIMES[step] - start) * previous / (previous - next));
    }
    previous = next;
  }
  return DURATION;
}

function iconEdge(frame) {
  return HALF_CELL * frame.scaleX + ICON_HALF_WIDTH;
}

function frameStyles(frames) {
  const number = value => Number(value.toFixed(6));
  return frames.map(({ position, scaleX, scaleY }, index) =>
    `--tab-flight-${index}:translate3d(${number(position)}%,0,0) scale(${number(scaleX)},${number(scaleY)});`).join('');
}

function createTabSelection(now = () => Date.now()) {
  let flight = null, sequence = 0, pending = null;
  const bars = new Map();
  function makeFlight(index, current, startedAt) {
    const to = index * 100;
    const from = current.position;
    const frames = makeFrames(from, to, current);
    const iconLeaves = {};
    for (const icon of current.litIcons) {
      if (icon === index) continue;
      iconLeaves[icon] = crossingTime(frames, frame => iconEdge(frame) - Math.abs(frame.position - icon * 100));
    }
    return { id: ++sequence, index, from, to, startedAt, iconLeaves, iconFrom: current.litIcons, frames, motionStyle: frameStyles(frames),
      iconContact: crossingTime(frames, frame => Math.abs(to - frame.position) - iconEdge(frame)) };
  }
  function read(index) {
    const settled = { id: 0, position: index * 100, litIcons: [index], active: false };
    if (!flight || flight.index !== index) return settled;
    if (flight.startedAt === null && pendingIndex() === index) {
      return { ...flight, ...flight.frames[0], litIcons: flight.iconFrom, waiting: true, active: false };
    }
    const elapsed = flight.startedAt === null ? DURATION : Math.max(0, now() - flight.startedAt);
    if (elapsed >= DURATION) return settled;
    const litIcons = flight.iconFrom.filter(icon => icon === index || elapsed < flight.iconLeaves[icon]);
    if (elapsed >= flight.iconContact && !litIcons.includes(index)) litIcons.push(index);
    return { ...flight, ...sampleFrames(flight.frames, elapsed), elapsed, duration: DURATION, active: true, litIcons };
  }
  function begin(fromIndex, index, compact = false) {
    const current = read(fromIndex < 0 ? index : fromIndex);
    // 快速往返时从正在放大的尺寸接续。尺寸与胶囊共用目标页起跑时间。
    const scaleFrom = current.waiting && current.scaleFrom !== undefined ? current.scaleFrom :
      current.active && current.scaleFrom !== undefined && current.elapsed < DOCK_DURATION ?
        current.scaleFrom + (1 - current.scaleFrom) * ease(current.elapsed / DOCK_DURATION) : compact ? .8 : 1;
    flight = { ...makeFlight(index, current, null), scaleFrom };
    pending = { id: flight.id, index, at: now() };
    return flight.id;
  }
  function start(index, id, keepPending = false) {
    if (pendingIndex() !== index || flight.id !== id || flight.startedAt !== null) return false;
    flight.startedAt = now();
    if (!keepPending) pending = null;
    return true;
  }
  function acknowledge(index) {
    if (pendingIndex() === index && flight.startedAt !== null) pending = null;
  }
  function rollback(id, index) {
    if (!flight || flight.id !== id) return false;
    const current = read(flight.index);
    flight = current.position !== index * 100 || current.velocity ? makeFlight(index, current, now()) : null;
    pending = null;
    return true;
  }
  function pendingIndex() { return pending && now() - pending.at < HANDOFF_TIMEOUT ? pending.index : null; }
  function register(index, bar) { bars.set(index, bar); }
  function unregister(index, bar) { if (bars.get(index) === bar) bars.delete(index); }
  function prepare(index, source) {
    const target = bars.get(index);
    if (!target || target === source) return false;
    target.paintSelection(index, { compact: false });
    return true;
  }
  return { read, begin, start, acknowledge, rollback, pendingIndex, register, unregister, prepare };
}

// 缓存页从交接帧起跑，首次打开的页面接续来源页已开始的动画。
module.exports = { ...createTabSelection(), createTabSelection };
