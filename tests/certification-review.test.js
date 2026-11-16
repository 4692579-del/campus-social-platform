const test = require('node:test');
const assert = require('node:assert/strict');
const { userIdFor } = require('../cloudfunctions/userService/service');
const { fixture, application } = require('./helpers/certification-fixture');

async function setup(options) {
  const f = fixture(options);
  await f.login(); await f.submit(); await f.loginAdmin();
  f.id = `cert_${userIdFor('alice')}`;
  f.review = (review = { decision: 'approved', schoolName: '测试大学' }, extra = {}, identity = f.admin) =>
    f.handle({ action: 'reviewCertification', applicationId: f.id, revision: 1, review, ...extra }, identity);
  return f;
}

test('普通用户、学生和伪造管理员字段不能读取列表、详情、材料或审核', async () => {
  const f = await setup();
  for (const role of ['user', 'student']) {
    Object.assign(f.users.get(userIdFor('alice')), { role, schoolId: 'school-test', certificationStatus: 'approved' });
    for (const action of ['listCertifications', 'getCertificationDetail', 'getCertificationProof', 'reviewCertification']) {
      const result = await f.handle({ action, applicationId: f.id, revision: 1,
        review: { decision: 'approved', schoolName: '测试大学' }, role: 'admin', openid: 'admin', userId: userIdFor('admin') }, f.alice);
      assert.equal(result.code, 'FORBIDDEN');
      assert.equal(result.reviewResult, undefined);
    }
  }
  assert.equal(f.proofRequests.length, 0);
});

test('管理员列表按状态分页，只返回必要信息，不含学号、材料路径或 URL', async () => {
  const f = await setup();
  const source = f.applications.get(f.id);
  for (let n = 0; n < 25; n++) {
    const userId = userIdFor('test-applicant-' + n);
    f.applications.set(`cert_${userId}`, { ...source, _id: `cert_${userId}`, userId });
  }
  const first = (await f.handle({ action: 'listCertifications', status: 'pending' }, f.admin)).reviewResult;
  assert.equal(first.items.length, 20); assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 20);
  for (const row of first.items) {
    assert.equal(row.studentNumber, undefined); assert.equal(row.proofFileID, undefined); assert.equal(row.url, undefined);
  }
  const next = (await f.handle({ action: 'listCertifications', status: 'pending', offset: 20 }, f.admin)).reviewResult;
  assert.equal(next.items.length, 6); assert.equal(next.hasMore, false);
  assert.equal(new Set(first.items.concat(next.items).map(row => row._id)).size, 26);
  assert.deepEqual((await f.handle({ action: 'listCertifications', status: 'approved' }, f.admin)).reviewResult.items, []);
  for (const data of [{ status: 'all' }, { offset: -1 }, { offset: 1.5 }, { offset: 10001 }]) {
    assert.equal((await f.handle({ action: 'listCertifications', ...data }, f.admin)).code, 'INVALID_REVIEW');
  }
});

test('详情包含材料标记和学号，只有主动获取材料才生成临时链接', async () => {
  const f = await setup();
  const detail = (await f.handle({ action: 'getCertificationDetail', applicationId: f.id }, f.admin)).reviewResult;
  assert.equal(detail.studentNumber, '00123456'); assert.equal(detail.revision, 1);
  assert.equal(detail.hasProof, true); assert.equal(detail.proofFileID, undefined);
  assert.equal(f.proofRequests.length, 0);
  const proof = (await f.handle({ action: 'getCertificationProof', applicationId: f.id, revision: 1 }, f.admin)).reviewResult;
  assert.match(proof.url, /^https:/); assert.equal(proof.expiresIn, 120); assert.equal(proof.fileID, undefined);
  assert.equal(f.proofRequests.length, 1);
});

test('通过审核原子更新角色、学校和结果，保存审核人及不可被重提覆盖的记录', async () => {
  const f = await setup();
  const result = await f.review({ decision: 'approved', schoolName: ' 核准测试大学 ' });
  assert.equal(result.success, true);
  assert.equal(result.reviewResult.approvedSchoolName, '核准测试大学');
  const user = f.users.get(userIdFor('alice'));
  const record = f.applications.get(f.id);
  assert.equal(user.role, 'student'); assert.equal(user.certificationStatus, 'approved');
  assert.equal(user.schoolName, '核准测试大学'); assert.match(user.schoolId, /^school_[a-f0-9]{32}$/);
  assert.equal(record.schoolId, user.schoolId); assert.equal(record.status, 'approved');
  assert.equal(record.reviewerId, userIdFor('admin')); assert.ok(record.reviewedAt);
  assert.equal(f.reviews.size, 1);
  assert.equal(f.reviews.get(f.id + '_v1').status, 'approved');
  const restored = await f.handle({ action: 'getProfile' }, f.alice);
  assert.equal(restored.user.role, 'student'); assert.equal(restored.user.schoolName, '核准测试大学');
  assert.equal(restored.user.realName, undefined); assert.equal(restored.user.studentNumber, undefined);
  assert.equal((await f.submit()).code, 'ALREADY_CERTIFIED');
});

test('同一核准学校全称生成相同归属，审核请求不能指定 schoolId 或角色', async () => {
  const f = await setup();
  await f.login(f.bob); await f.submit(application(), f.bob);
  assert.equal((await f.review({ decision: 'approved', schoolName: '测试 大学' })).success, true);
  const bobId = `cert_${userIdFor('bob')}`;
  assert.equal((await f.review({ decision: 'approved', schoolName: '测试大学' }, { applicationId: bobId })).success, true);
  assert.equal(f.users.get(userIdFor('alice')).schoolId, f.users.get(userIdFor('bob')).schoolId);
  assert.equal((await f.review({ decision: 'approved', schoolName: '测试大学', schoolId: 'fake' })).code, 'INVALID_REVIEW');
});

test('驳回需原因，账号保持普通身份；重提后保留历史审核且旧页面不能审核新版本', async () => {
  const f = await setup();
  assert.equal((await f.review({ decision: 'rejected', rejectionReason: '' })).code, 'INVALID_REVIEW');
  assert.equal((await f.review({ decision: 'rejected', rejectionReason: ' 材料不清晰，请补充在读信息 ' })).success, true);
  const user = f.users.get(userIdFor('alice'));
  assert.equal(user.role, 'user'); assert.equal(user.certificationStatus, 'rejected'); assert.equal(user.schoolId, '');
  const own = (await f.handle({ action: 'getCertification' }, f.alice)).certification.application;
  assert.equal(own.rejectionReason, '材料不清晰，请补充在读信息');
  await f.submit(application({ requestId: 'test-request-00000002' }));
  assert.equal(f.applications.get(f.id).revision, 2);
  assert.equal(f.reviews.get(f.id + '_v1').rejectionReason, '材料不清晰，请补充在读信息');
  assert.equal((await f.review()).code, 'STALE_APPLICATION');
  assert.equal((await f.handle({ action: 'getCertificationProof', applicationId: f.id, revision: 1 }, f.admin)).code, 'STALE_APPLICATION');
  assert.equal((await f.review({ decision: 'approved', schoolName: '测试大学' }, { revision: 2 })).success, true);
  assert.equal(f.reviews.size, 2);
});

test('两个管理员并发处理同一申请只有一个结果，重复请求不重复写审核记录', async () => {
  const f = await setup();
  const second = { openid: 'second-admin', env: 'test' }; await f.loginAdmin(second);
  const results = await Promise.all([f.review(), f.review({ decision: 'rejected', rejectionReason: '材料不符合要求' }, {}, second)]);
  assert.equal(results.filter(r => r.success).length, 1);
  assert.equal(results.filter(r => r.code === 'APPLICATION_ALREADY_REVIEWED').length, 1);
  assert.equal(f.reviews.size, 1);
  assert.equal((await f.review()).code, 'APPLICATION_ALREADY_REVIEWED');
  assert.equal(f.reviews.size, 1);
});

test('日志集合写入失败时申请、角色和审核员记录全部回滚', async () => {
  const f = await setup({ failCollection: 'certification_reviews' });
  assert.equal((await f.review()).code, 'SERVICE_ERROR');
  assert.equal(f.users.get(userIdFor('alice')).role, 'user');
  assert.equal(f.users.get(userIdFor('alice')).certificationStatus, 'pending');
  assert.equal(f.applications.get(f.id).status, 'pending'); assert.equal(f.reviews.size, 0);
  assert.equal(f.users.get(userIdFor('admin')).lastCertificationReviewAt, undefined);
});

test('事务提交前管理员被撤权或封禁，审核拒绝，不更新申请人', async () => {
  for (const changes of [{ role: 'user' }, { status: 'banned' }]) {
    const f = await setup();
    f.hooks.beforeTransaction = tables => Object.assign(tables.get('users').get(userIdFor('admin')), changes);
    assert.equal((await f.review()).code, 'FORBIDDEN');
    assert.equal(f.applications.get(f.id).status, 'pending'); assert.equal(f.reviews.size, 0);
  }
});

test('申请人被封禁、提升为管理员、删除或认证状态不一致时不能审核', async () => {
  for (const changes of [{ status: 'banned' }, { role: 'admin' }, { certificationStatus: 'approved' }, null]) {
    const f = await setup();
    if (changes) Object.assign(f.users.get(userIdFor('alice')), changes); else f.users.delete(userIdFor('alice'));
    assert.equal((await f.review()).code, 'INVALID_APPLICANT');
    assert.equal(f.reviews.size, 0); assert.equal(f.applications.get(f.id).status, 'pending');
  }
});

test('材料失效时不能通过，仍可说明原因驳回；跨环境和跨用户路径不生成链接', async () => {
  const f = await setup({ proofAvailable: false });
  assert.equal((await f.review()).code, 'PROOF_UNAVAILABLE');
  assert.equal((await f.review({ decision: 'rejected', rejectionReason: '材料无法读取，请重新上传' })).success, true);
  for (const file of ['https://example.com/image.png', 'cloud://other.bucket/certification-proofs/anything/photo.png',
    `cloud://test.bucket/certification-proofs/${userIdFor('bob')}/${'a'.repeat(32)}.png`]) {
    f.applications.get(f.id).proofFileID = file;
    assert.equal((await f.handle({ action: 'getCertificationProof', applicationId: f.id, revision: 1 }, f.admin)).code, 'PROOF_UNAVAILABLE');
  }
});

test('非法编号、版本、决策和原因被拒绝；已撤权管理员不能读取材料', async () => {
  const f = await setup();
  assert.equal((await f.review(undefined, { applicationId: '../escape' })).code, 'INVALID_REVIEW');
  assert.equal((await f.review(undefined, { revision: 0 })).code, 'INVALID_REVIEW');
  assert.equal((await f.review({ decision: 'banned' })).code, 'INVALID_REVIEW');
  assert.equal((await f.review({ decision: 'rejected', rejectionReason: '字'.repeat(201) })).code, 'INVALID_REVIEW');
  f.users.get(userIdFor('admin')).role = 'user';
  assert.equal((await f.handle({ action: 'getCertificationProof', applicationId: f.id, revision: 1 }, f.admin)).code, 'FORBIDDEN');
  assert.equal(f.proofRequests.length, 0);
});
