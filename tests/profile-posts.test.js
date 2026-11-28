const { loadPostActions, applyPageData, postMenuAnchor, choosePostMenu } = require('./helpers/post-actions-fixture');
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
function measureProfileMenu(page) {
  page.createSelectorQuery = () => ({
    selectors: [],
    select(selector) { this.selectors.push(selector); return this; },
    selectAll(selector) { return this.select(selector); },
    boundingClientRect() { return this; },
    scrollOffset() { return this; },
    exec(callback) {
      if (!callback) return;
      if (!this.selectors[0].endsWith(' .tab-dropdown-chevron')) { callback([]); return; }
      const left = this.selectors[0].startsWith('.content-tab-album ') ? 281.25 : 0;
      callback([{ left: left + 64, top: 183, bottom: 195, width: 12 }, { left, width: 93.75 },
        { bottom: 212 }, { left: left + 17, width: 20 }, { left: left + 43, width: 16 }]);
    },
  });
}
function fixture(options = {}) {
  let definition, cached = options.cached || null, current = { ...user }, albumCache = options.albumCache || null, quoteCache = options.quoteCache || null, session = 0;
  const calls = [], routes = [], statsListeners = new Set();
  const users = { getCachedUser: () => current, getSessionVersion: () => session, restore: async () => current };
  const square = {
    cachedOwnFeed: type => type === 'quotes' ? quoteCache : cached, cachedPost: () => null,
    cachedAlbum: () => albumCache,
    album: async args => { calls.push({ album: true, ...args }); albumCache = options.album ? await options.album(args) : { items: [], hasMore: false, nextOffset: 0 }; return albumCache; },
    cachedProfileVideos: () => options.cachedVideos || null,
    listProfileVideos: async (accountId, args) => { calls.push({ videos: true, accountId, ...args }); return options.videos ? options.videos(args) : { items: [], hasMore: false, nextCursor: '' }; },
    list: async args => { calls.push(args); if (args.postType === 'quotes') { quoteCache = options.quotes ? await options.quotes(args) : { items: [], hasMore: false, nextOffset: 0 }; return quoteCache; } cached = options.list ? await options.list(args) : result; return cached; },
    react: async () => ({ ...post, liked: true, likeCount: 1 }),
    cachedOwnStats: () => options.cachedStats || null,
    getOwnStats: options.getOwnStats,
    reportUser: options.reportUser,
    subscribeOwnStats(listener) { statsListeners.add(listener); return () => statsListeners.delete(listener); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.js'), 'utf8'), {
    Page: value => { definition = value; }, setTimeout, clearTimeout,
    require: name => name.includes('label-indicator') ? require('../miniprogram/utils/label-indicator') : name.includes('post-removal-motion') ? require('../miniprogram/utils/post-removal-motion') : name.includes('cui-refresh-drawing') ? require('../miniprogram/utils/cui-refresh-drawing') : name.includes('profile-navigation') ? require('../miniprogram/utils/profile-navigation') : name.includes('post-actions') ? loadPostActions(users, square, { showToast() {}, navigateTo: args => routes.push(args.url) }) : name.includes('services/square') ? square : name.includes('user-role') ? { describeUser } :
      name.includes('post-view') ? require('../miniprogram/utils/post-view') : name.includes('account-menu') ? require('../miniprogram/utils/account-menu') : name.includes('post-images') ? { resolveVideoPlayback: options.resolveVideoPlayback } : users,
    wx: { getWindowInfo: () => ({ statusBarHeight: 44 }), getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32 }),
      navigateTo: args => routes.push(args.url), showToast: options.showToast || (() => {}),
      showActionSheet: options.showActionSheet, showModal: options.showModal, stopPullDownRefresh() {} },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(values, callback) { applyPageData(this.data, values); callback?.(); } };
  return { page, calls, routes, statsListeners, setUser: value => { if ((current && current._id) !== (value && value._id)) { session++; cached = null; albumCache = null; quoteCache = null; options.cachedStats = null; } current = value; page.applyUser(value); } };
}

test('访客主页菜单在确认后才提交用户举报，取消和过期确认不写数据', async () => {
  const reports = [], toasts = [];
  let confirm;
  const f = fixture({
    showActionSheet() { assert.fail('访客操作应使用玻璃菜单'); },
    showModal(args) { confirm = args.success; },
    reportUser: async (...args) => { reports.push(args); return { alreadyReported: false }; },
    showToast: args => toasts.push(args.title),
  });
  f.page.onLoad();
  await f.page.openProfileUserMenu();
  assert.equal(f.page.data.postPopover, null);
  Object.assign(f.page.data, { isVisitor: true, profileUser: { accountId: '10000002' } });
  f.page.createSelectorQuery = () => ({
    select(selector) { assert.equal(selector, '.profile-user-menu'); return this; },
    boundingClientRect(callback) { return { exec() { callback(postMenuAnchor); } }; },
  });
  const canceled = f.page.openProfileUserMenu();
  await Promise.resolve();
  assert.equal(f.page.data.profileUserMenuPulsing, true);
  assert.deepEqual(Array.from(f.page.data.postPopover.options, option => option.label), ['举报用户', '拉黑用户']);
  await choosePostMenu(f.page, 'block');
  confirm({ confirm: false }); await canceled;
  assert.deepEqual(toasts, []);
  assert.equal(reports.length, 0);
  const dismissed = f.page.openProfileUserMenu();
  await Promise.resolve();
  f.page.onPostPopoverDismiss({ currentTarget: { dataset: { kind: 'post' } } });
  assert.equal(f.page.data.postPopover.closing, true);
  await dismissed;
  assert.equal(f.page.data.postPopover, null);
  const first = f.page.openProfileUserMenu();
  await Promise.resolve();
  await choosePostMenu(f.page, 'report');
  assert.equal(f.page.data.postPopover.label, '举报原因');
  await choosePostMenu(f.page, 'spam');
  assert.equal(reports.length, 0);
  confirm({ confirm: true }); await first;
  assert.deepEqual(reports, [['10000002', 'spam']]);
  assert.equal(toasts.at(-1), '举报已提交');
  const stale = f.page.openProfileUserMenu();
  await Promise.resolve();
  await choosePostMenu(f.page, 'report');
  await choosePostMenu(f.page, 'spam');
  f.page._visible = false;
  confirm({ confirm: true }); await stale;
  assert.equal(reports.length, 1);
  f.page._visible = true;
  let measured;
  f.page.createSelectorQuery = () => ({
    select() { return this; },
    boundingClientRect(callback) { return { exec() { measured = callback; } }; },
  });
  const late = f.page.openProfileUserMenu();
  f.page.cancelPublicReads = () => {};
  f.page.onHide();
  measured(postMenuAnchor);
  await late;
  assert.equal(f.page.data.postPopover, null);
  assert.equal(f.page.data.profileUserMenuPulsing, false);
});

test('本人主页首帧复用侧栏获赞缓存，统计失效后只更新数字，失败保留已有值', async () => {
  let fail = false, receivedLikes = 8;
  const options = { cached: result, cachedStats: { receivedLikes: 5 }, async getOwnStats() {
    if (fail) throw new Error('offline');
    return options.cachedStats = { receivedLikes };
  } };
  const f = fixture(options);
  f.page.onLoad();
  assert.equal(f.page.data.likeCount, 5);
  await f.page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.page.data.likeCount, 8);
  const posts = f.page.data.ownPosts;
  receivedLikes = 9;
  await [...f.statsListeners][0]();
  assert.equal(f.page.data.likeCount, 9);
  assert.equal(f.page.data.ownPosts, posts);
  fail = true;
  await [...f.statsListeners][0]();
  assert.equal(f.page.data.likeCount, 9);
  f.page.onHide();
  assert.equal(f.statsListeners.size, 0);
});

test('本人主页的迟到获赞请求不能覆盖另一账号', async () => {
  let finish;
  const f = fixture({ getOwnStats: () => new Promise(resolve => { finish = resolve; }) });
  f.page.onLoad();
  assert.equal(f.page.data.likeCount, '—');
  f.page._visible = true;
  const pending = f.page.refreshOwnLikes(), resolveAlice = finish;
  f.setUser({ ...user, _id: 'bob' });
  resolveAlice({ receivedLikes: 99 });
  await pending;
  assert.equal(f.page.data.likeCount, '—');
  finish({ receivedLikes: 0 });
  await Promise.resolve();
  assert.equal(f.page.data.likeCount, 0);
});

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

test('个人主页视频复用第四项位置，播放和动态详情分开，视频分页保留相册', async () => {
  const photo = { _id: 'photo', fileID: 'cloud://test.bucket/square-media/alice/photo.jpg' };
  const album = { items: [photo], hasMore: true, nextOffset: 20 };
  const video = { _id: `${post._id}_0`, postId: post._id, fileID: 'cloud://test.bucket/square-media/alice/video.mp4', content: '视频正文', createdAt: post.createdAt };
  let finish;
  const f = fixture({ albumCache: album, album: async () => album, videos: ({ cursor }) => ({ items: [video], hasMore: !cursor, nextCursor: cursor ? '' : 'older' }),
    resolveVideoPlayback: () => new Promise(resolve => { finish = resolve; }) });
  f.page.onLoad();
  await f.page.selectContent(event('album'));
  measureProfileMenu(f.page);
  assert.equal(f.page.data.contentIndex, 3);
  const images = f.page.data.albumImages;
  const firstMenu = f.page.selectContent(event('album'));
  await Promise.resolve();
  assert.equal(f.page.data.postPopover.kind, 'media');
  assert.equal(f.page.data.postPopover.selectedKey, 'album');
  await choosePostMenu(f.page, 'videos', 'media');
  await firstMenu;
  assert.equal(f.page.data.mediaTab, 'videos');
  assert.equal(f.page.data.selectedContent, 'album');
  assert.equal(f.page.data.contentIndex, 3);
  assert.equal(f.page.data.videos[0].content, '视频正文');
  assert.match(f.page.data.videos[0].timeText, /11月17日/);
  await f.page.loadMoreOwnPosts();
  assert.equal(f.calls.at(-1).cursor, 'older');
  assert.equal(f.calls.filter(call => call.album).length, 1);
  assert.equal(f.page.data.albumImages, images);
  const tap = { currentTarget: { dataset: { id: video._id, post: post._id } } };
  const playing = f.page.playProfileVideo(tap);
  assert.equal(f.page.data.videoPlayback.id, video._id);
  assert.equal(f.routes.length, 0);
  finish('https://example.com/video.mp4'); await playing;
  assert.equal(f.page.data.videoPlayback.src, 'https://example.com/video.mp4');
  f.page.openVideoPost(tap);
  assert.equal(f.page.data.videoPlayback, null);
  assert.equal(f.routes[0], `/pages/square-detail/index?id=${post._id}`);
  const late = f.page.playProfileVideo(tap);
  const secondMenu = f.page.toggleMediaMenu();
  finish('https://example.com/late.mp4'); await late;
  assert.equal(f.page.data.videoPlayback, null);
  await choosePostMenu(f.page, 'album', 'media');
  await secondMenu;
  assert.equal(f.page.data.mediaTab, 'album');
  assert.equal(f.page.data.postPopover, null);
  assert.equal(f.page.data.albumImages[0]._id, photo._id);
  const pendingMenu = f.page.toggleMediaMenu();
  f.page.onHide();
  await pendingMenu;
  assert.equal(f.page.data.postPopover, null);
});

test('动态箭头切换来源，评论保留原面板，正文可进入详情', async () => {
  const f = fixture({ cached: result }); f.page.onLoad();
  measureProfileMenu(f.page);
  assert.equal(f.page.data.ownPosts[0].content, post.content);
  assert.equal(f.calls.length, 0);
  const menu = f.page.selectContent(event('posts'));
  await Promise.resolve();
  assert.equal(f.page.data.postPopover.kind, 'posts');
  assert.equal(f.page.data.postPopover.top, 218);
  assert.ok(Math.abs(f.page.data.postPopover.width - 286 / 3) < 0.01);
  assert.equal(f.page.data.postPopover.selectedKey, 'square');
  await choosePostMenu(f.page, 'campus', 'posts');
  await menu;
  assert.equal(f.page.data.postPopover, null); assert.equal(f.page.data.postScope, 'campus');
  assert.equal(f.calls.length, 0);
  f.page.selectPostScope('square');
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
  f.page.selectContent(event('replies')); assert.equal(f.page.data.postPopover, null);
  assert.equal(f.page.data.selectedContent, 'replies');
  assert.equal(f.page.data.contentIndex, 1);
  f.page.selectContent(event('reposts')); assert.equal(f.page.data.contentIndex, 2);
  await f.page.selectContent(event('album')); assert.equal(f.page.data.contentIndex, 3);
  f.page.selectContent(event('posts')); assert.equal(f.page.data.postPopover, null); assert.equal(f.page.data.contentIndex, 0);
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
  assert.equal(f.page.data.ownPosts.length, 0); assert.equal(f.page.data.postPopover, null);
  f.page.selectContent(event('posts')); assert.equal(f.page.data.postPopover, null);
});

test('下拉刷新合并正在进行的读取，失败保留现有内容并完成Cui动画', async () => {
  let fail;
  const f = fixture({ cached: result, list: () => new Promise((resolve, reject) => { fail = reject; }) });
  f.page.onLoad(); f.page._visible = true;
  const reading = f.page.loadOwnPosts(true);
  const refreshing = f.page.refreshProfilePosts();
  assert.equal(f.calls.length, 1); assert.equal(f.page.data.profileRefreshing, true);
  await Promise.resolve(); assert.equal(f.page.data.profileRefreshing, true);
  fail(new Error('网络失败')); await reading; await refreshing;
  assert.equal(f.page.data.profileRefreshing, true);
  f.page.resetProfilePull(); assert.equal(f.page.data.profileRefreshing, false);
  assert.equal(f.page.data.ownPosts[0].content, post.content);
  assert.equal(f.page.data.postsError, '网络失败');
});


test('引用标签同步预填真实缓存，独立分页和刷新，普通动态不包含引用且切换不销毁列表', async () => {
  const quote = { ...post, _id: 'p_' + 'b'.repeat(40), quotePostId: post._id };
  const older = { ...quote, _id: 'p_' + 'c'.repeat(40) };
  const f = fixture({ cached: { ...result, items: [post, quote] }, quoteCache: { items: [quote], hasMore: true, nextOffset: 20 },
    quotes: async args => ({ items: args.offset ? [quote, older] : [quote], hasMore: !args.offset, nextOffset: args.offset ? 21 : 20 }) });
  f.page.onLoad(); assert.equal(f.page.data.ownPosts.length, 1); assert.equal(f.page.data.quotePosts[0]._id, quote._id);
  await f.page.selectContent(event('reposts'));
  assert.equal(f.page.data.contentIndex, 2); assert.equal(f.calls.at(-1).postType, 'quotes');
  await f.page.loadMoreOwnPosts(); assert.equal(f.calls.at(-1).offset, 20); assert.equal(f.page.data.quotePosts.length, 2);
  await f.page.refreshProfilePosts(); assert.equal(f.calls.at(-1).force, true); assert.equal(f.calls.at(-1).postType, 'quotes');
  f.page.selectContent(event('posts')); assert.equal(f.page.data.quotePosts[0]._id, quote._id);
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.wxml'), 'utf8');
  assert.match(template, /view wx:for="{{quotePosts}}" wx:key="_id" id="{{'profile-quotes-row-' \+ item\._id}}"/);
});

test('本人主页复用碎裂补位，动画期间延后更新列表，访客主页不启动动画', () => {
  const f = fixture();
  f.page.onLoad();
  const next = { ...post, _id: 'p_' + 'b'.repeat(40) };
  f.page.showOwnPosts({ ...result, items: [post, next] });
  const neighbor = f.page.data.ownPosts[1];
  f.page.createSelectorQuery = () => ({
    select(selector) { assert.equal(selector, '#profile-posts-row-' + post._id); return this; },
    boundingClientRect(callback) { return { exec() { callback({ width: 375, height: 150, top: 200, bottom: 350 }); } }; },
  });
  const removed = () => f.page.setData({ ownPosts: [neighbor] });
  assert.equal(f.page.animateDeletedPost(post._id, removed), true);
  assert.equal(f.page.data.postRemoval.target, 'profile-posts');
  f.page.showOwnPosts({ ...result, items: [next] });
  assert.equal(f.page.data.ownPosts[0]._id, post._id);
  const animationEnd = phase => f.page.onPostRemovalAnimationEnd({ target: { dataset: { id: post._id, phase } } });
  animationEnd('scatter');
  assert.equal(f.page.data.postRemoval.phase, 'reflow');
  animationEnd('reflow');
  assert.equal(f.page.data.postRemoval, null);
  assert.equal(f.page.data.ownPosts[0], neighbor);
  f.page.data.isVisitor = true;
  assert.equal(f.page.animateDeletedPost(next._id, removed), false);
});

test('引用读取失败保留旧卡片，换账号及隐藏后的迟到结果不恢复旧记录', async () => {
  const quote = { ...post, quotePostId: 'source' }; let finish, attempts = 0;
  const f = fixture({ quoteCache: { items: [quote], hasMore: true, nextOffset: 20 }, quotes: async () => {
    if (++attempts === 1) throw new Error('网络失败');
    return new Promise(resolve => { finish = resolve; });
  } });
  f.page.onLoad(); await f.page.selectContent(event('reposts'));
  assert.equal(f.page.data.quotePosts.length, 1); assert.equal(f.page.data.quotesError, '网络失败');
  const pending = f.page.retryOwnQuotes(); f.page.onHide(); f.setUser({ ...user, _id: 'bob' });
  finish({ items: [quote], hasMore: false, nextOffset: 1 }); await pending;
  assert.equal(f.page.data.quotePosts.length, 0); assert.equal(f.page.data.quotesError, '');
});
