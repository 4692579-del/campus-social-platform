const crypto = require('crypto');
const { TYPES } = require('./uapi');
const TTL = 5 * 60 * 1000, MAX_STALE = 24 * 60 * 60 * 1000, LEASE = 20000;
const MESSAGES = {
  HOTBOARD_AUTH_FAILED: '热榜服务鉴权失败，请联系管理员', HOTBOARD_QUOTA_EXHAUSTED: '热榜服务额度不足，请稍后再试',
  HOTBOARD_RATE_LIMITED: '热榜更新频繁，请稍后再试', HOTBOARD_UPSTREAM_ERROR: '热榜来源暂不可用，请稍后再试',
  HOTBOARD_TIMEOUT: '热榜请求超时，请稍后再试', HOTBOARD_INVALID_RESPONSE: '热榜数据格式异常，请稍后再试',
  HOTBOARD_BUSY: '热榜正在更新，请稍后再试', HOTBOARD_STORAGE_NOT_READY: '热榜缓存尚未配置，请联系管理员',
};
const unwrap = value => value && Object.prototype.hasOwnProperty.call(value, 'result') ? value.result : value;
function createHotboardService(db, fetchBoard, { now = Date.now, token = () => crypto.randomBytes(12).toString('hex') } = {}) {
  const pending = new Map();
  const valid = (row, type) => row && row.version === 1 && row.type === type && Number.isFinite(row.fetchedAt) && row.fetchedAt <= now() &&
    now() - row.fetchedAt < MAX_STALE && typeof row.updateTime === 'string' && Number.isFinite(Date.parse(row.updateTime)) &&
    Array.isArray(row.list) && row.list.length <= 200 && row.list.every(item => Number.isSafeInteger(item.rank) && item.rank > 0 && typeof item.title === 'string' && item.title.trim());
  const fresh = (row, type) => valid(row, type) && now() - row.fetchedAt < TTL;
  const result = (row, stale = false) => ({ success: true, board: { type: row.type, list: row.list, updateTime: row.updateTime,
    fetchedAt: row.fetchedAt, expiresAt: row.fetchedAt + TTL, stale } });
  const failure = code => { throw Object.assign(new Error(MESSAGES[code] || MESSAGES.HOTBOARD_UPSTREAM_ERROR), { code }); };
  async function load(type) {
    const ref = db.collection('hotboard_cache').doc(type);
    const cached = (await ref.get()).data;
    if (fresh(cached, type)) return result(cached);
    const owner = token();
    const state = unwrap(await db.runTransaction(async transaction => {
      const doc = transaction.collection('hotboard_cache').doc(type), row = (await doc.get()).data;
      if (fresh(row, type)) return { row, fresh: true };
      if (row && row.retryAt > now()) return { row, blocked: row.errorCode || 'HOTBOARD_UPSTREAM_ERROR' };
      if (row && row.leaseUntil > now()) return { row, blocked: 'HOTBOARD_BUSY' };
      const value = valid(row, type) ? { version: 1, type, list: row.list, updateTime: row.updateTime, fetchedAt: row.fetchedAt } : { version: 1, type };
      await doc.set({ data: { ...value, leaseOwner: owner, leaseUntil: now() + LEASE } });
      return { row, acquired: true };
    }));
    if (state.fresh) return result(state.row);
    if (state.blocked) { if (valid(state.row, type)) return result(state.row, true); failure(state.blocked); }
    try {
      const board = await fetchBoard(type), value = { version: 1, ...board, fetchedAt: now(), leaseOwner: '', leaseUntil: 0, retryAt: 0, errorCode: '' };
      const saved = unwrap(await db.runTransaction(async transaction => {
        const doc = transaction.collection('hotboard_cache').doc(type), row = (await doc.get()).data;
        if (!row || row.leaseOwner !== owner) return null;
        await doc.set({ data: value }); return value;
      }));
      if (saved) return result(saved);
      const latest = (await ref.get()).data;
      if (valid(latest, type)) return result(latest, !fresh(latest, type));
      failure('HOTBOARD_BUSY');
    } catch (error) {
      const code = MESSAGES[error.code] ? error.code : 'HOTBOARD_UPSTREAM_ERROR';
      await db.runTransaction(async transaction => {
        const doc = transaction.collection('hotboard_cache').doc(type), row = (await doc.get()).data;
        if (row && row.leaseOwner === owner) await doc.update({ data: { leaseOwner: '', leaseUntil: 0, retryAt: now() + (code === 'HOTBOARD_AUTH_FAILED' || code === 'HOTBOARD_QUOTA_EXHAUSTED' ? TTL : 30000), errorCode: code } });
      });
      const latest = (await ref.get()).data;
      if (valid(latest, type)) return result(latest, !fresh(latest, type));
      failure(code);
    }
  }
  return async event => {
    const type = event && event.type;
    if (!TYPES.includes(type)) return { success: false, code: 'HOTBOARD_INVALID_TYPE', message: '不支持的热榜平台' };
    if (pending.has(type)) return pending.get(type);
    const request = load(type).catch(error => {
      const missing = /-502005|DATABASE_COLLECTION_NOT_EXIST|collection[^\n]*(not exist|does not exist|not found)/i.test(`${error.code || ''} ${error.errCode || ''} ${error.message || ''}`);
      const code = missing ? 'HOTBOARD_STORAGE_NOT_READY' : MESSAGES[error.code] ? error.code : 'HOTBOARD_UPSTREAM_ERROR';
      return { success: false, code, message: MESSAGES[code] };
    }).finally(() => { if (pending.get(type) === request) pending.delete(type); });
    pending.set(type, request); return request;
  };
}
module.exports = { createHotboardService, TTL, MAX_STALE, LEASE };
