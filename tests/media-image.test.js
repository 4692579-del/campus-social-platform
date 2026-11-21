const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const layout = require('../miniprogram/utils/post-image-layout');

function fixture(src, options = {}) {
  let definition, intersect, disconnected = 0;
  const patches = [], events = [];
  vm.runInNewContext(fs.readFileSync('miniprogram/components/media-image/index.js', 'utf8'), {
    Component: value => { definition = value; }, require: () => layout,
  });
  const c = { ...definition.methods, data: { ...structuredClone(definition.data), src },
    setData(patch) { patches.push(patch); Object.assign(this.data, patch); },
    triggerEvent(name, detail) { events.push({ name, detail }); },
    createIntersectionObserver() { return {
      relativeToViewport() { return this; },
      observe(selector, callback) { intersect = callback; },
      disconnect() { disconnected++; },
    }; },
  };
  if (options.noObserver) delete c.createIntersectionObserver;
  definition.observers.src.call(c, src);
  definition.lifetimes.attached.call(c);
  definition.lifetimes.ready.call(c);
  return { c, definition, patches, events,
    source(value) { definition.observers.src.call(c, value); },
    load(key = c._generation, width = 800, height = 600) { c.loaded({ currentTarget: { dataset: { key } }, detail: { width, height } }); },
    error(key = c._generation) { c.loadFailed({ currentTarget: { dataset: { key } } }); },
    visible(value) { intersect({ intersectionRatio: value ? 1 : 0 }); },
    hide() { definition.pageLifetimes.hide.call(c); },
    show() { definition.pageLifetimes.show.call(c); },
    detach() { definition.lifetimes.detached.call(c); },
    get disconnected() { return disconnected; },
  };
}

test('扫光只等真实解码；同图更新、切页和返回均保留原节点与加载状态', () => {
  const f = fixture('cloud://test/square-media/owner/p_one/0.jpg');
  const nodes = f.c.data.nodes;
  assert.equal(f.c.data.ready, false);
  f.visible(true); assert.equal(f.c.data.active, true);
  f.load(); assert.equal(f.c.data.ready, true);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].name, 'load');
  assert.equal(f.events[0].detail.width, 800);
  const count = f.patches.length;
  f.source(f.c._source); f.load();
  assert.equal(f.patches.length, count);
  f.hide(); f.show();
  assert.equal(f.c.data.nodes, nodes); assert.equal(f.c.data.ready, true);
  assert.ok(f.patches.slice(count).every(patch => Object.keys(patch).every(key => key === 'active')));
});

test('换图后旧load/error无效；卸载后观察器和迟到事件不再写视图', () => {
  const f = fixture('first'), oldKey = f.c._generation;
  f.source('second'); const nodes = f.c.data.nodes, count = f.patches.length;
  f.load(oldKey); f.error(oldKey);
  assert.equal(f.patches.length, count); assert.equal(f.events.length, 0);
  f.load(); assert.equal(f.c.data.ready, true); assert.equal(f.c.data.nodes, nodes);
  f.detach(); const final = f.patches.length;
  f.visible(true); f.load(); f.error(); f.source('third'); f.show();
  assert.equal(f.patches.length, final); assert.equal(f.disconnected, 1);
});

test('尺寸缓存只提示避免重复淡入，新节点仍须等自己的真实load', () => {
  const file = 'cloud://test/square-media/owner/p_known/0.jpg';
  const first = fixture(file); first.load();
  const next = fixture(file);
  assert.equal(next.c.data.known, true); assert.equal(next.c.data.ready, false);
  next.load(); assert.equal(next.c.data.ready, true);
  for (const src of ['https://test/photo.jpg?signature=private', 'cloud://test/square-uploads/owner/private.jpg']) {
    const f = fixture(src); f.load();
    assert.equal(layout.hasDecodedSize(src), false);
  }
});

test('离开视口和页面隐藏暂停扫光，隐藏期完成解码返回不重播淡入', () => {
  const f = fixture('hidden-photo');
  f.visible(true); f.hide(); assert.equal(f.c.data.active, false);
  f.load(); assert.equal(f.c.data.ready, true); assert.equal(f.c.data.known, true);
  const nodes = f.c.data.nodes;
  f.show(); assert.equal(f.c.data.active, true); assert.equal(f.c.data.nodes, nodes);
  f.visible(false); assert.equal(f.c.data.active, false);
});

test('真实失败停止扫光并保留占位，不假装成功、不重设图片源或自动重试', () => {
  const f = fixture('broken'), nodes = f.c.data.nodes;
  f.error(); const count = f.patches.length;
  f.error(); f.source('broken');
  assert.equal(f.c.data.failed, true); assert.equal(f.c.data.ready, false);
  assert.equal(f.patches.length, count); assert.equal(f.c.data.nodes, nodes);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].name, 'error');
  const invalid = fixture('invalid'); invalid.load(undefined, 0, 0);
  assert.equal(invalid.c.data.failed, true); assert.equal(invalid.c.data.ready, false);
});

test('观察器不可用时仍能正常扫光及完成加载', () => {
  const f = fixture('fallback', { noObserver: true });
  assert.equal(f.c.data.active, true); f.load(); assert.equal(f.c.data.ready, true);
});
