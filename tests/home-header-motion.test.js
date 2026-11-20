const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const context = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/home/header-motion.wxs'), 'utf8'), context);
  const handlers = context.module.exports, state = {}, styles = [], forwarded = [];
  const owner = {
    getState: () => state,
    selectComponent(selector) {
      assert.equal(selector, '.home-header', '滚动过程中只能移动标题栏，不能移动列表或整页');
      return { setStyle(values) { styles.push(values); } };
    },
    callMethod(name, event) { assert.equal(name, 'onHomeFeedScroll'); forwarded.push(event); },
  };
  let config = { compact: false, active: 'square', header: 136.5, safe: 44, blocked: false };
  const result = {
    styles, forwarded,
    sync(values) { const old = config; config = { ...config, ...values }; handlers.sync(config, old, owner); },
    scroll(top, key = 'square') { handlers.scroll({ instance: { getDataset: () => ({ feed: key }) },
      detail: { scrollTop: top, scrollHeight: 2000 } }, owner); },
  };
  result.sync({}); return result;
}

test('开始下滑时标题栏位移不超过真实已滚动距离，不额外拉动内容', () => {
  const f = fixture(); f.scroll(4); f.sync({ compact: true });
  assert.equal(f.styles.at(-1).transform, 'translateY(-4px)');
  f.scroll(30); assert.equal(f.styles.at(-1).transform, 'translateY(-30px)');
  f.scroll(100); assert.equal(f.styles.at(-1).transform, 'translateY(-92.5px)');
  assert.equal(f.styles.at(-1)['pointer-events'], 'none');
  const count = f.styles.length;
  f.scroll(500); f.scroll(900); assert.equal(f.styles.length, count, '完全收起后不重复写样式');
});

test('向上恢复标题栏、回到顶部或打开遮挡面板，都只修改头部样式', () => {
  const f = fixture(); f.scroll(400); f.sync({ compact: true });
  f.sync({ compact: false }); assert.equal(f.styles.at(-1).transform, 'translateY(-0px)');
  assert.equal(f.styles.at(-1)['pointer-events'], 'auto');
  f.sync({ compact: true }); f.scroll(-10);
  assert.equal(f.styles.at(-1).transform, 'translateY(-0px)');
  f.scroll(400); f.sync({ blocked: true });
  assert.equal(f.styles.at(-1).transform, 'translateY(-0px)');
});

test('列表独立保留位置，隐藏列表的事件不改当前头部，仍转交原方向和防回弹逻辑', () => {
  const f = fixture(); f.scroll(300); f.sync({ compact: true });
  const count = f.styles.length, calls = f.forwarded.length;
  f.scroll(0, 'campus'); assert.equal(f.styles.length, count); assert.equal(f.forwarded.length, calls);
  f.sync({ active: 'campus' }); assert.equal(f.styles.at(-1).transform, 'translateY(-0px)');
  f.scroll(8, 'campus'); assert.equal(f.styles.at(-1).transform, 'translateY(-8px)');
  assert.equal(f.forwarded.at(-1).detail.scrollTop, 8);
  assert.equal(f.forwarded.at(-1).currentTarget.dataset.feed, 'campus');
});

