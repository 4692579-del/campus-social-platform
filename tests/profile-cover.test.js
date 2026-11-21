const { loadPostActions, applyPageData } = require('./helpers/post-actions-fixture');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture } = require('./helpers/certification-fixture');
const { describeUser } = require('../miniprogram/utils/user-role');

test('封面只更新本人字段，昵称头像和认证保留，重登录可读取封面和真实加入日期', async () => {
  const f = fixture();
  const alice = await f.login();
  const bob = await f.login(f.bob);
  Object.assign(f.users.get(alice._id), { nickname: '原昵称', avatarFileID: 'original-avatar',
    role: 'student', certificationStatus: 'approved', schoolId: 'real-school', schoolName: '真实学校' });
  const before = { ...f.users.get(alice._id) };
  const fileID = `cloud://test.bucket/avatars/${alice._id}/cover-123-test.png`;
  const result = await f.handle({ action: 'updateCover', coverFileID: fileID, userId: bob._id, role: 'admin' }, f.alice);
  assert.equal(result.success, true);
  assert.equal(result.user.coverFileID, fileID);
  for (const key of ['nickname', 'avatarFileID', 'role', 'certificationStatus', 'schoolId', 'schoolName']) {
    assert.equal(result.user[key], before[key]);
  }
  const restored = await f.login();
  assert.equal(restored.coverFileID, fileID);
  assert.equal(restored.createdAt, before.createdAt);
  assert.equal(restored.openid, undefined);
  assert.equal(f.users.get(bob._id).coverFileID, '');
  await f.handle({ action: 'updateProfile', profile: { nickname: '新昵称', avatarFileID: '' } }, f.alice);
  assert.equal((await f.login()).coverFileID, fileID);
});

test('封面拒绝外链、跨环境、跨账号、非封面路径及未知类型', async () => {
  const f = fixture();
  const alice = await f.login();
  const bob = await f.login(f.bob);
  for (const coverFileID of [null, '', 'https://example.com/image.jpg',
    `cloud://other.bucket/avatars/${alice._id}/cover-one.png`,
    `cloud://test.bucket/avatars/${bob._id}/cover-one.png`,
    `cloud://test.bucket/avatars/${alice._id}/../cover-one.png`,
    `cloud://test.bucket/avatars/${alice._id}/photo.png`,
    `cloud://test.bucket/avatars/${alice._id}/cover-one.svg`]) {
    assert.equal((await f.handle({ action: 'updateCover', coverFileID }, f.alice)).code, 'INVALID_COVER');
  }
  assert.equal(f.users.get(alice._id).coverFileID, '');
});

test('未建档、缺少可信微信身份、封禁用户不能修改封面', async () => {
  const f = fixture();
  assert.equal((await f.handle({ action: 'updateCover' }, {})).code, 'UNAUTHENTICATED');
  assert.equal((await f.handle({ action: 'updateCover' }, f.alice)).code, 'NOT_REGISTERED');
  const alice = await f.login();
  f.users.get(alice._id).status = 'banned';
  assert.equal((await f.handle({ action: 'updateCover' }, f.alice)).code, 'ACCOUNT_DISABLED');
});

function pageFixture(options = {}) {
  let definition;
  const requests = [], toasts = [], routes = [], modals = [], navigationColors = [], backCalls = [], renderTasks = [];
  const service = {
    getCachedUser: () => options.cachedUser || null,
    restore: async () => { requests.push('restore'); return options.restore ? options.restore() : null; },
    login: async () => { requests.push('login'); return options.login ? options.login() : { ...ordinary }; },
    logout() { requests.push('logout'); },
    updateCover: options.updateCover || (async fileID => ({ ...page.data.user, coverFileID: fileID })),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.js'), 'utf8'), {
    Page: value => { definition = value; },
    getCurrentPages: () => [...(options.previousPages || []), page],
    require: name => name.includes('cui-refresh-drawing') ? require('../miniprogram/utils/cui-refresh-drawing') : name.includes('profile-navigation') ? require('../miniprogram/utils/profile-navigation') : name.includes('post-actions') ? loadPostActions(service, {}, { showToast: args => toasts.push(args) }) : name.includes('services/square') ? { cachedOwnFeed: () => null, cachedAlbum: () => null, album: async () => ({ items: [], hasMore: false, nextOffset: 0 }), list: async () => ({ items: [], hasMore: false, nextOffset: 0 }) } :
      name.includes('post-view') ? require('../miniprogram/utils/post-view') : name.includes('user-role') ? { describeUser } : name.includes('account-menu') ? require('../miniprogram/utils/account-menu') : service,
    wx: {
      getWindowInfo: () => ({ statusBarHeight: 44, windowWidth: 375 }),
      getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32, left: 278 }),
      chooseMedia: args => { requests.push('choose');
        if (options.choose) return options.choose(args);
        args.success({ tempFiles: [{ tempFilePath: '/temp/cover.png' }] }); },
      getImageInfo: args => args.success({ type: 'png', width: 1000 }),
      compressImage: args => args.success({ tempFilePath: '/temp/compressed.png' }),
      getFileSystemManager: () => ({ getFileInfo: args => args.success({ size: options.size || 1024 }) }),
      cloud: { uploadFile: async args => { requests.push(args); return { fileID: 'cloud://test.bucket/' + args.cloudPath }; } },
      showToast: args => toasts.push(args),
      showModal: args => modals.push(args),
      setNavigationBarColor: args => navigationColors.push(args.frontColor),
      nextTick: callback => { if (options.deferRender) renderTasks.push(callback); else callback(); },
      navigateBack: args => backCalls.push(args),
      navigateTo: args => routes.push(args.url), switchTab: args => {
        routes.push(args.url);
        if (options.failSwitchTab && args.fail) args.fail();
        if (args.complete) args.complete();
      },
    },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  return { page, service, requests, toasts, routes, modals, navigationColors, backCalls, renderTasks };
}
const ordinary = { _id: 'alice', nickname: '测试同学', role: 'user', certificationStatus: 'unverified', schoolId: '' };

test('个人主页首帧显示会话资料，后台刷新不弹登录遮罩，网络失败保留已有内容', async () => {
  let reject;
  const f = pageFixture({ cachedUser: { ...ordinary, bio: '已有简介', coverFileID: '已有封面' },
    restore: () => new Promise((resolve, fail) => { reject = fail; }) });
  f.page.onLoad();
  assert.equal(f.page.data.user.nickname, ordinary.nickname);
  assert.equal(f.page.data.coverFileID, '已有封面');
  assert.equal(f.page.data.authChecking, false);
  const pending = f.page.onShow();
  assert.equal(f.page.data.loading, false);
  assert.equal(f.page.data.loginSheetOpen, false);
  f.page.editProfile();
  assert.deepEqual(f.routes, ['/pages/edit-profile/index']);
  reject(new Error('连接失败'));
  await pending;
  assert.equal(f.page.data.user.bio, '已有简介');
  assert.equal(f.page.data.error, '');
});

test('侧栏可打开和收起，离开页面自动关闭并恢复导航颜色，保留当前账号', () => {
  const f = pageFixture();
  f.page.applyUser(ordinary);
  f.page.openMenu(); f.page.openMenu();
  assert.equal(f.page.data.menuOpen, true);
  assert.deepEqual(f.navigationColors, ['#000000']);
  f.page.closeMenu();
  assert.equal(f.page.data.menuOpen, false);
  assert.equal(f.navigationColors.at(-1), '#ffffff');
  f.page.openMenu();
  f.page.onHide();
  assert.equal(f.page.data.menuOpen, false);
  assert.equal(f.page.data.user._id, ordinary._id);
  assert.equal(f.navigationColors.at(-1), '#ffffff');
});

test('尚未开发的侧栏菜单只提示，不导航、不退出；未知菜单不执行', () => {
  const f = pageFixture();
  f.page.applyUser(ordinary);
  f.page.openMenu();
  for (const key of ['add', 'friends', 'history', 'creator', 'settings', 'help', 'unknown']) {
    f.page.selectMenuItem({ currentTarget: { dataset: { key } } });
  }
  // “添加”已删除，与未知菜单一样忽略；其余五个未开放入口保留提示。
  assert.equal(f.toasts.length, 5);
  assert.ok(f.toasts.every(item => /后续开放/.test(item.title)));
  assert.equal(f.routes.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.page.data.menuOpen, true);
  assert.equal(f.page.data.user._id, ordinary._id);
});

test('菜单认证入口对学生打开现有认证页；未登录被登录面板阻止，管理员显示对应提示', () => {
  const f = pageFixture();
  const event = { currentTarget: { dataset: { key: 'certification' } } };
  f.page.openMenu();
  f.page.selectMenuItem(event);
  assert.equal(f.routes.length, 0);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.page.data.menuOpen, false);
  f.page.applyUser(ordinary);
  f.page.openMenu(); f.page.selectMenuItem(event);
  assert.deepEqual(f.routes, ['/pages/certification/index']);
  assert.equal(f.page.data.menuOpen, false);
  f.page.applyUser({ ...ordinary, role: 'student', certificationStatus: 'approved', schoolId: 'school' });
  f.page.openMenu(); f.page.selectMenuItem(event);
  assert.equal(f.routes.length, 2);
  f.page.applyUser({ ...ordinary, role: 'admin' });
  f.page.openMenu(); f.page.selectMenuItem(event);
  assert.equal(f.routes.length, 2);
  assert.equal(f.toasts.at(-1).title, '管理员账号无需学生认证');
});

test('展开菜单时同步推动底部导航，关闭、离开或卸载后恢复', () => {
  const f = pageFixture();
  const state = {};
  f.page.applyUser(ordinary);
  f.page.getTabBar = () => ({ setData: value => Object.assign(state, value) });
  f.page.syncNavigation();
  assert.equal(state.menuOpen, false);
  f.page.openMenu();
  assert.equal(state.menuOpen, true);
  f.page.closeMenu();
  assert.equal(state.menuOpen, false);
  f.page.openMenu(); f.page.onHide();
  assert.equal(state.menuOpen, false);
  f.page.openMenu(); f.page.onUnload();
  assert.equal(state.menuOpen, false);
});

test('侧栏退出只弹一次确认；取消保留账号和菜单，确认后清理登录并关闭菜单', () => {
  const f = pageFixture();
  f.page.applyUser({ ...ordinary, coverFileID: 'saved-cover' });
  f.page.openMenu();
  f.page.logout(); f.page.logout();
  assert.equal(f.modals.length, 1);
  assert.equal(f.page.data.confirmingLogout, true);
  f.modals[0].success({ confirm: false }); f.modals[0].complete();
  assert.equal(f.page.data.user._id, ordinary._id);
  assert.equal(f.page.data.menuOpen, true);
  assert.equal(f.page.data.confirmingLogout, false);
  assert.equal(f.requests.length, 0);
  f.page.selectContent({ currentTarget: { dataset: { key: 'album' } } });
  f.page.logout();
  f.modals[1].success({ confirm: true }); f.modals[1].complete();
  assert.deepEqual(f.requests, ['logout']);
  assert.equal(f.page.data.user, null);
  assert.equal(f.page.data.loginSheetOpen, true);
  assert.equal(f.page.data.coverFileID, '');
  assert.equal(f.page.data.isVerified, false);
  assert.equal(f.page.data.menuOpen, false);
  assert.equal(f.page.data.confirmingLogout, false);
  assert.equal(f.page.data.selectedContent, 'posts');
  assert.equal(f.page.data.likeCount, 0);
});

test('退出确认期间切换账号、离开或卸载页面，迟到确认不会退出新账号', () => {
  for (const action of ['switch', 'hide', 'unload']) {
    const f = pageFixture();
    f.page.applyUser(ordinary);
    f.page.openMenu();
    f.page.logout();
    if (action === 'switch') f.page.applyUser({ ...ordinary, _id: 'bob' });
    if (action === 'hide') f.page.onHide();
    if (action === 'unload') f.page.onUnload();
    f.modals[0].success({ confirm: true }); f.modals[0].complete();
    assert.equal(f.requests.length, 0);
    assert.ok(f.page.data.user);
    if (action === 'switch') assert.equal(f.page.data.user._id, 'bob');
  }
});

test('未登录或资料忙碌时不能退出；确认窗口失败后可重试', () => {
  const f = pageFixture();
  f.page.logout();
  assert.equal(f.modals.length, 0);
  f.page.applyUser(ordinary);
  f.page.setData({ loading: true }); f.page.logout();
  f.page.setData({ loading: false, coverBusy: true }); f.page.logout();
  assert.equal(f.modals.length, 0);
  f.page.setData({ coverBusy: false }); f.page.logout();
  f.modals[0].fail(); f.modals[0].complete();
  assert.equal(f.page.data.confirmingLogout, false);
  assert.equal(f.page.data.user._id, ordinary._id);
  assert.equal(f.toasts[0].title, '暂时无法确认，请重试');
  f.page.logout();
  assert.equal(f.modals.length, 2);
});

test('主页使用真实身份与日期，不编造关注粉丝，只有认证学生显示认证标记', () => {
  const { page } = pageFixture();
  page.onLoad();
  assert.equal(page.data.navTop, 52);
  assert.equal(page.data.navHeight, 92);
  assert.equal(page.data.searchLeft, 68);
  page.applyUser({ ...ordinary, createdAt: '2026-11-17T00:00:00Z' });
  assert.equal(page.data.joinedText, '2026年11月 加入');
  assert.equal(page.data.followingCount, '—');
  assert.equal(page.data.followerCount, '—');
  assert.equal(page.data.certificationAction, '去认证');
  assert.equal(page.data.isVerified, false);
  page.applyUser({ ...ordinary, role: 'student', certificationStatus: 'approved', schoolId: 'school' });
  assert.equal(page.data.isVerified, true);
  page.applyUser({ ...ordinary, certificationStatus: 'pending' });
  assert.equal(page.data.certificationAction, '查看审核');
  page.applyUser({ ...ordinary, certificationStatus: 'rejected', createdAt: 'invalid' });
  assert.equal(page.data.certificationAction, '重新认证');
  assert.equal(page.data.joinedText, '');
});

test('无首页页面栈时返回键兜底回首页，搜索按钮仍进入搜索底栏页面', () => {
  const f = pageFixture();
  f.page.applyUser(ordinary);
  f.page.backToHome();
  assert.deepEqual(f.routes, ['/pages/home/index']);
  f.page.openSearch();
  assert.deepEqual(f.routes, ['/pages/home/index', '/pages/search/index']);
});

test('个人主页先恢复首页与底栏，再沿页面栈原生返回，连续点击不重复跳转', () => {
  let prepared = 0;
  const home = { route: 'pages/home/index', prepareMenuReturn() { prepared++; } };
  const f = pageFixture({ previousPages: [home], deferRender: true });
  f.page.onLoad();
  f.page.backToHome(); f.page.backToHome();
  assert.equal(prepared, 1);
  assert.equal(f.backCalls.length, 0); assert.equal(f.routes.length, 0);
  assert.equal(f.renderTasks.length, 1);
  f.renderTasks.shift()();
  assert.equal(f.backCalls.length, 1); assert.equal(f.backCalls[0].delta, 1);
  assert.equal(f.routes.length, 0);
  f.page.onUnload(); assert.equal(prepared, 1);
});

test('多层页面一次返回首页，不逐页闪回；返回失败有兜底且失败后允许重试', () => {
  const home = { route: 'pages/home/index', prepareMenuReturn() {} };
  const f = pageFixture({ previousPages: [home, { route: 'pages/another/index' }], failSwitchTab: true });
  f.page.onLoad(); f.page.backToHome();
  assert.equal(f.backCalls.length, 1); assert.equal(f.backCalls[0].delta, 2);
  assert.equal(f.routes.length, 0);
  f.backCalls[0].fail();
  assert.deepEqual(f.routes, ['/pages/home/index']);
  assert.equal(f.toasts.at(-1).title, '返回首页失败，请重试');
  f.page.backToHome(); assert.equal(f.backCalls.length, 2);
  let prepared = 0;
  const native = pageFixture({ previousPages: [{ route: 'pages/home/index', prepareMenuReturn() { prepared++; } }] });
  native.page.onLoad(); native.page.onUnload();
  assert.equal(prepared, 1); assert.equal(native.routes.length, 0);
});

test('四个内容选项切换空状态，保留普通用户认证入口与管理员工作台', () => {
  const { page, routes } = pageFixture();
  page.applyUser(ordinary);
  for (const key of ['posts', 'replies', 'reposts', 'album']) {
    page.selectContent({ currentTarget: { dataset: { key } } });
    assert.equal(page.data.selectedContent, key);
  }
  page.selectContent({ currentTarget: { dataset: { key: 'unknown' } } });
  assert.equal(page.data.selectedContent, 'album');
  page.applyUser(ordinary);
  page.openCertification(); page.openAdmin();
  assert.deepEqual(routes, ['/pages/certification/index']);
  page.applyUser({ ...ordinary, role: 'admin' });
  page.openCertification(); page.openAdmin();
  assert.deepEqual(routes, ['/pages/certification/index', '/pages/admin/index']);
});

test('未登录进入我的自动弹出登录面板，不自动调用登录，面板期间禁止其他个人中心操作', async () => {
  const f = pageFixture();
  const bar = {};
  f.page.getTabBar = () => ({ setData: value => Object.assign(bar, value) });
  await f.page.onShow();
  assert.equal(f.page.data.loginSheetOpen, true);
  assert.equal(f.page.data.authChecking, false);
  assert.equal(bar.authBlocked, true);
  assert.deepEqual(f.requests, ['restore']);
  f.page.openMenu(); f.page.openSearch(); f.page.editProfile(); f.page.openCertification();
  f.page.openAccountAbout(); f.page.shareProfile(); f.page.publishPost(); f.page.logout();
  f.page.selectContent({ currentTarget: { dataset: { key: 'album' } } });
  assert.equal(f.page.data.menuOpen, false);
  assert.equal(f.page.data.selectedContent, 'posts');
  assert.equal(f.routes.length, 0);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.modals.length, 0);
});

test('确认登录状态期间阻止点击，已有会话恢复后直接进入个人主页，不弹登录面板', async () => {
  let resolve;
  const f = pageFixture({ restore: () => new Promise(done => { resolve = done; }) });
  const bar = {};
  f.page.getTabBar = () => ({ setData: value => Object.assign(bar, value) });
  const pending = f.page.onShow();
  assert.equal(f.page.data.authChecking, true);
  assert.equal(f.page.data.loginSheetOpen, false);
  f.page.openMenu(); f.page.editProfile();
  assert.equal(f.page.data.menuOpen, false);
  assert.equal(f.routes.length, 0);
  resolve(ordinary);
  await pending;
  assert.equal(f.page.data.user._id, ordinary._id);
  assert.equal(f.page.data.loginSheetOpen, false);
  assert.equal(bar.authBlocked, false);
  assert.deepEqual(f.requests, ['restore']);
});

test('登录失败保留面板和错误供重试；重复点击只发一次，成功后才解锁页面及底栏', async () => {
  let resolve, attempts = 0;
  const f = pageFixture({ login: () => {
    attempts += 1;
    if (attempts === 1) throw new Error('连接失败，请重试');
    return new Promise(done => { resolve = done; });
  } });
  const bar = {};
  f.page.getTabBar = () => ({ setData: value => Object.assign(bar, value) });
  await f.page.onShow();
  await f.page.login();
  assert.equal(f.page.data.loginSheetOpen, true);
  assert.equal(f.page.data.error, '连接失败，请重试');
  assert.equal(bar.authBlocked, true);
  const pending = f.page.login();
  await f.page.login();
  assert.equal(attempts, 2);
  resolve(ordinary);
  await pending;
  assert.equal(f.page.data.user._id, ordinary._id);
  assert.equal(f.page.data.loginSheetOpen, false);
  assert.equal(f.page.data.loading, false);
  assert.equal(f.page.data.error, '');
  assert.equal(bar.authBlocked, false);
  assert.equal(f.toasts.at(-1).title, '登录成功');
});

test('取消登录返回首页并撤销会话，迟到登录响应不关闭面板或提示成功', async () => {
  let resolve;
  const f = pageFixture({ login: () => new Promise(done => { resolve = done; }) });
  await f.page.onShow();
  const pending = f.page.login();
  f.page.cancelLogin();
  assert.deepEqual(f.routes, ['/pages/home/index']);
  assert.deepEqual(f.requests, ['restore', 'login', 'logout']);
  resolve(ordinary);
  await pending;
  assert.equal(f.page.data.user, null);
  assert.equal(f.page.data.loginSheetOpen, true);
  assert.equal(f.toasts.length, 0);
  const failed = pageFixture({ failSwitchTab: true });
  await failed.page.onShow();
  failed.page.cancelLogin();
  assert.equal(failed.page.data.loginSheetOpen, true);
  assert.equal(failed.page.data.error, '返回首页失败，请重试');
});

test('离开后迟到的会话恢复不覆盖再次进入的登录面板，错误恢复及无效登录结果可重试', async () => {
  let resolve, restores = 0;
  const f = pageFixture({ restore: () => ++restores === 1 ? new Promise(done => { resolve = done; }) : null });
  const first = f.page.onShow();
  f.page.onHide();
  await f.page.onShow();
  assert.equal(f.page.data.loginSheetOpen, true);
  resolve(ordinary);
  await first;
  assert.equal(f.page.data.user, null);
  assert.equal(f.page.data.loginSheetOpen, true);
  const failed = pageFixture({ restore: () => { throw new Error('账号读取失败'); }, login: () => null });
  await failed.page.onShow();
  assert.equal(failed.page.data.error, '账号读取失败');
  assert.equal(failed.page.data.loginSheetOpen, true);
  await failed.page.login();
  assert.equal(failed.page.data.error, '登录信息读取失败，请重试');
  assert.equal(failed.page.data.loginSheetOpen, true);
  assert.equal(failed.toasts.length, 0);
});

test('更换封面走本人上传目录和服务保存，超时重试复用文件', async () => {
  let attempts = 0;
  const f = pageFixture({ updateCover: async fileID => {
    if (++attempts === 1) throw new Error('network timeout');
    return { ...ordinary, coverFileID: fileID };
  } });
  f.page.applyUser(ordinary);
  await f.page.chooseCover();
  assert.equal(f.page.data.coverRetry, true);
  assert.equal(f.page.data.coverFileID, '');
  await f.page.chooseCover();
  assert.equal(f.requests.filter(item => item === 'choose').length, 1);
  const upload = f.requests.find(item => item.cloudPath);
  assert.match(upload.cloudPath, /^avatars\/alice\/cover-[\w-]+\.png$/);
  assert.equal(f.page.data.coverFileID, 'cloud://test.bucket/' + upload.cloudPath);
  assert.equal(f.page.data.coverRetry, false);
  assert.equal(f.page.data.coverBusy, false);
});

test('未登录、取消选择或图片过大时不上传；取消相册不显示错误', async () => {
  const anonymous = pageFixture();
  await anonymous.page.chooseCover();
  assert.equal(anonymous.requests.length, 0);
  const cancelled = pageFixture({ choose: args => args.fail({ errMsg: 'chooseMedia:fail cancel' }) });
  cancelled.page.applyUser(ordinary);
  await cancelled.page.chooseCover();
  assert.equal(cancelled.page.data.error, '');
  const large = pageFixture({ size: 6 * 1024 * 1024 });
  large.page.applyUser(ordinary);
  await large.page.chooseCover();
  assert.match(large.page.data.error, /5MB/);
  assert.equal(large.requests.length, 1);
});

test('相册等待期间切换账号，旧图片不能上传或保存到新账号', async () => {
  let choose;
  const f = pageFixture({ choose: args => { choose = args; } });
  f.page.applyUser({ ...ordinary, coverFileID: 'old-cover' });
  const pending = f.page.chooseCover();
  f.page.applyUser({ ...ordinary, _id: 'bob' });
  choose.success({ tempFiles: [{ tempFilePath: '/temp/old.png' }] });
  await pending;
  assert.equal(f.page.data.coverFileID, '');
  assert.equal(f.requests.length, 1);
  assert.equal(f.page.data.coverBusy, false);
});
