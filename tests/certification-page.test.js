const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const user = (extra = {}) => ({ _id: 'test-user', role: 'user', certificationStatus: 'unverified', ...extra });
const pending = () => ({ user: user({ certificationStatus: 'pending' }), application: {
  _id: 'cert_test-user', schoolName: '闽南科技学院', realName: '测试同学', studentNumber: '001234',
  status: 'pending', revision: 1, hasProof: true, submittedAt: '2026-11-14T10:00:00Z',
} });
const formEvent = () => ({ detail: { value: { schoolName: ' 闽南科技学院 ', realName: '测试同学', studentNumber: '001234' } } });

test('认证介绍直接使用会话状态，后台刷新不打断已经选择学校的步骤', async () => {
  let resolve;
  const f = fixture({ cachedUser: user(), query: () => new Promise(done => { resolve = done; }) });
  const loading = f.page.loadApplication(false);
  assert.equal(f.page.data.loading, false);
  f.page.beginCertification();
  f.page.selectSchool();
  f.page.continueSchool();
  assert.equal(f.page.data.stage, 'proof');
  f.page.setData({ realName: '草稿姓名' });
  await new Promise(setImmediate);
  resolve({ user: user(), application: null });
  await loading;
  assert.equal(f.page.data.stage, 'proof');
  assert.equal(f.page.data.realName, '草稿姓名');
});

function fixture({ signedIn = user(), cachedUser = null, cachedCertification = null, query, save, withdraw, confirm = true, modal,
  mediaError, largeImage = false, compressionError = false, previousPages = [], deferRender = false } = {}) {
  const submissions = [];
  const toasts = [];
  const selections = [];
  const withdrawals = [], confirmations = [];
  let definition, page;
  const backCalls = [], tabCalls = [], renderTasks = [];
  const service = {
    getCachedUser: () => cachedUser, getCachedCertification: () => cachedCertification,
    restore: async () => signedIn,
    getCertification: async () => query ? query() : { user: signedIn, application: null },
    submitCertification: async value => {
      submissions.push(value);
      return save ? save(value) : pending();
    },
    withdrawCertification: async (id, revision, status) => {
      withdrawals.push({ id, revision, status });
      return withdraw ? withdraw() : { user: user(), application: null };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/certification/index.js'), 'utf8'), {
    Page: value => { definition = value; }, require: () => service,
    getCurrentPages: () => [...previousPages, page],
    wx: {
      chooseMedia(options) {
        selections.push(options);
        if (mediaError) options.fail(mediaError);
        else options.success({ tempFiles: [{ tempFilePath: '/tmp/proof.png' }] });
      },
      getImageInfo: options => options.success({ type: 'png', width: 1200, height: 800 }),
      compressImage: options => compressionError ? options.fail({ errMsg: 'not supported' }) : options.success({ tempFilePath: '/tmp/compressed.png' }),
      getFileSystemManager: () => ({ readFile: options => options.success({ data: largeImage ? 'A'.repeat(1400000) : 'aW1hZ2U=' }) }),
      showToast: options => toasts.push(options.title), switchTab: options => tabCalls.push(options), previewImage() {},
      navigateBack: options => backCalls.push(options),
      nextTick: callback => { if (deferRender) renderTasks.push(callback); else callback(); },
      showModal: options => { confirmations.push(options); if (modal) modal(options); else options.success({ confirm }); },
    },
  });
  page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
  return { page, submissions, toasts, selections, withdrawals, confirmations, backCalls, tabCalls, renderTasks };
}

test('从侧栏认证返回时先恢复被覆盖的首页，提交视图后只执行一次原生返回', async () => {
  let prepared = 0;
  const home = { prepareMenuReturn() { prepared++; } };
  const f = fixture({ cachedUser: user(), previousPages: [home], deferRender: true });
  await f.page.onLoad();
  f.page.backStep(); f.page.backStep();
  assert.equal(prepared, 1);
  assert.equal(f.backCalls.length, 0); assert.equal(f.renderTasks.length, 1);
  f.renderTasks.shift()();
  assert.equal(f.backCalls.length, 1); assert.equal(f.tabCalls.length, 0);
  f.page.onUnload(); assert.equal(prepared, 1);
});

test('认证从个人主页进入仍返回个人主页，独立入口不先尝试无效返回，系统卸载也恢复侧栏底页', async () => {
  const profile = fixture({ previousPages: [{ route: 'pages/profile/index' }] });
  await profile.page.onLoad(); profile.page.backToProfile();
  assert.equal(profile.backCalls.length, 1); assert.equal(profile.tabCalls.length, 0);
  const single = fixture(); await single.page.onLoad(); single.page.backToProfile();
  assert.equal(single.backCalls.length, 0); assert.equal(single.tabCalls[0].url, '/pages/home/index');
  let prepared = 0;
  const nativeBack = fixture({ previousPages: [{ prepareMenuReturn() { prepared++; } }] });
  await nativeBack.page.onLoad(); nativeBack.page.onUnload();
  assert.equal(prepared, 1);
});

async function fill(f) {
  await f.page.loadApplication();
  f.page.selectSchool();
  await f.page.chooseProof();
  f.page.onAgreementChange({ detail: { value: ['agree'] } });
}

test('认证流程从介绍开始，选择唯一学校后才可进入材料页，返回不丢草稿', async () => {
  const f = fixture(); await f.page.loadApplication();
  assert.equal(f.page.data.stage, 'intro');
  f.page.beginCertification();
  assert.equal(f.page.data.stage, 'school');
  f.page.continueSchool();
  assert.equal(f.page.data.stage, 'school');
  f.page.openSchoolSearch();
  assert.equal(f.page.data.stage, 'search');
  assert.equal(f.page.data.hasSchoolResult, false);
  f.page.onSchoolSearch({ detail: { value: '闽南' } });
  assert.equal(f.page.data.hasSchoolResult, true);
  assert.equal(f.page.data.matchText, '闽南');
  assert.equal(f.page.data.matchAfter, '科技学院');
  f.page.selectSchool();
  assert.equal(f.page.data.schoolName, '闽南科技学院');
  assert.equal(f.page.data.stage, 'school');
  f.page.continueSchool();
  assert.equal(f.page.data.stage, 'proof');
  assert.equal(f.page.data.navTitle, '身份认证');
  await f.page.chooseProof();
  f.page.onFieldInput({ currentTarget: { dataset: { field: 'realName' } }, detail: { value: '测试同学' } });
  f.page.backStep(); f.page.continueSchool();
  assert.equal(f.page.data.proofPath, '/tmp/compressed.png');
  assert.equal(f.page.data.realName, '测试同学');
  assert.equal(f.submissions.length, 0);
});

test('搜索没有其他学校，清空及取消不更改已选学校', async () => {
  const f = fixture(); await f.page.loadApplication(); f.page.selectSchool(); f.page.openSchoolSearch();
  for (const value of ['清华', '闽南师范大学', '科技大学', '<script>', '   ']) {
    f.page.onSchoolSearch({ detail: { value } });
    assert.equal(f.page.data.hasSchoolResult, false);
  }
  f.page.onSchoolSearch({ detail: { value: '  闽南科技学院  ' } });
  assert.equal(f.page.data.hasSchoolResult, true);
  assert.equal(f.page.data.matchText, '闽南科技学院');
  f.page.clearSchoolSearch();
  assert.equal(f.page.data.schoolQuery, '');
  assert.equal(f.page.data.hasSchoolResult, false);
  f.page.cancelSchoolSearch();
  assert.equal(f.page.data.stage, 'school');
  assert.equal(f.page.data.schoolName, '闽南科技学院');
});

test('待审核及已通过的申请进入状态页，不允许绕到新申请流程', async () => {
  for (const status of ['pending', 'approved']) {
    const record = pending(); record.user.certificationStatus = status; record.application.status = status;
    const f = fixture({ query: () => record }); await f.page.loadApplication();
    assert.equal(f.page.data.stage, 'status');
    f.page.beginCertification(); f.page.openSchoolSearch(); f.page.selectSchool(); f.page.continueSchool();
    assert.equal(f.page.data.stage, 'status');
    assert.equal(f.submissions.length, 0);
  }
});

test('伪造表单学校不能绕过选择，学校不匹配时不提交材料', async () => {
  const f = fixture(); await fill(f);
  const event = formEvent(); event.detail.value.schoolName = '其他大学';
  await f.page.submit(event);
  assert.equal(f.submissions.length, 0);
  assert.match(f.page.data.error, /闽南科技学院/);
});

test('旧版其他学校驳回申请可查看，重新申请仍需重新选择当前可用学校', async () => {
  const record = pending(); record.application.schoolName = '历史测试大学';
  record.user.certificationStatus = 'rejected'; record.application.status = 'rejected';
  const f = fixture({ query: () => record }); await f.page.loadApplication();
  assert.equal(f.page.data.stage, 'intro');
  assert.equal(f.page.data.application.schoolName, '历史测试大学');
  f.page.beginCertification(); f.page.continueSchool();
  assert.equal(f.page.data.stage, 'school');
  f.page.selectSchool(); f.page.continueSchool();
  assert.equal(f.page.data.stage, 'proof');
});

test('取消申请后返回认证介绍并清空学校搜索，忙碌时不能切换步骤', async () => {
  const f = fixture({ query: pending }); await f.page.loadApplication();
  f.page.onSchoolSearch({ detail: { value: '闽南' } });
  await f.page.withdraw();
  assert.equal(f.page.data.stage, 'intro');
  assert.equal(f.page.data.schoolQuery, '');
  assert.equal(f.page.data.hasSchoolResult, false);
  f.page.data.saving = true;
  f.page.beginCertification(); f.page.backStep();
  assert.equal(f.page.data.stage, 'intro');
});

test('未认证账号可填写申请；图片内容仅存在内存，提交成功后清空并显示审核中', async () => {
  const f = fixture(); await fill(f);
  assert.equal(f.page.data.canApply, true);
  assert.equal(f.page.data.proofPath, '/tmp/compressed.png');
  assert.equal(f.page.data.proofBase64, undefined);
  await f.page.submit(formEvent());
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].schoolName, '闽南科技学院');
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

test('认证信息仅生成姓名末字和学号末三位的展示值，不改变原申请与重提资料', async () => {
  const record = pending(); record.application.status = 'approved'; record.user.certificationStatus = 'approved';
  record.application.realName = '测试同学'; record.application.studentNumber = '001234567';
  const f = fixture({ query: () => record }); await f.page.loadApplication();
  assert.equal(f.page.data.maskedRealName, '***学');
  assert.equal(f.page.data.maskedStudentNumber, '******567');
  assert.equal(f.page.data.application.realName, '测试同学');
  assert.equal(f.page.data.realName, '测试同学');
  assert.equal(f.page.data.application.studentNumber, '001234567');
  await f.page.withdraw();
  assert.equal(f.page.data.maskedRealName, '');
  assert.equal(f.page.data.maskedStudentNumber, '');
});

test('短姓名和学号不会误删末尾字符，空值不显示 undefined', () => {
  const f = fixture();
  for (const [realName, studentNumber, expectedName, expectedNumber] of [
    ['罗凯', '123123', '*凯', '***123'], ['单', '012', '单', '012'], ['𠮷同学', '01', '**学', '01'], ['', '', '—', '—'],
  ]) {
    const record = pending(); Object.assign(record.application, { realName, studentNumber });
    f.page.showCertification(record);
    assert.equal(f.page.data.maskedRealName, expectedName);
    assert.equal(f.page.data.maskedStudentNumber, expectedNumber);
  }
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
  f.page.selectSchool();
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
  assert.equal(f.page.data.schoolName, '闽南科技学院');
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
  assert.equal(f.page.data.schoolName, '闽南科技学院');
  assert.equal(f.page.data.proofPath, '');
  await f.page.submit(formEvent());
  assert.match(f.page.data.error, /图片/);
  const broken = fixture({ query: () => ({ user: user(), application: pending().application }) });
  await broken.page.loadApplication();
  assert.equal(broken.page.data.canApply, false);
  assert.match(broken.page.data.error, /异常/);
});

test('取消待审核申请需确认，成功后清空草稿及旧请求标识并开放重新申请', async () => {
  const f = fixture({ query: pending }); await f.page.loadApplication();
  f.page._submission = { requestId: 'old-request' }; f.page._proofBase64 = 'old-proof';
  assert.equal(f.page.data.canWithdraw, true);
  await f.page.withdraw();
  assert.equal(f.confirmations[0].title, '取消认证申请');
  assert.deepEqual(f.withdrawals, [{ id: 'cert_test-user', revision: 1, status: 'pending' }]);
  assert.equal(f.page.data.stateText, '未认证'); assert.equal(f.page.data.canApply, true);
  assert.equal(f.page.data.application, null); assert.equal(f.page.data.canWithdraw, false);
  assert.equal(f.page.data.schoolName, ''); assert.equal(f.page.data.realName, '');
  assert.equal(f.page.data.studentNumber, ''); assert.equal(f.page._submission, null);
  assert.equal(f.page._proofBase64, ''); assert.deepEqual(f.toasts, ['申请已取消']);
});

test('通过后撤回认证明确提示失去学生身份，确认后使用已通过状态发请求', async () => {
  const approved = pending();
  approved.user = user({ role: 'student', certificationStatus: 'approved', schoolId: 'school-test' });
  approved.application.status = 'approved';
  const f = fixture({ signedIn: approved.user, query: () => approved });
  await f.page.loadApplication(); await f.page.withdraw();
  assert.equal(f.confirmations[0].title, '撤回学校认证');
  assert.match(f.confirmations[0].content, /普通用户/);
  assert.equal(f.withdrawals[0].status, 'approved');
  assert.equal(f.page.data.user.role, 'user'); assert.equal(f.page.data.canApply, true);
  assert.deepEqual(f.toasts, ['认证已撤回']);
});

test('取消确认和重复点击均不产生多次撤回，确认窗口打开期间不能刷新或提交', async () => {
  const cancel = fixture({ query: pending, confirm: false });
  await cancel.page.loadApplication(); await cancel.page.withdraw();
  assert.equal(cancel.withdrawals.length, 0); assert.equal(cancel.page.data.confirmingWithdrawal, false);
  let confirmation;
  const f = fixture({ query: pending, modal: value => { confirmation = value; } });
  await f.page.loadApplication();
  const first = f.page.withdraw();
  await f.page.withdraw(); await f.page.loadApplication(); await f.page.submit(formEvent());
  assert.equal(f.confirmations.length, 1); assert.equal(f.withdrawals.length, 0); assert.equal(f.submissions.length, 0);
  confirmation.success({ confirm: true }); await first;
  assert.equal(f.withdrawals.length, 1);
});

test('撤回响应超时但查询已成功时显示未认证，不重复执行撤回', async () => {
  let committed = false;
  const f = fixture({ query: () => committed ? { user: user(), application: null } : pending(),
    withdraw: () => { committed = true; throw new Error('超时'); } });
  await f.page.loadApplication(); await f.page.withdraw();
  assert.equal(f.withdrawals.length, 1); assert.equal(f.page.data.canApply, true);
  assert.equal(f.page.data.error, ''); assert.deepEqual(f.toasts, ['申请已取消']);
});

test('撤回与确认查询都失败时阻止再次操作，重新刷新成功后才允许重新确认', async () => {
  let offline = false;
  const f = fixture({ query: () => { if (offline) throw new Error('离线'); return pending(); },
    withdraw: () => { offline = true; throw new Error('超时'); } });
  await f.page.loadApplication(); await f.page.withdraw();
  assert.equal(f.page.data.withdrawalBlocked, true); assert.match(f.page.data.error, /尚未确认/);
  await f.page.withdraw(); assert.equal(f.withdrawals.length, 1);
  offline = false; await f.page.loadApplication();
  assert.equal(f.page.data.withdrawalBlocked, false); assert.equal(f.page.data.canWithdraw, true);
});

test('管理员先通过时只刷新为已认证，不能把取消申请自动升级成撤回已认证身份', async () => {
  let approved = false;
  const f = fixture({ query: () => {
    const value = pending();
    if (approved) { value.user.certificationStatus = 'approved'; value.user.role = 'student'; value.application.status = 'approved'; }
    return value;
  }, withdraw: () => { approved = true; throw Object.assign(new Error('认证状态已变化'), { code: 'CERTIFICATION_CHANGED' }); } });
  await f.page.loadApplication(); await f.page.withdraw();
  assert.equal(f.withdrawals.length, 1); assert.equal(f.withdrawals[0].status, 'pending');
  assert.equal(f.page.data.stateText, '已认证'); assert.equal(f.page.data.canApply, false);
  assert.match(f.page.data.error, /状态已变化/); assert.deepEqual(f.toasts, []);
});

test('撤回期间退出账号或卸载页面，不显示迟到成功消息和旧资料', async () => {
  const denied = fixture({ query: pending, withdraw: () => {
    throw Object.assign(new Error('登录状态已变更'), { code: 'UNAUTHENTICATED' });
  } });
  await denied.page.loadApplication(); await denied.page.withdraw();
  assert.equal(denied.page.data.user, null); assert.equal(denied.page.data.application, null);
  assert.equal(denied.page.data.canWithdraw, false);
  let resolve;
  const f = fixture({ query: pending, withdraw: () => new Promise(done => { resolve = done; }) });
  await f.page.loadApplication();
  const request = f.page.withdraw(); await new Promise(done => setImmediate(done));
  f.page.onUnload(); resolve({ user: user(), application: null }); await request;
  assert.deepEqual(f.toasts, []);
});

test('撤回超时后的确认查询发现退出登录，会清空认证详情和姓名学号', async () => {
  let attempted = false;
  const f = fixture({ query: () => {
    if (attempted) throw Object.assign(new Error('请重新登录'), { code: 'UNAUTHENTICATED' });
    return pending();
  }, withdraw: () => { attempted = true; throw new Error('超时'); } });
  await f.page.loadApplication(); await f.page.withdraw();
  assert.equal(f.page.data.user, null); assert.equal(f.page.data.application, null);
  assert.equal(f.page.data.realName, ''); assert.equal(f.page.data.studentNumber, '');
  assert.equal(f.page.data.canApply, false); assert.equal(f.page.data.canWithdraw, false);
});

test('另一窗口已撤回的旧提交重试，不保留已经失效的提交标识', async () => {
  const f = fixture({ save: () => {
    throw Object.assign(new Error('这次申请已撤回，请重新填写并提交'), { code: 'CERTIFICATION_WITHDRAWN' });
  } });
  await fill(f); await f.page.submit(formEvent());
  assert.equal(f.page.data.canApply, true); assert.equal(f.page._submission, null);
  assert.equal(f.page._proofBase64, ''); assert.match(f.page.data.error, /已撤回/);
});
