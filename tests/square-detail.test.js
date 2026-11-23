const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadPostActions, applyPageData } = require('./helpers/post-actions-fixture');

const user = { _id: 'alice', accountId: '12345678', certificationStatus: 'unverified' };
const id = 'p_' + 'a'.repeat(40);
const post = { _id: id, author: { nickname: '真实作者', accountId: '12345678' }, isOwn: true,
  content: '正文'.repeat(180), createdAt: '2026-11-18T03:20:00Z', liked: false, likeCount: 0, replyCount: 2 };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture(options = {}) {
  let definition, account = options.guest ? null : user, version = 0, cached = options.cached || null;
  const calls = [], routes = [], updates = [], toasts = [], listeners = new Set();
  const translations = new Map();
  const users = { getCachedUser: () => account, getSessionVersion: () => version,
    logout() { account = null; version++; cached = null; },
    login: async () => { account = user; version++; cached = null; return account; } };
  const square = {
    cachedPost: () => cached,
    cachedNewsTranslation: (id, key) => translations.get(`${version}:${id}:${key}`),
    async translateNews(id, key) {
      calls.push({ type: 'translation', id, key });
      const cacheKey = `${version}:${id}:${key}`;
      const result = await options.translateNews(id, key);
      translations.set(cacheKey, result);
      return result;
    },
    subscribePost(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    detail: async (postId, force) => {
      calls.push({ type: 'detail', postId, force });
      const result = options.detail ? await options.detail(postId, force) : post;
      // 服务层在真实项目中已有账号隔离；此处不将迟到数据写入缓存。
      return result;
    },
    react: async (postId, kind, active) => {
      calls.push({ type: 'react', postId, kind, active });
      if (options.react) return options.react();
      cached = { ...(cached || post), liked: active, likeCount: active ? 1 : 0 }; return cached;
    },
    deletePost: async postId => { calls.push({ type: 'delete', postId }); cached = null; },
  };
  const wx = { getWindowInfo: () => ({ windowHeight: 812, statusBarHeight: 44 }),
    getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32 }), hideKeyboard() {},
    showToast: args => toasts.push(args.title),
    showActionSheet: args => args.success({ tapIndex: 0 }), showModal: args => args.success({ confirm: true }),
    navigateBack(args) { routes.push('back'); if (options.failBack) args.fail(); },
    switchTab: args => routes.push(args.url), nextTick: fn => fn() };
  const gateContext = { module: { exports: {} }, require: () => users, wx };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/login-gate.js'), 'utf8'), gateContext);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/square-detail/index.js'), 'utf8'), {
    Page: value => { definition = value; }, wx,
    getCurrentPages: () => options.returnPage ? [options.returnPage, page] : [page],
    require: name => name.includes('services/user') ? users : name.includes('services/square') ? square :
      name.includes('login-gate') ? gateContext.module.exports : name.includes('post-actions') ? loadPostActions(users, square, wx) : require('../miniprogram/utils/post-view'),
  });
  const page = { ...definition, data: structuredClone(definition.data),
    setData(values) { updates.push(values); applyPageData(this.data, values); },
    selectComponent: () => options.comments || null };
  return { page, calls, routes, toasts, updates, listeners,
    start(postId = id) { page.onLoad({ id: postId }); return page.onShow(); },
    setUser(next) { account = next; version++; cached = null; },
    setCached(next) { cached = next; } };
}

const news = { ...post, _id: 'n_' + 'a'.repeat(40), contentType: 'news', title: 'English headline', content: 'First.\n\nSecond.',
  translationVersion: '1'.repeat(40), images: ['https://images.example.com/a.jpg'] };
const translation = { version: news.translationVersion, title: '中文标题', content: '第一段。\n\n第二段。' };

test('新闻详情首次点击展现翻译状态，后续原文译文切换复用首次结果，只更新译文展示', async () => {
  let finish;
  const f = fixture({ cached: news, detail: () => news, translateNews: () => new Promise(resolve => { finish = resolve; }) });
  await f.start(news._id);
  const original = f.page.data.posts[0];
  const pending = f.page.toggleNewsTranslation();
  assert.equal(f.page.data.translatingNews, true);
  assert.equal(f.page.data.newsTranslation, null);
  await f.page.toggleNewsTranslation();
  finish(translation); await pending;
  assert.equal(f.page.data.translatingNews, false);
  assert.deepEqual(f.page.data.newsTranslation, translation);
  await f.page.toggleNewsTranslation();
  assert.equal(f.page.data.newsTranslation, null);
  await f.page.toggleNewsTranslation();
  assert.deepEqual(f.page.data.newsTranslation, translation);
  assert.equal(f.page.data.posts[0], original);
  assert.equal(f.calls.filter(call => call.type === 'translation').length, 1);
  await f.page.loadPost();
  assert.deepEqual(f.page.data.newsTranslation, translation);
  f.page.showPost({ ...news, translationVersion: '2'.repeat(40), title: 'Updated' });
  assert.equal(f.page.data.newsTranslation, null);
});

test('页面隐藏后的译文不主动覆盖界面，返回后可使用已完成结果', async () => {
  let finish;
  const f = fixture({ cached: news, detail: () => news, translateNews: () => new Promise(resolve => { finish = resolve; }) });
  await f.start(news._id);
  const pending = f.page.toggleNewsTranslation();
  f.page.onHide();
  finish(translation); await pending;
  assert.equal(f.page.data.newsTranslation, null);
  await f.page.onShow();
  assert.equal(f.page.data.translatingNews, false);
  await f.page.toggleNewsTranslation();
  assert.deepEqual(f.page.data.newsTranslation, translation);
  assert.equal(f.calls.filter(call => call.type === 'translation').length, 1);
});

test('详情首帧展示真实缓存全文，复用会话，不等待后台，不重复加载', async () => {
  let finish;
  const f = fixture({ cached: { ...post, content: post.content.slice(0, 280), fullContent: post.content, truncated: true },
    detail: () => new Promise(resolve => { finish = resolve; }) });
  f.page.onLoad({ id });
  assert.equal(f.page.data.posts[0].content, post.content);
  assert.equal(f.page.data.posts[0].exactTime, '2026年11月18日 11:20');
  assert.equal(f.page.data.user._id, user._id); assert.equal(f.calls.length, 0);
  const reading = f.page.onShow(), duplicate = f.page.loadPost();
  assert.equal(reading, duplicate); assert.equal(f.page.data.loading, false);
  await tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].force, false);
  finish(post); await reading;
  assert.equal(f.page.data.posts[0].author.nickname, post.author.nickname);
});

test('首次无缓存按需读动态，失败保留原内容，重试不重建评论区或清空草稿', async () => {
  let failed = false;
  const f = fixture({ detail: () => { if (failed) throw new Error('网络暂不可用'); return post; } });
  f.page.onLoad({ id }); assert.equal(f.page.data.loading, true);
  await f.page.onShow(); const mounts = f.page.data.commentMounts;
  failed = true; await f.page.retry();
  assert.equal(f.page.data.posts[0].content, post.content); assert.equal(f.page.data.error, '网络暂不可用');
  assert.equal(f.page.data.commentMounts, mounts); assert.equal(f.calls.at(-1).force, true);
  failed = false; await f.page.retry();
  assert.equal(f.page.data.error, ''); assert.equal(f.page.data.commentMounts, mounts);
  f.setCached({ ...post, replyCount: 3 }); f.page.commentChanged({ detail: { id } });
  assert.equal(f.page.data.posts[0].replyCount, 3); assert.equal(f.page.data.posts[0].fullContent, post.content);
  assert.equal(f.page.data.commentMounts, mounts);
});

test('离开时解除点赞订阅和忽略迟到读取，返回后重新使用缓存', async () => {
  let finish;
  const f = fixture({ cached: post, detail: () => new Promise(resolve => { finish = resolve; }) });
  const reading = f.start(); await tick(); assert.equal(f.listeners.size, 1);
  f.page.onHide(); assert.equal(f.listeners.size, 0);
  finish({ ...post, content: '迟到旧正文' }); await reading;
  assert.equal(f.page.data.posts[0].content, post.content);
  f.setCached({ ...post, likeCount: 5 });
  const returning = f.page.onShow(); await tick();
  assert.equal(f.page.data.posts[0].likeCount, 5);
  finish({ ...post, likeCount: 5 }); await returning;
  f.page.onUnload(); assert.equal(f.listeners.size, 0);
});

test('换账号重建私人评论状态，旧账号迟到的详情不能覆盖新账号', async () => {
  const completions = [];
  const f = fixture({ cached: { ...post, liked: true }, detail: () => new Promise(resolve => completions.push(resolve)) });
  const old = f.start(); await tick(); const oldMounts = f.page.data.commentMounts;
  f.setUser({ _id: 'bob', accountId: '87654321' });
  const fresh = f.page.onLoggedIn(); await tick();
  assert.equal(f.page.data.posts.length, 0); assert.notEqual(f.page.data.commentMounts, oldMounts);
  completions[1]({ ...post, liked: false, likeCount: 4 }); await fresh;
  completions[0]({ ...post, liked: true, likeCount: 99 }); await old;
  assert.equal(f.page.data.user._id, 'bob'); assert.equal(f.page.data.posts[0].likeCount, 4);
  assert.equal(f.page.data.posts[0].liked, false);
});

test('游客可读详情，点赞时才提示登录，取消后继续停留详情', async () => {
  const f = fixture({ guest: true, cached: post }); await f.start();
  assert.equal(f.page.data.loginSheetOpen, false); assert.equal(f.page.data.posts[0]._id, id);
  await f.page.reactPost({ detail: { id, kind: 'like' } });
  assert.equal(f.page.data.loginSheetOpen, true);
  assert.equal(f.calls.filter(row => row.type === 'react').length, 0);
  await f.page.cancelLogin();
  assert.equal(f.page.data.loginSheetOpen, false); assert.equal(f.routes.length, 0);
  f.page.commentLogin(); await f.page.login();
  assert.equal(f.page.data.user._id, user._id); assert.equal(f.page.data.loginSheetOpen, false);
});

test('未认证账号在详情中点赞立即变红；评论按钮直接聚焦原有输入组件', async () => {
  let finish, focused = 0;
  const f = fixture({ cached: post, react: () => new Promise(resolve => { finish = resolve; }), comments: { focusComposer() { focused++; } } });
  await f.start();
  const liking = f.page.reactPost({ detail: { id, kind: 'like' } });
  assert.equal(f.page.data.posts[0].liked, true); assert.equal(f.page.data.posts[0].likeCount, 1);
  f.page.focusComments(); assert.equal(focused, 1);
  f.setCached({ ...post, liked: true, likeCount: 1 }); finish({ ...post, liked: true, likeCount: 1 }); await liking;
  assert.equal(f.page.data.posts[0].liked, true);
});

test('删除本人的详情后清理正文与评论，不多跳页面；远端不可见也移除缓存展示', async () => {
  const f = fixture({ cached: post }); await f.start();
  await f.page.managePost({ detail: { id } });
  assert.equal(f.page.data.posts.length, 0); assert.equal(f.calls.at(-1).type, 'delete');
  assert.equal(f.routes.length, 0); assert.equal(f.toasts.at(-1), '动态已删除');
  const missing = fixture({ cached: post, detail: () => { throw Object.assign(new Error('不存在'), { code: 'POST_NOT_FOUND' }); } });
  await missing.start(); assert.equal(missing.page.data.posts.length, 0); assert.equal(missing.page.data.unavailable, true);
});

test('无效入口不发云端请求；原生返回只执行一次并提前恢复来源首页', async () => {
  const invalid = fixture(); invalid.page.onLoad({ id: '../非法ID' }); await invalid.page.onShow();
  assert.equal(invalid.calls.length, 0); assert.equal(invalid.page.data.unavailable, true);
  let prepared = 0;
  const f = fixture({ cached: post, returnPage: { prepareMenuReturn() { prepared++; } } }); await f.start();
  f.page.back(); f.page.back(); f.page.onUnload();
  assert.deepEqual(f.routes, ['back']); assert.equal(prepared, 1);
  const direct = fixture({ failBack: true }); direct.page.onLoad({ id }); direct.page.back();
  assert.deepEqual(direct.routes, ['back', '/pages/home/index']);
});
