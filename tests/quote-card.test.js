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
    require: name => require('../miniprogram/utils/' + name.split('/').pop()),
    wx: { navigateTo: args => routes.push(args.url), showToast: args => toasts.push(args.title) },
  });
  const c = { ...definition.methods, data: { ...structuredClone(definition.data), removable: false, disabled: false },
    setData(values) { patches.push(values); applyPageData(this.data, values); }, triggerEvent(name) { events.push(name); } };
  return { c, patches, routes, events, toasts, show: () => definition.pageLifetimes.show.call(c), hide: () => definition.pageLifetimes.hide.call(c),
    set(value) { c.data.quote = value; definition.observers.quote.call(c, value); } };
}
test('引用卡片保留图片节点；点击跳到被引用详情，编辑态只能移除', () => {
  const f = fixture(); f.set(quote);
  const images = f.c.data.frames[0].images;
  f.patches.length = 0;
  f.set({ ...quote, images: [...quote.images] });
  assert.equal(f.c.data.frames[0].images, images); assert.equal(f.patches.length, 0);
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
test('引用图片沿用动态原始比例，按引用正文实际宽度适配，横图矮竖图高且超长图收窄', () => {
  const { rememberSize, imageLayout } = require('../miniprogram/utils/post-image-layout');
  const f = fixture(), file = 'quote-original-ratio';
  f.c.createSelectorQuery = () => ({ selectAll() { return this; }, fields() { return this; }, exec(fn) { fn([[{ width: 260, dataset: { frame: 0 } }]]); } });
  for (const [width, height] of [[1200,600],[600,600],[600,1200]]) {
    rememberSize(file,width,height); f.set({ ...quote, images: [file] }); f.c.measureImages();
    const expected = imageLayout([file],false,520), row = f.c.data.frames[0];
    assert.equal(row.galleryWidth,expected.galleryWidth); assert.equal(row.galleryHeight,expected.galleryHeight);
    assert.ok(Math.abs(520*row.galleryWidth/100/row.galleryHeight-width/height)<0.001);
  }
  assert.ok(f.c.data.frames[0].galleryWidth<100);
});
test('引用多图滑到第二张后，隐藏期间首次解码只缓存比例，返回只修正几何并保留页码及图源', () => {
  const f = fixture(), images = ['quote-delayed-first','quote-delayed-second'];
  f.set({ ...quote, images });
  f.c.imageChanged({ currentTarget: { dataset: { frame: 0 } }, detail: { current: 1 } });
  f.patches.length=0; f.hide();
  f.c.photoLoaded({ currentTarget: { dataset: { frame: 0, file: images[0] } }, detail: { width: 600,height: 1000 } });
  assert.equal(f.patches.length,0); f.show();
  assert.equal(f.c.data.frames[0].imageIndex,1);
  assert.ok(f.patches.every(patch => Object.keys(patch).every(key => /(?:gallery(?:Width|Height)|photoFrames\[\d+\])$/.test(key))));
});
