const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('miniprogram/components/square-post/index.js', 'utf8');
function fixture(options = {}) {
  let definition, now = 1000, timerId = 0;
  const timers = new Map(), writes = [], events = [];
  vm.runInNewContext(source, { Component: value => { definition = value; },
    require: () => require('../miniprogram/utils/post-image-layout'),
    Date: { now: () => now }, setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  const c = { ...definition.methods, data: { ...structuredClone(definition.data), likeMotion: options.enabled !== false,
    viewer: options.guest ? null : { _id: 'alice' }, post: { _id: 'post', liked: false, images: ['one', 'two'] } },
    setData(value) { writes.push(value); Object.assign(this.data, value); }, triggerEvent(name, detail) { events.push({ name, ...detail }); } };
  const state = liked => { c.data.post = { ...c.data.post, liked }; definition.observers['post.liked'].call(c, liked); };
  return { c, definition, timers, writes, events, state, advance: value => { now += value; } };
}

test('初始展示及后台同步不播动画；明确点击后的真实乐观状态触发点赞爆发和取消回弹', () => {
  const f = fixture(); f.state(true); assert.equal(f.c.data.likeMotionClass, '');
  f.state(false); f.c.like(); assert.equal(f.c.data.likeMotionClass, '');
  assert.deepEqual(f.events.map(row => [row.name, row.kind, row.id]), [['react', 'like', 'post']]);
  f.state(true); assert.match(f.c.data.likeMotionClass, /^is-like-/); assert.equal([...f.timers.values()][0].delay, 960);
  f.c.like(); f.state(false); assert.match(f.c.data.likeMotionClass, /^is-unlike-/); assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 440);
  assert.ok(f.writes.every(value => Object.keys(value).every(key => key === 'likeMotionClass')));
});

test('快速连续点击从新动画重播，旧完成回调不清空新动画；失败回退只恢复真实图标', () => {
  const f = fixture(); f.c.like(); f.state(true);
  const stale = [...f.timers.values()][0].callback;
  f.c.like(); f.state(false); const unlike = f.c.data.likeMotionClass; f.c.like(); f.state(true);
  assert.notEqual(f.c.data.likeMotionClass, unlike, '反向点击立即换成新动画');
  const current = f.c.data.likeMotionClass; stale(); assert.equal(f.c.data.likeMotionClass, current);
  f.state(false); assert.equal(f.c.data.likeMotionClass, ''); assert.equal(f.timers.size, 0);
});

test('隐藏、卸载、切账号和复用成另一条动态都取消计时；不更新图源、页码或展开状态', () => {
  for (const mode of ['hide', 'detach', 'account', 'post']) {
    const f = fixture(); f.c.data.imageIndex = 1; f.c.data.expanded = true;
    const files = f.c.data.imageFiles;
    f.c.like(); f.state(true); const stale = [...f.timers.values()][0].callback;
    if (mode === 'hide') f.definition.pageLifetimes.hide.call(f.c);
    if (mode === 'detach') f.definition.lifetimes.detached.call(f.c);
    if (mode === 'account') f.definition.observers['viewer._id'].call(f.c, 'bob');
    if (mode === 'post') f.definition.observers['post._id'].call(f.c, 'other');
    assert.equal(f.timers.size, 0); const count = f.writes.length; stale(); assert.equal(f.writes.length, count);
    assert.equal(f.c.data.imageFiles, files);
    if (mode !== 'post') { assert.equal(f.c.data.imageIndex, 1); assert.equal(f.c.data.expanded, true); }
  }
});

test('游客、未启用页面和过期点击不播放动画，不阻塞原点赞事件或伪造业务状态', () => {
  for (const options of [{ guest: true }, { enabled: false }, {}]) {
    const f = fixture(options); f.c.like(); f.advance(800); f.state(true);
    assert.equal(f.c.data.likeMotionClass, ''); assert.equal(f.events.length, 1); assert.equal(f.timers.size, 0);
  }
  const f = fixture(); f.c.like(); f.state(true); [...f.timers.values()][0].callback();
  assert.equal(f.c.data.likeMotionClass, ''); assert.equal(f.c.data.post.liked, true);
});

test('首页显式启用动效，模板传递局部字段；CSS动画不影响数字且支持减少动态效果', () => {
  const home = fs.readFileSync('miniprogram/pages/home/index.wxml', 'utf8');
  const template = fs.readFileSync('miniprogram/components/square-post/index.wxml', 'utf8');
  const css = fs.readFileSync('miniprogram/components/square-post/index.wxss', 'utf8');
  assert.match(home, /like-motion="{{true}}"/);
  const filled = fs.readFileSync('miniprogram/images/post-actions/like-filled.svg', 'utf8');
  assert.match(filled, /fill="#E34B76"/);
  assert.match(template, /likeMotion \? '-filled' : '-active'/);
  assert.match(template, /<template is="actions" data="{{post: post, likeMotion:/);
  assert.match(template, /likeMotionClass: likeMotionClass, likeParticleRays: likeParticleRays/);
  assert.match(template, /like-stage {{likeMotionClass}}/); assert.match(template, /class="like-glyph"/);
  assert.match(css, /\.post-actions \.post-action-like \{ overflow: visible;/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /\.post-action text\s*\{[^}]*animation/);
});
