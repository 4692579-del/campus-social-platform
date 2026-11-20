const crypto = require('crypto');
const { aiError } = require('./ai-errors');
const DAILY_CHARS = 15000;
const HOURLY_CHARS = 5000;
const LEASE_MS = 120000;
const USAGE_CODES = ['AI_HOURLY_QUOTA_EXHAUSTED', 'AI_QUOTA_EXHAUSTED', 'AI_QUOTA_BUSY', 'AI_USAGE_EXPIRED', 'AI_USAGE_UNAVAILABLE'];
function usageDay(now) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
function usageId(userId, day) { return 'usage_' + crypto.createHash('sha256').update(userId + ':' + day).digest('hex'); }
function usageHour(now) { return new Date(now + 8 * 3600000).toISOString().slice(0, 13); }
function stateOf(row, now, maximum = DAILY_CHARS) {
  const usedChars = row ? row.usedChars : 0;
  if (!Number.isSafeInteger(usedChars) || usedChars < 0 || usedChars > maximum) throw aiError('AI_USAGE_UNAVAILABLE');
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
  const save = (ref, userId, day, state) => ref.set({ data: { type: day.length > 10 ? 'hourly_usage' : 'daily_usage', userId, day, ...state } });
  async function get(userId) {
    const stamp = now(), day = usageDay(stamp);
    const hour = usageHour(stamp);
    const [dailyRow, hourlyRow] = await Promise.all([refFor(db, usageId(userId, day)).get(), refFor(db, usageId(userId, hour)).get()]);
    const state = stateOf(dailyRow.data, stamp), hourly = stateOf(hourlyRow.data, stamp, HOURLY_CHARS);
    return { day, hourly: { usedPercent: Number((hourly.usedChars / 50).toFixed(2)), exhausted: hourly.usedChars >= HOURLY_CHARS,
      resetsAt: new Date(Date.parse(hour + ':00:00+08:00') + 3600000).toISOString() }, usedPercent: Number((state.usedChars / 150).toFixed(2)),
      exhausted: state.usedChars >= DAILY_CHARS,
      resetsAt: new Date(Date.parse(day + 'T00:00:00+08:00') + 86400000).toISOString() };
  }
  async function reserve(userId) {
    const stamp = now(), day = usageDay(stamp), id = usageId(userId, day), token = crypto.randomBytes(16).toString('hex');
    const hour = usageHour(stamp), hourlyId = usageId(userId, hour);
    let reservation;
    await db.runTransaction(async tx => {
      const account = (await tx.collection('users').doc(userId).get()).data;
      if (!account || account.status !== 'active' || !['user', 'student', 'admin'].includes(account.role)) throw aiError('AI_USAGE_UNAVAILABLE');
      const ref = refFor(tx, id), state = stateOf((await ref.get()).data, now());
      if (state.usedChars >= DAILY_CHARS) throw aiError('AI_QUOTA_EXHAUSTED');
      const hourRef = refFor(tx, hourlyId), hourly = stateOf((await hourRef.get()).data, now(), HOURLY_CHARS);
      if (hourly.usedChars >= HOURLY_CHARS) throw aiError('AI_HOURLY_QUOTA_EXHAUSTED');
      const hourlyAvailable = HOURLY_CHARS - hourly.usedChars - Object.values(hourly.reservations).reduce((sum, value) => sum + value.chars, 0);
      const available = DAILY_CHARS - state.usedChars - Object.values(state.reservations).reduce((sum, value) => sum + value.chars, 0);
      if (Math.min(available, hourlyAvailable) <= 0) throw aiError('AI_QUOTA_BUSY');
      const chars = Math.min(150, available, hourlyAvailable);
      state.reservations[token] = { chars, until: now() + LEASE_MS };
      hourly.reservations[token] = { ...state.reservations[token] };
      await save(ref, userId, day, state);
      await save(hourRef, userId, hour, hourly);
      reservation = { id, token, userId, day, chars, hourlyId, hour };
    });
    return reservation;
  }
  // 与AI回复落库共用一个事务：保存失败不扣额，重复任务不会重复计费。
  async function commit(tx, reservation, chars) {
    // 两个周期先读完并校验，再一起写；任意周期过期或落库失败，整个事务回滚。
    const buckets = [{ id: reservation.id, period: reservation.day, maximum: DAILY_CHARS },
      { id: reservation.hourlyId, period: reservation.hour, maximum: HOURLY_CHARS }];
    for (const bucket of buckets) {
      bucket.ref = refFor(tx, bucket.id);
      bucket.state = stateOf((await bucket.ref.get()).data, now(), bucket.maximum);
      const held = bucket.state.reservations[reservation.token];
      if (!held) throw aiError('AI_USAGE_EXPIRED');
      if (!Number.isSafeInteger(chars) || chars < 1 || chars > held.chars || bucket.state.usedChars + chars > bucket.maximum) throw aiError('AI_USAGE_UNAVAILABLE');
      delete bucket.state.reservations[reservation.token];
      bucket.state.usedChars += chars;
    }
    for (const bucket of buckets) await save(bucket.ref, reservation.userId, bucket.period, bucket.state);
  }

  async function release(reservation) {
    if (!reservation) return;
    try {
      await db.runTransaction(async tx => {
        const buckets = [{ id: reservation.id, period: reservation.day, maximum: DAILY_CHARS },
          { id: reservation.hourlyId, period: reservation.hour, maximum: HOURLY_CHARS }];
        for (const bucket of buckets) {
          bucket.ref = refFor(tx, bucket.id);
          bucket.row = (await bucket.ref.get()).data;
        }
        for (const bucket of buckets) {
          if (!bucket.row || !bucket.row.reservations || !bucket.row.reservations[reservation.token]) continue;
          const state = stateOf(bucket.row, now(), bucket.maximum);
          delete state.reservations[reservation.token];
          await save(bucket.ref, reservation.userId, bucket.period, state);
        }
      });
    } catch (error) { console.error('userService AI usage: reservation release failed'); }
  }
  return { get, reserve, commit, release };
}
module.exports = { createAIUsage, usageDay, usageHour, usageId, DAILY_CHARS, HOURLY_CHARS, USAGE_CODES };
