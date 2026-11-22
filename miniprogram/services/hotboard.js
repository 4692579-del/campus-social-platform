const TYPES = ['weibo', 'zhihu', 'bilibili', 'baidu', 'toutiao'];
const cache = new Map(), pending = new Map();
function cached(type) { return cache.get(type)?.board || null; }
function load(type, { force = false } = {}) {
  if (!TYPES.includes(type)) return Promise.reject(new Error('不支持的热榜平台'));
  const saved = cache.get(type);
  if (!force && saved && Date.now() < saved.until) return Promise.resolve(saved.board);
  if (pending.has(type)) return pending.get(type);
  const request = Promise.resolve().then(() => wx.cloud.callFunction({ name: 'hotboard', data: { type } }))
    .catch(() => { throw new Error('热榜连接失败，请稍后重试'); }).then(response => {
    const result = response && response.result;
    if (!result || !result.success) throw Object.assign(new Error(result && result.message || '热榜暂不可用，请稍后再试'), { code: result && result.code || 'HOTBOARD_UNAVAILABLE' });
    const board = result.board;
    if (!board || board.type !== type || !Array.isArray(board.list) || typeof board.updateTime !== 'string' || !Number.isFinite(Date.parse(board.updateTime)) ||
      !Number.isFinite(board.fetchedAt) || !Number.isFinite(board.expiresAt) || typeof board.stale !== 'boolean' ||
      !board.list.every(item => Number.isSafeInteger(item.rank) && item.rank > 0 && typeof item.title === 'string' && item.title.trim())) throw new Error('热榜数据格式异常，请更新云函数后重试');
    cache.set(type, { board, until: board.stale ? Date.now() + 15000 : Math.min(Date.now() + 60000, board.expiresAt) });
    return board;
  }).finally(() => { if (pending.get(type) === request) pending.delete(type); });
  pending.set(type, request); return request;
}
function updateText(value) {
  const date = new Date(Date.parse(value) + 8 * 3600000), pad = n => String(n).padStart(2, '0');
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
module.exports = { TYPES, cached, load, updateText };
