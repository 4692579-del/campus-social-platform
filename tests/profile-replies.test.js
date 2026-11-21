const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { applyPageData } = require('./helpers/post-actions-fixture');
const row = (n = 1) => ({ _id: 'r_' + String(n).padStart(40, '0'), postId: 'p_' + 'a'.repeat(40), sortKey: String(n),
  context: { _id: 'p_' + 'a'.repeat(40), author: { nickname: '同学' }, content: '原动态' },
  reply: { _id: 'r_' + String(n).padStart(40, '0'), author: { nickname: '我' }, content: '我的回复', images: ['one', 'two', 'three'], liked: false, likeCount: 0 } });
function fixture(options = {}) {
  let definition, version = 0, current = { _id: 'alice' }, cached = options.cached || null, listener;
  const calls = [], events = [], patches = [], toasts = [];
  const square = {
    cachedOwnReplies: () => cached,
    cachedProfileReplies: () => cached,
    subscribeHistory: fn => { listener = fn; return () => { listener = null; }; },
    listOwnReplies: async args => { calls.push({ type: 'read', ...args });
      cached = options.read ? await options.read(args) : cached || { items: [], hasMore: false, nextCursor: '' }; return cached; },
    commentState: async (postId, id, kind, active) => { calls.push({ type: 'state', postId, id, kind, active });
      cached.items[0].reply = { ...cached.items[0].reply, liked: active, likeCount: active ? 1 : 0 }; listener({}); },
    deleteReply: async (postId, id) => { calls.push({ type: 'delete', postId, id }); if (options.remove) return options.remove();
      cached.items = cached.items.filter(item => item._id !== id); listener({}); },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/components/profile-replies/index.js'), 'utf8'), {
    Component: value => { definition = value; },
    require: name => name.includes('services/user') ? { getCachedUser: () => current, getSessionVersion: () => version }
      : name.includes('services/square') ? square : name.includes('post-images') ? { previewImages: async (files, selected) => calls.push({ type: 'preview', files, selected }) }
      : name.includes('comment-threads') ? require('../miniprogram/utils/comment-threads') : require('../miniprogram/utils/post-view'),
    wx: { showToast: args => toasts.push(args.title), showActionSheet: args => args.success({ tapIndex: 0 }), showModal: args => args.success({ confirm: true }) },
  });
  const c = { ...definition.methods, data: { ...structuredClone(definition.data), active: options.active !== false, viewer: current, accountId: options.accountId || '' },
    setData(value) { patches.push(value); applyPageData(this.data, value); }, triggerEvent(name, detail) { events.push({ name, detail }); } };
  return { c, calls, events, patches, toasts, attach: () => definition.lifetimes.attached.call(c),
    detach: () => definition.lifetimes.detached.call(c), logout() { current = null; version++; cached = null; },
    setCache(value) { cached = value; listener({}); } };
}
const click = (item, extra = {}) => ({ currentTarget: { dataset: { id: item._id, ...extra } } });
test('访客回复按目标ID读取，只读历史不提供删除，头像入口指向真正作者', async () => {
  const item = row(); item.reply.author.accountId = '87654321';
  const f = fixture({ accountId: '87654321', cached: { items: [item], hasMore: false, nextCursor: '' } });
  await f.attach(); assert.equal(f.calls[0].profileAccountId, '87654321');
  await f.c.manageComment(click(item)); assert.ok(!f.calls.some(call => call.type === 'delete'));
  f.c.viewCommentAuthor(click(item)); assert.equal(f.events.at(-1).name, 'author'); assert.equal(f.events.at(-1).detail.author.accountId, '87654321');
});
test('回复标签同步预填真实缓存，未选中不请求；不因点赞重设图片源', async () => {
  const item = row(), f = fixture({ active: false, cached: { items: [item], hasMore: true, nextCursor: 'cursor' } });
  await f.attach(); assert.equal(f.c.data.items[0].reply.content, '我的回复'); assert.equal(f.calls.length, 0);
  f.c.data.active = true; await f.c.sync(); assert.equal(f.calls[0].type, 'read');
  f.patches.length = 0; await f.c.reactComment(click(item, { kind: 'like' }));
  assert.equal(f.c.data.items[0].reply.liked, true);
  assert.ok(!f.patches.some(patch => 'items' in patch || Object.keys(patch).some(key => key.includes('images'))));
  await f.c.loadMore(); assert.equal(f.calls.at(-1).cursor, 'cursor'); f.detach();
});
test('历史正文与回复按钮分别定位和选中对象，图片预览用原图序，删除成功才移除', async () => {
  const item = row(), f = fixture({ cached: { items: [item], hasMore: false, nextCursor: 'cursor' } });
  await f.attach(); f.c.openComment(click(item)); f.c.selectReply(click(item));
  assert.equal(f.events[0].name, 'open'); assert.equal(f.events[1].name, 'reply');
  assert.equal(f.events[0].detail.id, item.postId); assert.equal(f.events[0].detail.replyId, item._id);
  await f.c.previewCommentImages(click(item, { index: 1 }));
  assert.deepEqual(Array.from(f.calls.at(-1).files), ['one', 'two', 'three']); assert.equal(f.calls.at(-1).selected, 'two');
  await f.c.manageComment(click(item)); assert.equal(f.c.data.items.length, 0); f.detach();
  const failed = fixture({ cached: { items: [row()], hasMore: false, nextCursor: '' }, remove: async () => { throw new Error('删除失败'); } });
  await failed.attach(); await failed.c.manageComment(click(row()));
  assert.equal(failed.c.data.items.length, 1); assert.equal(failed.toasts.at(-1), '删除失败'); failed.detach();
});
test('后台更新失败保留已有内容；账号变更后迟到响应不能恢复旧列表', async () => {
  const f = fixture({ cached: { items: [row()], hasMore: false, nextCursor: '' }, read: async () => { throw new Error('读取失败'); } });
  await f.attach(); assert.equal(f.c.data.items.length, 1); assert.equal(f.c.data.error, '读取失败'); f.detach();
  let finish;
  const g = fixture({ read: () => new Promise(resolve => { finish = resolve; }) });
  const attaching = g.attach(); g.logout(); await g.c.sync();
  finish({ items: [row()], hasMore: false, nextCursor: '' }); await attaching;
  assert.equal(g.c.data.items.length, 0); g.detach();
});
