const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { fixture } = require('./helpers/certification-fixture');
const { loadPostActions, applyPageData } = require('./helpers/post-actions-fixture');
const { createNewsService, TTL } = require('../cloudfunctions/userService/news-service');
const { createWorldNewsClient, newsError } = require('../cloudfunctions/userService/world-news');

const tables = ['news_articles', 'news_cache', 'news_interactions', 'news_replies', 'news_reply_children', 'news_comment_states', 'news_reports'];
function upstreamArticle(id, fields = {}) {
  return { id, title: `Synthetic test article ${id}`, url: `https://publisher.example.com/articles/${id}`,
    publish_date: '2026-11-23 01:00:00', text: 'First paragraph.\n\n' + 'Second paragraph. '.repeat(100).trimEnd(),
    summary: 'Short summary.', image: 'https://images.example.com/cover.jpg', authors: ['Test author'],
    category: 'science', language: 'en', source_country: 'au', ...fields };
}

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
  assert.equal(initial.items[0].content, 'Short summary.');
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

test('新闻详情按需取多图并保留完整正文；点赞、收藏和分层评论走独立集合', async () => {
  let now = Date.parse('2026-11-23T02:00:00Z');
  const raw = upstreamArticle(1);
  const paths = [];
  const f = fixture({ tables, news: db => createNewsService(db, { now: () => now, async request(path, params) {
    paths.push(path);
    if (path === 'search-news') return { news: [raw], available: 1 };
    assert.equal(path, 'extract-news');
    assert.equal(params.url, raw.url);
    return { text: 'Alternative article text.', images: [{ url: raw.image }, { url: 'https://images.example.com/more.jpg' },
      { url: 'https://images.example.com/pixel.png', width: 1, height: 1 }, { url: 'http://127.0.0.1/a.png' }] };
  } }) });
  await f.login(); await f.login(f.bob);
  const call = (action, fields = {}, who = f.alice) => f.handle({ action, personalize: true, ...fields }, who);
  const { _id: id } = (await call('listNewsPosts')).square.items[0];
  now += 1000;
  const detail = (await call('getSquarePost', { postId: id, url: 'https://wrong.example.com' })).square.post;
  assert.equal(detail.content, raw.text);
  assert.equal(detail.sourceUrl, raw.url);
  assert.equal(detail.images.length, 2);
  assert.equal((await call('getSquarePost', { postId: id })).square.post.images.length, 2);
  assert.deepEqual(paths, ['search-news', 'extract-news']);
  const reaction = (kind, active, who) => call('setSquareReaction', { postId: id, kind, active }, who);
  assert.equal((await reaction('like', true)).square.post.likeCount, 1);
  assert.equal((await reaction('like', true)).square.post.likeCount, 1);
  assert.equal((await reaction('bookmark', true)).square.post.bookmarked, true);
  assert.equal((await call('getSquarePost', { postId: id }, f.bob)).square.post.bookmarked, false);
  assert.equal((await reaction('bookmark', false)).square.post.bookmarked, false);
  const reply = (text, requestId, replyToId, who, askAI) => call('publishSquareReply', { post: { postId: id, scope: 'square',
    content: text, requestId, ...(replyToId ? { replyToId } : {}), ...(askAI ? { askAI } : {}) } }, who);
  const root = (await reply('新闻评论', 'news-root-test-0001')).square.reply;
  const nested = (await reply('新闻楼中楼', 'news-child-test-001', root._id, f.bob)).square.reply;
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
