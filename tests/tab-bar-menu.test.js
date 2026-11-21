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
    if (before.selected !== this.data.selected) definition.observers.selected.call(this, this.data.selected);
    if (['authBlocked', 'commentsOpen', 'composerOpen', 'menuOpen'].some(key => before[key] !== this.data[key]))
      definition.observers['authBlocked, commentsOpen, composerOpen, menuOpen'].call(this);
    if (callback) callback();
  } };
  return { bar, routes, pages, navigation, toasts, selection, timers,
    attach: () => definition.lifetimes.attached.call(bar), ready: () => definition.lifetimes.ready.call(bar),
    show: () => definition.pageLifetimes.show.call(bar), hide: () => definition.pageLifetimes.hide.call(bar),
    detach: () => definition.lifetimes.detached.call(bar) };
}

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
      require: name => name.includes('services/user') ? { searchSessionKey: () => 'guest:0', consumeSearchEntry: () => null } : name.includes('tab-selection') ? { pendingIndex: () => null } : name.includes('search-query') ? require('../miniprogram/utils/search-query') : require('../miniprogram/utils/secondary-tab-page'),
      wx: new Proxy({}, { get() { throw new Error('占位页面不应发起请求'); } }),
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

test('无过渡能力的页面使用原生切页兜底，底栏从共享进度接续且重复就绪不重播', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), sourceTicks = [], targetTicks = [];
  const source = fixture({ selection, switchTab() {}, nextTick: callback => sourceTicks.push(callback) });
  source.pages.push({ route: 'pages/home/index', data: {} }); source.attach();
  source.bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.deepEqual(source.routes, ['/pages/search/index']); assert.equal(source.bar.data.selected, 3);
  assert.equal(source.bar.data.indicatorAnimating, false, '原生切页不等待动画开始或结束');
  now += 32; sourceTicks.shift()();
  assert.equal(source.bar.data.indicatorDelay, -32); assert.equal(source.bar.data.indicatorAnimating, true);
  source.hide(); assert.equal(source.timers.size, 0);
  const target = fixture({ selection, nextTick: callback => targetTicks.push(callback) });
  target.pages.push({ route: 'pages/search/index', data: {} }); target.attach();
  assert.equal(target.bar.data.indicatorPosition, selection.read(3).position);
  assert.ok(target.bar.data.indicatorPosition > 0 && target.bar.data.indicatorPosition < 300);
  target.ready(); target.show(); assert.equal(targetTicks.length, 1);
  now += 16; targetTicks.shift()();
  assert.equal(target.bar.data.indicatorDelay, -48); assert.equal(target.bar.data.indicatorFrom, 0);
  assert.equal(target.bar.data.indicatorTo, 300); assert.equal(target.timers.size, 1);
  assert.equal([...target.timers.values()][0].delay, 272);
  now = 1320; [...target.timers.values()][0].callback();
  assert.equal(target.bar.data.indicatorAnimating, false); assert.equal(target.bar.data.indicatorPosition, 300);
});

test('快速反向切换从当前滑动坐标继续，旧帧与旧结束回调不能拉回滑块', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), ticks = [];
  selection.begin(0, 3);
  const f = fixture({ selection, switchTab() {}, nextTick: callback => ticks.push(callback) });
  f.pages.push({ route: 'pages/search/index', data: {} }); f.attach(); ticks.shift()();
  const staleFinish = [...f.timers.values()][0].callback;
  now = 1096; const position = selection.read(3).position;
  f.bar.switchTab({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(f.bar.data.indicatorPosition, position); assert.equal(selection.read(1).from, position);
  ticks.shift()(); assert.equal(f.bar.data.indicatorTo, 100);
  staleFinish(); assert.equal(f.bar.data.indicatorTo, 100); assert.equal(f.bar.data.indicatorAnimating, true);
  const interrupted = fixture({ selection, nextTick: callback => ticks.push(callback) });
  interrupted.pages.push({ route: 'pages/inbox/index', data: {} }); interrupted.attach();
  const oldFrame = ticks.shift(); interrupted.hide(); oldFrame();
  assert.equal(interrupted.bar.data.indicatorAnimating, false); assert.equal(interrupted.timers.size, 0);
});

test('直接进入标签页不从首页虚假滑动，过期动画也只呈现正确终点', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), f = fixture({ selection });
  f.pages.push({ route: 'pages/messages/index', data: {} }); f.attach(); f.ready(); f.show();
  assert.equal(f.bar.data.selected, 2); assert.equal(f.bar.data.indicatorPosition, 200);
  assert.equal(f.bar.data.indicatorAnimating, false); assert.equal(f.timers.size, 0);
  selection.begin(0, 2); now += 500;
  const late = fixture({ selection }); late.pages.push({ route: 'pages/messages/index', data: {} }); late.attach();
  assert.equal(late.bar.data.indicatorPosition, 200); assert.equal(late.bar.data.indicatorAnimating, false);
});

test('隐藏、遮挡和销毁取消本地动画，返回时只接续尚未结束的共享进度', () => {
  let now = 1000;
  const selection = createTabSelection(() => now); selection.begin(0, 3);
  const f = fixture({ selection }); f.pages.push({ route: 'pages/search/index', data: {} }); f.attach();
  assert.equal(f.timers.size, 1); f.hide(); assert.equal(f.timers.size, 0);
  now += 100; f.show(); assert.equal(f.bar.data.indicatorDelay, -100); assert.equal(f.timers.size, 1);
  f.pages[0].data.commentPostId = 'post'; f.bar.syncPageState();
  assert.equal(f.timers.size, 0); assert.equal(f.bar.data.indicatorAnimating, false);
  delete f.pages[0].data.commentPostId; now += 250; f.bar.syncPageState();
  assert.equal(f.bar.data.indicatorPosition, 300); assert.equal(f.bar.data.indicatorAnimating, false);
  selection.begin(3, 2); f.pages[0].route = 'pages/messages/index'; f.bar.syncPageState();
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
  assert.equal(f.bar.data.selected, 0); assert.equal(selection.read(0).from, position);
  assert.equal(f.bar.data.indicatorTo, 0); assert.equal(f.bar.data.indicatorAnimating, true);
  f.bar.switchTab({ currentTarget: { dataset: { index: 1 } } });
  const nextPosition = f.bar.data.indicatorPosition; failed.fail();
  assert.equal(f.bar.data.selected, 1); assert.equal(f.bar.data.indicatorPosition, nextPosition);
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
  const id = selection.begin(0, 3);
  target.pages.push({ route: 'pages/home/index', data: {} }); // 原生栈尚未更新
  target.attach(); assert.equal(target.bar.data.selected, 3);
  target.ready(); target.show(); assert.equal(target.bar.data.selected, 3);
  assert.equal(target.bar.data.indicatorFrom, 0); assert.equal(target.bar.data.indicatorTo, 300);
  selection.complete(id); target.pages[0].route = 'pages/search/index'; target.show();
  assert.equal(target.bar.data.selected, 3);
});

test('新底栏初始化早于页面栈时使用导航目标；完成后的过期回调不抹掉新目标', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), target = fixture({ selection });
  const old = selection.begin(0, 3), current = selection.begin(3, 1);
  selection.complete(old); target.attach(); assert.equal(target.bar.data.selected, 1);
  selection.complete(current); assert.equal(selection.pendingIndex(), null);
  selection.begin(1, 2); now += 1001; assert.equal(selection.pendingIndex(), null);
});

test('源页隐藏时仅清理回调，不撤掉 CSS 动画让灰滑块跳到终点', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), f = fixture({ selection });
  selection.begin(0, 3); f.pages.push({ route: 'pages/search/index', data: {} }); f.attach();
  const staleFinish = [...f.timers.values()][0].callback;
  const state = JSON.stringify(f.bar.data), writes = [], setData = f.bar.setData.bind(f.bar);
  f.bar.setData = (values, callback) => { writes.push(values); setData(values, callback); };
  f.hide(); assert.equal(f.timers.size, 0); assert.equal(writes.length, 0);
  f.bar.syncIndicator(f.bar.data.selected); // 隐藏后迟到的遮挡状态同步也不得触发终点闪回。
  assert.equal(writes.length, 0);
  staleFinish(); assert.equal(JSON.stringify(f.bar.data), state);
  now += 80; f.show(); assert.equal(f.bar.data.indicatorDelay, -80);
});

test('快速反向时撤掉旧 CSS 动画与写入采样位置在同一补丁内，不暴露旧终点', () => {
  let now = 1000;
  const selection = createTabSelection(() => now), f = fixture({ selection, switchTab() {} });
  selection.begin(0, 3); f.pages.push({ route: 'pages/search/index', data: {} }); f.attach();
  now += 80;
  const position = selection.read(3).position, writes = [], setData = f.bar.setData.bind(f.bar);
  f.bar.setData = (values, callback) => { writes.push(values); setData(values, callback); };
  f.bar.switchTab({ currentTarget: { dataset: { index: 1 } } });
  const resets = writes.filter(values => values.indicatorAnimating === false);
  assert.equal(resets.length, 1);
  assert.equal(resets[0].indicatorPosition, position);
});

test('准备正文淡出后立即原生换页，不等待视图回调；成功后通知源页清理', () => {
  const ticks = [], f = fixture({ switchTab() {}, nextTick: callback => ticks.push(callback) });
  const finished = [], requested = [];
  f.pages.push({ route: 'pages/home/index', data: {},
    prepareTabLeave(route) { requested.push(route); return 42; },
    finishTabLeave(ticket) { finished.push(ticket); } });
  f.bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.deepEqual(f.routes, ['/pages/search/index']); assert.deepEqual(requested, f.routes);
  assert.deepEqual(finished, []); f.navigation[0].success();
  assert.deepEqual(finished, [42]);
});

test('原生跳转失败同时恢复源页过渡及滑块，旧失败不干扰新请求', () => {
  const f = fixture({ switchTab() {} }); const cancelled = [];
  f.pages.push({ route: 'pages/home/index', data: {},
    prepareTabLeave() { return 9; }, cancelTabLeave(ticket) { cancelled.push(ticket); } });
  f.bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  const old = f.navigation[0]; old.fail(); old.complete();
  assert.deepEqual(cancelled, [9]); assert.equal(f.bar.data.selected, 0);
  f.bar.switchTab({ currentTarget: { dataset: { index: 1 } } }); old.fail();
  assert.deepEqual(cancelled, [9]); assert.equal(f.bar.data.selected, 1);
});

test('缩小的首页底栏切到其他标签恢复原尺寸，失败则保留首页的紧凑状态', () => {
  const f = fixture({ switchTab() {} });
  f.pages.push({ route: 'pages/home/index', data: { chromeCompact: true } }); f.attach();
  assert.equal(f.bar.data.compact, true);
  f.bar.switchTab({ currentTarget: { dataset: { index: 3 } } });
  assert.equal(f.bar.data.compact, false); assert.equal(f.bar.data.selected, 3);
  f.navigation[0].fail(); f.navigation[0].complete();
  assert.equal(f.bar.data.compact, true); assert.equal(f.bar.data.selected, 0);
  f.bar.switchTab({ currentTarget: { dataset: { index: 1 } } });
  f.pages[0] = { route: 'pages/inbox/index', data: { chromeCompact: true } };
  f.navigation[1].complete(); f.show(); assert.equal(f.bar.data.compact, false);
});

test('首页滚动时底栏晚初始化能恢复紧凑状态，其他原生标签页始终显示正常大小', () => {
  const f = fixture(); f.pages.push({ route: 'pages/home/index', data: { chromeCompact: true } });
  f.attach(); f.ready(); f.show(); assert.equal(f.bar.data.compact, true);
  for (const route of ['pages/inbox/index', 'pages/messages/index', 'pages/search/index']) {
    f.pages[0] = { route, data: { chromeCompact: true } }; f.show(); assert.equal(f.bar.data.compact, false);
  }
});
