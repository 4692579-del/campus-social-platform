const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture } = require('./helpers/certification-fixture');
const { userIdFor } = require('../cloudfunctions/userService/service');

function oldAccount(f, openid, extra = {}) {
  const user = { _id: userIdFor(openid), openid, nickname: '旧昵称', avatarFileID: '',
    role: 'user', status: 'active', certificationStatus: 'unverified', schoolId: '',
    createdAt: '2020-01-01', updatedAt: '2020-02-01', nicknameChangeCount: 3,
    nicknameLastChangedAt: '2020-02-01', ...extra };
  f.users.set(user._id, { ...user });
  return user;
}
const migrate = (f, cursor = '', identity = f.admin) => f.handle({ action: 'backfillAccountIds', cursor }, identity);

test('首次注册分配8位随机ID并绑定可信OpenID；退出重登和修改资料均不换号', async () => {
  const f = fixture();
  const user = await f.login();
  assert.match(user.accountId, /^[1-9][0-9]{7}$/);
  assert.equal(user._id, userIdFor(f.alice.openid));
  assert.equal(f.accountIds.get(user.accountId).userId, user._id);
  assert.equal(user.openid, undefined);
  assert.equal((await f.login()).accountId, user.accountId);
  assert.equal((await f.handle({ action: 'updateProfile', profile: { nickname: '新昵称', avatarFileID: '' } }, f.alice)).user.accountId, user.accountId);
  assert.equal((await f.handle({ action: 'getAccountInfo' }, f.alice)).accountInfo.user.accountId, user.accountId);
});

test('随机号码碰撞重新生成；既有绑定永不被覆盖', async () => {
  const candidates = ['12345678', '12345678', '87654321'];
  const f = fixture({ randomAccountId: () => candidates.shift() });
  const alice = await f.login(), bob = await f.login(f.bob);
  assert.equal(alice.accountId, '12345678');
  assert.equal(bob.accountId, '87654321');
  assert.equal(f.accountIds.get('12345678').userId, alice._id);
  assert.equal(f.accountIds.get('87654321').userId, bob._id);
});

test('同一OpenID并发注册只建一个账号和一个号码，不同账号并发也不重号', async () => {
  let next = 10000000;
  const f = fixture({ randomAccountId: () => String(next++) });
  const responses = await Promise.all(Array.from({ length: 10 }, () => f.login()));
  assert.equal(new Set(responses.map(user => user.accountId)).size, 1);
  assert.equal(f.users.size, 1);
  assert.equal(f.accountIds.size, 1);
  const others = await Promise.all(Array.from({ length: 25 }, (_, index) => f.login({ openid: `other-${index}`, env: 'test' })));
  assert.equal(new Set(others.map(user => user.accountId)).size, 25);
  assert.equal(f.users.size, 26);
  assert.equal(f.accountIds.size, 26);
});

test('用户建档或号码占用任一写入失败一起回滚，不留下半注册账号或孤立号码', async () => {
  for (const name of ['users', 'account_ids']) {
    const f = fixture({ failCollection: name });
    const result = await f.handle({ action: 'login' }, f.alice);
    assert.equal(result.success, false);
    assert.equal(f.users.size, 0);
    assert.equal(f.accountIds.size, 0);
  }
});

test('老账号补齐失败不占用号码；恢复后重试保留原资料并只增加ID字段', async () => {
  const options = { failUserUpdate: true };
  const f = fixture(options);
  const before = oldAccount(f, 'alice', { role: 'student', certificationStatus: 'approved', schoolId: 'school', schoolName: '真实学校' });
  assert.equal((await f.handle({ action: 'getProfile' }, f.alice)).success, false);
  assert.equal(f.accountIds.size, 0);
  assert.deepEqual(f.users.get(before._id), before);
  options.failUserUpdate = false;
  const result = await f.handle({ action: 'getProfile' }, f.alice);
  assert.match(result.user.accountId, /^[1-9][0-9]{7}$/);
  const { accountId, accountIdAssignedAt, ...after } = f.users.get(before._id);
  assert.deepEqual(after, before);
  assert.ok(accountIdAssignedAt);
  assert.equal((await f.login()).accountId, accountId);
});

test('不可通过资料或伪造身份更改ID，普通账号不能执行批量补齐', async () => {
  const f = fixture();
  const user = await f.login(), bob = oldAccount(f, 'bob');
  const result = await f.handle({ action: 'updateProfile', profile: { nickname: '篡改', avatarFileID: '', accountId: '88888888' } }, f.alice);
  assert.equal(result.code, 'INVALID_PROFILE');
  const logged = await f.handle({ action: 'login', openid: 'bob', userId: bob._id, accountId: '88888888' }, f.alice);
  assert.equal(logged.user.accountId, user.accountId);
  assert.equal(f.users.get(bob._id).accountId, undefined);
  assert.equal((await migrate(f, '', f.alice)).code, 'FORBIDDEN');
  assert.equal((await migrate(f, '', {})).code, 'UNAUTHENTICATED');
});

test('管理员分页补齐所有旧账号含停用账号，重复或并发执行不换号且不改其他字段', async () => {
  let next = 20000000;
  const f = fixture({ randomAccountId: () => String(next++) });
  oldAccount(f, 'admin', { role: 'admin' });
  const originals = Array.from({ length: 27 }, (_, i) => oldAccount(f, `old-${i}`, i === 0 ? { status: 'banned' } : {}));
  let cursor = '', scanned = 0, assigned = 0;
  for (;;) {
    const result = await migrate(f, cursor);
    assert.equal(result.success, true);
    const page = result.migration;
    assert.ok(page.scanned <= 20);
    scanned += page.scanned;
    assigned += page.assigned;
    if (page.done) break;
    cursor = page.nextCursor;
  }
  assert.equal(scanned, 28);
  assert.equal(assigned, 28);
  const bindings = [...f.users.values()].map(user => [user._id, user.accountId]);
  await Promise.all([migrate(f), migrate(f)]);
  assert.deepEqual([...f.users.values()].map(user => [user._id, user.accountId]), bindings);
  assert.equal(f.accountIds.size, 28);
  for (const before of originals) {
    const { accountId, accountIdAssignedAt, ...after } = f.users.get(before._id);
    assert.match(accountId, /^[1-9][0-9]{7}$/);
    assert.deepEqual(after, before);
  }
});

test('批量补齐在每个写入事务重查管理员权限；异常绑定不会被重新分配号码掩盖', async () => {
  const f = fixture();
  const admin = oldAccount(f, 'admin', { role: 'admin' });
  oldAccount(f, 'alice');
  f.hooks.beforeTransaction = tables => { tables.get('users').get(admin._id).role = 'user'; };
  assert.equal((await migrate(f)).code, 'FORBIDDEN');
  assert.equal(f.accountIds.size, 0);
  f.hooks.beforeTransaction = null;
  const other = oldAccount(f, 'bob', { accountId: '12345678' });
  f.accountIds.set('12345678', { _id: '12345678', userId: other._id });
  f.users.get(userIdFor('alice')).accountId = '12345678';
  f.users.get(admin._id).role = 'admin';
  assert.equal((await migrate(f)).code, 'ACCOUNT_ID_CONFLICT');
  assert.equal(f.users.get(userIdFor('alice')).accountId, '12345678');
  assert.equal(f.accountIds.get('12345678').userId, other._id);
});

test('ID被持续占用或绑定数据异常时返回明确失败，不生成重复或可变ID', async () => {
  const f = fixture({ randomAccountId: () => '12345678' });
  await f.login();
  assert.equal((await f.handle({ action: 'login' }, f.bob)).code, 'ACCOUNT_ID_BUSY');
  assert.equal(f.users.has(userIdFor('bob')), false);
  oldAccount(f, 'bob', { accountId: '123' });
  assert.equal((await f.handle({ action: 'login' }, f.bob)).code, 'ACCOUNT_ID_BINDING_ERROR');
});

test('按ID精确搜索仅返回必要资料，账号停用、绑定失效、无效ID及未登录均正确处理', async () => {
  const f = fixture();
  assert.equal((await f.handle({ action: 'findUserByAccountId', accountId: '12345678' }, {})).code, 'UNAUTHENTICATED');
  const alice = await f.login(), bob = await f.login(f.bob);
  const result = await f.handle({ action: 'findUserByAccountId', accountId: bob.accountId }, f.alice);
  assert.deepEqual(Object.keys(result.searchResult).sort(), ['_id', 'accountId', 'avatarFileID', 'isVerified', 'nickname']);
  assert.equal(result.searchResult._id, bob._id);
  for (const value of ['123', '01234567', 'abcdefgh', 12345678, '12345678 ']) {
    assert.equal((await f.handle({ action: 'findUserByAccountId', accountId: value }, f.alice)).code, 'INVALID_ACCOUNT_ID');
  }
  f.users.get(bob._id).status = 'banned';
  assert.equal((await f.handle({ action: 'findUserByAccountId', accountId: bob.accountId }, f.alice)).searchResult, null);
  f.users.get(bob._id).status = 'active';
  f.accountIds.get(bob.accountId).userId = alice._id;
  assert.equal((await f.handle({ action: 'findUserByAccountId', accountId: bob.accountId }, f.alice)).searchResult, null);
});

test('补齐脚本逐页运行到完成，服务报错后停止且不声称已完成', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/backfill-account-ids.devtools.js'), 'utf8');
  const requests = [], messages = [];
  await vm.runInNewContext(source, {
    wx: { cloud: { callFunction: async ({ data }) => {
      requests.push(data);
      return { result: { success: true, migration: data.cursor
        ? { scanned: 2, assigned: 1, done: true, nextCursor: 'end' }
        : { scanned: 20, assigned: 15, done: false, nextCursor: 'next' } } };
    } } }, console: { info: value => messages.push(value), error: value => messages.push(value) },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].cursor, 'next');
  assert.match(messages.at(-1), /已有账号ID补齐完成/);
  messages.length = 0;
  await vm.runInNewContext(source, { wx: { cloud: { callFunction: async () => ({ result: { success: false, message: '无权限' } }) } },
    console: { info: value => messages.push(value), error: value => messages.push(value) } });
  assert.deepEqual(messages, ['ID账号补齐未完成：无权限']);
});
