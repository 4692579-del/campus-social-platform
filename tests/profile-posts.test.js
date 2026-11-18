const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describeUser } = require('../miniprogram/utils/user-role');

const user = { _id: 'alice', nickname: '本人', role: 'user', certificationStatus: 'unverified' };
const post = { _id: 'p_' + 'a'.repeat(40), content: '本人的广场动态', author: { nickname: '本人' }, createdAt: '2026-11-17T06:00:00Z', liked: false, likeCount: 0 };
const result = { items: [post], hasMore: false, nextOffset: 1 };
const event = key => ({ currentTarget: { dataset: { key } } });
function fixture(options = {}) {
  let definition, cached = options.cached || null, current = { ...user };
  const calls = [], routes = [];
  const users = { getCachedUser: () => current, restore: async () => current };
  const square = {
    cachedOwnFeed: () => cached,
    list: async args => { calls.push(args); cached = options.list ? await options.list(args) : result; return cached; },
    react: async () => ({ ...post, liked: true, likeCount: 1 }),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.js'), 'utf8'), {
    Page: value => { definition = value; },
    require: name => name.includes('post-actions') ? require('../miniprogram/utils/post-actions') : name.includes('services/square') ? square : name.includes('user-role') ? { describeUser } :
      name.includes('post-view') ? require('../miniprogram/utils/post-view') : name.includes('account-menu') ? require('../miniprogram/utils/account-menu') : users,
    wx: { getWindowInfo: () => ({ statusBarHeight: 44 }), getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32 }),
      navigateTo: args => routes.push(args.url), showToast() {}, stopPullDownRefresh() {} },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData: values => Object.assign(page.data, values) };
  return { page, calls, routes, setUser: value => { if ((current && current._id) !== (value && value._id)) cached = null; current = value; page.applyUser(value); } };
}

test('动态箭头切换来源，评论在当前页展开，不再跳转详情页', async () => {
  const f = fixture({ cached: result }); f.page.onLoad();
  assert.equal(f.page.data.ownPosts[0].content, post.content);
  assert.equal(f.calls.length, 0);
  f.page.selectContent(event('posts')); assert.equal(f.page.data.postsMenuOpen, true);
  f.page.selectPostScope({ currentTarget: { dataset: { scope: 'campus' } } });
  assert.equal(f.page.data.postsMenuOpen, false); assert.equal(f.page.data.postScope, 'campus');
  assert.equal(f.calls.length, 0);
  f.page.selectPostScope({ currentTarget: { dataset: { scope: 'square' } } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls[0].mine, true);
  assert.equal(f.page.openPost, undefined);
  f.page.openComments({ detail: { id: post._id } });
  assert.equal(f.page.data.commentPostId, post._id);
  assert.equal(f.routes.length, 0);
  f.page.closeComments(); assert.equal(f.page.data.commentPostId, '');
  await f.page.reactPost({ detail: { id: post._id, kind: 'like' } });
  assert.equal(f.page.data.ownPosts[0].likeCount, 1);
  f.page.selectContent(event('replies')); assert.equal(f.page.data.postsMenuOpen, false);
  assert.equal(f.page.data.selectedContent, 'replies');
  f.page.selectContent(event('posts')); assert.equal(f.page.data.postsMenuOpen, false);
});

test('读取失败保留已有动态可重试，分页、离开页面和换账号均不让迟到数据覆盖', async () => {
  let finish, attempts = 0;
  const f = fixture({ cached: result, list: async () => {
    if (++attempts === 1) throw new Error('网络失败');
    return new Promise(resolve => { finish = resolve; });
  } });
  f.page.onLoad(); await f.page.loadOwnPosts(true);
  assert.equal(f.page.data.ownPosts[0].content, post.content); assert.equal(f.page.data.postsError, '网络失败');
  f.page.setData({ postsHasMore: true, postsOffset: 20 });
  // 缓存保留分页位置，触底使用服务端返回的 nextOffset。
  const pending = f.page.retryOwnPosts();
  f.page.onHide(); f.setUser({ ...user, _id: 'bob' });
  finish(result); await pending;
  assert.equal(f.page.data.ownPosts.length, 0);
  assert.equal(f.page.data.postsError, '');
  assert.equal(f.page.data.user._id, 'bob');
});

test('本人列表首次无缓存按需读取，分页请求不会重复；退出后立即清理页面', async () => {
  const f = fixture({ list: async args => ({ items: args.offset ? [post, { ...post, _id: 'older' }] : [post], hasMore: !args.offset, nextOffset: args.offset ? 2 : 1 }) });
  f.page.onLoad(); await f.page.loadOwnPosts();
  assert.equal(f.page.data.ownPosts.length, 1);
  await f.page.onReachBottom();
  assert.equal(f.calls.at(-1).offset, 1); assert.equal(f.page.data.ownPosts.length, 2);
  f.setUser(null);
  assert.equal(f.page.data.ownPosts.length, 0); assert.equal(f.page.data.postsMenuOpen, false);
  f.page.selectContent(event('posts')); assert.equal(f.page.data.postsMenuOpen, false);
});
