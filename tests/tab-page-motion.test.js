const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const timers = new Map(); let clock = 1000, sequence = 0;
  const context = { module: { exports: {} }, Date: { now: () => clock },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/tab-page-motion.js'), 'utf8'), context);
  const definition = context.module.exports;
  return {
    timers, advance(ms) { clock += ms; },
    page() { return { ...definition.methods, data: { ...definition.data },
      setData(values) { Object.assign(this.data, values); } }; },
    finish() { const [id, timer] = [...timers][0]; timers.delete(id); clock += timer.delay; timer.callback(); },
  };
}

test('首进、普通返回、相册返回不播放动画；源页准备淡出不安排等待计时器', () => {
  const f = fixture(), source = f.page();
  const posts = source.data.posts = [{ images: ['cloud://real/photo.jpg'] }];
  source.showTabMotion('/pages/home/index'); assert.equal(source.data.tabMotionPhase, '');
  source.prepareTabLeave('/pages/search/index');
  assert.equal(source.data.tabMotionPhase, 'leaving'); assert.equal(f.timers.size, 0);
  assert.equal(source.data.posts, posts);
  source.hideTabMotion(); source.showTabMotion('/pages/home/index');
  assert.equal(source.data.tabMotionPhase, '');
});

test('目标页渐入后清理遮片；源页仅在原生换页成功且隐藏后清理淡出状态', () => {
  const f = fixture(), source = f.page(), target = f.page();
  source.showTabMotion('/pages/home/index'); const ticket = source.prepareTabLeave('/pages/search/index');
  source.finishTabLeave(ticket); assert.equal(source.data.tabMotionPhase, 'leaving');
  source.hideTabMotion(); source.finishTabLeave(ticket); assert.equal(source.data.tabMotionPhase, '');
  f.advance(40);
  target.showTabMotion('/pages/search/index'); assert.equal(target.data.tabMotionPhase, 'entering');
  assert.ok(Math.abs(target.data.tabMotionOpacity - .18) < .00001);
  assert.equal([...f.timers.values()][0].delay, 180); f.finish();
  assert.equal(target.data.tabMotionPhase, '');
  target.hideTabMotion(); target.showTabMotion('/pages/search/index'); assert.equal(f.timers.size, 0);
});

test('路由失败回退淡出并清除匹配目标，不会让随后普通进入的页面误播', () => {
  const f = fixture(), source = f.page(), target = f.page();
  source.showTabMotion('/pages/home/index'); const ticket = source.prepareTabLeave('/pages/search/index');
  source.cancelTabLeave(ticket); assert.equal(source.data.tabMotionPhase, '');
  target.showTabMotion('/pages/search/index'); assert.equal(target.data.tabMotionPhase, '');
  assert.equal(f.timers.size, 0);
});

test('快速往返及旧成功/失败回调不得清除新一轮状态', () => {
  const f = fixture(), source = f.page(), target = f.page();
  source.showTabMotion('/pages/home/index'); const old = source.prepareTabLeave('/pages/search/index');
  source.hideTabMotion(); f.advance(40); target.showTabMotion('/pages/search/index');
  const stale = [...f.timers.values()][0].callback;
  f.advance(90);
  target.prepareTabLeave('/pages/home/index');
  assert.ok(Math.abs(target.data.tabMotionOpacity - .045) < .00001);
  target.hideTabMotion(); f.advance(40); source.showTabMotion('/pages/home/index');
  source.prepareTabLeave('/pages/search/index'); source.hideTabMotion(); f.advance(40); target.showTabMotion('/pages/search/index');
  source.finishTabLeave(old); source.cancelTabLeave(old);
  assert.equal(source.data.tabMotionPhase, 'leaving');
  stale(); assert.equal(target.data.tabMotionPhase, 'entering');
});

test('隐藏、卸载取消回调，过期标记不重播，不保存正文、图片或账号数据', () => {
  const f = fixture(), source = f.page(), target = f.page();
  source.showTabMotion('/pages/home/index'); source.prepareTabLeave('/pages/inbox/index');
  source.hideTabMotion(); f.advance(80); target.showTabMotion('/pages/inbox/index');
  assert.equal(target.data.tabMotionOpacity, .24);
  const stale = [...f.timers.values()][0].callback;
  target.hideTabMotion(); target._unloaded = true;
  target.setData = () => assert.fail('已卸载页面不能被迟到回调写入');
  stale(); assert.equal(f.timers.size, 0);
  assert.equal(target.prepareTabLeave('/pages/home/index'), null);
  source.showTabMotion('/pages/home/index'); source.prepareTabLeave('/pages/search/index'); f.advance(1001);
  const late = f.page(); late.showTabMotion('/pages/search/index'); assert.equal(late.data.tabMotionPhase, '');
  assert.equal(late.data.tabMotionOpacity, 0);
});
