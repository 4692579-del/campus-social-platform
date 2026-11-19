const crypto = require('crypto');
const { createCertificationService, EXPECTED_CODES } = require('./certification');
const { createCertificationReviewService, REVIEW_ACTIONS, REVIEW_CODES } = require('./certification-review');
const { createAccountIdService, isAccountId, ACCOUNT_ID_CODES } = require('./account-id');
const { createSquareService, SQUARE_ACTIONS, SQUARE_CODES } = require('./square');
const { createAIUsage, USAGE_CODES } = require('./ai-usage');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

// 固定主键利用数据库唯一性约束，避免重复点击、并发登录生成多个账号。
function userIdFor(openid) {
  return 'u_' + crypto.createHash('sha256').update(openid).digest('hex').slice(0, 32);
}

// 返回给前端的字段明确列出，避免以后增加内部字段时意外泄露。
function publicProfile(user) {
  return {
    _id: user._id,
    accountId: user.accountId || '',
    nickname: user.nickname,
    avatarFileID: user.avatarFileID,
    coverFileID: user.coverFileID || '',
    bio: user.bio || '',
    birthDate: user.birthDate || '',
    createdAt: user.createdAt || null,
    schoolId: user.schoolId,
    schoolName: user.schoolName || '',
    certificationStatus: user.certificationStatus,
    role: effectiveRole(user),
  };
}

// 学生权限同时要求角色、认证结果和学校归属有效；管理员不参与学生认证。
function effectiveRole(user) {
  if (user.role === 'admin') return 'admin';
  if (user.role === 'student' && user.certificationStatus === 'approved' &&
      typeof user.schoolId === 'string' && user.schoolId.trim()) return 'student';
  return 'user';
}

function checkAccount(user) {
  if (!user) fail('NOT_REGISTERED', '请先登录');
  if (user.status !== 'active') fail('ACCOUNT_DISABLED', '当前账号暂不可使用');
  if (!['user', 'student', 'admin'].includes(user.role)) fail('INVALID_ROLE', '账号身份异常，请联系管理员');
}

function hasNicknameHistory(user) {
  return Number.isSafeInteger(user.nicknameChangeCount) && user.nicknameChangeCount >= 0 &&
    Boolean(user.nicknameTrackingStartedAt) && typeof user.nicknameHistoryComplete === 'boolean';
}

// 老账号没有历史数据，明确从启用时起记录，不能用 updatedAt 推测改名时间。
function nicknameBaseline(now, complete = false) {
  return { nicknameChangeCount: 0, nicknameLastChangedAt: null,
    nicknameTrackingStartedAt: now, nicknameHistoryComplete: complete };
}

function validateCover(coverFileID, userId, env) {
  const prefix = `cloud://${env}.`;
  const marker = `/avatars/${userId}/`;
  const position = typeof coverFileID === 'string' ? coverFileID.indexOf(marker) : -1;
  if (!env || typeof coverFileID !== 'string' || coverFileID.length > 512 ||
      !coverFileID.startsWith(prefix) || position < prefix.length ||
      !/^cover-[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(coverFileID.slice(position + marker.length))) {
    fail('INVALID_COVER', '请上传当前账号的封面图片');
  }
  return coverFileID;
}

function validateProfile(profile, userId, env) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
      Object.keys(profile).some(key => !['nickname', 'avatarFileID', 'bio', 'birthDate', 'coverFileID'].includes(key))) {
    fail('INVALID_PROFILE', '个人资料字段不正确');
  }
  const nickname = typeof profile.nickname === 'string' ? profile.nickname.trim() : '';
  if (!nickname || Array.from(nickname).length > 20 || /[\u0000-\u001f\u007f]/.test(nickname)) {
    fail('INVALID_NICKNAME', '请输入 1—20 个字的昵称');
  }
  const avatarFileID = profile.avatarFileID;
  if (typeof avatarFileID !== 'string' || avatarFileID.length > 512) {
    fail('INVALID_AVATAR', '头像格式不正确，请重新选择');
  }
  if (avatarFileID) {
    // 只接收本环境、当前用户目录里的图片，拒绝外部 URL 和别人的头像路径。
    const prefix = `cloud://${env}.`;
    const marker = `/avatars/${userId}/`;
    const position = avatarFileID.indexOf(marker);
    const name = position >= 0 ? avatarFileID.slice(position + marker.length) : '';
    if (!env || !avatarFileID.startsWith(prefix) || position < prefix.length ||
        !/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(name)) {
      fail('INVALID_AVATAR', '请上传当前账号的头像');
    }
  }
  const changes = { nickname, avatarFileID };
  if (Object.prototype.hasOwnProperty.call(profile, 'bio')) {
    if (typeof profile.bio !== 'string') fail('INVALID_BIO', '简介格式不正确');
    const bio = profile.bio.replace(/\r\n?/g, '\n').trim();
    if (Array.from(bio).length > 160 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(bio)) {
      fail('INVALID_BIO', '简介最多 160 个字，请勿包含控制字符');
    }
    changes.bio = bio;
  }
  if (Object.prototype.hasOwnProperty.call(profile, 'birthDate')) {
    const birthDate = profile.birthDate;
    const date = typeof birthDate === 'string' ? new Date(birthDate + 'T00:00:00.000Z') : null;
    const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (birthDate !== '' && (typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate) ||
        Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== birthDate || birthDate < '1900-01-01' || birthDate > today)) {
      fail('INVALID_BIRTH_DATE', '请选择 1900 年至今天之间的有效出生日期');
    }
    changes.birthDate = birthDate;
  }
  if (Object.prototype.hasOwnProperty.call(profile, 'coverFileID')) changes.coverFileID = validateCover(profile.coverFileID, userId, env);
  return changes;
}

function createUserService(db, options) {
  const users = db.collection('users');
  const certificationService = createCertificationService(db, options);
  const certificationReviewService = createCertificationReviewService(db, options);
  const accountIds = createAccountIdService(db, options);
  async function findUser(id) {
    const result = await users.where({ _id: id }).get();
    return result.data[0] || null;
  }
  return async function handle(event, identity) {
    try {
      if (!identity || !identity.openid) fail('UNAUTHENTICATED', '请在微信小程序中登录');
      const action = event && event.action;
      if (!['login', 'getProfile', 'getAIUsage', 'getAccountInfo', 'backfillAccountIds', 'findUserByAccountId', 'updateProfile', 'updateCover', 'getAdminDashboard', 'getCertification', 'submitCertification', 'withdrawCertification', ...REVIEW_ACTIONS, ...SQUARE_ACTIONS].includes(action)) {
        fail('INVALID_ACTION', '不支持此操作');
      }
      const id = userIdFor(identity.openid);
      let user = await findUser(id);
      if (SQUARE_ACTIONS.includes(action)) {
        if (user) checkAccount(user);
        return { success: true, square: await createSquareService(db, options)(action, event, user, identity) };
      }
      if (!user && action === 'login') {
        const now = db.serverDate();
        const record = {
          _id: id,
          openid: identity.openid,
          nickname: '校园新同学',
          avatarFileID: '',
          coverFileID: '',
          schoolId: '',
          certificationStatus: 'unverified',
          role: 'user',
          status: 'active',
          createdAt: now,
          updatedAt: now,
          ...nicknameBaseline(now, true),
        };
        // 建档和号码占用同时提交；并发首次登录会读取已建档资料，不覆盖旧账号。
        await accountIds.assign(id, { newUser: record });
        user = await findUser(id);
      }
      if (!user) {
        if (action === 'getProfile') return { success: true, user: null };
        fail('NOT_REGISTERED', '请先登录');
      }
      if (user.status !== 'active') fail('ACCOUNT_DISABLED', '当前账号暂不可使用');
      if (!['user', 'student', 'admin'].includes(user.role)) {
        fail('INVALID_ROLE', '账号身份异常，请联系管理员');
      }
      if (action === 'getAIUsage') return { success: true, aiUsage: await createAIUsage(db, options).get(id) };
      // 第一阶段曾把未认证账号默认写为 student。只修正这个明确的旧数据组合。
      // 条件更新可防止查询后账号被设为 admin 时，被迟到的请求覆盖管理员身份。
      if (user.role === 'student' && user.certificationStatus === 'unverified' && user.schoolId === '') {
        await users.where({
          _id: id, role: 'student', certificationStatus: 'unverified', schoolId: '',
        }).update({ data: { role: 'user', updatedAt: db.serverDate() } });
        user = await findUser(id);
        if (!user) fail('NOT_REGISTERED', '请先登录');
        if (user.status !== 'active') fail('ACCOUNT_DISABLED', '当前账号暂不可使用');
        if (!['user', 'student', 'admin'].includes(user.role)) fail('INVALID_ROLE', '账号身份异常，请联系管理员');
      }
      if (action === 'backfillAccountIds') {
        return { success: true, migration: await accountIds.backfill(id, event.cursor) };
      }
      if (!isAccountId(user.accountId)) {
        await accountIds.assign(id);
        user = await findUser(id);
        checkAccount(user);
      }
      if (action === 'findUserByAccountId') {
        return { success: true, searchResult: await accountIds.find(event.accountId) };
      }
      if (REVIEW_ACTIONS.includes(action)) {
        const result = await certificationReviewService(action, event, user, identity);
        return { success: true, reviewResult: result };
      }
      if (['getCertification', 'submitCertification', 'withdrawCertification'].includes(action)) {
        const application = await certificationService(action, event.application, user);
        user = await findUser(id);
        if (!user || user.status !== 'active') fail('ACCOUNT_DISABLED', '当前账号暂不可使用');
        return { success: true, certification: { user: publicProfile(user), application } };
      }
      if (action === 'getAdminDashboard') {
        // 每次调用都按云端 OpenID 重新读取角色，不相信前端缓存或传入的 role。
        if (effectiveRole(user) !== 'admin') fail('FORBIDDEN', '仅管理员可以访问管理工作台');
        return {
          success: true,
          dashboard: { operator: publicProfile(user) },
        };
      }
      if (action === 'getAccountInfo') {
        await db.runTransaction(async transaction => {
          const ref = transaction.collection('users').doc(id);
          const latest = (await ref.get()).data;
          checkAccount(latest);
          if (!hasNicknameHistory(latest)) await ref.update({ data: nicknameBaseline(db.serverDate()) });
        });
        user = await findUser(id);
        checkAccount(user);
        return { success: true, accountInfo: { user: publicProfile(user), nicknameHistory: {
          changeCount: user.nicknameChangeCount,
          lastChangedAt: user.nicknameLastChangedAt || null,
          trackingStartedAt: user.nicknameTrackingStartedAt,
          historyComplete: user.nicknameHistoryComplete,
        } } };
      }
      if (action === 'updateCover') {
        const coverFileID = validateCover(event.coverFileID, id, identity.env);
        // 复用公开头像目录及其创建者写入规则，只更新封面，不覆盖昵称、头像或认证。
        await users.doc(id).update({ data: { coverFileID, updatedAt: db.serverDate() } });
        user = { ...user, coverFileID };
      }
      if (action === 'updateProfile') {
        const changes = validateProfile(event.profile, id, identity.env);
        await db.runTransaction(async transaction => {
          const ref = transaction.collection('users').doc(id);
          const latest = (await ref.get()).data;
          checkAccount(latest);
          const now = db.serverDate();
          const history = hasNicknameHistory(latest) ? {} : nicknameBaseline(now);
          // 与事务中最新昵称比较：并发、重试、只换头像/简介均不会虚增次数。
          if (changes.nickname !== latest.nickname) {
            history.nicknameChangeCount = (hasNicknameHistory(latest) ? latest.nicknameChangeCount : 0) + 1;
            history.nicknameLastChangedAt = now;
          }
          await ref.update({ data: { ...changes, ...history, updatedAt: now } });
        });
        user = await findUser(id);
        checkAccount(user);
      }
      return { success: true, user: publicProfile(user) };
    } catch (error) {
      const commentAction = event && ['listSquareReplies', 'listSquareReplyChildren', 'publishSquareReply', 'setSquareCommentState'].includes(event.action);
      const diagnostic = `${error.code || ''} ${error.errCode || ''} ${error.errMsg || error.message || ''}`;
      if (commentAction && /DATABASE_COLLECTION_NOT_EXIST|collection[^\n]*(not exist|does not exist|not found)|-502005/i.test(diagnostic)) {
        // 配置错误单独标识；日志只保留类别，不输出请求正文或账号资料。
        console.error('userService comments configuration: missing collection');
        return { success: false, code: 'COMMENTS_STORAGE_NOT_READY', message: '评论服务尚未配置完成，请稍后再试' };
      }
      const expected = ['UNAUTHENTICATED', 'INVALID_ACTION', 'INVALID_PROFILE', 'INVALID_NICKNAME',
        'INVALID_AVATAR', 'INVALID_COVER', 'INVALID_BIO', 'INVALID_BIRTH_DATE', 'NOT_REGISTERED', 'ACCOUNT_DISABLED', 'INVALID_ROLE', 'FORBIDDEN', ...USAGE_CODES, ...ACCOUNT_ID_CODES, ...EXPECTED_CODES, ...REVIEW_CODES, ...SQUARE_CODES].includes(error.code);
      // 不记录 event、姓名、学号或图片内容，只记录错误类别便于排查。
      if (!expected) console.error('userService failed:', error.code || 'UNKNOWN_ERROR');
      return {
        success: false,
        code: expected ? error.code : 'SERVICE_ERROR',
        message: expected ? error.message : '服务暂时不可用，请稍后重试',
      };
    }
  };
}

module.exports = { createUserService, userIdFor };
