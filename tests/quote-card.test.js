const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { applyPageData } = require('./helpers/post-actions-fixture');
const quote = { _id: 'p_' + 'a'.repeat(40), content: '原动态全文', author: { nickname: '真实作者' }, images: ['one', 'two'] };
function fixture() {
  let definition;
  const patches = [], routes = [], events = [], toasts = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/components/quote-card/index.js'), 'utf-8'), {
    Component: value => { definition = value; },
    require: name => name.includes('post-image-layout') ? require('../miniprogram/utils/post-image-layout') : require('../miniprogram/utils/post-view'),
    wx: { navigateTo: args => routes.push(args.url), showToast: args => toasts.push(args.title) },
  });
  const c = { ...definition.methods, data: { ...structuredClone(definition.data), removable: false, disabled: false },
    setData(values) { patches.push(values); applyPageData(this.data, values); }, triggerEvent(name) { events.push(name); } };
  return { c, patches, routes, events, toasts, show: () => definition.pageLifetimes.show.call(c),
    set(value) { c.data.quote = value; definition.observers.quote.call(c, value); } };
}
test('引用卡片保留图片节点和页码；点击跳到被引用详情，编辑态只能移除', () => {
  const f = fixture(); f.set(quote);
  f.c.imageChanged({ currentTarget: { dataset: { frame: 0 } }, detail: { current: 1 } }); f.patches.length = 0;
  f.set({ ...quote, images: [...quote.images] });
  assert.equal(f.c.data.frames[0].imageIndex, 1); assert.equal(f.patches.length, 0);
  f.c.open({ currentTarget: { dataset: { id: quote._id } } }); assert.equal(f.routes[0], `/pages/square-detail/index?id=${quote._id}`);
  f.show(); f.c.data.removable = true; f.c.open({ currentTarget: { dataset: { id: quote._id } } }); assert.equal(f.routes.length, 1);
  f.c.remove(); assert.equal(f.events[0], 'remove');
  f.c.data.disabled = true; f.c.remove(); assert.equal(f.events.length, 1);
});
test('删除的引用不保留正文图片，不可见卡片不假装跳转成功', () => {
  const f = fixture(); f.set(quote); f.set({ _id: quote._id, unavailable: true });
  assert.equal(f.c.data.frames[0].content, ''); assert.equal(f.c.data.frames[0].images.length, 0);
  f.c.open({ currentTarget: { dataset: { id: quote._id } } }); assert.equal(f.routes.length, 0); assert.equal(f.toasts.length, 1);
});
