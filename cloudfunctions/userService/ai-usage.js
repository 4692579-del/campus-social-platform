const crypto = require('crypto');
const { aiError } = require('./ai-errors');
const DAILY_CHARS = 15000;
const LEASE_MS = 120000;
const USAGE_CODES = ['AI_QUOTA_EXHAUSTED', 'AI_QUOTA_BUSY', 'AI_USAGE_EXPIRED', 'AI_USAGE_UNAVAILABLE'];
function usageDay(now) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
function usageId(userId, day) { return 'usage_' + crypto.createHash('sha256').update(userId + ':' + day).digest('hex'); }
function stateOf(row, now) {
  const usedChars = row ? row.usedChars : 0;
  if (!Number.isSafeInteger(usedChars) || usedChars < 0 || usedChars > DAILY_CHARS) throw aiError('AI_USAGE_UNAVAILABLE');
  const reservations = {};
  for (const [key, value] of Object.entries(row && row.reservations || {})) {
    if (!value || !Number.isSafeInteger(value.chars) || value.chars < 1 || value.chars > 150 || !Number.isFinite(value.until)) throw aiError('AI_USAGE_UNAVAILABLE');
    if (value.until > now) reservations[key] = value;
  }
  return { usedChars, reservations };
}
function createAIUsage(db, options = {}) {
  const now = () => options.aiNow ? options.aiNow() : Date.now();
  const refFor = (source, id) => source.collection('square_ai_jobs').doc(id);
  const save = (ref, userId, day, state) => ref.set({ data: { type: 'daily_usage', userId, day, ...state } });
  async function get(userId) {
    const stamp = now(), day = usageDay(stamp);
    const state = stateOf((await refFor(db, usageId(userId, day)).get()).data, stamp);
    return { day, usedPercent: Number((state.usedChars / 150).toFixed(2)),
      exhausted: state.usedChars >= DAILY_CHARS,
      resetsAt: new Date(Date.parse(day + 'T00:00:00+08:00') + 86400000).toISOString() };
  }
  async function reserve(userId) {
    const stamp = now(), day = usageDay(stamp), id = usageId(userId, day), token = crypto.randomBytes(16).toString('hex');
    let reservation;
    await db.runTransaction(async tx => {
      const account = (await tx.collection('users').doc(userId).get()).data;
      if (!account || account.status !== 'active' || !['user', 'student', 'admin'].includes(account.role)) throw aiError('AI_USAGE_UNAVAILABLE');
      const ref = refFor(tx, id), state = stateOf((await ref.get()).data, now());
      if (state.usedChars >= DAILY_CHARS) throw aiError('AI_QUOTA_EXHAUSTED');
      const available = DAILY_CHARS - state.usedChars - Object.values(state.reservations).reduce((sum, value) => sum + value.chars, 0);
      if (available <= 0) throw aiError('AI_QUOTA_BUSY');
      const chars = Math.min(150, available);
      state.reservations[token] = { chars, until: now() + LEASE_MS };
      await save(ref, userId, day, state);
      reservation = { id, token, userId, day, chars };
    });
    return reservation;
  }
  // 与AI回复落库共用一个事务：保存失败不扣额，重复任务不会重复计费。
  async function commit(tx, reservation, chars) {
    const ref = refFor(tx, reservation.id), state = stateOf((await ref.get()).data, now());
    const held = state.reservations[reservation.token];
    if (!held) throw aiError('AI_USAGE_EXPIRED');
    if (!Number.isSafeInteger(chars) || chars < 1 || chars > held.chars || state.usedChars + chars > DAILY_CHARS) throw aiError('AI_USAGE_UNAVAILABLE');
    delete state.reservations[reservation.token];
    state.usedChars += chars;
    await save(ref, reservation.userId, reservation.day, state);
  }
  async function release(reservation) {
    if (!reservation) return;
    try {
      await db.runTransaction(async tx => {
        const ref = refFor(tx, reservation.id), row = (await ref.get()).data;
        if (!row || !row.reservations || !row.reservations[reservation.token]) return;
        const state = stateOf(row, now());
        delete state.reservations[reservation.token];
        await save(ref, reservation.userId, reservation.day, state);
      });
    } catch (error) { console.error('userService AI usage: reservation release failed'); }
  }
  return { get, reserve, commit, release };
}
module.exports = { createAIUsage, usageDay, usageId, DAILY_CHARS, USAGE_CODES };
