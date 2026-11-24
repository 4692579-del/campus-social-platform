const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTabSelection } = require('../miniprogram/utils/tab-selection');

function fixture(options = {}) {
  let definition;
  const routes = [];
  const navigation = [], toasts = [];
  const pages = [];
  const selection = options.selection || createTabSelection(options.now);
  const timers = new Map(); let timerSequence = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/custom-tab-bar/index.js'), 'utf8'), {
    Component: value => { definition = value; },
    require: name => { assert.equal(name, '../utils/tab-selection'); return selection; },
    setTimeout: (callback, delay) => { const id = ++timerSequence; timers.set(id, { callback: () => { timers.delete(id); callback(); }, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    getCurrentPages: () => pages,
    wx: { switchTab: value => { routes.push(value.url); navigation.push(value); if (options.switchTab) options.switchTab(value); else value.complete(); },
      showToast: value => toasts.push(value.title), ...(options.nextTick ? { nextTick: options.nextTick } : {}) },
  });
  const bar = { ...definition.methods, data: structuredClone(definition.data), setData(values, callback) {
    const before = { ...this.data }; Object.assign(this.data, values);
    if (['authBlocked', 'commentsOpen', 'composerOpen', 'menuOpen'].some(key => before[key] !== this.data[key]))
      definition.observers['authBlocked, commentsOpen, composerOpen, menuOpen'].call(this);
    if (callback) (options.paint ? options.paint(callback) : callback());
  } };
  return { bar, routes, pages, navigation, toasts, selection, timers,
    attach: () => definition.lifetimes.attached.call(bar), ready: () => definition.lifetimes.ready.call(bar),
    show: () => definition.pageLifetimes.show.call(bar), hide: () => definition.pageLifetimes.hide.call(bar),
    detach: () => definition.lifetimes.detached.call(bar) };
}

test('玻璃按压只改变材质，移出、取消、遮挡和切页隐藏都清除按压', () => {
  const { bar, routes, attach, hide, show } = fixture();
  const touch = { identifier: 1, clientX: 20, clientY: 60 };
  const press = (glass, index) => bar.pressGlass({ currentTarget: { dataset: { glass, index } }, touches: [touch] });
  attach();
  bar.setData({ selected: 0 });
  press('tabs', 0);
  assert.equal(bar.data.glassPressedIndex, 0);
  bar.moveGlassPress({ touches: [{ ...touch, clientX: 34 }] });
  assert.equal(bar.data.glassPress, '');

  press('compose');
  assert.equal(bar.data.glassPress, 'compose');
  assert.equal(bar.data.glassPressedIndex, -1);
  bar.releaseGlass({ touches: [] });
  assert.equal(bar.data.glassPress, '');

  press('tabs', 1);
  assert.equal(bar.data.selected, 0);
  bar.setData({ menuOpen: true });
  assert.equal(bar.data.glassPress, '');
  press('tabs', 1);
  assert.equal(bar.data.glassPress, '');
  bar.setData({ menuOpen: false });
  press('tabs', 0);
  hide();
  show();
  assert.equal(bar.data.glassPress, '');
  assert.deepEqual(routes, []);
});

test('菜单展开时点导航只收起当前主页菜单，收起后导航正常切换', () => {
  const { bar, routes, pages } = fixture();
  let closed = 0;
  pages.push({ closeMenu() { throw new Error('不应操作前一个页面'); } });
  pages.push({ closeMenu() { closed += 1; bar.data.menuOpen = false; } });
  bar.data.selected = 3;
  bar.data.menuOpen = true;
  bar.switchTab({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(closed, 1);
  assert.equal(routes.length, 0);
  assert.equal(bar.data.menuOpen, false);
  bar.switchTab({ currentTarget: { dataset: { index: 0 } } });
  assert.deepEqual(routes, ['/pages/home/index']);
});

test('点击导航变暗区域可收起菜单；不存在当前页面时安全返回', () => {
  const { bar, pages } = fixture();
  assert.doesNotThrow(() => bar.closeProfileMenu());
  pages.push({});
  assert.doesNotThrow(() => bar.closeProfileMenu());
  let closed = 0;
  pages.push({ closeMenu() { closed += 1; } });
  bar.closeProfileMenu();
  assert.equal(closed, 1);
});

test('个人中心登录面板期间禁止底栏切页，解除登录遮罩后恢复导航', () => {
  const { bar, routes } = fixture();
  bar.data.selected = 3;
  bar.data.authBlocked = true;
  bar.switchTab({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(routes.length, 0);
  bar.data.authBlocked = false;
  bar.switchTab({ currentTarget: { dataset: { index: 0 } } });
  assert.deepEqual(routes, ['/pages/home/index']);
});

test('最右导航显示搜索图标并打开搜索页', () => {
  const { bar, routes } = fixture();
  assert.equal(bar.data.items[3].label, '搜索');
  assert.equal(bar.data.items[3].icon, 'search');
  bar.data.selected = 0;
  bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.deepEqual(routes, ['/pages/search/index']);
});

test('评论面板期间底栏不接受迟到的点击事件，收起评论后恢复切页', () => {
  const { bar, routes } = fixture();
  bar.data.commentsOpen = true;
  bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.equal(routes.length, 0);
  bar.data.commentsOpen = false;
  bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.deepEqual(routes, ['/pages/search/index']);
});

test('发布及其设置面板期间底栏禁止切页，关闭发布后正常恢复', () => {
  const { bar, routes } = fixture();
  bar.data.composerOpen = true;
  bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.equal(routes.length, 0);
  bar.data.composerOpen = false;
  bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.deepEqual(routes, ['/pages/search/index']);
});

test('相册返回与底栏晚初始化均从当前页面恢复隐藏标记，关闭发布后解除隐藏', () => {
  const f = fixture();
  const page = { data: { composerOpen: true } }; f.pages.push(page);
  f.attach(); assert.equal(f.bar.data.composerOpen, true); assert.equal(f.bar.data.authBlocked, true);
  f.bar.setData({ composerOpen: false, authBlocked: false }); f.ready();
  assert.equal(f.bar.data.composerOpen, true);
  f.bar.setData({ composerOpen: false, authBlocked: false }); f.show();
  assert.equal(f.bar.data.composerOpen, true);
  // 即使恢复期间收到迟到点击，也应检查真实页面状态，不能跳去其他页。
  f.bar.setData({ composerOpen: false, authBlocked: false });
  f.bar.switchTab({ currentTarget: { dataset: { index: 3 } } }); assert.equal(f.routes.length, 0);
  page.data.composerOpen = false; f.show();
  assert.equal(f.bar.data.composerOpen, false); assert.equal(f.bar.data.authBlocked, false);
  f.bar.switchTab({ currentTarget: { dataset: { index: 3 } } }); assert.deepEqual(f.routes, ['/pages/search/index']);
});

test('底栏晚初始化时仍读取荟萃计划的遮挡状态，点击不会切走当前页面', () => {
  const f = fixture();
  const page = { route: 'pages/search/index', data: { menuOpen: true, membershipOpen: true },
    closeMenu() { throw new Error('荟萃面板展开时不能关闭底层侧栏'); } };
  f.pages.push(page);
  f.attach();
  assert.equal(f.bar.data.authBlocked, true);
  f.bar.switchTab({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(f.routes.length, 0);
  page.data.membershipOpen = false;
  f.show();
  assert.equal(f.bar.data.authBlocked, false);
  assert.equal(f.bar.data.menuOpen, true);
});

test('切到其他页面后底栏不沿用发布页的遮挡状态', () => {
  const f = fixture(); f.pages.push({ data: { composerOpen: true } }); f.attach();
  f.pages.push({ data: {} }); f.show();
  assert.equal(f.bar.data.composerOpen, false); assert.equal(f.bar.data.authBlocked, false);
});

test('四个导航入口、注册路由及资源完整对应，集市和任务页面不再存在', () => {
  const f = fixture(), root = path.join(__dirname, '../miniprogram');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const expected = ['pages/home/index', 'pages/inbox/index', 'pages/messages/index', 'pages/search/index'];
  assert.deepEqual(config.tabBar.list.map(tab => tab.pagePath), expected);
  assert.deepEqual([...f.bar.data.items].map(item => item.path.slice(1)), expected);
  for (const [index, item] of [...f.bar.data.items].entries()) {
    assert.equal(config.tabBar.list[index].text, item.label);
    assert.ok(config.pages.includes(item.path.slice(1)));
    for (const extension of ['js', 'json', 'wxml', 'wxss']) assert.ok(fs.existsSync(path.join(root, `${item.path}.${extension}`)), item.path + '.' + extension);
    for (const suffix of ['', '-active']) assert.ok(fs.existsSync(path.join(root, `images/tab-bar/${item.icon}${suffix}.svg`)));
    f.bar.data.selected = -1;
    f.bar.switchTab({ currentTarget: { dataset: { index } } });
    assert.equal(f.routes.at(-1), item.path);
  }
  for (const name of ['market', 'tasks']) {
    assert.ok(!config.pages.includes(`pages/${name}/index`));
    assert.ok(!fs.existsSync(path.join(root, 'pages', name)));
  }
  assert.equal(f.bar.data.items[1].label, '消息');
  assert.equal(f.bar.data.items[1].icon, 'paper-plane');
  f.bar.switchTab({ currentTarget: { dataset: { index: 4 } } });
  assert.equal(f.routes.length, 4, '已删除位置不能再触发页面跳转');
});

test('私信、消息、搜索页面在进入和就绪时恢复正确选中索引，消息页不请求业务', () => {
  for (const [name, selected] of [['inbox', 1], ['messages', 2], ['search', 3]]) {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../miniprogram/pages/${name}/index.js`), 'utf8'), {
      Page: value => { definition = value; },
      require: name => name === './refresh' ? require('../miniprogram/pages/search/refresh') : name.includes('utils/account-menu') ? require('../miniprogram/utils/account-menu') : name.includes('utils/tab-page-layout') ? require('../miniprogram/utils/tab-page-layout') : name.includes('services/square') ? {} : name.includes('services/hotboard') ? { cached:()=>null, load:async()=>{throw new Error('此测试不联网');} } : name.includes('services/user') ? { getCachedUser: () => null, restore: async () => null, searchSessionKey: () => 'guest:0', consumeSearchEntry: () => null } : name.includes('tab-selection') ? { pendingIndex: () => null } : name.includes('search-query') ? require('../miniprogram/utils/search-query') : require('../miniprogram/utils/secondary-tab-page'),
      wx: new Proxy({}, { get(target,key) {
        if (key === 'nextTick') return fn => fn();
        if (name === 'search' && key === 'cloud') return undefined;
        throw new Error('占位页面不应发起请求');
      } }),
    });
    let state = {};
    const page = { ...definition, data: { ...definition.data }, setData(value, callback) { Object.assign(this.data, value); if (callback) callback(); }, getTabBar: () => ({ setData: value => { state = { ...state, ...value }; } }) };
    page.onShow(); assert.equal(state.selected, selected);
    state.selected = -1; page.onReady(); assert.equal(state.selected, selected);
  }
});

test('右侧发布按钮复用首页面板，登录、评论、发布及菜单遮挡时不误触', () => {
  const f = fixture(); let opened = 0, closed = 0;
  const home = { route: 'pages/home/index', data: {}, openComposer() { opened++; }, closeMenu() { closed++; } };
  f.pages.push(home); f.bar.openComposer();
  assert.equal(opened, 1); assert.equal(f.routes.length, 0);
  for (const data of [{ authChecking: true }, { loginSheetOpen: true }, { commentPostId: 'post' }, { composerOpen: true }, { tabMenuKey: 'square' }]) {
    home.data = data; f.bar.openComposer(); assert.equal(opened, 1);
  }
  home.data = { menuOpen: true }; f.bar.openComposer(); assert.equal(closed, 1); assert.equal(opened, 1);
  home.data = {}; home._visible = false; f.bar.openComposer(); assert.equal(opened, 1);
});

test('其他底部页点击发布只切回首页一次，页面已覆盖后才打开原有发布面板', () => {
  const ticks = [], f = fixture({ switchTab() {}, nextTick: callback => ticks.push(callback) });
  f.pages.push({ route: 'pages/messages/index', data: {} });
  f.bar.openComposer(); f.bar.openComposer();
  assert.deepEqual(f.routes, ['/pages/home/index']);
  let opened = 0;
  const home = { route: 'pages/home/index', data: {}, openComposer() { opened++; } };
  f.pages.push(home); f.navigation[0].success(); f.navigation[0].complete();
  assert.equal(opened, 0); ticks.shift()(); assert.equal(opened, 1);
  // 若下一帧前用户已经离开首页，迟到回调不能打开新页面上的发布面板。
  f.pages.push({ route: 'pages/search/index', data: {}, openComposer() { throw new Error('不能打开搜索页发布面板'); } });
  f.navigation[0].success(); ticks.shift()(); assert.equal(opened, 1);
});

test('发布入口切页失败恢复按钮，可重试且不报告发布成功', () => {
  const f = fixture({ switchTab() {} }); f.pages.push({ route: 'pages/search/index', data: {} });
  f.bar.openComposer(); f.navigation[0].fail(); f.navigation[0].complete();
  assert.equal(f.bar._switching, false); assert.deepEqual(f.toasts, ['发布入口打开失败，请重试']);
  f.bar.openComposer(); assert.equal(f.routes.length, 2);
});

test('首次打开标签同时提交底栏反馈和原生切页，目标页接续滑动', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), sourceTicks = [], targetTicks = [];
  const source = fixture({ selection, switchTab() {}, paint: callback => sourceTicks.push(callback) });
  source.pages.push({ route: 'pages/home/index', data: {} }); source.attach();
  source.bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.deepEqual(source.routes, ['/pages/search/index']); assert.equal(source.bar.data.selected, 3);
  assert.equal(source.bar.data.indicatorAnimating, true);
  assert.equal(sourceTicks.length, 0);
  now += 48;
  source.hide(); assert.equal(source.timers.size, 0);
  const target = fixture({ selection, nextTick: callback => targetTicks.push(callback) });
  target.pages.push({ route: 'pages/search/index', data: {} }); target.attach();
  assert.equal(target.bar.data.indicatorPosition, selection.read(3).position);
  target.ready(); target.show(); assert.equal(targetTicks.length, 0);
  assert.equal(target.bar.data.indicatorDelay, -48);
  assert.equal(target.bar.data.indicatorMotionStyle, source.bar.data.indicatorMotionStyle);
  assert.equal(target.bar.data.indicatorTo, 300); assert.equal(target.timers.size, 1);
  assert.equal([...target.timers.values()][0].delay, 612);
  now = 1368; [...target.timers.values()][0].callback();
  assert.equal(target.bar.data.indicatorAnimating, false); assert.equal(target.bar.data.indicatorPosition, 300);
});

test('已缓存底栏在原生切换前预填同一帧，目标页绘制前不消耗滑动时间', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), paints = [];
  const target = fixture({ selection, paint: callback => paints.push(callback) });
  target.pages.push({ route: 'pages/search/index', data: {}, getTabBar: () => target.bar });
  target.attach(); target.hide();
  const source = fixture({ selection, switchTab() {} });
  source.pages.push({ route: 'pages/home/index', data: { chromeCompact: true }, getTabBar: () => source.bar });
  source.attach();
  source.bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.deepEqual(source.routes, ['/pages/search/index']);
  assert.equal(target.bar.data.selected, 3);
  assert.deepEqual({ ...target.bar.data.litIcons }, { 0: true });
  assert.equal(target.bar.data.indicatorPosition, source.bar.data.indicatorPosition);
  assert.equal(target.bar.data.dockScaleFrom, .8);
  assert.equal(source.bar.data.dockScaleFrom, .8);
  source.navigation[0].complete();
  source.bar.syncFromPage(0, {});
  assert.equal(source.bar.data.selected, 3);
  now += 450;
  target.bar.syncFromPage(3, {}); // 页面 onShow 先于组件 show。
  target.show();
  assert.equal(target.bar.data.indicatorPosition, 0);
  assert.equal(target.bar.data.indicatorAnimating, false);
  assert.equal(target.bar.data.dockHandoff, true);
  assert.equal(target.bar.data.dockScaleFrom, .8);
  assert.equal(paints.length, 1);
  paints.pop()();
  assert.equal(target.bar.data.indicatorDelay, 0);
  assert.equal(target.bar.data.indicatorAnimating, true);
  assert.equal(target.bar.data.dockHandoff, true);
  assert.deepEqual({ ...target.bar.data.litIcons }, { 0: true });
  assert.ok(target.bar.data.iconContact > 0);
  assert.equal([...target.timers.values()][0].delay, 660);
  now += 660;
  [...target.timers.values()][0].callback();
  assert.equal(target.bar.data.dockHandoff, false);
  assert.equal(target.bar.data.compact, false);
});

test('缩放途中快速反向，新目标从当前尺寸继续放大', () => {
  let now = 1000;
  const selection = createTabSelection(() => now);
  const id = selection.begin(0, 3, true);
  selection.start(3, id);
  now += 100;
  selection.begin(3, 0);
  const second = selection.read(0);
  assert.ok(second.scaleFrom > .8 && second.scaleFrom < 1);
  now += 150;
  assert.equal(selection.read(0).scaleFrom, second.scaleFrom);
});

test('搜索底栏已恢复原尺寸时回首页，首页旧滚动状态不能重播放大', () => {
  let now = 1000;
  const selection = createTabSelection(() => now);
  const home = fixture({ selection, switchTab() {} });
  const search = fixture({ selection, switchTab() {} });
  const homePage = { route: 'pages/home/index', data: { chromeCompact: true }, getTabBar: () => home.bar };
  const searchPage = { route: 'pages/search/index', data: {}, getTabBar: () => search.bar };
  const current = page => { home.pages[0] = page; search.pages[0] = page; };
  current(homePage); home.attach();
  home.bar.setDockScrollCompact(false);
  home.bar.setDockScrollCompact(true);
  assert.equal(home.bar.data.dockScrollMotion, true);
  home.bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.equal(home.bar.data.dockScrollMotion, false);
  home.hide(); home.navigation[0].complete();
  current(searchPage); search.attach(); search.show();
  now += 660;
  [...search.timers.values()][0].callback();
  search.bar.switchTab({ currentTarget: { dataset: { index: 0 } } });
  search.hide(); search.navigation[0].complete();
  current(homePage);
  home.show(); home.ready(); // 组件先出现，首页还没重置滚动状态。
  assert.equal(homePage.data.chromeCompact, true);
  assert.equal(home.bar.data.compact, false);
  assert.equal(home.bar.data.dockHandoff, false);
  assert.equal(home.bar.data.dockScaleFrom, 1);
  assert.equal(home.bar.data.dockScrollMotion, false);
  assert.equal(home.bar.data.indicatorAnimating, true);
  homePage.data.chromeCompact = false;
  home.bar.syncFromPage(0, { compact: false });
  assert.equal(home.bar.data.compact, false);
});

test('成功切离缩小的首页后清除隐藏页的滚动缩小状态，目标保留本次放大起点', () => {
  for (const successBeforeHide of [true, false]) {
    const selection = createTabSelection();
    const source = fixture({ selection, switchTab() {} });
    const home = { route: 'pages/home/index', data: { chromeCompact: true }, getTabBar: () => source.bar,
      setData(patch) { Object.assign(this.data, patch); } };
    source.pages.push(home); source.attach();
    source.bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
    if (successBeforeHide) source.navigation[0].success();
    assert.equal(source.bar.data.dockScaleFrom, .8);
    assert.equal(home.data.chromeCompact, true);
    source.hide();
    if (!successBeforeHide) source.navigation[0].success();
    assert.equal(home.data.chromeCompact, false);
    assert.equal(source.bar.data.dockScaleFrom, 1);
    assert.equal(source.bar.data.dockHandoff, false);
    assert.equal(selection.read(3).scaleFrom, .8);
  }
});

test('胶囊双向经过原图标和目标图标的边缘时分别切换颜色，快速反向保留当时的颜色', () => {
  for (const [from, to] of [[0, 3], [3, 0], [1, 2], [2, 1]]) {
    let now = 1000;
    const selection = createTabSelection(() => now);
    const id = selection.begin(from, to);
    assert.deepEqual(selection.read(to).litIcons, [from]);
    selection.start(to, id);
    const { iconContact, iconLeaves } = selection.read(to);
    const edgeContact = frame => 50 * frame.scaleX + 22 / 132.5 * 100;
    now = 1000 + iconLeaves[from] - 1;
    const stillOverlapping = selection.read(to);
    assert.ok(stillOverlapping.litIcons.includes(from));
    assert.ok(Math.abs(stillOverlapping.position - from * 100) < edgeContact(stillOverlapping));
    now++;
    const left = selection.read(to);
    assert.ok(!left.litIcons.includes(from));
    assert.ok(Math.abs(left.position - from * 100) >= edgeContact(left));
    now = 1000 + iconContact - 1;
    const before = selection.read(to);
    assert.ok(!before.litIcons.includes(to));
    assert.ok(Math.abs(before.to - before.position) > edgeContact(before));
    now++;
    const reached = selection.read(to);
    assert.ok(reached.litIcons.includes(to));
    assert.equal(reached.litIcons.includes(from), iconContact < iconLeaves[from]);
    assert.ok(Math.abs(reached.to - reached.position) <= edgeContact(reached));
    selection.begin(to, from);
    assert.equal(selection.read(from).from, reached.position);
    assert.deepEqual(selection.read(from).litIcons, reached.litIcons);
  }
});

test('快速反向切换从当前滑动坐标继续，旧帧与旧结束回调不能拉回滑块', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), ticks = [];
  selection.begin(0, 3);
  const f = fixture({ selection, switchTab() {}, nextTick: callback => ticks.push(callback) });
  f.pages.push({ route: 'pages/search/index', data: {} }); f.attach(); f.show();
  const staleFinish = [...f.timers.values()][0].callback;
  now = 1096; const position = selection.read(3).position;
  f.bar.switchTab({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(f.bar.data.indicatorPosition, position); assert.equal(selection.read(1).from, position);
  assert.equal(ticks.length, 0); assert.equal(f.bar.data.indicatorAnimating, true);
  staleFinish(); assert.equal(f.bar.data.indicatorPosition, position);
  const interrupted = fixture({ selection, nextTick: callback => ticks.push(callback) });
  interrupted.pages.push({ route: 'pages/inbox/index', data: {} }); interrupted.attach(); interrupted.show();
  const interruptedState = { ...interrupted.bar.data };
  const oldFinish = [...interrupted.timers.values()][0].callback;
  interrupted.hide(); oldFinish();
  assert.deepEqual(interrupted.bar.data, interruptedState); assert.equal(interrupted.timers.size, 0);
});

test('胶囊碰边后挤压140ms，再用320ms回弹到原形', () => {
  for (const [from, to] of [[0, 3], [3, 0], [1, 0], [2, 3], [1, 2], [2, 1]]) {
    const selection = createTabSelection(() => 1000);
    selection.start(to, selection.begin(from, to));
    const { frames, duration } = selection.read(to);
    const arrival = frames[10], squeezed = frames[17], settled = frames.at(-1);
    const direction = Math.sign(to - from);
    const leadingEdge = frame => frame.position + direction * 50 * frame.scaleX;
    const padding = to === 0 || to === 3 ? 10 / 132.5 * 100 : 0;
    const boundary = to * 100 + direction * (50 + padding);
    assert.ok(frames.slice(1, 11).every(frame => frame.scaleX > 1 && frame.scaleY < 1));
    assert.ok(Math.abs(leadingEdge(arrival) - boundary) < 1e-8);
    for (const frame of frames) {
      assert.ok(direction * (leadingEdge(frame) - boundary) < 1e-8);
    }
    assert.ok(squeezed.scaleX < .87 && squeezed.scaleX >= .79);
    assert.ok(squeezed.scaleY > 1.15 && squeezed.scaleY < 1.27);
    assert.ok(frames[11].scaleX < arrival.scaleX && frames[11].scaleY > arrival.scaleY);
    assert.equal(duration - 340, 320);
    assert.ok(frames[12].scaleX > squeezed.scaleX && frames[12].velocity !== 0);
    for (const frame of frames) assert.ok(Math.abs(frame.scaleX * frame.scaleY - 1) < 1e-8);
    assert.ok(direction * (squeezed.position - to * 100) <= 10.5 + padding + 1e-8);
    for (const frame of frames.slice(10, 18)) {
      assert.ok(Math.abs(leadingEdge(frame) - leadingEdge(arrival)) < 1e-8);
    }
    assert.ok(direction * (frames[20].position - to * 100) > 0);
    assert.ok(direction * (frames[26].position - to * 100) > 0);
    assert.equal(frames[27].position, to * 100);
    assert.ok(frames[26].scaleY > 1 && frames[27].scaleX < 1);
    for (let step = 18; step < frames.length; step++) {
      assert.ok(frames[step].scaleY < frames[step - 1].scaleY);
      assert.ok(frames[step].scaleX > frames[step - 1].scaleX);
    }
    assert.equal(settled.position, to * 100);
    assert.equal(settled.scaleX, 1);
    assert.equal(settled.scaleY, 1);
  }
});

test('胶囊反向和失败回退保留惯性', () => {
  let now = 1000;
  const selection = createTabSelection(() => now);
  const id = selection.begin(0, 3);
  selection.start(3, id);
  const initial = selection.read(3);
  assert.equal(initial.velocity, 0);
  assert.equal(initial.scaleX, 1);
  assert.equal(initial.scaleY, 1);
  assert.equal(initial.frames.at(-1).position, 300);
  assert.equal(initial.frames.at(-1).scaleX, 1);

  now += 45;
  const fast = selection.read(3);
  assert.ok(fast.position > 0 && fast.position < 150);
  assert.ok(fast.scaleX > 1.22 && fast.scaleX < 1.30);
  assert.ok(fast.scaleY < .89);
  now += 115;
  const slow = selection.read(3);
  assert.ok(slow.position > fast.position && slow.position < 300);
  assert.ok(slow.scaleX > 1 && slow.scaleY < 1);
  assert.ok(slow.velocity > 0 && slow.velocity < fast.velocity);
  assert.equal(initial.frames.at(-1).scaleY, 1);

  now = 1045;
  assert.equal(selection.rollback(id, 0), true);
  const returning = selection.read(0);
  assert.equal(returning.position, fast.position);
  assert.equal(returning.velocity, fast.velocity);
  assert.equal(returning.scaleX, fast.scaleX);
  now += 20;
  assert.ok(selection.read(0).position > returning.position);
  now += 60;
  const turning = selection.read(0);
  assert.ok(turning.velocity < 0);

  const next = selection.begin(0, 3);
  now += 40;
  assert.equal(selection.read(3).position, turning.position);
  assert.equal(selection.read(3).velocity, turning.velocity);
  selection.start(3, next);
  assert.equal(selection.read(3).scaleX, turning.scaleX);
});

test('直接进入标签页不从首页虚假滑动，过期动画也只呈现正确终点', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), f = fixture({ selection });
  f.pages.push({ route: 'pages/messages/index', data: {} }); f.attach(); f.ready(); f.show();
  assert.equal(f.bar.data.selected, 2); assert.equal(f.bar.data.indicatorPosition, 200);
  assert.equal(f.bar.data.indicatorAnimating, false); assert.equal(f.timers.size, 0);
  const id = selection.begin(0, 2); selection.start(2, id); now += 700;
  const late = fixture({ selection }); late.pages.push({ route: 'pages/messages/index', data: {} }); late.attach();
  assert.equal(late.bar.data.indicatorPosition, 200); assert.equal(late.bar.data.indicatorAnimating, false);
});

test('隐藏、遮挡和销毁取消本地动画，返回时只接续尚未结束的共享进度', () => {
  let now = 1000;
  const selection = createTabSelection(() => now); selection.begin(0, 3);
  const f = fixture({ selection }); f.pages.push({ route: 'pages/search/index', data: {} }); f.attach(); f.show();
  assert.equal(f.timers.size, 1); f.hide(); assert.equal(f.timers.size, 0);
  now += 100; f.show(); assert.equal(f.bar.data.indicatorDelay, -100); assert.equal(f.timers.size, 1);
  f.pages[0].data.commentPostId = 'post'; f.bar.syncPageState();
  assert.equal(f.timers.size, 0); assert.equal(f.bar.data.indicatorAnimating, false);
  delete f.pages[0].data.commentPostId; now += 620; f.bar.syncPageState();
  assert.equal(f.bar.data.indicatorPosition, 300); assert.equal(f.bar.data.indicatorAnimating, false);
  selection.begin(2, 3); f.bar.syncFromPage(3, {});
  const staleFinish = [...f.timers.values()][0].callback;
  f.detach(); assert.equal(f.timers.size, 0); const state = JSON.stringify(f.bar.data);
  staleFinish(); assert.equal(JSON.stringify(f.bar.data), state);
});

test('切页失败从当前位置滑回原标签，过期失败不能覆盖后续切换', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), f = fixture({ selection, switchTab() {} });
  f.pages.push({ route: 'pages/home/index', data: {} });
  f.bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  now += 80; const position = selection.read(3).position;
  const failed = f.navigation[0]; failed.fail(); failed.complete();
  assert.equal(f.bar.data.selected, 0); assert.equal(selection.read(0).position, position);
  assert.equal(f.bar.data.indicatorPosition, position); assert.equal(f.bar.data.indicatorAnimating, true);
  f.bar.switchTab({ currentTarget: { dataset: { index: 1 } } });
  const nextPosition = f.bar.data.indicatorPosition; failed.fail(); failed.complete();
  assert.equal(f.bar.data.selected, 1); assert.equal(f.bar.data.indicatorPosition, nextPosition);
  assert.equal(f.bar._switching, true);
  assert.deepEqual(f.toasts, ['页面打开失败，请重试']);
});

test('原生路由尚未完成时连点不回写源页索引，也不反弹滑块或重复发起导航', () => {
  const f = fixture({ switchTab() {} });
  f.pages.push({ route: 'pages/home/index', data: {} });
  f.bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  const position = f.bar.data.indicatorPosition;
  f.bar.switchTab({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(f.bar.data.selected, 3); assert.equal(f.bar.data.indicatorPosition, position);
  assert.deepEqual(f.routes, ['/pages/search/index']);
  f.bar.syncPageState(); assert.equal(f.bar.data.selected, 3);
});

test('原生跳转失败回退滑块并解除切换锁，保留真实错误', () => {
  const f = fixture({ switchTab() {} });
  f.pages.push({ route: 'pages/home/index', data: {} });
  f.bar.switchTab({ currentTarget: { dataset: { index: 2 } } });
  f.navigation[0].fail(); f.navigation[0].complete();
  assert.equal(f.bar.data.selected, 0); assert.equal(f.bar._switching, false);
  assert.deepEqual(f.toasts, ['页面打开失败，请重试']);
});

test('新底栏首帧不默认点亮首页，页面栈滞后时以本次导航目标初始化', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), target = fixture({ selection });
  assert.equal(target.bar.data.selected, -1);
  selection.begin(0, 3);
  target.pages.push({ route: 'pages/home/index', data: {} }); // 原生栈尚未更新
  target.attach(); assert.equal(target.bar.data.selected, -1);
  target.bar.syncFromPage(3, {});
  target.ready(); target.show(); assert.equal(target.bar.data.selected, 3);
  assert.match(target.bar.data.indicatorMotionStyle, /--tab-flight-0:translate3d\(0%,/); assert.equal(target.bar.data.indicatorTo, 300);
  target.pages[0].route = 'pages/search/index'; target.show();
  assert.equal(target.bar.data.selected, 3);
});

test('过期的目标页在新导航等待时不能启动旧动画', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), target = fixture({ selection });
  const old = selection.begin(0, 3), current = selection.begin(3, 1);
  assert.equal(selection.start(3, old), false);
  assert.equal(selection.pendingIndex(), 1);
  assert.equal(selection.start(1, current), true);
  assert.equal(selection.pendingIndex(), null);
  selection.begin(1, 2); now += 1001; assert.equal(selection.pendingIndex(), null);
});

test('源页隐藏时仅清理回调，不撤掉 CSS 动画让灰滑块跳到终点', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), f = fixture({ selection });
  selection.begin(0, 3); f.pages.push({ route: 'pages/search/index', data: {} }); f.attach(); f.show();
  const staleFinish = [...f.timers.values()][0].callback;
  const state = JSON.stringify(f.bar.data), writes = [], setData = f.bar.setData.bind(f.bar);
  f.bar.setData = (values, callback) => { writes.push(values); setData(values, callback); };
  f.hide(); assert.equal(f.timers.size, 0); assert.equal(writes.length, 0);
  f.bar.syncFromPage(3, {}); // 隐藏后迟到的同步也不得触发终点闪回。
  assert.equal(writes.length, 0);
  staleFinish(); assert.equal(JSON.stringify(f.bar.data), state);
  now += 80; f.show(); assert.equal(f.bar.data.indicatorDelay, -80);
});

test('快速反向时在同一补丁内更换动画名并从采样位置开始', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), f = fixture({ selection, switchTab() {} });
  selection.begin(0, 3); f.pages.push({ route: 'pages/search/index', data: {} }); f.attach();
  now += 80;
  const position = selection.read(3).position, writes = [], setData = f.bar.setData.bind(f.bar);
  f.bar.setData = (values, callback) => { writes.push(values); setData(values, callback); };
  f.bar.switchTab({ currentTarget: { dataset: { index: 1 } } });
  const [handoff] = writes.filter(values => 'indicatorAnimating' in values);
  assert.equal(handoff.selected, 1);
  assert.equal(handoff.indicatorAnimating, true);
  assert.equal(handoff.indicatorPosition, position);
  const target = fixture({ selection }); target.pages.push({ route: 'pages/inbox/index', data: {} });
  target.attach(); target.show();
  assert.equal(target.bar.data.indicatorPosition, position);
  assert.equal(target.bar.data.indicatorTo, 100);
  assert.notEqual(target.bar.data.indicatorVariant, false);
});

test('缩小的首页底栏切到其他标签恢复原尺寸，失败则保留首页的紧凑状态', () => {
  const f = fixture({ switchTab() {} });
  f.pages.push({ route: 'pages/home/index', data: { chromeCompact: true } }); f.attach();
  assert.equal(f.bar.data.compact, true);
  f.bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.equal(f.bar.data.compact, false); assert.equal(f.bar.data.selected, 3);
  assert.equal(f.bar.data.dockHandoff, true);
  f.navigation[0].fail(); f.navigation[0].complete();
  assert.equal(f.bar.data.compact, true); assert.equal(f.bar.data.selected, 0);
  assert.equal(f.bar.data.dockHandoff, false);
  f.bar.switchTab({ currentTarget: { dataset: { index: 1 } } });
  f.pages[0] = { route: 'pages/inbox/index', data: { chromeCompact: true } };
  f.navigation[1].complete(); f.show(); assert.equal(f.bar.data.compact, false);
});

test('首页滚动时底栏晚初始化能恢复紧凑状态，其他原生标签页始终显示正常大小', () => {
  const f = fixture(); f.pages.push({ route: 'pages/home/index', data: { chromeCompact: true } });
  f.attach(); f.ready(); f.show(); assert.equal(f.bar.data.compact, true);
  for (const route of ['pages/inbox/index', 'pages/messages/index', 'pages/search/index']) {
    const target = fixture(); target.pages.push({ route, data: { chromeCompact: true } });
    target.attach(); target.show(); assert.equal(target.bar.data.compact, route === 'pages/search/index');
  }
});
