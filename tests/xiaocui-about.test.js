const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture(options = {}) {
  let definition, version = 0, user = options.guest ? null : { _id: 'alice', nickname: '真实昵称' };
  let cache = options.cached || null, timerId = 0;
  const timers = new Map(), requests = [], navigation = [];
  const users = { getCachedUser: () => user, getSessionVersion: () => version, getCachedAIUsage: () => cache,
    restore: async () => user, getAIUsage: async args => { requests.push(args); return options.read ? options.read(args) : { usedPercent: 7.5, resetsAt: '2050-01-01T16:00:00Z' }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/xiaocui-about/index.js'), 'utf8'), {
    Page: value => { definition = value; }, require: () => users, Date,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    wx: { getWindowInfo: () => ({ statusBarHeight: 44 }), getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32 }),
      navigateBack: () => navigation.push('back'), switchTab: value => navigation.push(value.url) },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  return { page, requests, timers, navigation, switchUser(value) { user = value; cache = null; version++; } };
}
test('额度页面同步预填真实缓存，后台刷新保留进度，失败不伪造0%', async () => {
  let resolve;
  const f = fixture({ cached: { usedPercent: 12, resetsAt: '2050-01-01T16:00:00Z' }, read: () => new Promise(done => { resolve = done; }) });
  f.page.onLoad(); assert.equal(f.page.data.usage.usedPercent, 12);
  const request = f.page.onShow(); await new Promise(done => setImmediate(done)); assert.equal(f.page.data.loading, false); assert.equal(f.page.data.usage.usedPercent, 12);
  resolve({ usedPercent: 20, resetsAt: '2050-01-01T16:00:00Z' }); await request;
  assert.equal(f.page.data.usage.usedPercent, 20); assert.equal(f.page.data.percentText, '20');
  const failed = fixture({ cached: { usedPercent: 18, resetsAt: '2050-01-01T16:00:00Z' }, read: async () => { throw new Error('连接失败'); } });
  failed.page.onLoad(); await failed.page.onShow(); assert.equal(failed.page.data.usage.usedPercent, 18); assert.equal(failed.page.data.error, '连接失败');
});
test('游客不查询额度，切换账号或页面隐藏后迟到数据不恢复旧账号', async () => {
  const guest = fixture({ guest: true }); guest.page.onLoad(); await guest.page.onShow(); assert.equal(guest.requests.length, 0); assert.equal(guest.page.data.usage, null);
  for (const operation of ['logout', 'hide']) {
    let resolve; const f = fixture({ read: () => new Promise(done => { resolve = done; }) });
    f.page.onLoad(); const request = f.page.onShow(); await new Promise(done => setImmediate(done));
    if (operation === 'logout') f.switchUser(null); else f.page.onHide();
    resolve({ usedPercent: 95, resetsAt: '2050-01-01T16:00:00Z' }); await request;
    assert.equal(f.page.data.usage, null); if (operation === 'logout') assert.equal(f.page.data.user, null);
  }
});
test('跨0点计时触发真实查询，隐藏清理计时器，返回使用原导航', async () => {
  const f = fixture(); f.page.onLoad(); await f.page.onShow(); assert.equal(f.timers.size, 1);
  const callback = [...f.timers.values()][0]; callback(); await new Promise(done => setImmediate(done));
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].force, true);
  f.page.onHide(); assert.equal(f.timers.size, 0); f.page.back(); assert.deepEqual(f.navigation, ['back']);
});
test('点击刷新携带原生事件时仍强制读取云端额度', async () => {
  const f = fixture(); f.page.onLoad(); await f.page.onShow();
  await f.page.refresh({ type: 'tap' }); assert.equal(f.requests[1].force, true);
});
