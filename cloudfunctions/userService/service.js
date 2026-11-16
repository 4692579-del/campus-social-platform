const crypto = require('crypto');
const { createCertificationService, EXPECTED_CODES } = require('./certification');
const { createCertificationReviewService, REVIEW_ACTIONS, REVIEW_CODES } = require('./certification-review');

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
    nickname: user.nickname,
    avatarFileID: user.avatarFileID,
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

function validateProfile(profile, userId, env) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
      Object.keys(profile).some(key => !['nickname', 'avatarFileID'].includes(key))) {
    fail('INVALID_PROFILE', '仅支持修改昵称和头像');
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
  return { nickname, avatarFileID };
}

function createUserService(db, options) {
  const users = db.collection('users');
  const certificationService = createCertificationService(db, options);
  const certificationReviewService = createCertificationReviewService(db, options);
  async function findUser(id) {
    const result = await users.where({ _id: id }).get();
    return result.data[0] || null;
  }
  return async function handle(event, identity) {
    try {
      if (!identity || !identity.openid) fail('UNAUTHENTICATED', '请在微信小程序中登录');
      const action = event && event.action;
      if (!['login', 'getProfile', 'updateProfile', 'getAdminDashboard', 'getCertification', 'submitCertification', ...REVIEW_ACTIONS].includes(action)) {
        fail('INVALID_ACTION', '不支持此操作');
      }
      const id = userIdFor(identity.openid);
      let user = await findUser(id);
      if (!user && action === 'login') {
        const now = db.serverDate();
        const record = {
          _id: id,
          openid: identity.openid,
          nickname: '校园新同学',
          avatarFileID: '',
          schoolId: '',
          certificationStatus: 'unverified',
          role: 'user',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        try {
          await users.add({ data: record });
          user = record;
        } catch (error) {
          // 两个登录请求可能同时发现用户不存在：新增失败时重新查询，绝不覆盖资料。
          user = await findUser(id);
          if (!user) throw error;
        }
      }
      if (!user) {
        if (action === 'getProfile') return { success: true, user: null };
        fail('NOT_REGISTERED', '请先登录');
      }
      if (user.status !== 'active') fail('ACCOUNT_DISABLED', '当前账号暂不可使用');
      if (!['user', 'student', 'admin'].includes(user.role)) {
        fail('INVALID_ROLE', '账号身份异常，请联系管理员');
      }
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
      if (REVIEW_ACTIONS.includes(action)) {
        const result = await certificationReviewService(action, event, user, identity);
        return { success: true, reviewResult: result };
      }
      if (action === 'getCertification' || action === 'submitCertification') {
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
      if (action === 'updateProfile') {
        const changes = validateProfile(event.profile, id, identity.env);
        await users.doc(id).update({ data: { ...changes, updatedAt: db.serverDate() } });
        user = { ...user, ...changes };
      }
      return { success: true, user: publicProfile(user) };
    } catch (error) {
      const expected = ['UNAUTHENTICATED', 'INVALID_ACTION', 'INVALID_PROFILE', 'INVALID_NICKNAME',
        'INVALID_AVATAR', 'NOT_REGISTERED', 'ACCOUNT_DISABLED', 'INVALID_ROLE', 'FORBIDDEN', ...EXPECTED_CODES, ...REVIEW_CODES].includes(error.code);
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
