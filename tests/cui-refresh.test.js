const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const drawing = require('../miniprogram/utils/cui-refresh-drawing');
const read = name => fs.readFileSync(path.join(__dirname, '../miniprogram', name), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function clock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    Date: { now: () => now }, timers,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      await flush(); const target = now + ms;
      while (true) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, t]) => t.at <= target);
        if (!entry) break;
        timers.delete(entry[0]); now = entry[1].at; entry[1].fn(); await flush();
      }
      now = target; await flush();
    },
  };
}
function refreshFixture(load = async () => {}, nextTick) {
  const time = clock(), context = { ...time, module: { exports: {} }, require: () => drawing, wx: nextTick ? { nextTick } : {} };
  vm.runInNewContext(read('utils/home-refresh.js'), context);
  const states = [], writes = [], requests = [], posts = [{ _id: 'real', images: ['cloud://public/photo'] }];
  const page = {
    ...context.module.exports, data: { brandRefreshPhase: 'idle', pullRefreshing: false, nativeRefreshing: false, posts },
    setData(value, done) { writes.push(value); Object.assign(this.data, value); if (done) done(); },
    selectComponent: () => ({ setState: state => states.push(state) }),
    interactionBlocked() { return !!this.data.composerOpen; }, canRefreshFeed() { return !this.data.campus; },
    stopBrandBounce() {}, loadFeed(force) { requests.push(force); return load(); },
  };
  return { page, states, writes, requests, posts, time };
}

test('字标沿C圆弧、u左下右、i顶部依次染色，往返共用同一条路径', () => {
  const { splitProgress, C_PATH, U_PATH } = drawing;
  assert.deepEqual(splitProgress(0), [0, 0, 0]);
  assert.deepEqual(splitProgress(1 / 3), [1, 0, 0]);
  assert.deepEqual(splitProgress(.5), [1, .5, 0]);
  assert.deepEqual(splitProgress(2 / 3), [1, 1, 0]);
  assert.deepEqual(splitProgress(1), [1, 1, 1]);
  assert.deepEqual(splitProgress(-1), [0, 0, 0]);
  assert.deepEqual(splitProgress(5), [1, 1, 1]);
  assert.ok(C_PATH.find(p => p.y > 250 && p.y < 270 && p.x < 50));
  const bottom = U_PATH.reduce((a, b) => a.y > b.y ? a : b);
  assert.ok(bottom.x > 530 && bottom.x < 540 && bottom.y === 410);
  assert.ok(U_PATH[1].x < U_PATH.at(-2).x && U_PATH[1].y < 200 && U_PATH.at(-2).y < 200);
  for (const points of [C_PATH, U_PATH]) for (let i = 1; i < points.length; i++) assert.ok(points[i].length > points[i - 1].length);
  assert.ok(drawing.waveOffset(300, 0) < drawing.waveOffset(300, 1));
  assert.ok(drawing.waveOffset(450, 1) < drawing.waveOffset(450, 2));
  for (const i of [0, 1, 2]) assert.ok(Math.abs(drawing.waveOffset(900, i)) < 1e-10);
});

test('拖动只更新字标、不请求或重绘列表；未满松手反向恢复，再次拖动取消旧回填', async () => {
  const f = refreshFixture();
  f.page.pullHomeFeed({ detail: { dy: 18 } });
  f.page.pullHomeFeed({ detail: { dy: 36 } });
  assert.equal(f.states.at(-1).progress, .5); assert.equal(f.requests.length, 0);
  assert.equal(f.writes.length, 1); assert.equal(f.page.data.posts, f.posts);
  f.page.releaseHomePull(); assert.equal(f.states.at(-1).phase, 'returning');
  await f.time.advance(100);
  f.page.pullHomeFeed({ detail: { dy: 72 } });
  await f.time.advance(500);
  assert.equal(f.page.data.brandRefreshPhase, 'pulling'); assert.equal(f.states.at(-1).progress, 1);
  f.page.releaseHomePull(); assert.equal(f.requests.length, 0); // 原生refresh事件前，拉满并松手也不伪造请求。
  f.page.pullHomeFeed({ detail: { dy: 12 } }); f.page.cancelHomePull(); await f.time.advance(160);
  assert.equal(f.states.at(-1).phase, 'idle'); assert.equal(f.time.timers.size, 0);
});

test('快速响应也先回位、至少完整起伏900ms，然后依次回蓝600ms', async () => {
  const f = refreshFixture(), pending = f.page.refreshFeed();
  assert.equal(f.page.data.pullRefreshing, true); assert.equal(f.page.data.nativeRefreshing, false);
  assert.equal(f.states.at(-1).phase, 'settling'); assert.deepEqual(f.requests, [true]);
  assert.equal(f.page.refreshFeed(), pending);
  f.page.restoreHomePull(); await flush();
  assert.equal(f.states.at(-1).phase, 'loading');
  await f.time.advance(899); assert.equal(f.states.at(-1).phase, 'loading');
  await f.time.advance(1); assert.equal(f.states.at(-1).phase, 'refill');
  await f.time.advance(599); assert.equal(f.page.data.pullRefreshing, true);
  await f.time.advance(1); await pending;
  assert.equal(f.states.at(-1).phase, 'idle'); assert.equal(f.page.data.pullRefreshing, false);
  assert.equal(f.time.timers.size, 0); assert.equal(f.page.data.posts, f.posts);
});

test('请求未完成持续起伏，完成后等当前整轮结束；无restore事件有回位兜底', async () => {
  let finish;
  const f = refreshFixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.page.refreshFeed();
  await f.time.advance(240); assert.equal(f.states.at(-1).phase, 'loading');
  await f.time.advance(1250); assert.equal(f.states.at(-1).phase, 'loading');
  finish(); await flush();
  await f.time.advance(549); assert.equal(f.states.at(-1).phase, 'loading');
  await f.time.advance(1); assert.equal(f.states.at(-1).phase, 'refill');
  await f.time.advance(600); await pending; assert.equal(f.page.data.brandRefreshPhase, 'idle');
});

test('隐藏、弹层和切账号清理动画等待；迟到原生回调及请求不能重启旧动画', async () => {
  const ticks = []; let finish;
  const f = refreshFixture(() => new Promise(resolve => { finish = resolve; }), fn => ticks.push(fn));
  const pending = f.page.refreshFeed(); f.page.stopHomeRefresh(); f.page._visible = false;
  for (const tick of ticks) tick(); f.page.restoreHomePull();
  finish(); await pending; await f.time.advance(3000);
  assert.equal(f.states.at(-1).phase, 'idle'); assert.equal(f.time.timers.size, 0);
  assert.equal(f.page.data.pullRefreshing, false);
  f.page._visible = true;
  const next = f.page.refreshFeed(); ticks.at(-1)(); f.page.restoreHomePull();
  finish(); await flush(); assert.equal(f.time.timers.size, 1);
  f.page.stopHomeRefresh(); await next; assert.equal(f.time.timers.size, 0);
  for (const blocked of [{ menuOpen: true }, { authorMenu: {} }, { commentPostId: 'post' }, { composerOpen: true }, { campus: true }]) {
    const g = refreshFixture(); Object.assign(g.page.data, blocked);
    g.page.pullHomeFeed({ detail: { dy: 100 } }); assert.equal(g.page.refreshFeed(), undefined);
    assert.equal(g.states.length, 0); assert.equal(g.requests.length, 0);
  }
});

function rendererFixture() {
  const time = clock(), measures = [], frames = new Map(), paints = [], writes = [];
  let definition, frameId = 0;
  const canvas = { getContext: () => ({ scale() {} }),
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); } };
  vm.runInNewContext(read('components/cui-refresh/index.js'), {
    Component: value => { definition = value; }, Date: time.Date, wx: { getWindowInfo: () => ({ pixelRatio: 3 }) },
    require: () => ({ ...drawing, drawLogo: (...args) => paints.push(args.at(-1)) }),
  });
  const component = { ...definition.methods, data: { ...definition.data },
    setData(value) { writes.push(value); Object.assign(this.data, value); }, triggerEvent() {},
    createSelectorQuery() { const query = { select: () => query, fields: () => query, exec: fn => measures.push(fn) }; return query; } };
  const measure = () => measures.at(-1)([{ node: canvas, width: 52, height: 54 }]);
  const frame = () => { const [id, fn] = [...frames][0]; frames.delete(id); fn(); };
  return { component, definition, canvas, frames, paints, writes, time, measure, frame, measures };
}
test('画布等待测量期间保留最新下拉；按DPR绘制，逐帧不经setData，停止后旧帧无效', async () => {
  const f = rendererFixture(); f.component.initializeCanvas();
  f.component.setState({ phase: 'pulling', progress: .7 }); f.measure();
  assert.equal(f.canvas.width, 156); assert.equal(f.paints.at(-1).progress, .7);
  f.component.setState({ phase: 'loading', startedAt: 0 }); const lateFrame = [...f.frames.values()][0];
  await f.time.advance(450); f.frame(); assert.equal(f.paints.at(-1).elapsed, 450);
  assert.equal(f.writes.length, 1); // 仅显示画布时写一次，动画帧不更新页面/列表。
  f.component.setState({ phase: 'idle' }); const count = f.paints.length; lateFrame();
  assert.equal(f.paints.length, count); assert.equal(f.frames.size, 0); assert.equal(f.component.data.canvasVisible, false);
  f.component.initializeCanvas(); f.definition.lifetimes.detached.call(f.component); f.measure();
  assert.equal(f.component._ctx, null); assert.equal(f.frames.size, 0);
});
test('未拉满恢复从当前进度倒退，刷新回蓝使用同一正向路径，重新测量忽略旧尺寸', async () => {
  const f = rendererFixture(); f.component.initializeCanvas(); const oldMeasure = f.measures[0];
  f.component.initializeCanvas(); oldMeasure([{ node: f.canvas, width: 1, height: 1 }]);
  assert.equal(f.component._ctx, undefined); f.measure();
  f.component.setState({ phase: 'pulling', progress: .6 });
  f.component.setState({ phase: 'returning', duration: 400, startedAt: 0 });
  await f.time.advance(200); f.frame(); assert.ok(f.paints.at(-1).progress < .6 && f.paints.at(-1).progress > 0);
  await f.time.advance(200); f.frame(); assert.equal(f.paints.at(-1).progress, 0); assert.equal(f.frames.size, 0);
  f.component.setState({ phase: 'refill', duration: 600, startedAt: 400 });
  await f.time.advance(300); f.frame(); assert.equal(f.paints.at(-1).progress, .5); assert.equal(f.paints.at(-1).refill, true);
  f.definition.pageLifetimes.hide.call(f.component); assert.equal(f.frames.size, 0);
});

test('搜索字标在松手后才完成画布初始化时，仍从松手时的进度回蓝', async () => {
  const f = rendererFixture();
  f.component.initializeCanvas();
  f.component.setState({ phase: 'returning', progress: .5, duration: 240, startedAt: 0 });
  await f.time.advance(60);
  f.measure();
  assert.ok(f.paints.at(-1).progress > 0 && f.paints.at(-1).progress < .5);
  await f.time.advance(180);
  f.frame();
  assert.equal(f.paints.at(-1).progress, 0);
});
