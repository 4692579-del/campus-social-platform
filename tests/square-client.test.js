const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { postView } = require('../miniprogram/utils/post-view');

const user = { _id: 'alice', nickname: '普通同学', role: 'user', certificationStatus: 'unverified', avatarFileID: '' };
const post = (extra = {}) => ({ _id: 'p_' + 'a'.repeat(40), content: '来自广场的一条文字动态',
  author: { nickname: '普通同学', avatarFileID: '', accountId: '12345678', verified: false },
  createdAt: '2026-11-17T06:00:00Z', likeCount: 0, replyCount: 0, repostCount: 0, liked: false, reposted: false, ...extra });

test('分层回复缓存不混入一级列表，迟到读取不会覆盖刚发出的回复和个人折叠状态', async () => {
  const root = { _id: 'r_' + 'a'.repeat(40), content: '一级评论', author: post().author, replyCount: 0 };
  const child = { _id: 'c_' + 'b'.repeat(40), rootId: root._id, content: '新回复', author: post().author, folded: false };
  let delay = false, finishRoots, finishChildren;
  const f = client(data => {
    if (data.action === 'listSquareReplies') return delay ? new Promise(resolve => { finishRoots = resolve; }) : { result: { success: true, square: { items: [root], hasMore: false, nextOffset: 1 } } };
    if (data.action === 'listSquareReplyChildren') return delay ? new Promise(resolve => { finishChildren = resolve; }) : { result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } };
    if (data.action === 'publishSquareReply') return { result: { success: true, square: { post: post(), reply: child, root: { ...root, replyCount: 1 } } } };
    return { result: { success: true, square: { reply: { ...child, folded: true } } } };
  });
  const id = post()._id;
  await f.service.listReplies(id); await f.service.listChildren(id, root._id);
  delay = true;
  const rootsRead = f.service.listReplies(id, { force: true }), childrenRead = f.service.listChildren(id, root._id, { force: true });
  await f.service.reply(id, '新回复', 'child-request-00001', root._id);
  assert.equal(f.calls.at(-1).post.replyToId, root._id);
  await f.service.commentState(id, child._id, 'fold', true);
  finishRoots({ result: { success: true, square: { items: [root], hasMore: false, nextOffset: 1 } } });
  finishChildren({ result: { success: true, square: { items: [child], hasMore: false, nextOffset: 1 } } });
  await rootsRead; await childrenRead;
  assert.equal(f.service.cachedReplies(id).items.length, 1); assert.equal(f.service.cachedReplies(id).items[0].replyCount, 1);
  assert.equal(f.service.cachedChildren(id, root._id).items[0].folded, true);
  f.users.logout(); assert.equal(f.service.cachedChildren(id, root._id), null); assert.equal(f.service.cachedReplies(id), null);
});
function client(handler) {
  let current = { ...user }, version = 0;
  const calls = [];
  const users = { getCachedUser: () => current, getSessionVersion: () => version, logout: () => { current = null; version++; } };
  const context = { module: { exports: {} }, require: () => users,
    wx: { cloud: { callFunction: async args => { calls.push(args.data); return handler(args.data); } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/services/square.js'), 'utf8'), context);
  return { service: context.module.exports, users, calls, login(value = user) { current = { ...value }; version++; } };
}

test('信息流、完整动态和回复在一分钟内复用；普通用户发布后立即更新预览并返回广场', async () => {
  const f = client(async data => ({ result: { success: true, square:
    data.action === 'listSquarePosts' ? { items: [post()], hasMore: false, nextOffset: 1 } :
      data.action === 'listSquareReplies' ? { items: [], hasMore: false, nextOffset: 0 } : { post: post({ _id: 'p_' + 'b'.repeat(40), content: data.post && data.post.content || '详情' }) } } }));
  await f.service.list(); await f.service.list();
  assert.equal(f.calls.length, 1);
  await f.service.detail(post()._id);
  assert.equal(f.calls.length, 1);
  await f.service.listReplies(post()._id); await f.service.listReplies(post()._id);
  assert.equal(f.calls.length, 2);
  await f.service.publish('未认证也能发布', 'post-request-00000001');
  assert.equal(f.calls.at(-1).post.scope, 'square');
  assert.equal(f.calls.at(-1).scope, undefined);
  assert.equal(f.service.cachedFeed().items[0].content, '未认证也能发布');
  assert.equal(f.service.consumePublication(), true);
  assert.equal(f.service.consumePublication(), false);
});

test('详情点赞和回复同步列表；迟到的旧详情不会覆盖刚成功的点赞', async () => {
  let finish;
  const f = client(data => data.action === 'getSquarePost' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ result: { success: true, square:
    data.action === 'listSquarePosts' ? { items: [post()], hasMore: false, nextOffset: 1 } :
      data.action === 'setSquareReaction' ? { post: post({ liked: true, likeCount: 1 }) } :
        { post: post({ liked: true, likeCount: 1, replyCount: 1 }), reply: { _id: 'reply', content: '你好' } } } }));
  await f.service.list();
  const pending = f.service.detail(post()._id, true);
  await f.service.react(post()._id, 'like', true);
  finish({ result: { success: true, square: { post: post() } } });
  assert.equal((await pending).likeCount, 1);
  assert.equal(f.service.cachedFeed().items[0].likeCount, 1);
  await f.service.reply(post()._id, '你好', 'reply-request-000001');
  assert.equal(f.service.cachedFeed().items[0].replyCount, 1);
});

test('长文预览已同步缓存全文，点击进入详情不再等待额外请求，点赞后预览仍保持截断', async () => {
  const content = '长'.repeat(700);
  const f = client(async data => ({ result: { success: true, square: data.action === 'listSquarePosts'
    ? { items: [post({ content: content.slice(0, 280), fullContent: content, truncated: true })], hasMore: false, nextOffset: 1 }
    : { post: post({ content, liked: true, likeCount: 1 }) } } }));
  await f.service.list();
  assert.equal(f.service.cachedPost(post()._id).content.length, 700);
  assert.equal((await f.service.detail(post()._id)).truncated, false);
  assert.equal(f.calls.length, 1);
  await f.service.react(post()._id, 'like', true);
  assert.equal(f.service.cachedFeed().items[0].content.length, 280);
  assert.equal(f.service.cachedFeed().items[0].truncated, true);
});

test('强制刷新可读取他人新点赞；会话退出清理互动状态，旧响应不能进入新账号缓存', async () => {
  let finish, latest = 0;
  const f = client(data => data.action === 'getSquarePost' ? new Promise(resolve => { finish = resolve; }) :
    Promise.resolve({ result: { success: true, square: data.action === 'setSquareReaction' ? { post: post({ liked: true, likeCount: 1 }) } :
      { items: [post({ likeCount: latest })], hasMore: false, nextOffset: 1 } } }));
  await f.service.list(); await f.service.react(post()._id, 'like', true);
  latest = 7;
  await f.service.list({ force: true });
  assert.equal(f.service.cachedFeed().items[0].likeCount, 7);
  const pending = f.service.detail(post()._id, true);
  f.users.logout(); f.login({ ...user, _id: 'bob' });
  finish({ result: { success: true, square: { post: post({ liked: true }) } } });
  await assert.rejects(pending, error => error.code === 'SESSION_CHANGED');
  assert.equal(f.service.cachedPost(post()._id), null);
  f.users.logout();
  await assert.rejects(f.service.publish('不能匿名发布', 'post-request-00000001'), error => error.code === 'UNAUTHENTICATED');
});

test('个人动态独立缓存和分页，发布、详情互动同步到个人动态；广场不会被本人列表替换', async () => {
  const own = post({ _id: 'p_' + 'b'.repeat(40) });
  const f = client(async data => ({ result: { success: true, square: data.action === 'listSquarePosts'
    ? { ...(data.mine ? { mine: true } : {}), items: data.mine ? [own] : [post(), own], hasMore: false, nextOffset: data.mine ? 1 : 2 }
    : { post: data.action === 'publishSquarePost' ? post({ _id: 'p_' + 'c'.repeat(40), content: data.post.content }) : { ...own, liked: true, likeCount: 1 } } } }));
  await f.service.list(); await f.service.list({ mine: true }); await f.service.list({ mine: true });
  assert.equal(f.calls.length, 2);
  assert.equal(f.service.cachedFeed().items.length, 2);
  assert.equal(f.service.cachedOwnFeed().items.length, 1);
  await f.service.react(own._id, 'like', true);
  assert.equal(f.service.cachedOwnFeed().items[0].likeCount, 1);
  await f.service.publish('新发布立即出现在个人主页', 'profile-client-00001');
  assert.equal(f.service.cachedOwnFeed().items[0].content, '新发布立即出现在个人主页');
  assert.equal(f.service.cachedOwnFeed().nextOffset, 2);
  f.users.logout(); assert.equal(f.service.cachedOwnFeed(), null);
});

test('旧版云函数未支持本人筛选时不把全部广场内容显示到个人主页', async () => {
  const f = client(async () => ({ result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } }));
  await assert.rejects(f.service.list({ mine: true }), /重新部署 userService/);
  assert.equal(f.service.cachedOwnFeed(), null);
});

test('本人列表的迟到响应不会覆盖刚发布的新动态，也不会进入另一账号缓存', async () => {
  let finish;
  const f = client(data => data.action === 'listSquarePosts' ? new Promise(resolve => { finish = resolve; }) :
    Promise.resolve({ result: { success: true, square: { post: post({ content: data.post.content }) } } }));
  const listing = f.service.list({ mine: true });
  await f.service.publish('先于列表返回发布成功', 'profile-race-00000001');
  finish({ result: { success: true, square: { mine: true, items: [], hasMore: false, nextOffset: 0 } } });
  assert.equal((await listing).items[0].content, '先于列表返回发布成功');
  const stale = f.service.list({ mine: true, force: true });
  f.users.logout(); f.login({ ...user, _id: 'bob' });
  finish({ result: { success: true, square: { mine: true, items: [post()], hasMore: false, nextOffset: 1 } } });
  await assert.rejects(stale, error => error.code === 'SESSION_CHANGED');
  assert.equal(f.service.cachedOwnFeed(), null);
});

test('删除同步清理广场、个人、详情与回复缓存，迟到响应不能让动态复活', async () => {
  let finishList, finishDetail, finishReplies, delayed = false, listCalls = 0;
  const f = client(data => {
    if (data.action === 'deleteSquarePost') return Promise.resolve({ result: { success: true, square: { deletedId: data.postId } } });
    if (delayed && data.action === 'listSquarePosts' && ++listCalls > 1) return Promise.resolve({ result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } });
    if (delayed) return new Promise(resolve => {
      if (data.action === 'listSquarePosts') finishList = resolve;
      if (data.action === 'getSquarePost') finishDetail = resolve;
      if (data.action === 'listSquareReplies') finishReplies = resolve;
    });
    return Promise.resolve({ result: { success: true, square: { ...(data.mine ? { mine: true } : {}), items: [post()], hasMore: false, nextOffset: 1 } } });
  });
  await f.service.list(); await f.service.list({ mine: true });
  delayed = true;
  const listing = f.service.list({ force: true }), detail = f.service.detail(post()._id, true), replies = f.service.listReplies(post()._id);
  await f.service.deletePost(post()._id);
  assert.equal(f.service.cachedFeed().items.length, 0); assert.equal(f.service.cachedOwnFeed().items.length, 0);
  assert.equal(f.service.cachedPost(post()._id), null); assert.equal(f.service.cachedReplies(post()._id), null);
  const detailRejected = assert.rejects(detail, error => error.code === 'POST_NOT_FOUND');
  const repliesRejected = assert.rejects(replies, error => error.code === 'POST_NOT_FOUND');
  finishList({ result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } });
  finishDetail({ result: { success: true, square: { post: post() } } });
  finishReplies({ result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } });
  const afterDelete = await listing;
  assert.equal(afterDelete.items.length, 0); assert.equal(afterDelete.nextOffset, 0);
  await detailRejected; await repliesRejected;
  assert.equal(f.service.cachedPost(post()._id), null);
});

test('分享计数同步两个列表；失败删除保留动态，账号切换后旧删除结果不能清理新账号缓存', async () => {
  let failed = true, finish;
  const f = client(data => {
    if (data.action === 'deleteSquarePost') return failed ? Promise.resolve({ result: { success: false, code: 'FORBIDDEN', message: '只能删除自己的动态' } }) : new Promise(resolve => { finish = resolve; });
    return Promise.resolve({ result: { success: true, square: data.action === 'recordSquareShare' ? { post: post({ shareCount: 1 }) } :
      { ...(data.mine ? { mine: true } : {}), items: [post()], hasMore: false, nextOffset: 1 } } });
  });
  await f.service.list(); await f.service.list({ mine: true }); await f.service.recordShare(post()._id, 'share-client-00000001');
  assert.equal(f.service.cachedFeed().items[0].shareCount, 1); assert.equal(f.service.cachedOwnFeed().items[0].shareCount, 1);
  await assert.rejects(f.service.deletePost(post()._id), error => error.code === 'FORBIDDEN');
  assert.equal(f.service.cachedPost(post()._id).shareCount, 1);
  failed = false;
  const deleting = f.service.deletePost(post()._id);
  f.users.logout(); f.login({ ...user, _id: 'bob' }); await f.service.list();
  finish({ result: { success: true, square: { deletedId: post()._id } } });
  await assert.rejects(deleting, error => error.code === 'SESSION_CHANGED');
  assert.equal(f.service.cachedFeed().items.length, 1);
});

function pageFixture(name, options = {}) {
  let definition, current = options.guest ? null : { ...user };
  const storage = options.storage || new Map(), routes = [], calls = [];
  const users = { getCachedUser: () => current, restore: async () => current,
    login: async () => { current = { ...user }; return current; }, logout: () => { current = null; } };
  const square = { publish: async (content, id) => { calls.push({ content, id }); return options.publish ? options.publish(content, id) : post({ content }); },
    cachedPost: () => options.post || null, cachedReplies: () => options.replies || null,
    detail: async () => options.detail ? options.detail() : options.post || post(),
    listReplies: async () => options.replies || { items: [], hasMore: false, nextOffset: 0 },
    react: async (id, kind, active) => { calls.push({ id, kind, active }); return post({ liked: active, likeCount: active ? 1 : 0 }); },
    reply: async (id, content) => ({ post: post({ replyCount: 1 }), reply: post({ _id: 'reply', content }) }) };
  const wx = { getWindowInfo: () => ({ statusBarHeight: 44 }), getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32 }),
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    showToast() {}, navigateBack: () => routes.push('back'), switchTab: value => routes.push(value.url) };
  const gateContext = { module: { exports: {} }, require: () => users, wx };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/login-gate.js'), 'utf8'), gateContext);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../miniprogram/pages/${name}/index.js`), 'utf8'), {
    Page: value => { definition = value; }, wx,
    require: key => key.includes('post-actions') ? require('../miniprogram/utils/post-actions') : key.includes('login-gate') ? gateContext.module.exports : key.includes('post-view') ? require('../miniprogram/utils/post-view') : key.includes('services/square') ? square : users,
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  return { page, storage, routes, calls };
}

test('发布页普通用户直接输入，仅发布广场；自动保留本账号草稿并限制1000字', async () => {
  const f = pageFixture('square-compose'); await f.page.onLoad();
  f.page.onInput({ detail: { value: '未认证同学的想法' } });
  assert.equal(f.page.data.canPublish, true);
  f.page.cancel();
  assert.equal(f.storage.get('square.draft.alice').content, '未认证同学的想法');
  const reopened = pageFixture('square-compose', { storage: f.storage }); await reopened.page.onLoad();
  assert.equal(reopened.page.data.content, '未认证同学的想法');
  reopened.page.onInput({ detail: { value: '😊'.repeat(1001) } });
  assert.equal(reopened.page.data.count, 1001);
  assert.equal(reopened.page.data.canPublish, false);
  await reopened.page.publish(); assert.equal(reopened.calls.length, 0);
});

test('发布请求失败保留草稿和幂等标识，成功才清理草稿并回到首页', async () => {
  let failed = true;
  const f = pageFixture('square-compose', { publish: async () => { if (failed) throw new Error('暂时无法连接'); return post(); } });
  await f.page.onLoad(); f.page.onInput({ detail: { value: '失败后可以重试' } });
  await f.page.publish();
  assert.equal(f.page.data.error, '暂时无法连接'); assert.equal(f.routes.length, 0);
  assert.equal(f.storage.size, 1);
  failed = false; await f.page.publish();
  assert.equal(f.calls[0].id, f.calls[1].id);
  assert.deepEqual(f.routes, ['/pages/home/index']); assert.equal(f.storage.size, 0);
});

test('首次评论读取迟于发送返回时保留刚发布的评论', async () => {
  let finish;
  const f = client(data => data.action === 'listSquareReplies' ? new Promise(resolve => { finish = resolve; }) :
    Promise.resolve({ result: { success: true, square: { post: post({ replyCount: 1 }), reply: { _id: 'reply', content: '新评论' } } } }));
  const reading = f.service.listReplies(post()._id);
  await f.service.reply(post()._id, '新评论', 'reply-race-00000001');
  finish({ result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } });
  assert.equal((await reading).items[0].content, '新评论');
  assert.match(postView(post()).exactTime, /2026年11月17日 14:00/);
});
