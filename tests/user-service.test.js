// 运行：node --test tests/user-service.test.js（仅使用 Node 内置模块，不连接真实云环境）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserService, userIdFor } = require('../cloudfunctions/userService/service');

function fixture() {
  const records = new Map();
  const db = {
    serverDate: () => 'server-time',
    collection(name) {
      assert.equal(name, 'users');
      return {
        where({ _id }) { return { get: async () => ({ data: records.has(_id) ? [{ ...records.get(_id) }] : [] }) }; },
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

test('首次登录建档，返回值不包含 openid、角色等内部字段', async () => {
  const f = fixture();
  const result = await f.handle({ action: 'login' }, f.alice);
  assert.equal(result.success, true);
  assert.equal(result.user.certificationStatus, 'unverified');
  assert.equal(result.user.openid, undefined);
  assert.equal(result.user.role, undefined);
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
  assert.equal(f.records.get(userIdFor('alice')).role, 'student');
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
