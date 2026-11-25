const crypto = require('crypto');
const { profileAppearance } = require('./xiaocui-profile');

const REGISTRY = 'account_ids';
const BATCH_SIZE = 20;
const ACCOUNT_ID_CODES = ['INVALID_ACCOUNT_ID', 'INVALID_ACCOUNT_CURSOR', 'ACCOUNT_ID_CONFLICT',
  'ACCOUNT_ID_BINDING_ERROR', 'ACCOUNT_ID_BUSY'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isAccountId(value) { return typeof value === 'string' && /^[1-9][0-9]{7}$/.test(value); }
function boundUser(user) {
  return user && typeof user.openid === 'string' && user.openid &&
    user._id === 'u_' + crypto.createHash('sha256').update(user.openid).digest('hex').slice(0, 32);
}
function checkActive(user) {
  if (!user) fail('NOT_REGISTERED', '请先登录');
  if (user.status !== 'active') fail('ACCOUNT_DISABLED', '当前账号暂不可使用');
  if (!['user', 'student', 'admin'].includes(user.role)) fail('INVALID_ROLE', '账号身份异常，请联系管理员');
}

function createAccountIdService(db, options = {}) {
  const randomId = options.randomAccountId || (() => String(crypto.randomInt(10000000, 100000000)));

  async function assign(userId, { operatorId, newUser } = {}) {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = randomId();
      if (!isAccountId(candidate)) fail('ACCOUNT_ID_BUSY', 'ID账号分配失败，请稍后重试');
      try {
        const result = await db.runTransaction(async transaction => {
          const users = transaction.collection('users');
          if (operatorId) {
            const operator = (await users.doc(operatorId).get()).data;
            checkActive(operator);
            if (operator.role !== 'admin') fail('FORBIDDEN', '仅管理员可以补齐ID账号');
          }
          const ref = users.doc(userId);
          const stored = (await ref.get()).data;
          const user = stored || newUser;
          // 批量补齐包含停用账号，确保其 ID 永不被分配给其他人。
          if (!operatorId) checkActive(user);
          if (!boundUser(user)) fail('ACCOUNT_ID_BINDING_ERROR', '账号绑定信息异常，请联系管理员');
          const existing = user.accountId;
          if (existing !== undefined && existing !== null && existing !== '' && !isAccountId(existing)) {
            fail('ACCOUNT_ID_BINDING_ERROR', '已有ID账号格式异常，请联系管理员');
          }
          const accountId = existing || candidate;
          const reservation = transaction.collection(REGISTRY).doc(accountId);
          const owner = (await reservation.get()).data;
          if (owner && owner.userId !== userId) {
            if (existing) fail('ACCOUNT_ID_CONFLICT', 'ID账号绑定冲突，请联系管理员');
            fail('ACCOUNT_ID_COLLISION', '随机号码已占用');
          }
          const now = db.serverDate();
          if (!owner) await reservation.set({ data: { userId, createdAt: now } });
          if (!stored) {
            const { _id, ...data } = user;
            await ref.set({ data: { ...data, accountId, accountIdAssignedAt: now } });
          } else if (!existing) await ref.update({ data: { accountId, accountIdAssignedAt: now } });
          return { accountId, assigned: !existing };
        });
        return result.result;
      } catch (error) {
        if (error.code !== 'ACCOUNT_ID_COLLISION') throw error;
      }
    }
    fail('ACCOUNT_ID_BUSY', 'ID账号分配繁忙，请稍后重试');
  }

  async function backfill(operatorId, cursor = '') {
    if (typeof cursor !== 'string' || (cursor && !/^u_[a-f0-9]{32}$/.test(cursor))) {
      fail('INVALID_ACCOUNT_CURSOR', '补齐进度不正确，请从头重试');
    }
    const operator = (await db.collection('users').doc(operatorId).get()).data;
    checkActive(operator);
    if (operator.role !== 'admin') fail('FORBIDDEN', '仅管理员可以补齐ID账号');
    const condition = cursor ? { _id: db.command.gt(cursor) } : {};
    const result = await db.collection('users').where(condition).orderBy('_id', 'asc').limit(BATCH_SIZE + 1).get();
    const rows = result.data.slice(0, BATCH_SIZE);
    let assigned = 0;
    for (const row of rows) {
      if ((await assign(row._id, { operatorId })).assigned) assigned += 1;
    }
    return { scanned: rows.length, assigned, existing: rows.length - assigned,
      done: result.data.length <= BATCH_SIZE, nextCursor: rows.length ? rows[rows.length - 1]._id : cursor };
  }

  async function find(accountId) {
    if (!isAccountId(accountId)) fail('INVALID_ACCOUNT_ID', '请输入8位数字ID账号');
    const owner = (await db.collection(REGISTRY).doc(accountId).get()).data;
    if (!owner) return null;
    const user = (await db.collection('users').doc(owner.userId).get()).data;
    if (!boundUser(user) || user.accountId !== accountId || user.status !== 'active' ||
        !['user', 'student', 'admin'].includes(user.role)) return null;
    return { _id: user._id, accountId, ...profileAppearance(user),
      isVerified: user.role === 'student' && user.certificationStatus === 'approved' && Boolean(user.schoolId),
      ...(user.officialVerified === true ? { officialVerified: true } : {}) };
  }

  return { assign, backfill, find };
}

module.exports = { createAccountIdService, isAccountId, ACCOUNT_ID_CODES };
