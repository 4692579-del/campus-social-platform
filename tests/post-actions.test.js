const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { applyPageData } = require('./helpers/post-actions-fixture');

const user = { _id: 'alice', accountId: '12345678' };
const post = { _id: 'p_' + 'a'.repeat(40), content: '真实动态', isOwn: true, author: { accountId: user.accountId } };
function fixture(options = {}) {
  let account = options.guest ? null : { ...user }, version = 0, stored = { ...post, liked: false, likeCount: 0, ...(options.post || {}) };
  const reactionCalls = [], updates = [], listeners = new Set();
  const sheets = [], modals = [], toasts = [], deleted = [], reports = [], routes = [], logins = [];
  const users = { getCachedUser: () => account, getSessionVersion: () => version };
  const square = {
    cachedPost: () => stored,
    subscribePost: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    react: async (id, kind, active, source) => {
      reactionCalls.push({ id, kind, active });
      stored = options.react ? await options.react(id, kind, active, source) : { ...stored, liked: active, likeCount: active ? 1 : 0 };
      return stored;
    },
    deletePost: async id => { deleted.push(id); if (options.failDelete) throw new Error('删除失败'); stored = null; },
    reportPost: async (id, reason) => { reports.push({ id, reason }); return { alreadyReported: false }; },
  };
  const wx = { showActionSheet: args => sheets.push(args), showModal: args => modals.push(args), showToast: args => toasts.push(args.title),
    navigateBack: () => routes.push('back'), switchTab: args => routes.push(args.url) };
  const context = { module: { exports: {} }, require: name => name.includes('services/user') ? users : name.includes('services/square') ? square : require('../miniprogram/utils/post-view'), wx };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/post-actions.js'), 'utf8'), context);
  const page = { ...context.module.exports, _visible: true, data: { user: account, posts: [{ ...stored }], ownPosts: [{ ...stored }], feedOffset: 1, postsOffset: 1 },
    setData(values) { updates.push(values); applyPageData(this.data, values); }, requestLogin() { logins.push(true); } };
  return { page, sheets, modals, toasts, deleted, reports, routes, logins, reactionCalls, updates, listeners,
    emitPost(row) { stored = row; for (const listener of listeners) listener(row); },
    switchUser() { account = { _id: 'bob', accountId: '87654321' }; version++; },
  };
}
const event = { detail: { id: post._id } };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
test('引用图标拉起现有发布面板，游客先登录，实时引用数量只更新对应字段', () => {
  const f = fixture(); let source;
  f.page.openComposer = event => { source = event.quotePost; };
  f.page.quotePost(event); assert.equal(source._id, post._id);
  const guest = fixture({ guest: true }); guest.page.quotePost(event); assert.equal(guest.logins.length, 1);
  f.page.startPostUpdates(); f.emitPost({ ...post, liked: false, likeCount: 0, quoteCount: 2 });
  assert.equal(f.page.data.posts[0].quoteCount, 2); assert.equal(f.page.data.ownPosts[0].quoteCount, 2);
  assert.ok(f.updates.every(update => Object.keys(update).every(key => /quoteCount$/.test(key))));
});

test('爱心与数量先于云端响应更新，快速取消可立即操作，只更新卡片两个字段', async () => {
  const completions = [];
  const f = fixture({ react: (id, kind, active) => new Promise(resolve => completions.push(() => resolve({ ...post, liked: active, likeCount: active ? 1 : 0 }))) });
  const likeEvent = { detail: { id: post._id, kind: 'like' } };
  const liking = f.page.reactPost(likeEvent);
  assert.equal(f.page.data.posts[0].liked, true); assert.equal(f.page.data.posts[0].likeCount, 1);
  assert.equal(f.page.data.ownPosts[0].liked, true);
  const cancelling = f.page.reactPost(likeEvent);
  assert.equal(f.page.data.posts[0].liked, false); assert.equal(f.page.data.posts[0].likeCount, 0);
  assert.deepEqual(f.reactionCalls.map(row => row.active), [true, false]);
  assert.ok(f.updates.every(update => Object.keys(update).every(key => /^(posts|ownPosts)\[0\]\.(liked|likeCount)$/.test(key))));
  completions[0](); await liking;
  assert.equal(f.page.data.posts[0].liked, false);
  completions[1](); await cancelling;
  assert.equal(f.page.data.posts[0].likeCount, 0); assert.equal(f.toasts.length, 0);
});

test('点赞失败回退并提示，切换账号后的迟到响应不修改新账号卡片', async () => {
  let fail;
  const f = fixture({ react: () => new Promise((resolve, reject) => { fail = reject; }) });
  const likeEvent = { detail: { id: post._id, kind: 'like' } };
  const pending = f.page.reactPost(likeEvent);
  assert.equal(f.page.data.posts[0].likeCount, 1);
  fail(new Error('保存失败')); await pending;
  assert.equal(f.page.data.posts[0].liked, false); assert.equal(f.page.data.posts[0].likeCount, 0);
  assert.deepEqual(f.toasts, ['保存失败']);
  let finish;
  const changed = fixture({ react: () => new Promise(resolve => { finish = resolve; }) });
  const old = changed.page.reactPost(likeEvent);
  changed.switchUser(); changed.page.data.user = { _id: 'bob' };
  changed.page.data.posts = [{ ...post, liked: false, likeCount: 15 }];
  finish({ ...post, liked: true, likeCount: 1 }); await old;
  assert.equal(changed.page.data.posts[0].liked, false); assert.equal(changed.page.data.posts[0].likeCount, 15);
});

test('可见页面订阅共享点赞结果，离开解除订阅，不覆盖其他卡片字段或旧账号', () => {
  const f = fixture({ post: { replyCount: 7 } });
  f.page.startPostUpdates(); f.page.startPostUpdates(); assert.equal(f.listeners.size, 1);
  f.emitPost({ ...post, liked: true, likeCount: 5, replyCount: 99 });
  assert.equal(f.page.data.posts[0].liked, true); assert.equal(f.page.data.posts[0].likeCount, 5);
  assert.equal(f.page.data.posts[0].replyCount, 7);
  f.switchUser(); f.emitPost({ ...post, liked: false, likeCount: 20 });
  assert.equal(f.page.data.posts[0].likeCount, 5);
  f.page.stopPostUpdates(); assert.equal(f.listeners.size, 0);
});

test('自己的动态只有删除选项；取消保留内容，确认后才调用云端并同步列表', async () => {
  const f = fixture();
  let pending = f.page.managePost(event);
  assert.deepEqual([...f.sheets[0].itemList], ['删除动态']);
  f.sheets[0].success({ tapIndex: 0 }); await tick();
  f.modals[0].success({ confirm: false }); await pending;
  assert.equal(f.deleted.length, 0); assert.equal(f.page.data.posts.length, 1);
  pending = f.page.managePost(event);
  await f.page.managePost(event); assert.equal(f.sheets.length, 2);
  f.sheets[1].success({ tapIndex: 0 }); await tick();
  f.modals[1].success({ confirm: true }); await pending;
  assert.deepEqual(f.deleted, [post._id]);
  assert.equal(f.page.data.posts.length, 0); assert.equal(f.page.data.ownPosts.length, 0);
  assert.equal(f.page.data.feedOffset, 0); assert.equal(f.page.data.postsOffset, 0);
  assert.deepEqual(f.toasts, ['动态已删除']);
});

test('删除当前评论面板所属动态会关闭面板；云端失败不清理内容或提示成功', async () => {
  const f = fixture(); f.page.data.commentPostId = post._id;
  const pending = f.page.managePost(event);
  f.sheets[0].success({ tapIndex: 0 }); await tick(); f.modals[0].success({ confirm: true }); await pending;
  assert.equal(f.page.data.commentPostId, ''); assert.equal(f.routes.length, 0);
  const failed = fixture({ failDelete: true });
  const deleting = failed.page.managePost(event);
  failed.sheets[0].success({ tapIndex: 0 }); await tick(); failed.modals[0].success({ confirm: true }); await deleting;
  assert.equal(failed.page.data.posts.length, 1); assert.deepEqual(failed.toasts, ['删除失败']);
});

test('别人的动态提供举报而非删除，选择原因并确认后真实提交；切账号撤销旧确认', async () => {
  const f = fixture({ post: { isOwn: false, author: { accountId: '87654321' } } });
  const pending = f.page.managePost(event);
  assert.deepEqual([...f.sheets[0].itemList], ['举报动态']);
  f.sheets[0].success({ tapIndex: 0 }); await tick();
  f.sheets[1].success({ tapIndex: 3 }); await tick();
  f.modals[0].success({ confirm: true }); await pending;
  assert.deepEqual(f.reports, [{ id: post._id, reason: 'abuse' }]); assert.equal(f.deleted.length, 0);
  assert.deepEqual(f.toasts, ['举报已提交']);
  const switched = fixture(); const deleting = switched.page.managePost(event);
  switched.sheets[0].success({ tapIndex: 0 }); await tick();
  switched.switchUser(); switched.modals[0].success({ confirm: true }); await deleting;
  assert.equal(switched.deleted.length, 0); assert.equal(switched.toasts.length, 0);
});

test('未登录管理动态时打开登录，保留删除和举报入口的身份校验', async () => {
  const guest = fixture({ guest: true }); await guest.page.managePost(event);
  assert.equal(guest.logins.length, 1); assert.equal(guest.sheets.length, 0);
});
