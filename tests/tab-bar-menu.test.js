const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  let definition;
  const routes = [];
  const pages = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/custom-tab-bar/index.js'), 'utf8'), {
    Component: value => { definition = value; },
    getCurrentPages: () => pages,
    wx: { switchTab: value => { routes.push(value.url); value.complete(); }, showToast() {} },
  });
  const bar = { ...definition.methods, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  return { bar, routes, pages, attach: () => definition.lifetimes.attached.call(bar), ready: () => definition.lifetimes.ready.call(bar), show: () => definition.pageLifetimes.show.call(bar) };
}

test('菜单展开时点导航只收起当前主页菜单，收起后导航正常切换', () => {
  const { bar, routes, pages } = fixture();
  let closed = 0;
  pages.push({ closeMenu() { throw new Error('不应操作前一个页面'); } });
  pages.push({ closeMenu() { closed += 1; bar.data.menuOpen = false; } });
  bar.data.selected = 4;
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
  bar.data.selected = 4;
  bar.data.authBlocked = true;
  bar.switchTab({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(routes.length, 0);
  bar.data.authBlocked = false;
  bar.switchTab({ currentTarget: { dataset: { index: 0 } } });
  assert.deepEqual(routes, ['/pages/home/index']);
});

test('最右导航显示搜索图标并打开搜索页', () => {
  const { bar, routes } = fixture();
  assert.equal(bar.data.items[4].label, '搜索');
  assert.equal(bar.data.items[4].icon, 'search');
  bar.data.selected = 0;
  bar.switchTab({ currentTarget: { dataset: { index: 4 } } });
  assert.deepEqual(routes, ['/pages/search/index']);
});

test('评论面板期间底栏不接受迟到的点击事件，收起评论后恢复切页', () => {
  const { bar, routes } = fixture();
  bar.data.commentsOpen = true;
  bar.switchTab({ currentTarget: { dataset: { index: 4 } } });
  assert.equal(routes.length, 0);
  bar.data.commentsOpen = false;
  bar.switchTab({ currentTarget: { dataset: { index: 4 } } });
  assert.deepEqual(routes, ['/pages/search/index']);
});

test('发布及其设置面板期间底栏禁止切页，关闭发布后正常恢复', () => {
  const { bar, routes } = fixture();
  bar.data.composerOpen = true;
  bar.switchTab({ currentTarget: { dataset: { index: 4 } } });
  assert.equal(routes.length, 0);
  bar.data.composerOpen = false;
  bar.switchTab({ currentTarget: { dataset: { index: 4 } } });
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
  f.bar.switchTab({ currentTarget: { dataset: { index: 4 } } }); assert.equal(f.routes.length, 0);
  page.data.composerOpen = false; f.show();
  assert.equal(f.bar.data.composerOpen, false); assert.equal(f.bar.data.authBlocked, false);
  f.bar.switchTab({ currentTarget: { dataset: { index: 4 } } }); assert.deepEqual(f.routes, ['/pages/search/index']);
});

test('切到其他页面后底栏不沿用发布页的遮挡状态', () => {
  const f = fixture(); f.pages.push({ data: { composerOpen: true } }); f.attach();
  f.pages.push({ data: {} }); f.show();
  assert.equal(f.bar.data.composerOpen, false); assert.equal(f.bar.data.authBlocked, false);
});
