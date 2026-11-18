const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture } = require('./helpers/certification-fixture');
const { describeUser } = require('../miniprogram/utils/user-role');

const profile = nickname => ({ nickname, avatarFileID: '' });
const accountInfo = (f, identity = f.alice, extra = {}) => f.handle({ action: 'getAccountInfo', ...extra }, identity);
const rename = (f, nickname) => f.handle({ action: 'updateProfile', profile: profile(nickname) }, f.alice);

test('新账号从零开始，改名与最后修改时间真实持久化，重登录不重置', async () => {
  const clock = { serverTime: '2026-11-17T06:00:00.000Z' };
  const f = fixture(clock);
  const user = await f.login();
  const initial = (await accountInfo(f)).accountInfo;
  assert.equal(initial.nicknameHistory.changeCount, 0);
  assert.equal(initial.nicknameHistory.lastChangedAt, null);
  assert.equal(initial.nicknameHistory.historyComplete, true);
  clock.serverTime = '2026-11-17T07:23:45.000Z';
  assert.equal((await rename(f, '第一次改名')).success, true);
  let info = (await accountInfo(f)).accountInfo;
  assert.equal(info.nicknameHistory.changeCount, 1);
  assert.equal(info.nicknameHistory.lastChangedAt, clock.serverTime);
  assert.equal(info.user.createdAt, user.createdAt);
  clock.serverTime = '2026-11-18T01:02:03.000Z';
  await rename(f, '第二次改名');
  await f.login();
  info = (await accountInfo(f)).accountInfo;
  assert.equal(info.nicknameHistory.changeCount, 2);
  assert.equal(info.nicknameHistory.lastChangedAt, clock.serverTime);
  assert.equal(info.nicknameHistory.trackingStartedAt, user.createdAt);
  assert.equal(info.user.openid, undefined);
});

test('相同昵称、空白规范化、只编辑简介头像生日封面，不增加改名次数或改名时间', async () => {
  const f = fixture();
  const user = await f.login();
  await rename(f, '小罗');
  const before = (await accountInfo(f)).accountInfo.nicknameHistory;
  const result = await f.handle({ action: 'updateProfile', profile: {
    nickname: '  小罗  ', avatarFileID: `cloud://test.bucket/avatars/${user._id}/avatar.png`,
    bio: '新简介', birthDate: '2000-02-29', coverFileID: `cloud://test.bucket/avatars/${user._id}/cover-new.png`,
  } }, f.alice);
  assert.equal(result.success, true);
  assert.deepEqual((await accountInfo(f)).accountInfo.nicknameHistory, before);
});

test('并发保存同一个昵称只记一次；不同昵称逐次记录，计数不会丢失', async () => {
  const f = fixture();
  await f.login();
  assert.ok((await Promise.all(Array.from({ length: 8 }, () => rename(f, '相同昵称')))).every(r => r.success));
  assert.equal((await accountInfo(f)).accountInfo.nicknameHistory.changeCount, 1);
  assert.ok((await Promise.all(['甲', '乙', '丙'].map(name => rename(f, name)))).every(r => r.success));
  assert.equal((await accountInfo(f)).accountInfo.nicknameHistory.changeCount, 4);
});

test('老账号不推测历史，首次查看与首次改名并发也只初始化一次', async () => {
  const f = fixture();
  const user = await f.login();
  const record = f.users.get(user._id);
  for (const key of ['nicknameChangeCount', 'nicknameLastChangedAt', 'nicknameTrackingStartedAt', 'nicknameHistoryComplete']) delete record[key];
  record.updatedAt = '2020-01-01T00:00:00.000Z';
  await Promise.all([accountInfo(f), rename(f, '新名字'), accountInfo(f)]);
  const history = (await accountInfo(f)).accountInfo.nicknameHistory;
  assert.equal(history.changeCount, 1);
  assert.equal(history.historyComplete, false);
  assert.equal(history.trackingStartedAt, '2026-11-14T10:00:00.000Z');
  assert.equal(history.lastChangedAt, '2026-11-14T10:00:00.000Z');
});

test('写入失败会同时回滚昵称和统计；事务内重新确认封禁状态', async () => {
  const f = fixture({ failUserUpdate: true });
  const user = await f.login();
  assert.equal((await rename(f, '不应保存')).success, false);
  assert.equal(f.users.get(user._id).nickname, user.nickname);
  assert.equal(f.users.get(user._id).nicknameChangeCount, 0);
  assert.equal(f.users.get(user._id).nicknameLastChangedAt, null);
  const g = fixture();
  const other = await g.login();
  g.hooks.beforeTransaction = tables => { tables.get('users').get(other._id).status = 'banned'; };
  assert.equal((await rename(g, '封禁后不可改名')).code, 'ACCOUNT_DISABLED');
  assert.equal(g.users.get(other._id).nickname, other.nickname);
});

test('账号信息仅按可信身份读取，禁止伪造统计字段，未注册或禁用不能访问', async () => {
  const f = fixture();
  assert.equal((await accountInfo(f, {})).code, 'UNAUTHENTICATED');
  assert.equal((await accountInfo(f)).code, 'NOT_REGISTERED');
  const alice = await f.login(), bob = await f.login(f.bob);
  await rename(f, 'Alice');
  const info = (await accountInfo(f, f.bob, { userId: alice._id, openid: 'alice' })).accountInfo;
  assert.equal(info.user._id, bob._id);
  assert.equal(info.nicknameHistory.changeCount, 0);
  for (const key of ['nicknameChangeCount', 'nicknameLastChangedAt', 'nicknameHistoryComplete', 'nicknameTrackingStartedAt']) {
    assert.equal((await f.handle({ action: 'updateProfile', profile: { ...profile('伪造'), [key]: 999 } }, f.alice)).code, 'INVALID_PROFILE');
  }
  f.users.get(alice._id).status = 'banned';
  assert.equal((await accountInfo(f)).code, 'ACCOUNT_DISABLED');
});

function pageFixture(result, options = {}) {
  let definition;
  const routes = [];
  const copies = [], toasts = [];
  const service = { getCachedUser: () => options.cachedUser || null, getCachedAccountInfo: () => options.cachedInfo || null, getAccountInfo: async () => typeof result === 'function' ? result() : result };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/account-about/index.js'), 'utf8'), {
    require: () => service, Page: page => { definition = page; },
    wx: { getWindowInfo: () => ({ statusBarHeight: 44 }), getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32 }),
      setClipboardData: args => {
        copies.push(args);
        if (options.holdCopy) return;
        if (options.failCopy) args.fail();
        else args.success();
        args.complete();
      },
      showToast: args => toasts.push(args.title),
      navigateBack: () => routes.push('back'), switchTab: value => routes.push(value.url) },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  return { page, routes, copies, toasts };
}
const info = { user: { _id: 'alice', accountId: '12345678', nickname: '真实昵称', avatarFileID: 'real-avatar', role: 'user',
  certificationStatus: 'unverified', schoolId: '', schoolName: '不应展示的旧学校', createdAt: '2026-11-16T16:00:00.000Z' },
nicknameHistory: { changeCount: 2, lastChangedAt: '2026-11-17T03:04:05.000Z', trackingStartedAt: '2026-11-17T01:00:00.000Z', historyComplete: false } };

test('关于账号直接展示已有资料，未知改名记录不编造，后台完成后补全真实统计', async () => {
  let resolve;
  const f = pageFixture(() => new Promise(done => { resolve = done; }), { cachedUser: info.user });
  f.page.onLoad();
  const pending = f.page.onShow();
  assert.equal(f.page.data.user.nickname, info.user.nickname);
  assert.equal(f.page.data.loading, false);
  assert.equal(f.page.data.changeCount, null);
  resolve(info);
  await pending;
  assert.equal(f.page.data.changeCount, 2);
  f.page.onHide();
  assert.equal(f.page.data.user.nickname, info.user.nickname);
});

test('ID复制由用户点击触发，只复制本账号8位ID且成功后显示指定提示', async () => {
  const f = pageFixture(info);
  await f.page.onShow();
  assert.equal(f.copies.length, 0);
  f.page.copyAccountId();
  assert.equal(f.copies[0].data, '12345678');
  assert.deepEqual(f.toasts, ['已复制ID账号']);
  const failed = pageFixture(info, { failCopy: true });
  await failed.page.onShow();
  failed.page.copyAccountId();
  assert.deepEqual(failed.toasts, ['复制失败，请重试']);
});

test('未分配或未登录不复制，连续点击不重复调用，离开页面忽略迟到的复制提示', async () => {
  const f = pageFixture(info, { holdCopy: true });
  f.page.copyAccountId();
  assert.equal(f.copies.length, 0);
  await f.page.onShow();
  f.page.data.user = { ...info.user, accountId: '' };
  f.page.copyAccountId();
  assert.equal(f.copies.length, 0);
  f.page.data.user = { ...info.user };
  f.page.copyAccountId(); f.page.copyAccountId();
  assert.equal(f.copies.length, 1);
  f.page.onHide();
  f.copies[0].success(); f.copies[0].complete();
  assert.deepEqual(f.toasts, []);
});

test('账号页展示真实资料与北京时间，未认证不展示旧学校', async () => {
  const { page, routes } = pageFixture(info);
  page.onLoad();
  await page.onShow();
  assert.equal(page.data.navHeight, 92);
  assert.equal(page.data.user.avatarFileID, 'real-avatar');
  assert.equal(page.data.schoolText, '未认证');
  assert.equal(page.data.joinedText, '2026年11月17日');
  assert.equal(page.data.changeCount, 2);
  assert.equal(page.data.lastChangedText, '2026年11月17日 11:04:05');
  page.back();
  assert.deepEqual(routes, ['back']);
});

test('只有真实通过认证的学生展示认证学校和已认证状态，缺失时间不编造', async () => {
  const result = structuredClone(info);
  Object.assign(result.user, { role: 'student', certificationStatus: 'approved', schoolId: 'school-real', schoolName: '闽南科技学院' });
  result.nicknameHistory = { ...result.nicknameHistory, historyComplete: true, changeCount: 0, lastChangedAt: null };
  const { page } = pageFixture(result);
  await page.onShow();
  assert.equal(page.data.isVerified, true);
  assert.equal(page.data.schoolText, '闽南科技学院');
  assert.equal(page.data.lastChangedText, '尚无更改记录');
  result.user.createdAt = null;
  result.user.certificationStatus = 'pending';
  await page.onShow();
  assert.equal(page.data.isVerified, false);
  assert.equal(page.data.schoolText, '未认证');
  assert.equal(page.data.joinedText, '暂无加入日期记录');
});

test('离开页面清除旧账号资料并忽略迟到响应；重新进入或失败不显示旧数据', async () => {
  let resolve;
  const { page } = pageFixture(() => new Promise(done => { resolve = done; }));
  const pending = page.onShow();
  page.onHide();
  resolve(info);
  await pending;
  assert.equal(page.data.user, null);
  const failed = pageFixture(async () => { throw new Error('请重新登录'); }).page;
  await failed.onShow();
  assert.equal(failed.data.error, '请重新登录');
  assert.equal(failed.data.user, null);
  assert.equal(failed.data.loading, false);
});

test('主页加入日期可进入账号页，学校名称已移出主页且新页面已注册', () => {
  let definition;
  const routes = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.js'), 'utf8'), {
    Page: value => { definition = value; }, require: name => name.includes('user-role') ? { describeUser } : name.includes('account-menu') ? require('../miniprogram/utils/account-menu') : {},
    wx: { navigateTo: value => routes.push(value.url) },
  });
  const page = { ...definition, data: { user: null } };
  page.openAccountAbout();
  assert.equal(routes.length, 0);
  page.data.user = info.user;
  page.openAccountAbout();
  assert.deepEqual(routes, ['/pages/account-about/index']);
  const markup = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.wxml'), 'utf8');
  assert.match(markup, /class="joined-row" bindtap="openAccountAbout"/);
  assert.doesNotMatch(markup, /user\.schoolName/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8')).pages.includes('pages/account-about/index'));
});
