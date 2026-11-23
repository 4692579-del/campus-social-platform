const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { fixture } = require('./helpers/certification-fixture');
const { loadPostActions, applyPageData } = require('./helpers/post-actions-fixture');
const { createNewsService, TTL } = require('../cloudfunctions/userService/news-service');
const { createWorldNewsClient, newsError } = require('../cloudfunctions/userService/world-news');
const { articleOf, newsView } = require('../cloudfunctions/userService/news-adapter');

const tables = ['news_articles', 'news_cache', 'news_interactions', 'news_replies', 'news_reply_children', 'news_comment_states', 'news_reports'];
function upstreamArticle(id, fields = {}) {
  return { id, title: `Synthetic test article ${id}`, url: `https://publisher.example.com/articles/${id}`,
    publish_date: '2026-11-23 01:00:00', text: 'First paragraph.\n\n' + 'Second paragraph. '.repeat(100).trimEnd(),
    summary: 'Short summary.', image: 'https://images.example.com/cover.jpg', authors: ['Test author'],
    category: 'science', language: 'en', source_country: 'au', ...fields };
}

test('小萃按可见新闻原文翻译标题和分段正文，合并并发任务，跨账号读取已有译文时不再生成或扣额', async () => {
  let finish, started, calls = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const checked = [];
  const f = fixture({ tables, async translateAI(input) {
    calls++;
    assert.deepEqual(input, { title: 'A & B', lines: ['First.', 'Second.'] });
    return new Promise(resolve => { finish = resolve; started(); });
  }, checkText: async text => { checked.push(text); return true; } });
  f.hooks.serialTransactionReads = true;
  await f.login(); await f.login(f.bob);
  const { _id: id, ...row } = articleOf(upstreamArticle(8, { title: 'A &amp; B', text: 'First.\n\nSecond.' }));
  const article = f.db.collection('news_articles').doc(id);
  await article.set({ data: row });
  const version = newsView({ _id: id, ...row }, true).translationVersion;
  const request = (who = f.alice, key = version) => f.handle({ action: 'translateNews', postId: id, version: key, title: 'untrusted input' }, who);
  assert.equal((await request({ openid: 'guest' })).code, 'NOT_REGISTERED');
  assert.equal((await request(f.alice, 'a'.repeat(40))).code, 'NEWS_TRANSLATION_CHANGED');
  const first = request(); await ready;
  assert.equal((await request(f.bob)).code, 'NEWS_TRANSLATION_BUSY');
  finish(JSON.stringify({ title: '甲和乙', lines: ['第一段。', '第二段。'] }));
  const translation = { version, title: '甲和乙', content: '第一段。\n\n第二段。' };
  assert.deepEqual((await first).square.translation, translation);
  assert.deepEqual((await request(f.bob)).square.translation, translation);
  assert.equal(calls, 1);
  assert.deepEqual(checked, ['甲和乙\n第一段。\n\n第二段。']);
  assert.equal((await article.get()).data.content, 'First.\n\nSecond.');
  assert.deepEqual([...f.aiJobs.values()].map(row => row.usedChars), [13, 13]);
});

test('译文缺段、审核拒绝与原文更新均不缓存、不扣额，释放租约后可重试', async () => {
  let mode = 'incomplete';
  const { _id: id, ...row } = articleOf(upstreamArticle(9, { title: 'News', text: 'First.\n\nSecond.' }));
  const f = fixture({ tables, async translateAI() {
    if (mode === 'changed') await article.update({ data: { title: 'Updated' } });
    return JSON.stringify({ title: '新闻', lines: mode === 'incomplete' ? ['第一段。'] : ['第一段。', '第二段。'] });
  }, checkText: async () => mode !== 'blocked' });
  const article = f.db.collection('news_articles').doc(id);
  await article.set({ data: row });
  await f.login();
  const version = newsView({ _id: id, ...row }, true).translationVersion;
  const request = () => f.handle({ action: 'translateNews', postId: id, version }, f.alice);
  assert.equal((await request()).code, 'NEWS_TRANSLATION_FAILED');
  mode = 'blocked'; assert.equal((await request()).code, 'CONTENT_REJECTED');
  mode = 'changed'; assert.equal((await request()).code, 'NEWS_TRANSLATION_CHANGED');
  assert.ok([...f.aiJobs.values()].every(job => job.usedChars === 0 && !Object.keys(job.reservations).length));
  await article.update({ data: { title: row.title } });
  mode = 'success'; assert.equal((await request()).square.translation.content, '第一段。\n\n第二段。');
});

test('全球新闻使用真实接口形状、固定分页时间窗和共享缓存；额度用完回退到旧榜单', async () => {
  let now = Date.parse('2026-11-23T02:00:00Z'), quota = false;
  const calls = [];
  const f = fixture({ tables, news: db => createNewsService(db, { now: () => now, async request(path, params) {
    calls.push({ path, params });
    if (quota) throw newsError('NEWS_QUOTA_EXHAUSTED');
    const news = params.offset ? [upstreamArticle(12)] : Array.from({ length: 10 }, (_, i) => upstreamArticle(i + 1));
    if (!params.offset) news[1] = upstreamArticle(99, { url: `${news[0].url}?utm_source=test` });
    return { news, available: 11, offset: params.offset };
  } }) });
  const list = args => f.handle({ action: 'listNewsPosts', ...args }, f.alice);
  const initial = (await list()).square;
  assert.equal(initial.items.length, 9);
  assert.equal(initial.items[0].contentType, 'news');
  assert.equal(initial.items[0].content, upstreamArticle(1).text);
  assert.equal(initial.items[0].fullContent, undefined);
  assert.equal(initial.items[0].author.nickname, 'publisher.example.com');
  assert.equal(initial.items[0].author.accountId, '');
  assert.equal(initial.nextOffset, 10);
  assert.equal(initial.hasMore, true);
  assert.equal(calls[0].params['sort-direction'], 'DESC');
  assert.equal(calls[0].params.sort, 'publish-time');
  assert.equal(calls[0].params['source-countries'], undefined);
  assert.equal((await list()).success, true);
  assert.equal(calls.length, 1);
  assert.equal((await list({ offset: 20, anchor: initial.anchor })).code, 'NEWS_INVALID_PAGE');
  now += 1000;
  const page = (await list({ offset: 10, anchor: initial.anchor })).square;
  assert.equal(page.items.length, 1);
  assert.equal(page.hasMore, false);
  assert.equal(calls[1].params['latest-publish-date'], calls[0].params['latest-publish-date']);
  assert.equal(calls[1].params['earliest-publish-date'], '2026-11-16 02:00:00');
  quota = true;
  now += TTL;
  const stale = (await list()).square;
  assert.equal(stale.stale, true);
  assert.equal(stale.items[0]._id, initial.items[0]._id);
  assert.equal((await list({ language: 'zh' })).code, 'NEWS_QUOTA_EXHAUSTED');
  assert.equal(calls.length, 3);
  assert.equal(f.squarePosts.size, 0);
});

test('新闻详情按需取多图并保留完整正文；关闭动态点赞和新评论，保留旧评论与收藏隔离', async () => {
  let now = Date.parse('2026-11-23T02:00:00Z');
  const raw = upstreamArticle(1, { text: 'First paragraph.&#13;&#13;Second &amp; third.' });
  const originals = Array.from({ length: 12 }, (_, i) => ({ url: `https://images.example.com/article-${i}.jpg` }));
  const paths = [];
  const f = fixture({ tables, news: db => createNewsService(db, { now: () => now, async request(path, params) {
    paths.push(path);
    if (path === 'search-news') return { news: [raw], available: 1 };
    assert.equal(path, 'extract-news');
    assert.equal(params.url, raw.url);
    return { text: 'Alternative article text.', images: [{ url: raw.image }, ...originals,
      { url: 'https://images.example.com/pixel.png', width: 1, height: 1 }, { url: 'http://127.0.0.1/a.png' }] };
  } }) });
  await f.login(); await f.login(f.bob);
  const call = (action, fields = {}, who = f.alice) => f.handle({ action, personalize: true, ...fields }, who);
  const { _id: id } = (await call('listNewsPosts')).square.items[0];
  now += 1000;
  const detail = (await call('getSquarePost', { postId: id, url: 'https://wrong.example.com' })).square.post;
  assert.equal(detail.content, 'First paragraph.\n\nSecond & third.');
  assert.equal(detail.sourceUrl, raw.url);
  assert.deepEqual(detail.images, [raw.image, ...originals.map(image => image.url)]);
  const refreshed = (await call('listNewsPosts')).square.items[0];
  assert.equal(refreshed.content, detail.content);
  assert.deepEqual(refreshed.images, detail.images);
  assert.deepEqual((await call('getSquarePost', { postId: id })).square.post.images, detail.images);
  assert.deepEqual(paths, ['search-news', 'extract-news']);
  const reaction = (kind, active, who) => call('setSquareReaction', { postId: id, kind, active }, who);
  for (const active of [true, false]) {
    const result = await reaction('like', active);
    assert.equal(result.code, 'NEWS_LIKES_DISABLED');
    assert.equal(result.message, '全球动态暂不支持点赞');
  }
  assert.equal((await call('getSquarePost', { postId: id })).square.post.likeCount, 0);
  assert.equal((await reaction('bookmark', true)).square.post.bookmarked, true);
  assert.equal((await call('getSquarePost', { postId: id }, f.bob)).square.post.bookmarked, false);
  assert.equal((await reaction('bookmark', false)).square.post.bookmarked, false);
  const reply = (text, requestId, replyToId, who, askAI) => call('publishSquareReply', { post: { postId: id, scope: 'square',
    content: text, requestId, ...(replyToId ? { replyToId } : {}), ...(askAI ? { askAI } : {}) } }, who);
  const alice = (await f.login())._id, bob = (await f.login(f.bob))._id;
  const root = { _id: 'r_' + 'a'.repeat(40) }, nested = { _id: 'c_' + 'b'.repeat(40) };
  await f.db.collection('news_replies').doc(root._id).set({ data: { postId: id, scope: 'news', status: 'published', authorId: alice,
    content: '已有新闻评论', sortKey: '01', replyCount: 1 } });
  await f.db.collection('news_reply_children').doc(nested._id).set({ data: { postId: id, scope: 'news', status: 'published', authorId: bob,
    content: '已有楼中回复', sortKey: '02', rootId: root._id, replyToId: root._id, replyToAuthorId: alice, ancestorIds: [root._id] } });
  await f.db.collection('news_articles').doc(id).update({ data: { replyCount: 2 } });
  const roots = (await call('listSquareReplies', { postId: id })).square;
  assert.equal(roots.commentsDisabled, true);
  assert.equal(roots.items[0]._id, root._id);
  for (const [key, target] of [['news-root-test-0001', ''], ['news-child-test-001', root._id]]) {
    const result = await reply('关闭后的新留言', key, target);
    assert.equal(result.code, 'COMMENTS_DISABLED');
    assert.equal(result.message, '全球动态暂不支持评论');
  }
  assert.equal((await call('getSquarePost', { postId: id })).square.post.replyCount, 2);
  assert.equal((await call('getSquareReplyContext', { postId: id, replyId: nested._id }, f.bob)).square.targetId, nested._id);
  assert.equal((await call('setSquareCommentState', { postId: id, replyId: nested._id, kind: 'like', active: true })).square.reply.likeCount, 1);
  assert.equal((await call('listSquareReplyChildren', { postId: id, rootId: root._id })).square.items.length, 1);
  assert.equal((await reply('不会启动 AI', 'news-ai-test-0001', '', f.alice, true)).code, 'INVALID_POST');
  assert.equal((await call('deleteSquarePost', { postId: id })).code, 'INVALID_POST');
  assert.equal((await call('deleteSquareReply', { postId: id, replyId: root._id }, f.bob)).code, 'FORBIDDEN');
  assert.equal((await call('deleteSquareReply', { postId: id, replyId: root._id })).square.post.replyCount, 0);
  assert.equal((await call('listSquareReplies', { postId: id })).square.items.length, 0);
  assert.equal(f.squarePosts.size + f.squareInteractions.size + f.squareReplies.size + f.squareReplyChildren.size + f.aiJobs.size, 0);
});

test('正文缺失使用 Retrieve News，空列表是真实空状态', async () => {
  let now = Date.parse('2026-11-23T02:00:00Z');
  const calls = [];
  const f = fixture({ tables, news: db => createNewsService(db, { now: () => now, async request(path, query) {
    calls.push({ path, query });
    if (path === 'retrieve-news') return { news: [upstreamArticle(1)] };
    return query.language === 'zh' ? { available: 0, news: [] } : { available: 1, news: [upstreamArticle(1, { text: '' })] };
  } }) });
  const row = (await f.handle({ action: 'listNewsPosts' }, f.alice)).square.items[0];
  now += 1000;
  const detail = (await f.handle({ action: 'getSquarePost', postId: row._id }, f.alice)).square.post;
  assert.equal(detail.content, upstreamArticle(1).text);
  assert.equal(calls[1].query.ids, 1);
  assert.equal(calls[1].path, 'retrieve-news');
  now += 1000;
  const empty = (await f.handle({ action: 'listNewsPosts', language: 'zh' }, f.alice)).square;
  assert.deepEqual(empty.items, []);
  assert.equal(empty.hasMore, false);
});

test('World News 客户端只从服务端鉴权头发送密钥并映射 401、402、429、超时', async () => {
  for (const [status, code] of [[401, 'NEWS_AUTH_FAILED'], [402, 'NEWS_QUOTA_EXHAUSTED'], [429, 'NEWS_RATE_LIMITED'], [0, 'NEWS_TIMEOUT']]) {
    const request = createWorldNewsClient({ getKey: () => 'synthetic-key', timeout: 10, get(url, options, callback) {
      assert.equal(url.origin, 'https://api.worldnewsapi.com');
      assert.equal(url.searchParams.has('api-key'), false);
      assert.equal(options.headers['x-api-key'], 'synthetic-key');
      const req = new EventEmitter();
      req.destroy = () => {};
      if (status) queueMicrotask(() => callback({ statusCode: status, destroy() {} }));
      return req;
    } });
    await assert.rejects(request('search-news', { number: 10 }), error => error.code === code && !error.message.includes('synthetic-key'));
  }
  await assert.rejects(createWorldNewsClient({ getKey: () => '' })('search-news', {}), { code: 'NEWS_KEY_MISSING' });
});

test('新闻页进入共用详情，返回保留列表，分页追加并拒绝换号前的结果', async () => {
  let definition, version = 0, resolvePage, cache = null;
  const calls = [], routes = [];
  const row = { _id: 'n_' + 'a'.repeat(40), contentType: 'news', title: 'Test headline', content: 'Test summary', images: ['https://images.example.com/a.jpg'] };
  const loaded = { items: [row], hasMore: true, nextOffset: 10, anchor: 123 };
  const users = { getSessionVersion: () => version, getCachedUser: () => null };
  const square = {
    subscribePost: () => () => {}, cachedNews: () => cache,
    listNews(options) { calls.push(options); return new Promise(resolve => { resolvePage = resolve; }); },
  };
  const wx = { navigateTo: options => routes.push(options.url), navigateBack: () => routes.push('back') };
  const dependencies = { user: users, square, 'login-gate': {}, 'post-actions': loadPostActions(users, square, wx) };
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/global-news/index.js', 'utf8'), {
    wx, Page: value => { definition = value; },
    require: name => dependencies[name.split('/').at(-1)] || require('../miniprogram/utils/' + name.split('/').at(-1)),
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { applyPageData(this.data, patch); } };
  page.onLoad();
  const first = page.onShow();
  resolvePage(cache = loaded); await first;
  page.openPost({ detail: { id: row._id } });
  assert.deepEqual(routes, [`/pages/square-detail/index?id=${row._id}`]);
  page.onHide(); page.onShow();
  assert.equal(calls.length, 1);
  assert.equal(page.data.posts[0].images, row.images);
  const next = page.loadMoreFeed();
  assert.equal(calls.at(-1).offset, 10);
  assert.equal(calls.at(-1).anchor, 123);
  resolvePage(cache = { ...loaded, items: [row, { ...row, _id: 'n_' + 'b'.repeat(40) }], hasMore: false });
  await next;
  assert.equal(page.data.posts.length, 2);
  const late = page.loadFeed(true);
  version++; cache = null;
  resolvePage(loaded); await late;
  assert.equal(page.data.posts.length, 0);
  page.onHide(); resolvePage(loaded);
});
