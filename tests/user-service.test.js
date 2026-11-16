// 运行：node --test tests/user-service.test.js（仅使用 Node 内置模块，不连接真实云环境）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserService, userIdFor } = require('../cloudfunctions/userService/service');

function fixture({ beforeConditionalUpdate } = {}) {
  const records = new Map();
  const db = {
    serverDate: () => 'server-time',
    collection(name) {
      assert.equal(name, 'users');
      return {
        where(query) {
          const matches = record => Object.entries(query).every(([key, value]) => record[key] === value);
          return {
            get: async () => ({ data: [...records.values()].filter(matches).map(record => ({ ...record })) }),
            update: async ({ data }) => {
              if (beforeConditionalUpdate) beforeConditionalUpdate(records, query);
              let updated = 0;
              for (const [id, record] of records) {
                if (!matches(record)) continue;
                records.set(id, { ...record, ...data });
                updated += 1;
              }
              return { stats: { updated } };
            },
          };
        },
        async add({ data }) {
          if (records.has(data._id)) throw new Error('duplicate id');
          records.set(data._id, { ...data });
        },
        doc(id) { return { update: async ({ data }) => {
          assert.ok(records.has(id));
          records.set(id, { ...records.get(id), ...data });
        } }; },
      };
    },
  };
  return { records, handle: createUserService(db), alice: { openid: 'alice', env: 'campus-test' }, bob: { openid: 'bob', env: 'campus-test' } };
}

test('首次登录建档为普通用户，返回可信角色但不泄露 openid', async () => {
  const f = fixture();
  const result = await f.handle({ action: 'login' }, f.alice);
  assert.equal(result.success, true);
  assert.equal(result.user.certificationStatus, 'unverified');
  assert.equal(result.user.openid, undefined);
  assert.equal(result.user.role, 'user');
  assert.equal(f.records.get(result.user._id).role, 'user');
  assert.equal(f.records.size, 1);
  assert.equal(f.records.get(result.user._id).status, 'active');
});

test('并发登录只产生一条记录，重复登录不覆盖已修改资料', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.handle({ action: 'login' }, f.alice)));
  assert.ok(results.every(result => result.success));
  assert.equal(f.records.size, 1);
  await f.handle({ action: 'updateProfile', profile: { nickname: '小罗', avatarFileID: '' } }, f.alice);
  assert.equal((await f.handle({ action: 'login' }, f.alice)).user.nickname, '小罗');
});

test('恢复未建档用户不会偷偷创建账号，未登录不能更新', async () => {
  const f = fixture();
  assert.equal((await f.handle({ action: 'getProfile' }, f.alice)).user, null);
  assert.equal((await f.handle({ action: 'updateProfile', profile: {} }, f.alice)).code, 'NOT_REGISTERED');
  assert.equal(f.records.size, 0);
});

test('缺少云端身份、未知操作会拒绝执行', async () => {
  const f = fixture();
  assert.equal((await f.handle({ action: 'login', openid: 'alice' }, {})).code, 'UNAUTHENTICATED');
  assert.equal((await f.handle({ action: 'deleteUser' }, f.alice)).code, 'INVALID_ACTION');
  assert.equal(f.records.size, 0);
});

test('伪造目标用户和 openid 不会修改别人的资料', async () => {
  const f = fixture();
  await f.handle({ action: 'login' }, f.alice);
  await f.handle({ action: 'login' }, f.bob);
  await f.handle({ action: 'updateProfile', userId: userIdFor('bob'), openid: 'bob',
    profile: { nickname: '我是 Alice', avatarFileID: '' } }, f.alice);
  assert.equal(f.records.get(userIdFor('bob')).nickname, '校园新同学');
  assert.equal(f.records.get(userIdFor('alice')).nickname, '我是 Alice');
});

test('禁止通过资料接口修改角色、认证、状态和学校', async () => {
  const f = fixture();
  await f.handle({ action: 'login' }, f.alice);
  for (const key of ['role', 'certificationStatus', 'schoolId', 'status', 'openid', '_id']) {
    const response = await f.handle({ action: 'updateProfile', profile: { nickname: '小罗', avatarFileID: '', [key]: 'admin' } }, f.alice);
    assert.equal(response.code, 'INVALID_PROFILE');
  }
  assert.equal(f.records.get(userIdFor('alice')).role, 'user');
});

test('昵称拒绝空白、超长、控制字符，接受正常中文与 emoji', async () => {
  const f = fixture();
  await f.handle({ action: 'login' }, f.alice);
  for (const nickname of [' ', '罗'.repeat(21), '小\n罗']) {
    assert.equal((await f.handle({ action: 'updateProfile', profile: { nickname, avatarFileID: '' } }, f.alice)).code, 'INVALID_NICKNAME');
  }
  const result = await f.handle({ action: 'updateProfile', profile: { nickname: '  同学🌻  ', avatarFileID: '' } }, f.alice);
  assert.equal(result.user.nickname, '同学🌻');
});

test('头像只接受当前环境当前用户目录，拒绝外链、跨用户和路径穿越', async () => {
  const f = fixture();
  await f.handle({ action: 'login' }, f.alice);
  const id = userIdFor('alice');
  for (const avatarFileID of [
    'https://example.com/avatar.png',
    `cloud://other-env.bucket/avatars/${id}/photo.png`,
    `cloud://campus-test.bucket/avatars/${userIdFor('bob')}/photo.png`,
    `cloud://campus-test.bucket/avatars/${id}/../photo.png`,
    `cloud://campus-test.bucket/avatars/${id}/photo.svg`,
  ]) {
    assert.equal((await f.handle({ action: 'updateProfile', profile: { nickname: '同学', avatarFileID } }, f.alice)).code, 'INVALID_AVATAR');
  }
  const file = `cloud://campus-test.bucket/avatars/${id}/photo-123.png`;
  assert.equal((await f.handle({ action: 'updateProfile', profile: { nickname: '同学', avatarFileID: file } }, f.alice)).user.avatarFileID, file);
});

test('禁用账号不能登录、读取或修改资料', async () => {
  const f = fixture();
  await f.handle({ action: 'login' }, f.alice);
  f.records.get(userIdFor('alice')).status = 'banned';
  for (const action of ['login', 'getProfile', 'updateProfile']) {
    assert.equal((await f.handle({ action }, f.alice)).code, 'ACCOUNT_DISABLED');
  }
});

test('数据库失败返回失败，不伪装成登录成功', async () => {
  const handle = createUserService({ collection: () => ({ where: () => ({ get: async () => { throw new Error('database unavailable'); } }) }) });
  const result = await handle({ action: 'login' }, { openid: 'alice' });
  assert.equal(result.success, false);
  assert.equal(result.code, 'SERVICE_ERROR');
});

test('旧版未认证 student 只修正自己的角色，保留资料和主键', async () => {
  const f = fixture();
  const original = (await f.handle({ action: 'login' }, f.alice)).user;
  Object.assign(f.records.get(original._id), { role: 'student', nickname: '原昵称', avatarFileID: 'old-avatar' });
  await f.handle({ action: 'login' }, f.bob);
  f.records.get(userIdFor('bob')).role = 'admin';
  const result = await f.handle({ action: 'getProfile' }, f.alice);
  assert.equal(result.user.role, 'user');
  assert.equal(result.user._id, original._id);
  assert.equal(result.user.nickname, '原昵称');
  assert.equal(result.user.avatarFileID, 'old-avatar');
  assert.equal(f.records.get(original._id).role, 'user');
  assert.equal(f.records.get(userIdFor('bob')).role, 'admin');
});

test('旧数据修正不覆盖查询后刚授予的管理员身份', async () => {
  const f = fixture({ beforeConditionalUpdate(records, query) { records.get(query._id).role = 'admin'; } });
  await f.handle({ action: 'login' }, f.alice);
  f.records.get(userIdFor('alice')).role = 'student';
  const result = await f.handle({ action: 'getProfile' }, f.alice);
  assert.equal(result.user.role, 'admin');
  assert.equal(f.records.get(userIdFor('alice')).role, 'admin');
});

test('管理员重复登录、恢复、修改资料都保留 admin，管理页由服务端验证', async () => {
  const f = fixture();
  await f.handle({ action: 'login' }, f.alice);
  f.records.get(userIdFor('alice')).role = 'admin';
  for (const action of ['login', 'getProfile', 'updateProfile']) {
    const result = await f.handle({ action, profile: { nickname: '管理员', avatarFileID: '' } }, f.alice);
    assert.equal(result.user.role, 'admin');
  }
  const result = await f.handle({ action: 'getAdminDashboard' }, f.alice);
  assert.equal(result.dashboard.operator.role, 'admin');
  assert.equal(result.dashboard.operator.openid, undefined);
});

test('普通用户伪造管理员角色、用户 ID 或 OpenID 不能访问工作台', async () => {
  const f = fixture();
  await f.handle({ action: 'login' }, f.alice);
  await f.handle({ action: 'login' }, f.bob);
  f.records.get(userIdFor('bob')).role = 'admin';
  const result = await f.handle({ action: 'getAdminDashboard', role: 'admin', userId: userIdFor('bob'), openid: 'bob' }, f.alice);
  assert.equal(result.code, 'FORBIDDEN');
  assert.equal(result.dashboard, undefined);
});

test('学生身份必须具备已通过认证和学校，学生仍无管理权限', async () => {
  const f = fixture();
  await f.handle({ action: 'login' }, f.alice);
  const user = f.records.get(userIdFor('alice'));
  user.role = 'student';
  user.certificationStatus = 'approved';
  assert.equal((await f.handle({ action: 'getProfile' }, f.alice)).user.role, 'user');
  user.schoolId = 'school-demo';
  assert.equal((await f.handle({ action: 'getProfile' }, f.alice)).user.role, 'student');
  assert.equal((await f.handle({ action: 'getAdminDashboard' }, f.alice)).code, 'FORBIDDEN');
});

test('认证待审核或已驳回时不会获得学生权限，也不自动升级普通角色', async () => {
  const f = fixture();
  await f.handle({ action: 'login' }, f.alice);
  const user = f.records.get(userIdFor('alice'));
  Object.assign(user, { role: 'student', schoolId: 'school-demo' });
  for (const certificationStatus of ['pending', 'rejected']) {
    user.certificationStatus = certificationStatus;
    assert.equal((await f.handle({ action: 'getProfile' }, f.alice)).user.role, 'user');
  }
  Object.assign(user, { role: 'user', certificationStatus: 'approved' });
  assert.equal((await f.handle({ action: 'getProfile' }, f.alice)).user.role, 'user');
});

test('管理员权限撤销或账号封禁后，下一次管理请求立即拒绝', async () => {
  const f = fixture();
  await f.handle({ action: 'login' }, f.alice);
  const user = f.records.get(userIdFor('alice'));
  user.role = 'admin';
  assert.equal((await f.handle({ action: 'getAdminDashboard' }, f.alice)).success, true);
  user.role = 'user';
  assert.equal((await f.handle({ action: 'getAdminDashboard' }, f.alice)).code, 'FORBIDDEN');
  Object.assign(user, { role: 'admin', status: 'banned' });
  assert.equal((await f.handle({ action: 'getAdminDashboard' }, f.alice)).code, 'ACCOUNT_DISABLED');
});

test('没有云端身份、没有用户记录或未知角色不能访问工作台', async () => {
  const f = fixture();
  assert.equal((await f.handle({ action: 'getAdminDashboard' }, {})).code, 'UNAUTHENTICATED');
  assert.equal((await f.handle({ action: 'getAdminDashboard' }, f.alice)).code, 'NOT_REGISTERED');
  assert.equal(f.records.size, 0);
  await f.handle({ action: 'login' }, f.alice);
  f.records.get(userIdFor('alice')).role = 'administrator';
  assert.equal((await f.handle({ action: 'getAdminDashboard' }, f.alice)).code, 'INVALID_ROLE');
});
