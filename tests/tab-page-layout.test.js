const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const layout = require('../miniprogram/utils/tab-page-layout');

test('四个原生标签页保持同样的全屏视窗、顶部计算和白色背景，不混用系统顶栏', () => {
  const root = path.join(__dirname, '../miniprogram');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.equal(app.tabBar.custom, true);
  for (const tab of app.tabBar.list) {
    const config = JSON.parse(fs.readFileSync(path.join(root, tab.pagePath + '.json'), 'utf8'));
    assert.equal(config.navigationStyle, 'custom', tab.pagePath);
    assert.equal(config.disableScroll, true, tab.pagePath);
    assert.equal(config.backgroundColor, '#FFFFFF', tab.pagePath);
  }
  const measured = layout.readTabLayout({ getWindowInfo: () => ({ statusBarHeight: 54, windowWidth: 393 }),
    getMenuButtonBoundingClientRect: () => ({ top: 60, height: 32 }) });
  assert.deepEqual(measured, { navTop: 60, navButtonHeight: 32, navHeight: 100, windowWidth: 393 });
});

test('旧客户端、无效胶囊及缺失窗口 API 均有稳定的顶部留白', () => {
  assert.deepEqual(layout.readTabLayout({}), { ...layout.DEFAULT_LAYOUT, windowWidth: 375 });
  const measured = layout.readTabLayout({ getWindowInfo: () => ({ statusBarHeight: 20, screenWidth: 320 }),
    getMenuButtonBoundingClientRect: () => ({ top: 0, height: 0 }) });
  assert.deepEqual(measured, { navTop: 28, navButtonHeight: 32, navHeight: 68, windowWidth: 320 });
});

test('占位页切换只同步变化的导航状态，不重复写顶部、不清空搜索草稿、不请求业务', () => {
  for (const index of [1, 2, 3]) {
    let factory;
    const apiCalls = [], pageWrites = [], barWrites = [];
    const api = { getWindowInfo() { apiCalls.push('window'); return { statusBarHeight: 54, windowWidth: 393 }; },
      getMenuButtonBoundingClientRect() { apiCalls.push('capsule'); return { top: 60, height: 32 }; } };
    const context = { module: { exports: {} }, require: name => name === './tab-page-motion' ? require('../miniprogram/utils/tab-page-motion') : layout,
      wx: new Proxy(api, { get(target, key) { assert.ok(key in target, '不得调用业务或路由 API：' + String(key)); return target[key]; } }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/secondary-tab-page.js'), 'utf8'), context);
    factory = context.module.exports;
    const definition = factory(index, { data: { keyword: '尚未提交' } });
    const bar = { data: { selected: -1, menuOpen: false, authBlocked: false, commentsOpen: false, composerOpen: false },
      setData(value) { barWrites.push(value); Object.assign(this.data, value); } };
    const page = { ...definition, data: { ...definition.data }, getTabBar: () => bar,
      setData(value) { pageWrites.push(value); Object.assign(this.data, value); } };
    page.onLoad(); assert.equal(page.data.navHeight, 100);
    const count = pageWrites.length;
    page.onShow(); page.onReady(); page.onHide(); page.onShow(); page.onResize();
    assert.equal(page.data.keyword, '尚未提交');
    assert.equal(pageWrites.length, count, '重复进入或相同尺寸不重复写视图');
    assert.equal(barWrites.length, 1); assert.equal(bar.data.selected, index);
    assert.deepEqual(apiCalls, ['window', 'capsule', 'window', 'capsule']);
    page.onUnload(); assert.equal(page._visible, false); assert.equal(page._unloaded, true);
  }
});
