const { loadPostActions, applyPageData } = require('./helpers/post-actions-fixture');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { navigationLayout, defaultGeometry, navigationState, pullState } = require('../miniprogram/utils/profile-navigation');
const { describeUser } = require('../miniprogram/utils/user-role');
const info = { windowWidth: 375, windowHeight: 812, statusBarHeight: 44 };
const capsule = { top: 52, height: 32, left: 278 };

test('导航尺寸适配 iOS、Android 与无胶囊信息的回退，封面保持原有预览比例', () => {
  const ios = navigationLayout(info, capsule);
  assert.equal(ios.navHeight, 92); assert.equal(ios.coverHeight, 222); assert.equal(ios.searchLeft, 68); assert.equal(ios.navTitleInset, 116);
  const android = navigationLayout({ windowWidth: 360, statusBarHeight: 24 }, { top: 28, height: 32, left: 263 });
  assert.equal(android.navHeight, 68); assert.equal(android.coverHeight, 192.8);
  assert.equal(navigationLayout({ windowWidth: 320, statusBarHeight: 24 }, { top: 0, height: 0 }).navTop, 32);
  assert.equal(navigationLayout().navButtonHeight, 32);
  for (const layout of [ios, android]) assert.ok(layout.navTop - 4 + layout.navButtonHeight + 8 <= layout.navHeight);
});

test('清晰封面、模糊深色与紧凑标题随实际位置双向计算，回弹和连续往返没有状态残留', () => {
  const layout = navigationLayout(info, capsule), geometry = defaultGeometry(layout);
  const initial = navigationState(0, layout.navHeight, geometry);
  assert.deepEqual(initial, { navCoverOffset: 0, navBlurOpacity: 0, navShadeOpacity: 0, navTitleOpacity: 0 });
  const middle = navigationState(65, layout.navHeight, geometry);
  assert.ok(middle.navBlurOpacity > 0 && middle.navBlurOpacity < 1); assert.equal(middle.navTitleOpacity, 0);
  const end = navigationState(1000, layout.navHeight, geometry);
  assert.equal(end.navBlurOpacity, 1); assert.equal(end.navShadeOpacity, .68); assert.equal(end.navTitleOpacity, 1);
  assert.ok(end.navCoverOffset + layout.navHeight < geometry.coverHeight);
  assert.deepEqual(navigationState(-40, layout.navHeight, geometry), initial);
  for (let i = 0; i < 100; i++) {
    for (const top of [0, 20, 80, 160, 240, 1000, 240, 160, 80, 20, 0]) {
      const state = navigationState(top, layout.navHeight, geometry);
      assert.ok(state.navBlurOpacity >= 0 && state.navBlurOpacity <= 1);
    }
    assert.deepEqual(navigationState(0, layout.navHeight, geometry), initial);
  }
});

function fixture(options = {}) {
  let definition, now = 1000, timerSequence = 0;
  const updates = [], measures = [], scrollReads = [], timers = new Map();
  const users = { getCachedUser: () => null };
  const square = { cachedOwnFeed: () => options.feed || null };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.js'), 'utf8'), {
    Page: value => { definition = value; }, Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { const id = ++timerSequence; timers.set(id, { fn, delay, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id),
    require: name => name.includes('cui-refresh-drawing') ? require('../miniprogram/utils/cui-refresh-drawing') : name.includes('profile-navigation') ? require('../miniprogram/utils/profile-navigation') : name.includes('post-actions') ? loadPostActions(users, square, {}) :
      name.includes('services/square') ? square : name.includes('user-role') ? { describeUser } : name.includes('post-view') ? require('../miniprogram/utils/post-view') : name.includes('account-menu') ? require('../miniprogram/utils/account-menu') : users,
    wx: { getWindowInfo: () => info, getMenuButtonBoundingClientRect: () => capsule },
  });
  const page = { ...definition, data: structuredClone(definition.data), _visible: true,
    setData(values) { updates.push(values); Object.assign(this.data, values); },
    createSelectorQuery() {
      const selectors = [];
      const query = { select: name => { selectors.push(name); return query; }, boundingClientRect: () => query, selectViewport: () => query, scrollOffset: () => query,
        exec: callback => { (selectors[0] === '.profile-scroll' ? scrollReads : measures).push(callback); } };
      return query;
    } };
  page.onLoad(); updates.length = 0;
  return { page, updates, measures, scrollReads, timers,
    frameCount() { return [...timers.values()].filter(timer => timer.delay <= 16).length; },
    tick(value) { now = value; },
    flush() { for (const [id, timer] of [...timers]) if (timer.delay <= 16) { timers.delete(id); timer.fn(); } },
    settle() { for (const [id, timer] of [...timers]) if (timer.delay === 80) { timers.delete(id); timer.fn(); } },
    async advance(ms) {
      const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
      await flush(); const target = now + ms;
      while (true) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= target);
        if (!entry) break;
        timers.delete(entry[0]); now = Math.max(now, entry[1].at); entry[1].fn(); await flush();
      }
      now = target; await flush();
    },
  };
}

test('标题阈值取实际布局坐标与视口偏移，忽略过期测量，已读资料不会被滚动修改', () => {
  const f = fixture(); f.page.data.user = { nickname: '真实昵称', bio: '真实简介' };
  f.page.measureProfileNavigation(); f.page.measureProfileNavigation();
  f.measures[0]([{ height: 230 }, { top: 1, bottom: 2, height: 1 }, { scrollTop: 0 }]);
  assert.notEqual(f.page._navGeometry.headingTop, 1);
  f.measures[1]([{ height: 230 }, { top: 216, bottom: 256, height: 40 }, { scrollTop: 84 }]);
  assert.equal(f.page._navGeometry.headingTop, 300); assert.equal(f.page._navGeometry.headingBottom, 340);
  f.page.onProfileScroll({ detail: { scrollTop: 198 } }); assert.equal(f.page.data.navTitleOpacity, 0);
  f.tick(1020); f.page.onProfileScroll({ detail: { scrollTop: 223 } }); assert.ok(f.page.data.navTitleOpacity > 0 && f.page.data.navTitleOpacity < 1);
  f.tick(1040); f.page.onProfileScroll({ detail: { scrollTop: 248 } }); assert.equal(f.page.data.navTitleOpacity, 1);
  assert.equal(f.page.data.user.nickname, '真实昵称');
});

test('每帧合并滚动更新、稳定区不再 setData，离开页面取消待处理帧', () => {
  const f = fixture();
  f.page.onProfileScroll({ detail: { scrollTop: 40 } });
  f.tick(1004); f.page.onProfileScroll({ detail: { scrollTop: 80 } });
  f.tick(1008); f.page.onProfileScroll({ detail: { scrollTop: 100 } });
  assert.equal(f.frameCount(), 1);
  f.tick(1016); f.flush(); assert.equal(f.page.data.navCoverOffset, 100);
  f.tick(1040); f.page.onProfileScroll({ detail: { scrollTop: 1000 } }); const writes = f.updates.length;
  for (let i = 0; i < 100; i++) { f.tick(1060 + i * 20); f.page.onProfileScroll({ detail: { scrollTop: 1000 + i } }); }
  assert.equal(f.updates.length, writes);
  f.tick(4000); f.page.onProfileScroll({ detail: { scrollTop: 90 } }); f.tick(4004); f.page.onProfileScroll({ detail: { scrollTop: 60 } });
  assert.equal(f.frameCount(), 1); f.page.onHide(); assert.equal(f.timers.size, 0);
  const count = f.updates.length; f.flush(); assert.equal(f.updates.length, count);
});

test('紧凑标题使用真实总数，未获完整列表时不将分页长度冒充总数', () => {
  const f = fixture();
  f.page.updatePostCount({ items: [{}], hasMore: true, nextOffset: 1 }); assert.equal(f.page.data.postCountText, '帖子');
  f.page.updatePostCount({ items: [{}], total: 37, hasMore: true, nextOffset: 1 }); assert.equal(f.page.data.postCountText, '37 条帖子');
  f.page.updatePostCount({ items: [], hasMore: false, nextOffset: 0 }); assert.equal(f.page.data.postCountText, '0 条帖子');
});

test('快速往返后回到顶点立即清除导航叠加状态，待处理尾帧不能恢复旧位置', () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) {
    f.tick(1000 + i * 40); f.page.onProfileScroll({ detail: { scrollTop: 300 } });
    f.tick(1004 + i * 40); f.page.onProfileScroll({ detail: { scrollTop: 70.4 } });
    assert.equal(f.frameCount(), 1);
    f.tick(1008 + i * 40); f.page.onProfileScroll({ detail: { scrollTop: i % 2 ? 0 : -0.4 } });
    assert.equal(f.frameCount(), 0);
    assert.equal(f.page.data.navCoverOffset, 0); assert.equal(f.page.data.navBlurOpacity, 0);
    assert.equal(f.page.data.navShadeOpacity, 0); assert.equal(f.page.data.navTitleOpacity, 0);
    f.flush(); assert.equal(f.page.data.navBlurOpacity, 0);
  }
});

const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });
function readyPullPage() {
  const f = fixture();
  Object.assign(f.page.data, { user: { _id: 'owner' }, authChecking: false, loginSheetOpen: false });
  return f;
}

test('只有顶部纵向下拉移动白色区域，封面与固定导航不变，Cui褪色进度随拉动距离增加', () => {
  const f = readyPullPage(), page = f.page;
  page.startProfilePull(touch(100, 300)); page.moveProfilePull(touch(100, 330));
  assert.equal(page.data.profilePullOffset, 13); assert.ok(page._profileCuiVisual.progress > 0);
  const progress = page._profileCuiVisual.progress;
  f.tick(1020); page.moveProfilePull(touch(100, 390));
  assert.ok(page._profileCuiVisual.progress > progress); assert.equal(page.data.navCoverOffset, 0);
  assert.equal(page.data.navBlurOpacity, 0); assert.equal(page.data.coverHeight, 222);
  for (const width of [320, 360, 375, 430]) {
    const layout = navigationLayout({ windowWidth: width }, capsule);
    assert.ok(layout.coverArtHeight - layout.coverHeight >= layout.pullMax - .001);
    assert.ok(pullState(10000, layout.pullMax, layout.pullThreshold).profilePullOffset <= layout.pullMax + .5);
  }
  page.cancelProfilePull(); assert.equal(page.data.profilePullOffset, 0);
  for (const end of [touch(140, 302), touch(100, 270)]) {
    page.startProfilePull(touch(100, 300)); page.moveProfilePull(end);
    assert.equal(page.data.profilePullOffset, 0);
  }
  page.onProfileScroll({ detail: { scrollTop: 20 } });
  page.startProfilePull(touch(100, 300)); page.moveProfilePull(touch(100, 400));
  assert.equal(page.data.profilePullOffset, 0);
});

test('松手立即复位，短拉不联网，超过阈值只发一次刷新且保留已有资料和动态', async () => {
  const f = readyPullPage(), page = f.page;
  const posts = [{ _id: 'existing' }]; page.data.ownPosts = posts;
  let calls = 0, resolve;
  page.loadOwnPosts = force => { assert.equal(force, true); calls++; return new Promise(done => { resolve = done; }); };
  page.startProfilePull(touch(100, 300)); page.moveProfilePull(touch(100, 330));
  await page.finishProfilePull(); assert.equal(calls, 0); assert.equal(page.data.profilePullOffset, 0);
  page.startProfilePull(touch(100, 300)); page.moveProfilePull(touch(100, 420));
  const pending = page.finishProfilePull();
  assert.equal(page.data.profilePullOffset, 0); assert.equal(page.data.pullDragging, false);
  assert.equal(page.data.profileRefreshing, true); assert.equal(page.data.ownPosts, posts);
  await page.finishProfilePull(); await page.refreshProfilePosts(); assert.equal(calls, 1);
  resolve(); await pending; assert.equal(page.data.profileRefreshing, true);
  await f.advance(1720); assert.equal(page.data.profileRefreshing, false);
});

test('Cui先随资料区域回位，再至少完整起伏一轮，依次补色后隐藏，保留旧图片引用', async () => {
  const f = readyPullPage(), page = f.page, states = [];
  const posts = [{ _id:'existing', images:['public-image'] }]; page.data.ownPosts = posts;
  page.selectComponent = id => id === '#profile-cui' ? { setState: value => states.push(value) } : null;
  page.loadOwnPosts = async () => {};
  await page.refreshProfilePosts(); assert.equal(page.data.profileRefreshPhase, 'settling');
  await f.advance(219); assert.equal(page.data.profileRefreshPhase, 'settling');
  await f.advance(1); assert.equal(page.data.profileRefreshPhase, 'loading');
  await f.advance(899); assert.equal(page.data.profileRefreshPhase, 'loading');
  await f.advance(1); assert.equal(page.data.profileRefreshPhase, 'refill');
  assert.equal(states.at(-1).duration, 600);
  await f.advance(599); assert.equal(page.data.profileRefreshing, true);
  await f.advance(1); assert.equal(page.data.profileRefreshPhase, 'idle'); assert.equal(page.data.profileRefreshing, false);
  assert.deepEqual(states.map(value => value.phase), ['settling','loading','refill','idle']);
  assert.equal(page.data.ownPosts, posts); assert.equal(page.data.ownPosts[0].images, posts[0].images);
});

test('慢请求和失败都等当前Cui整轮结束，切换内容标签取消动画及迟到回填', async () => {
  const f = readyPullPage(), page = f.page; let fail;
  page.loadOwnPosts = () => new Promise((resolve, reject) => { fail = reject; });
  const pending = page.refreshProfilePosts();
  await f.advance(1220); assert.equal(page.data.profileRefreshPhase, 'loading');
  fail(new Error('网络失败')); await assert.rejects(pending, /网络失败/);
  await f.advance(799); assert.equal(page.data.profileRefreshPhase, 'loading');
  await f.advance(1); assert.equal(page.data.profileRefreshPhase, 'refill');
  page.selectContent({ currentTarget:{ dataset:{ key:'replies' } } });
  assert.equal(page.data.profileRefreshPhase, 'idle'); assert.equal(page.data.profileRefreshing, false);
  await f.advance(2000); assert.equal(page.data.profileRefreshPhase, 'idle');
});

test('取消、离开页面及账号更换清理下拉状态，迟到刷新不覆盖新一轮指示器', async () => {
  const f = readyPullPage(), page = f.page;
  page.startProfilePull(touch(100, 300)); page.moveProfilePull(touch(100, 340));
  f.tick(1004); page.moveProfilePull(touch(100, 390)); assert.equal(f.frameCount(), 1);
  page.cancelProfilePull(); assert.equal(f.frameCount(), 0); assert.equal(page.data.profilePullOffset, 0);
  let finishOld, finishNew;
  page.loadOwnPosts = () => new Promise(resolve => { finishOld = resolve; });
  const oldRequest = page.refreshProfilePosts();
  page.onHide(); assert.equal(page.data.profileRefreshing, false);
  page._visible = true;
  page.loadOwnPosts = () => new Promise(resolve => { finishNew = resolve; });
  const newRequest = page.refreshProfilePosts();
  finishOld(); await oldRequest; assert.equal(page.data.profileRefreshing, true);
  finishNew(); await newRequest; assert.equal(page.data.profileRefreshing, true);
  await f.advance(1720); assert.equal(page.data.profileRefreshing, false);
  page.startProfilePull(touch(100, 300)); page.moveProfilePull(touch(100, 400));
  page.applyUser(null); assert.equal(page.data.profilePullOffset, 0); assert.equal(page.data.profileRefreshing, false);
});

test('白色区域下移时的布局测量不会改变紧凑标题的正常滚动阈值', () => {
  const f = readyPullPage(), page = f.page;
  page.measureProfileNavigation();
  const overlap = (222 - 92) * 32 / 260;
  f.measures[0]([{ height: 222 }, { top: 335, bottom: 375, height: 40 }, { scrollTop: 0 }, { top: 222 - overlap + 35 }]);
  assert.equal(page._navGeometry.headingTop, 300); assert.equal(page._navGeometry.headingBottom, 340);
});

const measuredScroll = (top, reportedTop = top) => [{ scrollTop: reportedTop }, { top: 0 }, { top: -top }];

test('漏掉回顶滚动事件时以实际封面位置恢复导航，随后仍能下拉刷新', async () => {
  const f = readyPullPage(), page = f.page;
  f.tick(1020);
  page.onProfileScroll({ detail: { scrollTop: 300 } });
  assert.equal(page.data.navBlurOpacity, 1);
  f.tick(1080); f.settle();
  // 原生容器也可能报告旧偏移，封面的实际坐标优先。
  f.scrollReads.shift()(measuredScroll(0, 300));
  assert.equal(page._profileScrollTop, 0); assert.equal(page.data.navBlurOpacity, 0);
  assert.equal(page.data.navTitleOpacity, 0);
  let refreshed = 0; page.loadOwnPosts = async () => { refreshed++; };
  page.startProfilePull(touch(100, 300)); page.moveProfilePull(touch(100, 420));
  assert.ok(page.data.profilePullOffset > 0);
  await page.finishProfilePull(); assert.equal(refreshed, 1);
  await f.advance(1720);
  assert.equal(page.data.profilePullOffset, 0); assert.equal(page.data.profileRefreshing, false);
});

test('从中途一次拖回顶部后继续下拉，只有到顶之后的位移用于刷新', () => {
  const f = readyPullPage(), page = f.page;
  page.onProfileScroll({ detail: { scrollTop: 100 } });
  page.startProfilePull(touch(100, 300));
  page.moveProfilePull(touch(100, 400)); assert.equal(page.data.profilePullOffset, 0);
  // 这一笔手势不因起点在内容区而作废；真实到顶时重新建立下拉起点。
  f.scrollReads.shift()(measuredScroll(0));
  page.moveProfilePull(touch(100, 420)); assert.equal(page.data.profilePullOffset, 8);
  assert.equal(page.data.navBlurOpacity, 0);
  page.cancelProfilePull(); assert.equal(page.data.profilePullOffset, 0);
});

test('手指再次触摸时核对真实位置；旧查询、离开页面后的结果不能倒退滚动状态', () => {
  const f = readyPullPage(), page = f.page;
  page.onProfileScroll({ detail: { scrollTop: 240 } });
  page.startProfilePull(touch(100, 300));
  const old = f.scrollReads.shift();
  f.tick(1020); page.onProfileScroll({ detail: { scrollTop: 310 } });
  old(measuredScroll(0)); assert.equal(page._profileScrollTop, 310);
  page.onProfileScrollUpper(); const current = f.scrollReads.shift();
  current(measuredScroll(0)); assert.equal(page._profileScrollTop, 0);
  page.onProfileScrollUpper(); const leaving = f.scrollReads.shift();
  page.onHide(); assert.equal(f.timers.size, 0);
  const writes = f.updates.length;
  leaving(measuredScroll(200)); assert.equal(f.updates.length, writes);
});

test('惯性中缺失末尾事件时持续校准至顶部，停在页面中部则稳定后停止检查', () => {
  const f = readyPullPage(), page = f.page;
  page.onProfileScroll({ detail: { scrollTop: 300 } });
  for (const top of [120, 30, 0]) {
    f.settle(); f.scrollReads.shift()(measuredScroll(top));
    assert.equal(page._profileScrollTop, top);
  }
  assert.equal(page.data.navBlurOpacity, 0);
  f.settle(); assert.equal(f.scrollReads.length, 0);
  f.tick(1200); page.onProfileScroll({ detail: { scrollTop: 120 } });
  for (let i = 0; i < 2; i++) { f.settle(); f.scrollReads.shift()(measuredScroll(120)); }
  f.settle(); assert.equal(f.scrollReads.length, 0);
  assert.equal(page._profileScrollTop, 120); // 中部停留时不得擅自跳回顶部。
});
