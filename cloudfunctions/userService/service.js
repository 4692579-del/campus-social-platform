const crypto = require('crypto');

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
    certificationStatus: user.certificationStatus,
  };
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

function createUserService(db) {
  const users = db.collection('users');
  async function findUser(id) {
    const result = await users.where({ _id: id }).get();
    return result.data[0] || null;
  }
  return async function handle(event, identity) {
    try {
      if (!identity || !identity.openid) fail('UNAUTHENTICATED', '请在微信小程序中登录');
      const action = event && event.action;
      if (!['login', 'getProfile', 'updateProfile'].includes(action)) {
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
          role: 'student',
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
      if (action === 'updateProfile') {
        const changes = validateProfile(event.profile, id, identity.env);
        await users.doc(id).update({ data: { ...changes, updatedAt: db.serverDate() } });
        user = { ...user, ...changes };
      }
      return { success: true, user: publicProfile(user) };
    } catch (error) {
      const expected = ['UNAUTHENTICATED', 'INVALID_ACTION', 'INVALID_PROFILE', 'INVALID_NICKNAME',
        'INVALID_AVATAR', 'NOT_REGISTERED', 'ACCOUNT_DISABLED'].includes(error.code);
      if (!expected) console.error('userService failed:', error);
      return {
        success: false,
        code: expected ? error.code : 'SERVICE_ERROR',
        message: expected ? error.message : '服务暂时不可用，请稍后重试',
      };
    }
  };
}

module.exports = { createUserService, userIdFor };
