const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const user = (extra = {}) => ({ _id: 'test-user', role: 'user', certificationStatus: 'unverified', ...extra });
const pending = () => ({ user: user({ certificationStatus: 'pending' }), application: {
  _id: 'cert_test-user', schoolName: '测试大学', realName: '测试同学', studentNumber: '001234',
  status: 'pending', hasProof: true, submittedAt: '2026-11-14T10:00:00Z',
} });
const formEvent = () => ({ detail: { value: { schoolName: ' 测试大学 ', realName: '测试同学', studentNumber: '001234' } } });

function fixture({ signedIn = user(), query, save, mediaError, largeImage = false, compressionError = false } = {}) {
  const submissions = [];
  const toasts = [];
  const selections = [];
  let definition;
  const service = {
    restore: async () => signedIn,
    getCertification: async () => query ? query() : { user: signedIn, application: null },
    submitCertification: async value => {
      submissions.push(value);
      return save ? save(value) : pending();
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/certification/index.js'), 'utf8'), {
    Page: value => { definition = value; }, require: () => service,
    wx: {
      chooseMedia(options) {
        selections.push(options);
        if (mediaError) options.fail(mediaError);
        else options.success({ tempFiles: [{ tempFilePath: '/tmp/proof.png' }] });
      },
      getImageInfo: options => options.success({ type: 'png', width: 1200, height: 800 }),
      compressImage: options => compressionError ? options.fail({ errMsg: 'not supported' }) : options.success({ tempFilePath: '/tmp/compressed.png' }),
      getFileSystemManager: () => ({ readFile: options => options.success({ data: largeImage ? 'A'.repeat(1400000) : 'aW1hZ2U=' }) }),
      showToast: options => toasts.push(options.title), switchTab() {}, previewImage() {},
    },
  });
  const page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
  return { page, submissions, toasts, selections };
}

async function fill(f) {
  await f.page.loadApplication();
  await f.page.chooseProof();
  f.page.onAgreementChange({ detail: { value: ['agree'] } });
}

test('未认证账号可填写申请；图片内容仅存在内存，提交成功后清空并显示审核中', async () => {
  const f = fixture(); await fill(f);
  assert.equal(f.page.data.canApply, true);
  assert.equal(f.page.data.proofPath, '/tmp/compressed.png');
  assert.equal(f.page.data.proofBase64, undefined);
  await f.page.submit(formEvent());
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].schoolName, '测试大学');
  assert.equal(f.submissions[0].studentNumber, '001234');
  assert.ok(f.submissions[0].proofBase64);
  assert.match(f.submissions[0].requestId, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(f.page.data.stateText, '审核中');
  assert.equal(f.page.data.canApply, false);
  assert.equal(f.page.data.proofPath, '');
  assert.equal(f.page._proofBase64, '');
  assert.deepEqual(f.toasts, ['申请已提交']);
  assert.equal(f.page.data.user.role, 'user');
});

test('已有待审核申请仅显示详情，重复点击提交不会再次发送', async () => {
  const f = fixture({ query: pending }); await f.page.loadApplication();
  assert.equal(f.page.data.application.hasProof, true);
  await f.page.chooseProof(); await f.page.submit(formEvent());
  assert.equal(f.submissions.length, 0);
  assert.equal(f.selections.length, 0);
});

test('未登录、管理员和读取失败不展示申请表，不误报成未认证', async () => {
  for (const options of [{ signedIn: null }, { signedIn: user({ role: 'admin' }) },
    { query: async () => { throw new Error('连接失败'); } }]) {
    const f = fixture(options); await f.page.loadApplication();
    assert.equal(f.page.data.user, null);
    assert.equal(f.page.data.canApply, false);
    assert.ok(f.page.data.error);
    await f.page.submit(formEvent());
    assert.equal(f.submissions.length, 0);
  }
});

test('拒绝无图片、未确认用途和不合法输入，不发送个人信息', async () => {
  const f = fixture(); await f.page.loadApplication();
  await f.page.submit(formEvent());
  assert.match(f.page.data.error, /图片/);
  await f.page.chooseProof(); await f.page.submit(formEvent());
  assert.match(f.page.data.error, /用途/);
  f.page.onAgreementChange({ detail: { value: ['agree'] } });
  const invalid = formEvent(); invalid.detail.value.studentNumber = '12 34';
  await f.page.submit(invalid);
  assert.match(f.page.data.error, /学号/);
  assert.equal(f.submissions.length, 0);
});

test('取消选图保留原材料，压缩后仍超大时拒绝材料，不支持压缩时可用小原图', async () => {
  const cancelled = fixture({ mediaError: { errMsg: 'chooseMedia:fail cancel' } });
  await cancelled.page.loadApplication();
  cancelled.page._proofBase64 = 'original'; cancelled.page.data.proofPath = '/tmp/original.png';
  await cancelled.page.chooseProof();
  assert.equal(cancelled.page.data.error, '');
  assert.equal(cancelled.page._proofBase64, 'original');
  const large = fixture({ largeImage: true }); await large.page.loadApplication(); await large.page.chooseProof();
  assert.match(large.page.data.error, /1MB/);
  assert.equal(large.page.data.proofPath, '');
  const unsupported = fixture({ compressionError: true }); await unsupported.page.loadApplication(); await unsupported.page.chooseProof();
  assert.equal(unsupported.page.data.proofPath, '/tmp/proof.png');
});

test('提交超时后查询到已保存申请时显示审核中，不重复提交或显示失败', async () => {
  let committed = false;
  const f = fixture({ query: () => committed ? pending() : { user: user(), application: null },
    save: () => { committed = true; throw new Error('连接超时'); } });
  await fill(f); await f.page.submit(formEvent());
  assert.equal(f.page.data.stateText, '审核中');
  assert.equal(f.page.data.error, '');
  assert.deepEqual(f.toasts, []);
  assert.equal(f.page.data.saving, false);
});

test('提交与确认查询均失败时保留草稿与提交标识，重试期间禁止重复点击', async () => {
  let failed = false;
  let release;
  const f = fixture({ query: () => {
    if (failed) throw new Error('连接失败');
    return { user: user(), application: null };
  }, save: () => new Promise((resolve, reject) => { release = () => { failed = true; reject(new Error('连接失败')); }; }) });
  await fill(f);
  const request = f.page.submit(formEvent());
  await f.page.submit(formEvent());
  assert.equal(f.submissions.length, 1);
  release(); await request;
  assert.equal(f.page.data.canApply, true);
  assert.equal(f.page.data.schoolName, '测试大学');
  assert.ok(f.page._proofBase64);
  const firstId = f.submissions[0].requestId;
  const retry = f.page.submit(formEvent());
  assert.equal(f.submissions[1].requestId, firstId);
  release(); await retry;
  assert.deepEqual(f.toasts, []);
});

test('驳回时预填原信息但必须重新选择材料；身份不一致时不开放表单', async () => {
  const rejected = pending();
  rejected.application.status = 'rejected'; rejected.application.rejectionReason = '图片不清晰';
  rejected.user.certificationStatus = 'rejected';
  const f = fixture({ query: () => rejected }); await f.page.loadApplication();
  assert.equal(f.page.data.canApply, true);
  assert.equal(f.page.data.schoolName, '测试大学');
  assert.equal(f.page.data.proofPath, '');
  await f.page.submit(formEvent());
  assert.match(f.page.data.error, /图片/);
  const broken = fixture({ query: () => ({ user: user(), application: pending().application }) });
  await broken.page.loadApplication();
  assert.equal(broken.page.data.canApply, false);
  assert.match(broken.page.data.error, /异常/);
});
