const DURATION = 320;

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

function createTabSelection(now = () => Date.now()) {
  let flight = null, sequence = 0, pending = null;
  function read(index) {
    const elapsed = flight ? Math.max(0, now() - flight.startedAt) : DURATION;
    if (!flight || flight.index !== index || elapsed >= DURATION) return { id: 0, position: index * 100, active: false };
    return { ...flight, elapsed, duration: DURATION, active: true,
      position: flight.from + (flight.to - flight.from) * ease(elapsed / DURATION) };
  }
  function begin(fromIndex, index) {
    const current = read(fromIndex);
    flight = { id: ++sequence, index, from: current.position, to: index * 100, startedAt: now() };
    pending = { id: flight.id, index, at: now() };
    return flight.id;
  }
  function rollback(id, index) {
    if (!flight || flight.id !== id) return false;
    begin(flight.index, index);
    pending = null;
    return true;
  }
  function pendingIndex() { return pending && now() - pending.at < 1000 ? pending.index : null; }
  function complete(id) { if (pending && pending.id === id) pending = null; }
  return { read, begin, rollback, pendingIndex, complete };
}

// 仅共享短时动画坐标与时间，不存账号数据，不延迟原生页面跳转。
module.exports = { ...createTabSelection(), createTabSelection };
