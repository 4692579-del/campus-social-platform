const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserService, userIdFor } = require('../cloudfunctions/userService/service');

// 材料为合成的 PNG 文件头与测试字节，不包含任何真实学生信息。
const proofBase64 = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32)]).toString('base64');
const application = (extra = {}) => ({ schoolName: '测试大学', realName: '测试同学', studentNumber: '00123456',
  proofBase64, requestId: 'test-request-00000001', ...extra });

function fixture({ ready = true, beforeTransaction, failUserUpdate = false, failUpload = false } = {}) {
  let tables = new Map([['users', new Map()], ['certification_applications', new Map()]]);
  const uploads = [];
  let tail = Promise.resolve();
  function collection(name, source, inTransaction = false) {
    assert.ok(source.has(name), '集合必须由部署者创建');
    const records = source.get(name);
    return {
      where: query => ({
        get: async () => ({ data: [...records.values()].filter(row => Object.entries(query).every(([k, v]) => row[k] === v)).map(row => ({ ...row })) }),
      }),
      add: async ({ data }) => {
        if (records.has(data._id)) throw new Error('duplicate');
        records.set(data._id, { ...data });
      },
      doc: id => ({
        get: async () => ({ data: records.has(id) ? { ...records.get(id) } : null }),
        set: async ({ data }) => { records.set(id, { ...data, _id: id }); },
        update: async ({ data }) => {
          if (inTransaction && name === 'users' && failUserUpdate) throw new Error('simulated write failure');
          assert.ok(records.has(id));
          records.set(id, { ...records.get(id), ...data });
        },
      }),
    };
  }
  const db = {
    collection: name => collection(name, tables),
    serverDate: () => '2026-11-14T10:00:00.000Z',
    async runTransaction(callback) {
      // 串行执行冲突事务，使用独立快照，回调失败时不提交任何文档。
      let release;
      const previous = tail;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        if (beforeTransaction) beforeTransaction(tables);
        const snapshot = new Map([...tables].map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, { ...row }]))]));
        const result = await callback({ collection: name => collection(name, snapshot, true) });
        // 保留 collection 引用所指向的 Map，模拟外部读在提交后可见新值。
        for (const [name, rows] of snapshot) {
          tables.get(name).clear();
          for (const [id, row] of rows) tables.get(name).set(id, row);
        }
        return { result, errMsg: 'runTransaction:ok' };
      } finally { release(); }
    },
  };
  const handle = createUserService(db, { proofStorageReady: ready,
    uploadProof: async options => {
      uploads.push(options);
      if (failUpload) throw new Error('upload unavailable');
      return 'cloud://test.bucket/' + options.cloudPath;
    } });
  const alice = { openid: 'alice', env: 'test' };
  const bob = { openid: 'bob', env: 'test' };
  return { handle, alice, bob, uploads, users: tables.get('users'), applications: tables.get('certification_applications'),
    async login(identity = alice) { return (await handle({ action: 'login' }, identity)).user; },
    submit(value = application(), identity = alice) { return handle({ action: 'submitCertification', application: value }, identity); },
  };
}

test('首次提交原子保存申请与待审核状态，保留资料、普通角色和空学校归属', async () => {
  const f = fixture();
  const user = await f.login();
  f.users.get(user._id).nickname = '原昵称';
  const result = await f.submit(application({ schoolName: ' 测试大学 ' }));
  assert.equal(result.success, true);
  assert.equal(result.certification.user.role, 'user');
  assert.equal(result.certification.user.schoolId, '');
  assert.equal(result.certification.user.certificationStatus, 'pending');
  assert.equal(result.certification.user.nickname, '原昵称');
  assert.equal(result.certification.application.studentNumber, '00123456');
  assert.equal(result.certification.application.schoolName, '测试大学');
  assert.equal(f.applications.size, 1);
  assert.equal(f.uploads.length, 1);
  assert.match(f.uploads[0].cloudPath, new RegExp(`^certification-proofs/${user._id}/[a-f0-9]{32}\\.png$`));
  assert.ok(Buffer.isBuffer(f.uploads[0].fileContent));
  const stored = [...f.applications.values()][0];
  assert.equal(stored.userId, user._id);
  assert.equal(stored.revision, 1);
  assert.equal(stored.status, 'pending');
  for (const key of ['proofFileID', 'requestId', 'fingerprint', 'reviewerId', 'userId']) {
    assert.equal(result.certification.application[key], undefined);
  }
  for (const key of ['realName', 'studentNumber', 'proofBase64']) assert.equal(result.certification.user[key], undefined);
});

test('查询仅返回当前账号申请，伪造 ID、openid 和 role 无法读取他人材料', async () => {
  const f = fixture();
  await f.login(); await f.submit(); await f.login(f.bob);
  const result = await f.handle({ action: 'getCertification', userId: userIdFor('alice'), openid: 'alice', role: 'admin' }, f.bob);
  assert.equal(result.success, true);
  assert.equal(result.certification.application, null);
  assert.equal((await f.handle({ action: 'getCertification' }, f.alice)).certification.application.status, 'pending');
});

test('待审核重复提交被拒绝，同一请求网络重试返回原申请且不再次上传', async () => {
  const f = fixture(); await f.login(); await f.submit();
  assert.equal((await f.submit()).success, true);
  assert.equal((await f.submit(application({ requestId: 'test-request-00000002' }))).code, 'CERTIFICATION_PENDING');
  assert.equal((await f.submit(application({ realName: '另一同学' }))).code, 'CERTIFICATION_PENDING');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.applications.size, 1);
  assert.equal([...f.applications.values()][0].realName, '测试同学');
});

test('并发首次提交只保留一个申请，不覆盖胜出的材料', async () => {
  const f = fixture(); await f.login();
  const results = await Promise.all([f.submit(), f.submit(application({ requestId: 'test-request-00000002', realName: '另一同学' }))]);
  assert.equal(results.filter(r => r.success).length, 1);
  assert.equal(results.filter(r => r.code === 'CERTIFICATION_PENDING').length, 1);
  assert.equal(f.applications.size, 1);
  assert.equal([...f.applications.values()][0].revision, 1);
  assert.equal(f.users.get(userIdFor('alice')).certificationStatus, 'pending');
});

test('相同请求并发提交均可确认原记录，申请版本不会增加', async () => {
  const f = fixture(); await f.login();
  const results = await Promise.all([f.submit(), f.submit()]);
  assert.ok(results.every(r => r.success));
  assert.equal(f.applications.size, 1);
  assert.equal([...f.applications.values()][0].revision, 1);
});

test('任一数据库写入失败时事务全部回滚，上传失败也不会写待审核', async () => {
  for (const options of [{ failUserUpdate: true }, { failUpload: true }]) {
    const f = fixture(options); await f.login();
    const result = await f.submit();
    assert.equal(result.code, 'SERVICE_ERROR');
    assert.equal(f.applications.size, 0);
    assert.equal(f.users.get(userIdFor('alice')).certificationStatus, 'unverified');
  }
});

test('存储未配置时禁止真实材料上传，查询空申请仍正常', async () => {
  const f = fixture({ ready: false }); await f.login();
  assert.equal((await f.submit()).code, 'CERTIFICATION_NOT_READY');
  assert.equal(f.uploads.length, 0);
  assert.equal((await f.handle({ action: 'getCertification' }, f.alice)).certification.application, null);
});

test('未建档、无可信身份、管理员及封禁账号不能提交，前端 role 无法越权', async () => {
  const f = fixture();
  assert.equal((await f.submit()).code, 'NOT_REGISTERED');
  assert.equal((await f.submit(application(), {})).code, 'UNAUTHENTICATED');
  await f.login();
  f.users.get(userIdFor('alice')).role = 'admin';
  assert.equal((await f.submit()).code, 'FORBIDDEN');
  assert.equal((await f.handle({ action: 'getCertification' }, f.alice)).code, 'FORBIDDEN');
  f.users.get(userIdFor('alice')).status = 'banned';
  assert.equal((await f.submit()).code, 'ACCOUNT_DISABLED');
  assert.equal(f.uploads.length, 0);
});

test('上传期间被封禁或提升为管理员，事务重读权限并拒绝保存', async () => {
  for (const changes of [{ status: 'banned' }, { role: 'admin' }]) {
    const f = fixture({ beforeTransaction: tables => Object.assign(tables.get('users').get(userIdFor('alice')), changes) });
    await f.login();
    assert.equal((await f.submit()).code, changes.status ? 'ACCOUNT_DISABLED' : 'FORBIDDEN');
    assert.equal(f.applications.size, 0);
  }
});

test('已认证账号拒绝重复申请，异常状态不能绕过', async () => {
  const f = fixture(); await f.login();
  const user = f.users.get(userIdFor('alice'));
  user.certificationStatus = 'approved';
  assert.equal((await f.submit()).code, 'ALREADY_CERTIFIED');
  user.certificationStatus = 'pending';
  assert.equal((await f.submit()).code, 'CERTIFICATION_STATE_ERROR');
  user.certificationStatus = 'unknown';
  assert.equal((await f.submit()).code, 'CERTIFICATION_STATE_ERROR');
  assert.equal(f.uploads.length, 0);
});

test('认证表单拒绝空值、超长值、非法学号及伪造审核字段', async () => {
  const f = fixture(); await f.login();
  for (const invalid of [null, [], application({ schoolName: '' }), application({ realName: '\n' }),
    application({ schoolName: '学'.repeat(61) }), application({ studentNumber: '12' }),
    application({ studentNumber: '12 345' }), application({ requestId: '../escape' }),
    application({ role: 'student' }), application({ status: 'approved' }), application({ userId: userIdFor('bob') })]) {
    assert.equal((await f.submit(invalid)).code, 'INVALID_CERTIFICATION');
  }
  assert.equal(f.uploads.length, 0);
});

test('材料拒绝超限、非图片、外链和非法 Base64；接受 JPG 文件头', async () => {
  const f = fixture(); await f.login();
  const huge = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(1024 * 1024)]).toString('base64');
  for (const proofBase64 of ['', 'https://example.com/photo.png', 'YWJj?', Buffer.from('not an image file').toString('base64'), huge]) {
    assert.equal((await f.submit(application({ proofBase64 }))).code, 'INVALID_PROOF');
  }
  const jpeg = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(32)]).toString('base64');
  assert.equal((await f.submit(application({ proofBase64: jpeg }))).success, true);
  assert.match(f.uploads[0].cloudPath, /\.jpg$/);
});

test('驳回后的重提更新同一槽位，重置审核信息而不改变原来的学校归属和账号角色', async () => {
  const f = fixture(); await f.login(); await f.submit();
  const existing = [...f.applications.values()][0];
  Object.assign(existing, { status: 'rejected', rejectionReason: '材料不清晰', reviewerId: 'reviewer', reviewedAt: 'old-date' });
  Object.assign(f.users.get(userIdFor('alice')), { certificationStatus: 'rejected' });
  const result = await f.submit(application({ requestId: 'test-request-00000002', schoolName: '另一测试大学' }));
  assert.equal(result.success, true);
  assert.equal(f.applications.size, 1);
  const latest = [...f.applications.values()][0];
  assert.equal(latest.revision, 2);
  assert.equal(latest.rejectionReason, '');
  assert.equal(latest.reviewerId, '');
  assert.equal(latest.reviewedAt, null);
  assert.equal(latest.createdAt, existing.createdAt);
  assert.equal(result.certification.user.role, 'user');
  assert.equal(result.certification.user.schoolId, '');
});
