const { loadPostActions, applyPageData } = require('./helpers/post-actions-fixture');
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
  let definition, cached = options.cached || null, current = { ...user }, albumCache = options.albumCache || null;
  const calls = [], routes = [];
  const users = { getCachedUser: () => current, getSessionVersion: () => 0, restore: async () => current };
  const square = {
    cachedOwnFeed: () => cached, cachedPost: () => null,
    cachedAlbum: () => albumCache,
    album: async args => { calls.push({ album: true, ...args }); albumCache = options.album ? await options.album(args) : { items: [], hasMore: false, nextOffset: 0 }; return albumCache; },
    list: async args => { calls.push(args); cached = options.list ? await options.list(args) : result; return cached; },
    react: async () => ({ ...post, liked: true, likeCount: 1 }),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.js'), 'utf8'), {
    Page: value => { definition = value; },
    require: name => name.includes('profile-navigation') ? require('../miniprogram/utils/profile-navigation') : name.includes('post-actions') ? loadPostActions(users, square, { showToast() {}, navigateTo: args => routes.push(args.url) }) : name.includes('services/square') ? square : name.includes('user-role') ? { describeUser } :
      name.includes('post-view') ? require('../miniprogram/utils/post-view') : name.includes('account-menu') ? require('../miniprogram/utils/account-menu') : users,
    wx: { getWindowInfo: () => ({ statusBarHeight: 44 }), getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32 }),
      navigateTo: args => routes.push(args.url), showToast() {}, stopPullDownRefresh() {} },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData: values => applyPageData(page.data, values) };
  return { page, calls, routes, setUser: value => { if ((current && current._id) !== (value && value._id)) { cached = null; albumCache = null; } current = value; page.applyUser(value); } };
}

test('个人主页发布打开原位面板，取消回到原个人主页，不跳转或清空动态', () => {
  const f = fixture({ cached: result }); f.page.onLoad(); f.page.publishPost();
  assert.equal(f.page.data.composerOpen, true); assert.equal(f.routes.length, 0);
  assert.equal(f.page.interactionBlocked(), true);
  f.page.closeComposer({ detail: { published: false } });
  assert.equal(f.page.data.composerOpen, false); assert.equal(f.routes.length, 0);
  assert.equal(f.page.data.ownPosts[0]._id, post._id);
});

test('个人相册同步预填缓存，后台失败保留图片；分页与账号切换不让迟到响应串号', async () => {
  const photo = { _id: 'photo', fileID: 'cloud://test.bucket/square-media/alice/photo.jpg' };
  let finish, attempts = 0;
  const f = fixture({ albumCache: { items: [photo], hasMore: true, nextOffset: 20 }, album: async args => {
    if (++attempts === 1) throw new Error('网络失败');
    assert.equal(args.offset, 20);
    return new Promise(resolve => { finish = resolve; });
  } });
  f.page.onLoad(); await f.page.selectContent(event('album'));
  assert.equal(f.page.data.albumImages[0]._id, 'photo'); assert.equal(f.page.data.albumError, '网络失败');
  const pending = f.page.loadMoreOwnPosts();
  f.page.onHide(); f.setUser({ ...user, _id: 'bob' });
  finish({ items: [photo], hasMore: false, nextOffset: 21 }); await pending;
  assert.equal(f.page.data.albumImages.length, 0); assert.equal(f.page.data.albumError, '');
});

test('动态箭头切换来源，评论保留原面板，正文可进入详情', async () => {
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
  f.page.openComments({ detail: { id: post._id } });
  assert.equal(f.page.data.commentPostId, post._id);
  assert.equal(f.routes.length, 0);
  f.page.closeComments(); assert.equal(f.page.data.commentPostId, '');
  f.page.openPost({ detail: { id: post._id } });
  assert.equal(f.routes[0], `/pages/square-detail/index?id=${post._id}`);
  await f.page.reactPost({ detail: { id: post._id, kind: 'like' } });
  assert.equal(f.page.data.ownPosts[0].likeCount, 1);
  f.page.selectContent(event('replies')); assert.equal(f.page.data.postsMenuOpen, false);
  assert.equal(f.page.data.selectedContent, 'replies');
  assert.equal(f.page.data.contentIndex, 1);
  f.page.selectContent(event('reposts')); assert.equal(f.page.data.contentIndex, 2);
  await f.page.selectContent(event('album')); assert.equal(f.page.data.contentIndex, 3);
  f.page.selectContent(event('posts')); assert.equal(f.page.data.postsMenuOpen, false); assert.equal(f.page.data.contentIndex, 0);
  assert.equal(f.page.data.ownPosts[0]._id, post._id);
  // 连续点击的最终面板与小蓝条使用同一索引，不依赖动画结束回调。
  for (const key of ['album', 'posts', 'reposts', 'replies']) f.page.selectContent(event(key));
  assert.equal(f.page.data.selectedContent, 'replies'); assert.equal(f.page.data.contentIndex, 1);
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
  await f.page.loadMoreOwnPosts();
  assert.equal(f.calls.at(-1).offset, 1); assert.equal(f.page.data.ownPosts.length, 2);
  f.setUser(null);
  assert.equal(f.page.data.ownPosts.length, 0); assert.equal(f.page.data.postsMenuOpen, false);
  f.page.selectContent(event('posts')); assert.equal(f.page.data.postsMenuOpen, false);
});

test('下拉刷新合并正在进行的读取，失败后停止转圈并保留现有内容', async () => {
  let fail;
  const f = fixture({ cached: result, list: () => new Promise((resolve, reject) => { fail = reject; }) });
  f.page.onLoad(); f.page._visible = true;
  const reading = f.page.loadOwnPosts(true);
  const refreshing = f.page.refreshProfilePosts();
  assert.equal(f.calls.length, 1); assert.equal(f.page.data.profileRefreshing, true);
  await Promise.resolve(); assert.equal(f.page.data.profileRefreshing, true);
  fail(new Error('网络失败')); await reading; await refreshing;
  assert.equal(f.page.data.profileRefreshing, false);
  assert.equal(f.page.data.ownPosts[0].content, post.content);
  assert.equal(f.page.data.postsError, '网络失败');
});
