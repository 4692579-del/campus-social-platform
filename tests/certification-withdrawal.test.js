const test = require('node:test');
const assert = require('node:assert/strict');
const { userIdFor } = require('../cloudfunctions/userService/service');
const { fixture, application } = require('./helpers/certification-fixture');

async function setup(options = {}) {
  const f = fixture(options);
  await f.login();
  await f.submit();
  await f.loginAdmin();
  f.userId = userIdFor('alice');
  f.id = `cert_${f.userId}`;
  f.withdraw = (extra = {}, identity = f.alice) => f.handle({ action: 'withdrawCertification', application: {
    applicationId: f.id, revision: 1, status: 'pending', ...extra,
  } }, identity);
  f.approve = (revision = 1) => f.handle({ action: 'reviewCertification', applicationId: f.id, revision,
    review: { decision: 'approved', schoolName: '测试大学' } }, f.admin);
  return f;
}

function assertUnverified(f) {
  const account = f.users.get(f.userId);
  assert.equal(account.role, 'user');
  assert.equal(account.certificationStatus, 'unverified');
  assert.equal(account.schoolId, '');
  assert.equal(account.schoolName, '');
  assert.equal(f.applications.get(f.id).status, 'withdrawn');
}

test('待审核申请可由本人取消，用户恢复未认证，管理端所有列表和直接接口均不可见', async () => {
  const f = await setup();
  const own = (await f.handle({ action: 'getCertification' }, f.alice)).certification.application;
  assert.equal(own.revision, 1);
  const result = await f.withdraw();
  assert.equal(result.success, true);
  assert.equal(result.certification.application, null);
  assert.equal(result.certification.user.certificationStatus, 'unverified');
  assertUnverified(f);
  for (const status of ['pending', 'approved', 'rejected']) {
    const list = await f.handle({ action: 'listCertifications', status }, f.admin);
    assert.deepEqual(list.reviewResult.items, []);
  }
  for (const action of ['getCertificationDetail', 'getCertificationProof', 'reviewCertification']) {
    const response = await f.handle({ action, applicationId: f.id, revision: 1,
      review: { decision: 'approved', schoolName: '测试大学' } }, f.admin);
    assert.equal(response.code, 'APPLICATION_NOT_FOUND');
    assert.equal(response.reviewResult, undefined);
  }
  assert.equal(f.proofRequests.length, 0);
  assert.equal((await f.handle({ action: 'getCertification' }, f.alice)).certification.application, null);
});

test('已认证学生撤回后清空学校和学生权限，保留个人资料及私有审核记录，可重新认证', async () => {
  const f = await setup(); await f.approve();
  Object.assign(f.users.get(f.userId), { nickname: '原昵称', avatarFileID: '原头像' });
  const result = await f.withdraw({ status: 'approved' });
  assert.equal(result.success, true); assertUnverified(f);
  assert.equal(result.certification.user.role, 'user');
  assert.equal(result.certification.user.nickname, '原昵称');
  assert.equal(result.certification.user.avatarFileID, '原头像');
  assert.equal(f.reviews.get(f.id + '_v1').status, 'approved');
  assert.equal((await f.handle({ action: 'getProfile' }, f.alice)).user.role, 'user');
  assert.equal((await f.submit(application({ requestId: 'test-request-00000002' }))).success, true);
  assert.equal(f.applications.get(f.id).revision, 2);
  assert.equal(f.applications.get(f.id).status, 'pending');
  assert.equal(f.users.get(f.userId).role, 'user');
  assert.equal((await f.approve(2)).success, true);
  assert.equal(f.users.get(f.userId).role, 'student');
  assert.equal(f.reviews.size, 2);
});

test('重复点击或并发重复撤回幂等，不创建多条申请', async () => {
  const f = await setup();
  const results = await Promise.all([f.withdraw(), f.withdraw()]);
  assert.ok(results.every(value => value.success));
  assert.equal((await f.withdraw()).success, true);
  assertUnverified(f); assert.equal(f.applications.size, 1); assert.equal(f.reviews.size, 0);
});

test('取消后重新申请递增版本，迟到的旧撤回不能取消新申请', async () => {
  const f = await setup(); await f.withdraw();
  assert.equal((await f.submit(application({ requestId: 'test-request-00000002' }))).success, true);
  assert.equal((await f.withdraw()).code, 'CERTIFICATION_CHANGED');
  assert.equal(f.applications.get(f.id).revision, 2);
  assert.equal(f.applications.get(f.id).status, 'pending');
  assert.equal((await f.withdraw({ revision: 2 })).success, true);
  assertUnverified(f);
});

test('多轮撤回后仍拒绝旧提交重试，旧审核不能处理新版本', async () => {
  const f = await setup(); await f.withdraw();
  assert.equal((await f.submit()).code, 'CERTIFICATION_WITHDRAWN');
  await f.submit(application({ requestId: 'test-request-00000002' }));
  await f.withdraw({ revision: 2 });
  assert.equal((await f.submit()).code, 'CERTIFICATION_WITHDRAWN');
  assert.equal((await f.submit(application({ requestId: 'test-request-00000002' }))).code, 'CERTIFICATION_WITHDRAWN');
  await f.submit(application({ requestId: 'test-request-00000003' }));
  assert.equal(f.applications.get(f.id).revision, 3);
  assert.equal((await f.approve()).code, 'STALE_APPLICATION');
  assert.equal((await f.approve(3)).success, true);
});

test('管理员已先通过时，旧的取消待审核操作不能偷偷撤销已认证身份', async () => {
  const f = await setup(); await f.approve();
  assert.equal((await f.withdraw()).code, 'CERTIFICATION_CHANGED');
  assert.equal(f.users.get(f.userId).role, 'student');
  assert.equal(f.applications.get(f.id).status, 'approved');
  assert.equal((await f.withdraw({ status: 'approved' })).success, true);
});

test('审核与取消同时执行，事务保证用户和申请结果一致，取消完成后不能再授予学生权限', async () => {
  const f = await setup();
  const results = await Promise.all([f.withdraw(), f.approve()]);
  assert.ok(results.some(value => value.success));
  const record = f.applications.get(f.id), account = f.users.get(f.userId);
  if (record.status === 'withdrawn') {
    assertUnverified(f);
    assert.equal((await f.approve()).code, 'APPLICATION_NOT_FOUND');
  } else {
    assert.equal(record.status, 'approved'); assert.equal(account.role, 'student');
    assert.equal(account.certificationStatus, 'approved');
    assert.equal(results[0].code, 'CERTIFICATION_CHANGED');
  }
});

test('事务中再次核对申请状态，不覆盖刚发生的审核结果', async () => {
  const f = await setup();
  f.hooks.beforeTransaction = tables => {
    Object.assign(tables.get('certification_applications').get(f.id), { status: 'approved' });
    Object.assign(tables.get('users').get(f.userId), { certificationStatus: 'approved', role: 'student', schoolId: 'school-test' });
  };
  assert.equal((await f.withdraw()).code, 'CERTIFICATION_CHANGED');
  assert.equal(f.users.get(f.userId).role, 'student');
});

test('撤回任一步写入失败会回滚，不出现申请消失但学生身份仍有效的情况', async () => {
  for (const collection of ['users', 'certification_applications']) {
    const options = {};
    const f = await setup(options); await f.approve();
    options.failCollection = collection;
    assert.equal((await f.withdraw({ status: 'approved' })).code, 'SERVICE_ERROR');
    assert.equal(f.users.get(f.userId).role, 'student');
    assert.equal(f.users.get(f.userId).certificationStatus, 'approved');
    assert.equal(f.applications.get(f.id).status, 'approved');
  }
});

test('伪造申请编号、版本、状态和账号字段不能撤回他人认证', async () => {
  const f = await setup(); await f.login(f.bob);
  assert.equal((await f.withdraw({}, f.bob)).code, 'INVALID_WITHDRAWAL');
  for (const extra of [{ applicationId: `cert_${userIdFor('bob')}` }, { revision: 0 }, { revision: '1' },
    { status: 'rejected' }, { role: 'admin' }, { userId: f.userId }, { openid: 'alice' }]) {
    assert.equal((await f.withdraw(extra)).code, 'INVALID_WITHDRAWAL');
  }
  assert.equal((await f.withdraw({ revision: 2 })).code, 'CERTIFICATION_CHANGED');
  assert.equal((await f.withdraw({}, f.admin)).code, 'FORBIDDEN');
  assert.equal((await f.withdraw({}, { openid: 'unregistered', env: 'test' })).code, 'NOT_REGISTERED');
  assert.equal((await f.withdraw({}, {})).code, 'UNAUTHENTICATED');
  assert.equal(f.applications.get(f.id).status, 'pending');
});

test('账号在事务前被封禁或设为管理员，撤回不能把账号改回普通用户', async () => {
  for (const changes of [{ status: 'banned' }, { role: 'admin' }]) {
    const f = await setup();
    f.hooks.beforeTransaction = tables => Object.assign(tables.get('users').get(f.userId), changes);
    assert.equal((await f.withdraw()).code, changes.role ? 'FORBIDDEN' : 'ACCOUNT_DISABLED');
    assert.equal(f.applications.get(f.id).status, 'pending');
    for (const [field, value] of Object.entries(changes)) assert.equal(f.users.get(f.userId)[field], value);
  }
});

test('未提交和已驳回的申请不能通过撤回接口修改状态', async () => {
  const f = await setup();
  await f.handle({ action: 'reviewCertification', applicationId: f.id, revision: 1,
    review: { decision: 'rejected', rejectionReason: '材料不清晰' } }, f.admin);
  assert.equal((await f.withdraw()).code, 'CERTIFICATION_CHANGED');
  assert.equal(f.users.get(f.userId).certificationStatus, 'rejected');
  f.applications.delete(f.id);
  assert.equal((await f.withdraw()).code, 'CERTIFICATION_CHANGED');
});

test('签发材料链接期间发生撤回，不把新生成的链接返回给管理员', async () => {
  const options = {};
  const f = await setup(options);
  options.beforeProofUrl = () => f.withdraw();
  const result = await f.handle({ action: 'getCertificationProof', applicationId: f.id, revision: 1 }, f.admin);
  assert.equal(result.code, 'APPLICATION_NOT_FOUND');
  assert.equal(result.reviewResult, undefined);
});
