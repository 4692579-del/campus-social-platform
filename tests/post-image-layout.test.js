const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const layout = require('../miniprogram/utils/post-image-layout');

test('单图按真实比例展示：横图矮、方图适中、竖图较高，长图收窄且保留完整比例', () => {
  const sizes = [['layout-wide', 1600,900], ['layout-square',1000,1000], ['layout-portrait',900,1200], ['layout-long',900,1600]];
  const values = sizes.map(([file,w,h]) => { layout.rememberSize(file,w,h); return layout.imageLayout([file]); });
  assert.equal(values[0].galleryWidth, 100); assert.equal(values[1].galleryHeight, 628);
  assert.ok(values[0].galleryHeight < values[1].galleryHeight && values[1].galleryHeight < values[2].galleryHeight);
  assert.equal(values[3].galleryHeight, 840); assert.ok(values[3].galleryWidth < 100);
  for (let i=0;i<sizes.length;i++) assert.ok(Math.abs(628 * values[i].galleryWidth / 100 / values[i].galleryHeight - sizes[i][1] / sizes[i][2]) < .001);
  const detail = layout.imageLayout(['layout-square'], true);
  assert.equal(detail.galleryHeight, 718); assert.equal(detail.galleryWidth, 100);
});

test('多图整组高度受限、只由首图确定，横滑不会因其他图片比例跳高', () => {
  layout.rememberSize('carousel-first',1600,900); layout.rememberSize('carousel-second',900,1600);
  const value = layout.imageLayout(['carousel-first','carousel-second']);
  assert.equal(value.galleryWidth,100); assert.equal(value.galleryHeight,360);
  layout.rememberSize('carousel-second',1000,1000);
  assert.deepEqual(layout.imageLayout(['carousel-first','carousel-second']),value);
  const portrait = layout.imageLayout(['layout-portrait','carousel-first']);
  assert.equal(portrait.galleryHeight,640);
});

test('无效尺寸不污染缓存，极端图片有可见边界，尺寸缓存有数量上限', () => {
  for (const size of [[0,1],[-1,10],[NaN,100],[100,Infinity],['100',100],[1000001,1]])
    assert.equal(layout.rememberSize('invalid-size',...size),false);
  assert.deepEqual(layout.imageLayout(['invalid-size']), {galleryWidth:100,galleryHeight:471});
  for (const [w,h] of [[1,1000000],[1000000,1]]) {
    layout.rememberSize('extreme-size',w,h); const value=layout.imageLayout(['extreme-size']);
    assert.ok(value.galleryWidth>0 && value.galleryHeight>0 && value.galleryHeight<=840);
  }
  layout.rememberSize('evict-first',1,1);
  for(let i=0;i<256;i++)layout.rememberSize('cache-'+i,100,100);
  assert.equal(layout.imageLayout(['evict-first']).galleryHeight,471);
});

function fixture(files) {
  let definition; const writes=[];
  vm.runInNewContext(fs.readFileSync('miniprogram/components/square-post/index.js','utf8'), {
    Component: value=>{definition=value;}, require:name=>name.endsWith('/post-media') ? require('../miniprogram/utils/post-media') : layout, wx:{},
  });
  const c={...definition.methods,data:{...structuredClone(definition.data),post:{_id:'test',images:files}},setData(value){writes.push(value);Object.assign(this.data,value);}};
  definition.observers['post.images'].call(c,files);
  return {c,writes,definition,load(file,width,height){c.photoLoaded({currentTarget:{dataset:{file}},detail:{width,height}});}};
}

test('真实图片加载后仅修正尺寸，不重写图片源；同组点赞/时间更新与重复load不触发重绘', () => {
  const f=fixture(['loaded-first','loaded-second']); const files=f.c.data.imageFiles;
  f.load('loaded-first',1200,900); const count=f.writes.length;
  f.load('loaded-second',900,1600); f.load('loaded-first',1200,900);
  f.load('not-current',100,200);
  f.definition.observers['post.images'].call(f.c,['loaded-first','loaded-second']);
  assert.equal(f.writes.length,count); assert.equal(f.c.data.imageFiles,files);
  f.c.imageChanged({detail:{current:1}}); const height=f.c.data.galleryHeight;
  f.c.imageChanged({detail:{current:0}}); assert.equal(f.c.data.galleryHeight,height);
});

test('隐藏期首次解码延迟到返回时修正，保留轮播索引和节点；卸载及已替换图片的迟到事件无效', () => {
  const f=fixture(['hidden-first','hidden-second']); f.c.imageChanged({detail:{current:1}});
  const files=f.c.data.imageFiles, count=f.writes.length;
  f.definition.pageLifetimes.hide.call(f.c); f.load('hidden-first',900,1200);
  assert.equal(f.writes.length,count);
  f.definition.pageLifetimes.show.call(f.c); assert.equal(f.c.data.galleryHeight,640); assert.equal(f.c.data.imageIndex,1);
  assert.equal(f.c.data.imageFiles,files);
  const oldCount=f.writes.length; f.definition.pageLifetimes.hide.call(f.c);f.definition.pageLifetimes.show.call(f.c);
  assert.equal(f.writes.length,oldCount);
  f.definition.observers['post.images'].call(f.c,['replacement']); const replacement=f.c.data.imageFiles;
  f.load('hidden-first',2000,500); assert.equal(f.c.data.imageFiles,replacement);
  f.definition.lifetimes.detached.call(f.c); const final=f.writes.length; f.load('replacement',1000,1000);
  assert.equal(f.writes.length,final);
});

test('已测量的公开图片在其他卡片立即复用尺寸，详情使用自身可用宽度', () => {
  const first=fixture(['shared-photo']), second=fixture(['shared-photo']);
  first.load('shared-photo',1600,900); second.load('shared-photo',1600,900);
  assert.equal(second.c.data.galleryHeight,first.c.data.galleryHeight);
  const third=fixture(['shared-photo']); assert.equal(third.c.data.galleryHeight,first.c.data.galleryHeight);
  second.c.data.detail=true;second.definition.observers.detail.call(second.c);
  assert.ok(second.c.data.galleryHeight>first.c.data.galleryHeight);
});
