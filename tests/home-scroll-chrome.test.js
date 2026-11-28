const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDirectionTracker } = require('../miniprogram/utils/home-scroll-chrome');

function fixture() {
  let now = 1000;
  const context = { module: { exports: {} }, require: () => require('../miniprogram/utils/tab-page-layout'),
    Date: { now: () => now },
    wx: { getWindowInfo: () => ({ windowHeight: 800, statusBarHeight: 44 }) },
    setTimeout() { assert.fail('滚动尺寸不能依赖计时器或逐帧同步'); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/home-scroll-chrome.js'), 'utf8'), context);
  const definition = context.module.exports, writes = [], navWrites = [];
  const bar = { data: { compact: false }, setData(values) { navWrites.push(values); Object.assign(this.data, values); } };
  const posts = [{ _id: 'real-post', images: ['cloud://real/photo.jpg'], imageIndex: 2 }];
  const page = { ...definition.methods, _visible: true,
    data: { ...definition.data, activeTab: 'square', navTop: 52, navHeight: 92, brandRefreshPhase: 'idle', posts },
    interactionBlocked() { return Boolean(this.data.composerOpen || this.data.loginSheetOpen || this.data.authChecking); },
    getTabBar: () => bar,
    syncNavigation() { if (bar.data.compact !== this.data.chromeCompact) bar.setData({ compact: this.data.chromeCompact }); },
    setData(values) { writes.push(values); Object.assign(this.data, values); } };
  page.configureHomeChrome(); page.resetHomeChrome(); writes.length = 0;
  return { page, bar, posts, writes, navWrites,
    advance(ms) { now += ms; },
    touch(key = 'square') { page.onHomeFeedTouchStart({ currentTarget: { dataset: { feed: key } } }); },
    scroll(top, key = 'square', height = 2000) { page.onHomeFeedScroll({ currentTarget: { dataset: { feed: key } }, detail: { scrollTop: top, scrollHeight: height } }); },
  };
}

test('微小抖动不反复切换，向下与向上分别产生紧凑和正常两个目标', () => {
  const tracker = createDirectionTracker(0);
  assert.equal(tracker.update(2), null); assert.equal(tracker.update(4), true);
  assert.equal(tracker.update(3), null); assert.equal(tracker.update(5), null);
  assert.equal(tracker.update(9), true); assert.equal(tracker.update(5), false);
  assert.equal(tracker.update(0), false);
});

test('下滑缩小、上滑恢复；持续同向滚动不重复setData，不重写列表、图片或原生滚动位置', () => {
  const f = fixture(); f.touch(); f.scroll(4);
  assert.equal(f.page.data.chromeSafeTop, 44); assert.equal(f.page.data.chromeHeaderHeight, 136.5);
  assert.equal(f.page.data.chromeCompact, true); assert.equal(f.bar.data.compact, true);
  for (const top of [20, 40, 100, 180]) f.scroll(top);
  assert.equal(f.writes.length, 1); assert.equal(f.navWrites.length, 1);
  f.scroll(176); assert.equal(f.page.data.chromeCompact, false); assert.equal(f.bar.data.compact, false);
  assert.deepEqual(f.writes.map(value => value.chromeCompact), [true, false]);
  assert.equal(f.page.data.posts, f.posts); assert.equal(f.page.data.posts[0].imageIndex, 2);
  for (const values of f.writes) assert.deepEqual(Object.keys(values), ['chromeCompact']);
});

test('停止滚动时只有布尔目标，无百分比或按距离停留的中间尺寸', () => {
  const f = fixture(); f.touch(); f.scroll(7);
  const stopped = JSON.stringify(f.page.data), writes = f.writes.length;
  for (let i = 0; i < 10; i++) f.scroll(7);
  assert.equal(JSON.stringify(f.page.data), stopped); assert.equal(f.writes.length, writes);
  f.scroll(3); assert.equal(f.page.data.chromeCompact, false);
  assert.deepEqual(f.writes.map(value => typeof value.chromeCompact), ['boolean', 'boolean']);
});

test('顶部回弹、底部回弹与不可滚动的短列表不会反复展开收起', () => {
  const f = fixture(); f.touch(); f.scroll(1100, 'square', 2000); f.scroll(1260, 'square', 2000);
  assert.equal(f.page.data.chromeCompact, true);
  const count = f.writes.length; f.scroll(1200, 'square', 2000); assert.equal(f.writes.length, count);
  f.scroll(1195, 'square', 2000); assert.equal(f.page.data.chromeCompact, false);
  f.scroll(-20); assert.equal(f.page.data.chromeCompact, false);
  f.scroll(0); assert.equal(f.page.data.chromeCompact, false);
  f.scroll(40, 'square', 500); assert.equal(f.page.data.chromeCompact, false);
});

test('隐藏页和非当前列表的迟到滚动无效，恢复滚动位置不被误当作用户向下浏览', () => {
  const f = fixture(); f.scroll(600); assert.equal(f.writes.length, 0);
  f.scroll(700, 'campus'); assert.equal(f.writes.length, 0);
  f.touch(); f.scroll(604); assert.equal(f.page.data.chromeCompact, true);
  f.page._visible = false; f.scroll(400); assert.equal(f.page.data.chromeCompact, true);
  f.page._visible = true; f.page.resetHomeChrome(true); assert.equal(f.page.data.chromeCompact, false);
  for (const top of [604, 620, 640]) f.scroll(top);
  assert.equal(f.page.data.chromeCompact, false); assert.equal(f.bar.data.compact, false);
  f.advance(150); // 某些原生滚动只派发 scroll，不能永久等 touchstart/dragstart。
  f.scroll(644); assert.equal(f.page.data.chromeCompact, true);
  f.scroll(638); assert.equal(f.page.data.chromeCompact, false);
});

test('返回时开始真实拖动，可立即结束恢复滚动保护', () => {
  const f = fixture();
  f.page.resetHomeChrome(true); f.scroll(400);
  f.page.onHomeFeedDragStart({ currentTarget: { dataset: { feed: 'square' } } });
  f.scroll(410);
  assert.equal(f.bar.data.compact, true);
});

test('菜单、评论、发布及刷新期间恢复头部，不跟随滚动缩小；切页中的惯性滚动不改导航状态', () => {
  for (const state of [{ menuOpen: true }, { commentPostId: 'post' },
    { composerOpen: true }, { loginSheetOpen: true }, { brandRefreshPhase: 'loading' }]) {
    const f = fixture(); f.touch(); f.scroll(20); Object.assign(f.page.data, state); f.scroll(40);
    assert.equal(f.page.data.chromeCompact, false); assert.equal(f.bar.data.compact, false);
  }
  const f = fixture(); f.touch(); f.scroll(20); f.bar._switching = true; f.scroll(10);
  assert.equal(f.page.data.chromeCompact, true);
});
