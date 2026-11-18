const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const user = { _id: 'alice', accountId: '12345678' };
const post = { _id: 'p_' + 'a'.repeat(40), content: '真实动态', isOwn: true, author: { accountId: user.accountId }, shareCount: 0 };
function fixture(options = {}) {
  let account = options.guest ? null : { ...user }, version = 0, stored = { ...post, ...(options.post || {}) };
  const sheets = [], modals = [], toasts = [], deleted = [], reports = [], shares = [], routes = [], logins = [];
  const users = { getCachedUser: () => account, getSessionVersion: () => version };
  const square = {
    cachedPost: () => stored,
    deletePost: async id => { deleted.push(id); if (options.failDelete) throw new Error('删除失败'); stored = null; },
    reportPost: async (id, reason) => { reports.push({ id, reason }); return { alreadyReported: false }; },
    recordShare: async (id, requestId) => { shares.push({ id, requestId }); if (options.failShare) throw new Error('计数失败'); stored = { ...stored, shareCount: 1 }; return stored; },
  };
  const wx = { showActionSheet: args => sheets.push(args), showModal: args => modals.push(args), showToast: args => toasts.push(args.title),
    navigateBack: () => routes.push('back'), switchTab: args => routes.push(args.url) };
  const context = { module: { exports: {} }, require: name => name.includes('services/user') ? users : name.includes('services/square') ? square : require('../miniprogram/utils/post-view'), wx };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/post-actions.js'), 'utf8'), context);
  const page = { ...context.module.exports, _visible: true, data: { user: account, posts: [stored], ownPosts: [stored], feedOffset: 1, postsOffset: 1 },
    setData(values) { Object.assign(this.data, values); }, requestLogin() { logins.push(true); } };
  return { page, sheets, modals, toasts, deleted, reports, shares, routes, logins,
    switchUser() { account = { _id: 'bob', accountId: '87654321' }; version++; },
  };
}
const event = { detail: { id: post._id } };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

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

test('分享只在原生分享事件中记录一次发起，不使用成功回调；未登录只打开登录', async () => {
  const f = fixture(); f.page.prepareShare(); assert.equal(f.shares.length, 0);
  const content = f.page.buildPostShare({ from: 'button', target: { dataset: { id: post._id } } });
  assert.equal(content.path, `/pages/home/index?postId=${post._id}`);
  assert.equal(content.success, undefined);
  await tick(); assert.equal(f.shares.length, 1); assert.equal(f.page.data.posts[0].shareCount, 1);
  const guest = fixture({ guest: true });
  guest.page.prepareShare(); await guest.page.managePost(event);
  assert.equal(guest.logins.length, 2); assert.equal(guest.sheets.length, 0); assert.equal(guest.shares.length, 0);
  const failed = fixture({ failShare: true }); failed.page.buildPostShare({}, post._id); await tick();
  assert.equal(failed.page.data.posts[0].shareCount, 0); assert.deepEqual(failed.toasts, ['计数失败']);
});
