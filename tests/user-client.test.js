const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('AI额度复用会话缓存并合并查询，生成完成后失效，旧查询不能覆盖新用量', async () => {
  const pending = [];
  const f = clientFixture(({ data }) => data.action === 'login' ? Promise.resolve({ result: { success: true, user: { _id: 'alice' } } }) : new Promise(resolve => pending.push(resolve)));
  await f.service.login();
  const first = f.service.getAIUsage(), second = f.service.getAIUsage();
  assert.equal(pending.length, 1);
  const value = usedPercent => ({ day: '2050-01-01', usedPercent, resetsAt: '2050-01-02T00:00:00Z' });
  pending.shift()({ result: { success: true, aiUsage: value(1) } });
  assert.equal((await first).usedPercent, 1); assert.equal((await second).usedPercent, 1);
  await f.service.getAIUsage(); assert.equal(pending.length, 0);
  const old = f.service.getAIUsage({ force: true });
  f.service.invalidateAIUsage();
  const fresh = f.service.getAIUsage(); assert.equal(pending.length, 2);
  pending[1]({ result: { success: true, aiUsage: value(5) } }); await fresh;
  pending[0]({ result: { success: true, aiUsage: value(2) } }); await old;
  assert.equal(f.service.getCachedAIUsage().usedPercent, 5);
});

test('AI额度退出登录后清理并忽略迟到响应，跨过重置时间不展示昨天额度', async () => {
  let resolve;
  let clock = Date.parse('2050-01-01T15:59:59Z');
  class Clock extends Date { static now() { return clock; } }
  const f = clientFixture(({ data }) => data.action === 'login' ? Promise.resolve({ result: { success: true, user: { _id: 'alice' } } }) : new Promise(done => { resolve = done; }), { Date: Clock });
  await assert.rejects(f.service.getAIUsage(), error => error.code === 'UNAUTHENTICATED');
  await f.service.login();
  const request = f.service.getAIUsage();
  resolve({ result: { success: true, aiUsage: { usedPercent: 90, resetsAt: '2050-01-01T16:00:00Z' } } }); await request;
  assert.equal(f.service.getCachedAIUsage().usedPercent, 90);
  clock += 2000; assert.equal(f.service.getCachedAIUsage(), null);
  const late = f.service.getAIUsage(); f.service.logout();
  resolve({ result: { success: true, aiUsage: { usedPercent: 0, resetsAt: '2050-01-02T16:00:00Z' } } });
  await assert.rejects(late, /登录状态已变更/); assert.equal(f.service.getCachedAIUsage(), null);
});

function clientFixture(callFunction, options = {}) {
  const storage = new Map();
  const app = { globalData: { currentUser: null } };
  const requests = [];
  const context = {
    module: { exports: {} }, console, Date: options.Date || Date,
    getApp: () => app,
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
      cloud: { callFunction: args => { requests.push(args); return callFunction(args); } },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/services/user.js'), 'utf8'), context);
  return { service: context.module.exports, storage, app, requests };
}

test('ID搜索要求登录，传递8位ID并忽略退出后的迟到结果', async () => {
  let resolveSearch;
  const f = clientFixture(({ data }) => data.action === 'login'
    ? Promise.resolve({ result: { success: true, user: { _id: 'alice', accountId: '12345678' } } })
    : new Promise(resolve => { resolveSearch = resolve; }));
  await assert.rejects(f.service.findUserByAccountId('87654321'), /请先登录/);
  assert.equal(f.requests.length, 0);
  await f.service.login();
  const pending = f.service.findUserByAccountId('87654321');
  assert.equal(f.requests[1].data.action, 'findUserByAccountId');
  assert.equal(f.requests[1].data.accountId, '87654321');
  f.service.logout();
  resolveSearch({ result: { success: true, searchResult: { _id: 'bob', accountId: '87654321' } } });
  await assert.rejects(pending, /登录状态已变更/);
  assert.equal(f.app.globalData.currentUser, null);
});

test('账号信息要求登录并读取云端数据，退出后的迟到响应不能恢复旧账号', async () => {
  let resolveInfo;
  const f = clientFixture(({ data }) => data.action === 'login'
    ? Promise.resolve({ result: { success: true, user: { _id: 'alice' } } })
    : new Promise(resolve => { resolveInfo = resolve; }));
  await assert.rejects(f.service.getAccountInfo(), error => error.code === 'UNAUTHENTICATED');
  assert.equal(f.requests.length, 0);
  await f.service.login();
  const pending = f.service.getAccountInfo();
  assert.equal(f.requests[1].data.action, 'getAccountInfo');
  f.service.logout();
  resolveInfo({ result: { success: true, accountInfo: { user: { _id: 'alice' }, nicknameHistory: { changeCount: 3 } } } });
  await assert.rejects(pending, /登录状态已变更/);
  assert.equal(f.app.globalData.currentUser, null);
});

test('账号信息读取同步真实资料，云端封禁后清理登录状态', async () => {
  let banned = false;
  const f = clientFixture(async ({ data }) => ({ result: banned
    ? { success: false, code: 'ACCOUNT_DISABLED', message: '账号已停用' }
    : data.action === 'login' ? { success: true, user: { _id: 'alice' } }
      : { success: true, accountInfo: { user: { _id: 'alice', nickname: '真实昵称' }, nicknameHistory: { changeCount: 2 } } } }));
  await f.service.login();
  assert.equal((await f.service.getAccountInfo()).nicknameHistory.changeCount, 2);
  assert.equal(f.app.globalData.currentUser.nickname, '真实昵称');
  banned = true;
  await assert.rejects(f.service.getAccountInfo(), error => error.code === 'ACCOUNT_DISABLED');
  assert.equal(f.app.globalData.currentUser, null);
});

test('封面保存要求已登录；退出后的迟到响应不恢复旧封面或旧账号', async () => {
  let resolveCover;
  const f = clientFixture(({ data }) => data.action === 'login'
    ? Promise.resolve({ result: { success: true, user: { _id: 'alice' } } })
    : new Promise(resolve => { resolveCover = resolve; }));
  await assert.rejects(f.service.updateCover('file'), error => error.code === 'UNAUTHENTICATED');
  assert.equal(f.requests.length, 0);
  await f.service.login();
  const pending = f.service.updateCover('cloud://own-cover');
  assert.equal(f.requests[1].data.action, 'updateCover');
  assert.equal(f.requests[1].data.coverFileID, 'cloud://own-cover');
  f.service.logout();
  resolveCover({ result: { success: true, user: { _id: 'alice', coverFileID: 'cloud://own-cover' } } });
  await assert.rejects(pending, /登录状态已变更/);
  assert.equal(f.app.globalData.currentUser, null);
});

test('未登录时恢复不会调用云端或创建用户', async () => {
  const f = clientFixture(() => { throw new Error('should not call'); });
  assert.equal(await f.service.restore(), null);
  assert.equal(f.requests.length, 0);
});

test('重复点击登录只发一次请求；恢复会重新向云端读取', async () => {
  const f = clientFixture(async () => ({ result: { success: true, user: { _id: 'alice', nickname: '同学' } } }));
  const first = f.service.login();
  const second = f.service.login();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.app.globalData.currentUser._id, 'alice');
  await f.service.restore();
  assert.equal(f.requests[1].data.action, 'getProfile');
  assert.deepEqual([...f.storage.values()], [true]);
});

test('云端返回业务失败时不会留下登录状态', async () => {
  const f = clientFixture(async () => ({ result: { success: false, message: '测试失败' } }));
  await assert.rejects(f.service.login(), /测试失败/);
  assert.equal(f.storage.size, 0);
  assert.equal(f.app.globalData.currentUser, null);
});

test('退出后迟到的登录响应不能重新登录账号', async () => {
  let resolve;
  const f = clientFixture(() => new Promise(done => { resolve = done; }));
  const pending = f.service.login();
  f.service.logout();
  resolve({ result: { success: true, user: { _id: 'alice' } } });
  await assert.rejects(pending, /登录已取消/);
  assert.equal(f.storage.size, 0);
  assert.equal(f.app.globalData.currentUser, null);
});

test('管理服务返回工作台数据，保留服务端拒绝码用于错误处理', async () => {
  const f = clientFixture(async () => ({ result: { success: true, dashboard: { operator: { role: 'admin' } } } }));
  assert.equal((await f.service.getAdminDashboard()).operator.role, 'admin');
  assert.equal(f.requests[0].data.action, 'getAdminDashboard');
  const denied = clientFixture(async () => ({ result: { success: false, code: 'FORBIDDEN', message: '仅管理员可访问' } }));
  await assert.rejects(denied.service.getAdminDashboard(), error => error.code === 'FORBIDDEN');
});

test('读取时从服务端更新身份，账号封禁时清除本地登录标记', async () => {
  let disabled = false;
  const f = clientFixture(async ({ data }) => ({ result: disabled
    ? { success: false, code: 'ACCOUNT_DISABLED', message: '当前账号暂不可使用' }
    : { success: true, user: { _id: 'alice', role: data.action === 'login' ? 'admin' : 'user' } } }));
  await f.service.login();
  assert.equal(f.app.globalData.currentUser.role, 'admin');
  assert.equal((await f.service.restore()).role, 'user');
  disabled = true;
  await assert.rejects(f.service.restore(), /暂不可使用/);
  assert.equal(f.app.globalData.currentUser, null);
  assert.equal(f.storage.size, 0);
});

test('认证服务使用固定云函数动作，成功后刷新当前用户的待审核状态', async () => {
  const f = clientFixture(async ({ data }) => ({ result: { success: true, certification: {
    user: { _id: 'alice', role: 'user', certificationStatus: data.action === 'submitCertification' ? 'pending' : 'unverified' },
    application: data.action === 'submitCertification' ? { status: 'pending' } : null,
  } } }));
  assert.equal((await f.service.getCertification()).application, null);
  const result = await f.service.submitCertification({ schoolName: '测试大学' });
  assert.equal(result.application.status, 'pending');
  assert.equal(f.app.globalData.currentUser.certificationStatus, 'pending');
  assert.equal(f.requests[1].data.action, 'submitCertification');
  assert.equal(f.requests[1].data.application.schoolName, '测试大学');
});

test('退出后迟到的认证响应不恢复登录状态', async () => {
  let resolve;
  const f = clientFixture(() => new Promise(done => { resolve = done; }));
  const request = f.service.getCertification();
  f.service.logout();
  resolve({ result: { success: true, certification: { user: { _id: 'alice' }, application: null } } });
  await assert.rejects(request, /登录状态已变更/);
  assert.equal(f.app.globalData.currentUser, null);
  assert.equal(f.storage.size, 0);
});

test('撤回服务要求登录并携带申请版本和原状态，成功同步普通身份，忽略退出后迟到的结果', async () => {
  let resolve;
  const f = clientFixture(({ data }) => data.action === 'login'
    ? Promise.resolve({ result: { success: true, user: { _id: 'alice', role: 'student' } } })
    : new Promise(done => { resolve = done; }));
  await assert.rejects(f.service.withdrawCertification('cert-alice', 2, 'approved'), error => error.code === 'UNAUTHENTICATED');
  assert.equal(f.requests.length, 0);
  await f.service.login();
  const request = f.service.withdrawCertification('cert-alice', 2, 'approved');
  assert.equal(f.requests[1].data.action, 'withdrawCertification');
  assert.equal(f.requests[1].data.application.applicationId, 'cert-alice');
  assert.equal(f.requests[1].data.application.revision, 2);
  assert.equal(f.requests[1].data.application.status, 'approved');
  resolve({ result: { success: true, certification: {
    user: { _id: 'alice', role: 'user', certificationStatus: 'unverified', schoolId: '', schoolName: '' }, application: null,
  } } });
  await request; assert.equal(f.app.globalData.currentUser.role, 'user');
  const late = f.service.withdrawCertification('cert-alice', 2, 'approved');
  f.service.logout();
  resolve({ result: { success: true, certification: { user: { _id: 'alice' }, application: null } } });
  await assert.rejects(late, /登录状态已变更/);
  assert.equal(f.app.globalData.currentUser, null);
});

test('审核服务未登录不发请求，登录后携带当前申请版本，不接受退出后的迟到响应', async () => {
  let resolve;
  const f = clientFixture(({ data }) => data.action === 'login'
    ? Promise.resolve({ result: { success: true, user: { _id: 'admin', role: 'admin' } } })
    : new Promise(done => { resolve = done; }));
  await assert.rejects(f.service.listCertifications('pending'), error => error.code === 'UNAUTHENTICATED');
  assert.equal(f.requests.length, 0);
  await f.service.login();
  const request = f.service.reviewCertification('application-id', 2, { decision: 'rejected', rejectionReason: '材料不清晰' });
  assert.equal(f.requests[1].data.revision, 2);
  assert.equal(f.requests[1].data.action, 'reviewCertification');
  f.service.logout(); resolve({ result: { success: true, reviewResult: { status: 'rejected' } } });
  await assert.rejects(request, error => error.code === 'UNAUTHENTICATED');
  assert.equal(f.app.globalData.currentUser, null);
});

test('会话缓存减少切页请求，超过一分钟才校验；显式刷新始终读取云端', async () => {
  let now = 1000;
  const f = clientFixture(async () => ({ result: { success: true, user: { _id: 'alice', nickname: '同学' } } }),
    { Date: class extends Date { static now() { return now; } } });
  await f.service.login();
  for (let i = 0; i < 5; i++) await f.service.restore({ force: false });
  assert.equal(f.requests.length, 1);
  assert.equal(f.service.getCachedUser()._id, 'alice');
  now += 60001;
  await f.service.restore({ force: false });
  assert.equal(f.requests.length, 2);
  await f.service.restore();
  assert.equal(f.requests.length, 3);
  f.service.logout();
  assert.equal(f.service.getCachedUser(), null);
  assert.equal(await f.service.restore({ force: false }), null);
  assert.equal(f.requests.length, 3);
});

test('账号详情和认证信息可复用；改名和认证撤回立即更新资料并使旧详情失效', async () => {
  let current = { _id: 'alice', nickname: '旧昵称', role: 'student', certificationStatus: 'approved' };
  const f = clientFixture(async ({ data }) => {
    if (data.action === 'getAccountInfo') return { result: { success: true, accountInfo: { user: { ...current }, nicknameHistory: { changeCount: 2 } } } };
    if (data.action === 'getCertification') return { result: { success: true, certification: { user: { ...current }, application: { status: 'approved' } } } };
    if (data.action === 'withdrawCertification') {
      current = { ...current, role: 'user', certificationStatus: 'unverified' };
      return { result: { success: true, certification: { user: { ...current }, application: null } } };
    }
    if (data.action === 'updateProfile') current = { ...current, nickname: data.profile.nickname };
    return { result: { success: true, user: { ...current } } };
  });
  await f.service.login();
  await f.service.getAccountInfo({ force: false });
  await f.service.getCertification({ force: false });
  await f.service.getAccountInfo({ force: false });
  await f.service.getCertification({ force: false });
  assert.equal(f.requests.length, 3);
  await f.service.updateProfile({ nickname: '新昵称' });
  assert.equal(f.service.getCachedUser().nickname, '新昵称');
  assert.equal(f.service.getCachedAccountInfo(), null);
  assert.equal(f.service.getCachedCertification(), null);
  await f.service.withdrawCertification('cert', 1, 'approved');
  assert.equal(f.service.getCachedUser().role, 'user');
  assert.equal(f.service.getCachedCertification().application, null);
  f.service.logout();
  assert.equal(f.service.getCachedAccountInfo(), null);
  assert.equal(f.service.getCachedCertification(), null);
});

test('迟到的资料刷新不能覆盖刚保存的新昵称；旧会话的拒绝响应不能退出新账号', async () => {
  let finishProfile, loginCount = 0;
  const f = clientFixture(({ data }) => {
    if (data.action === 'getProfile') return new Promise(resolve => { finishProfile = resolve; });
    if (data.action === 'updateProfile') return Promise.resolve({ result: { success: true, user: { _id: 'alice', nickname: '刚保存' } } });
    return Promise.resolve({ result: { success: true, user: { _id: ++loginCount === 1 ? 'alice' : 'bob', nickname: '原昵称' } } });
  });
  await f.service.login();
  const oldProfile = f.service.restore();
  await f.service.updateProfile({ nickname: '刚保存' });
  finishProfile({ result: { success: true, user: { _id: 'alice', nickname: '原昵称' } } });
  assert.equal((await oldProfile).nickname, '刚保存');
  const oldSession = f.service.restore();
  f.service.logout();
  await f.service.login();
  finishProfile({ result: { success: false, code: 'ACCOUNT_DISABLED', message: '旧账号停用' } });
  await assert.rejects(oldSession, /旧账号停用/);
  assert.equal(f.service.getCachedUser()._id, 'bob');
});

function editFixture({ failSave = false, failUpload = false } = {}) {
  const uploads = [];
  const saves = [];
  const toasts = [];
  const navigation = [];
  let page;
  const service = {
    getCachedUser: () => null, getCachedAccountInfo: () => null, getCachedCertification: () => null,
    async restore() { return { _id: 'alice', nickname: '旧昵称', avatarFileID: '' }; },
    async updateProfile(profile) {
      saves.push(profile);
      if (failSave) throw new Error('服务暂不可用');
      return profile;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/edit-profile/index.js'), 'utf8'), {
    Page: definition => { page = definition; }, require: () => service,
    console: { error() {} }, Date, Math,
    wx: {
      cloud: { uploadFile: async args => {
        uploads.push(args);
        if (failUpload) throw new Error('上传失败');
        return { fileID: 'cloud://campus-test.bucket/' + args.cloudPath };
      } },
      showToast: value => toasts.push(value.title),
      navigateBack: () => navigation.push('back'),
      switchTab: () => navigation.push('profile'),
    },
  });
  const instance = { ...page, data: { ...page.data }, setData(value) { Object.assign(this.data, value); } };
  return { page: instance, uploads, saves, toasts, navigation, allowSave() { failSave = false; }, allowUpload() { failUpload = false; } };
}

test('新头像先上传再保存，使用表单最终昵称，成功才返回', async () => {
  const f = editFixture();
  await f.page.loadProfile();
  f.page.onChooseAvatar({ detail: { avatarUrl: '/tmp/photo.png' } });
  await f.page.save({ detail: { value: { nickname: ' 新昵称 ' } } });
  assert.match(f.uploads[0].cloudPath, /^avatars\/alice\/.+\.png$/);
  assert.equal(f.saves[0].nickname, '新昵称');
  assert.match(f.saves[0].avatarFileID, /^cloud:\/\//);
  assert.deepEqual(f.toasts, ['资料已保存']);
  assert.deepEqual(f.navigation, ['back']);
});

test('保存失败不提示成功或返回，重试复用已上传头像', async () => {
  const f = editFixture({ failSave: true });
  await f.page.loadProfile();
  f.page.onChooseAvatar({ detail: { avatarUrl: '/tmp/photo.jpg' } });
  await f.page.save({ detail: { value: { nickname: '新昵称' } } });
  assert.equal(f.page.data.error, '服务暂不可用');
  assert.equal(f.page.data.saving, false);
  assert.deepEqual(f.toasts, []);
  assert.deepEqual(f.navigation, []);
  f.allowSave();
  await f.page.save({ detail: { value: { nickname: '新昵称' } } });
  assert.equal(f.uploads.length, 1);
  assert.deepEqual(f.toasts, ['资料已保存']);
});

test('头像上传失败不写入临时路径、不提交资料，可以重试', async () => {
  const f = editFixture({ failUpload: true });
  await f.page.loadProfile();
  f.page.onChooseAvatar({ detail: { avatarUrl: '/tmp/photo.jpg' } });
  await f.page.save({ detail: { value: { nickname: '新昵称' } } });
  assert.equal(f.uploads.length, 1);
  assert.equal(f.saves.length, 0);
  assert.equal(f.page.data.error, '上传失败');
  assert.deepEqual(f.toasts, []);
  assert.equal(f.page.data.saving, false);
  f.allowUpload();
  await f.page.save({ detail: { value: { nickname: '新昵称' } } });
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.toasts, ['资料已保存']);
});

test('空白昵称不上传头像或提交资料', async () => {
  const f = editFixture();
  await f.page.loadProfile();
  await f.page.save({ detail: { value: { nickname: '   ' } } });
  assert.equal(f.uploads.length, 0);
  assert.equal(f.saves.length, 0);
  assert.match(f.page.data.error, /昵称/);
});
