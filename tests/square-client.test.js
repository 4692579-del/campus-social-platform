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
  const context = { module: { exports: {} }, require: name => name.includes('comment-order') ? require('../miniprogram/utils/comment-order') : name.includes('comment-state') ? require('../miniprogram/utils/comment-state') : users,
    wx: { cloud: { callFunction: async args => { calls.push(args.data); return handler(args.data); } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/services/square.js'), 'utf8'), context);
  return { service: context.module.exports, users, calls, login(value = user) { current = { ...value }; version++; } };
}

const commentRow = (extra = {}) => ({ _id: 'r_' + 'a'.repeat(40), content: '评论', author: post().author, likeCount: 0, liked: false, folded: false, ...extra });
test('正文优化只发送正文并合并重复请求，不污染动态缓存，换账号后的迟到结果被拒绝', async () => {
  let finish;
  const f = client(() => new Promise(resolve => { finish = resolve; }));
  const first = f.service.optimizeContent('待优化正文');
  assert.equal(f.service.optimizeContent('待优化正文'), first);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'optimizeSquareContent');
  assert.equal(f.calls[0].content, '待优化正文'); assert.equal(f.calls[0].post, undefined);
  finish({ result: { success: true, square: { content: '😊'.repeat(180) } } });
  const result = await first;
  assert.equal(Array.from(result).length, 150); assert.equal(f.service.cachedFeed(), null);
  const late = f.service.optimizeContent('下一段正文');
  f.login({ ...user, _id: 'bob' }); finish({ result: { success: true, square: { content: '旧账号内容' } } });
  await assert.rejects(late, error => error.code === 'SESSION_CHANGED');
});
test('评论删除清理分层缓存并调整分页，迟到的列表、点赞和AI不得恢复已删除整组', async () => {
  const root = commentRow({ isOwn: true, replyCount: 1 }), child = commentRow({ _id: 'c_' + 'b'.repeat(40), rootId: root._id });
  let delayed = false, finishList, finishState, finishAI, removed = false;
  const f = client(data => {
    const ok = square => ({ result: { success: true, square } });
    if (data.action === 'listSquareReplies') return delayed && !removed ? new Promise(resolve => { finishList = resolve; }) : ok({ items: removed ? [] : [root], nextOffset: removed ? 0 : 1, hasMore: false });
    if (data.action === 'listSquareReplyChildren') return ok({ items: [child], nextOffset: 1, hasMore: false });
    if (data.action === 'setSquareCommentState') return new Promise(resolve => { finishState = resolve; });
    if (data.action === 'processSquareAIReply') return new Promise(resolve => { finishAI = resolve; });
    if (data.action === 'deleteSquareReply') { removed = true; return ok({ deletedId: root._id, rootId: '', post: post({ replyCount: 0 }) }); }
    return ok({ post: post({ replyCount: 2 }) });
  });
  const id = post()._id;
  await f.service.listReplies(id); await f.service.listChildren(id, root._id);
  const events = []; f.service.subscribeComment(row => events.push(row));
  delayed = true;
  const reading = f.service.listReplies(id, { force: true });
  const reacting = f.service.commentState(id, child._id, 'like', true, child);
  const ai = f.service.processAIReply(id, root._id);
  await f.service.deleteReply(id, root._id);
  finishState({ result: { success: true, square: { reply: { ...child, liked: true, likeCount: 1 } } } });
  finishList({ result: { success: true, square: { items: [root], nextOffset: 1, hasMore: false } } });
  finishAI({ result: { success: true, square: { target: root, root, reply: child, post: post({ replyCount: 2 }) } } });
  await assert.rejects(reacting); await assert.rejects(ai); await reading;
  assert.equal(f.service.cachedReplies(id).items.length, 0); assert.equal(f.service.cachedReplies(id).nextOffset, 0);
  assert.equal(f.service.cachedChildren(id, root._id), null); assert.equal(f.service.cachedComment(child._id), null);
  assert.equal(f.service.cachedPost(id).replyCount, 0);
  assert.equal(events.at(-1).status, 'deleted');
});

test('删除楼中回复同步根计数；删除失败或换账号后的结果不能清理缓存，举报使用独立接口', async () => {
  const root = commentRow({ replyCount: 1 }), child = commentRow({ _id: 'c_' + 'b'.repeat(40), rootId: root._id });
  for (const mode of ['success', 'failure', 'switch']) {
    let finish;
    const f = client(data => {
      const ok = square => ({ result: { success: true, square } });
      if (data.action === 'listSquareReplies') return ok({ items: [root], nextOffset: 1, hasMore: false });
      if (data.action === 'listSquareReplyChildren') return ok({ items: [child], nextOffset: 1, hasMore: false });
      if (data.action === 'deleteSquareReply') return new Promise(resolve => { finish = resolve; });
      return ok({ reportId: 'saved-report' });
    });
    await f.service.listReplies(post()._id); await f.service.listChildren(post()._id, root._id);
    const operation = f.service.deleteReply(post()._id, child._id);
    if (mode === 'switch') f.login({ ...user, _id: 'bob' });
    finish(mode === 'failure' ? { result: { success: false, message: '删除失败' } } : { result: { success: true, square: {
      deletedId: child._id, rootId: root._id, root: { ...root, replyCount: 0 }, post: post({ replyCount: 1 }) } } });
    if (mode !== 'success') await assert.rejects(operation); else await operation;
    if (mode === 'switch') assert.equal(f.service.cachedReplies(post()._id), null);
    else {
      assert.equal(f.service.cachedChildren(post()._id, root._id).items.length, mode === 'success' ? 0 : 1);
      assert.equal(f.service.cachedReplies(post()._id).items[0].replyCount, mode === 'success' ? 0 : 1);
    }
    await f.service.reportReply(post()._id, root._id, 'abuse');
    assert.equal(f.calls.at(-1).action, 'reportSquareReply'); assert.equal(f.calls.at(-1).replyId, root._id);
  }
});
test('AI请求合并、回复同步缓存；切换账号或删除动态后的迟到AI响应不能恢复旧内容', async () => {
  for (const operation of ['finish', 'logout', 'delete']) {
    let finish;
    const root = commentRow({ aiStatus: 'queued', aiCanManage: true, replyCount: 0 });
    const bot = { ...commentRow(), _id: 'c_' + 'b'.repeat(40), rootId: root._id, author: { nickname: '小萃小萃', isAI: true } };
    const f = client(data => data.action === 'processSquareAIReply' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ result: { success: true, square:
      data.action === 'deleteSquarePost' ? { deletedId: post()._id } : { post: post({ replyCount: 1 }), reply: root } } }));
    await f.service.reply(post()._id, '@小萃 怎么看', 'client-ai-comment001', undefined, true);
    assert.equal(f.calls.at(-1).post.askAI, true);
    const events = []; f.service.subscribeAI(result => events.push(result));
    const running = f.service.processAIReply(post()._id, root._id);
    assert.equal(f.service.processAIReply(post()._id, root._id), running);
    if (operation === 'logout') f.users.logout();
    if (operation === 'delete') await f.service.deletePost(post()._id);
    finish({ result: { success: true, square: { status: 'done', created: true, target: { ...root, aiStatus: 'done', replyCount: 1 },
      root: { ...root, aiStatus: 'done', replyCount: 1 }, reply: bot, post: post({ replyCount: 2 }) } } });
    if (operation === 'finish') {
      await running; assert.equal(events.length, 1); assert.equal(f.service.cachedPost(post()._id).replyCount, 2);
      assert.equal(f.service.cachedChildren(post()._id, root._id).items[0].author.isAI, true);
    } else { await assert.rejects(running); assert.equal(events.length, 0); assert.equal(f.service.cachedPost(post()._id), null); }
  }
});
const commentResponse = row => ({ result: { success: true, square: { reply: row } } });
test('评论点赞和取消立即更新缓存，串行合并快速点击，迟到确认不反弹，失败回退已确认状态', async () => {
  const writes = [];
  const f = client(data => new Promise(resolve => writes.push({ data, resolve })));
  const row = commentRow(), notices = [], stop = f.service.subscribeComment(value => notices.push({ ...value }));
  const liking = f.service.commentState(post()._id, row._id, 'like', true, row);
  assert.equal(f.service.cachedComment(row._id).liked, true); assert.equal(f.service.cachedComment(row._id).likeCount, 1);
  const cancelling = f.service.commentState(post()._id, row._id, 'like', false);
  assert.equal(liking, cancelling); assert.equal(writes.length, 1); assert.equal(f.service.cachedComment(row._id).liked, false);
  writes[0].resolve(commentResponse(commentRow({ liked: true, likeCount: 1 })));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(writes.length, 2); assert.equal(writes[1].data.active, false); assert.equal(f.service.cachedComment(row._id).liked, false);
  assert.equal(notices.slice(1).some(value => value.liked), false);
  writes[1].resolve({ result: { success: false, code: 'NETWORK_ERROR', message: '保存失败' } });
  await assert.rejects(liking, /保存失败/);
  assert.equal(f.service.cachedComment(row._id).liked, true); assert.equal(f.service.cachedComment(row._id).likeCount, 1);
  stop();
});

test('心碎后立即点赞恢复显示，两种状态共用队列，确认前的后台读取不能覆盖即时选择', async () => {
  const writes = []; let finishRead;
  const row = commentRow();
  const f = client(data => data.action === 'listSquareReplies' ? new Promise(resolve => { finishRead = resolve; }) : new Promise(resolve => writes.push({ data, resolve })));
  const fold = f.service.commentState(post()._id, row._id, 'fold', true, row);
  assert.equal(f.service.cachedComment(row._id).folded, true);
  const like = f.service.commentState(post()._id, row._id, 'like', true);
  assert.equal(fold, like); assert.equal(f.service.cachedComment(row._id).folded, false); assert.equal(f.service.cachedComment(row._id).liked, true);
  const reading = f.service.listReplies(post()._id);
  finishRead({ result: { success: true, square: { items: [row], nextOffset: 1, hasMore: false } } }); await reading;
  assert.equal(f.service.cachedReplies(post()._id).items[0].liked, true);
  writes[0].resolve(commentResponse(commentRow({ folded: true })));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(writes[1].data.kind, 'like'); assert.equal(writes[1].data.active, true);
  writes[1].resolve(commentResponse(commentRow({ liked: true, likeCount: 1, folded: false }))); await like;
  assert.equal(f.service.cachedComment(row._id).likeCount, 1); assert.equal(f.service.cachedReplies(post()._id).items[0].folded, false);
});

test('评论保存中换账号或删除动态，不让迟到状态恢复旧账号或已删除内容', async () => {
  let finish;
  const f = client(() => new Promise(resolve => { finish = resolve; }));
  const row = commentRow(), pending = f.service.commentState(post()._id, row._id, 'fold', true, row);
  f.login({ ...user, _id: 'bob' }); finish(commentResponse(commentRow({ folded: true })));
  await assert.rejects(pending, error => error.code === 'SESSION_CHANGED'); assert.equal(f.service.cachedComment(row._id), null);
  let complete;
  const removed = client(data => data.action === 'deleteSquarePost' ? { result: { success: true, square: { deletedId: post()._id } } } : new Promise(resolve => { complete = resolve; }));
  const writing = removed.service.commentState(post()._id, row._id, 'like', true, row);
  await removed.service.deletePost(post()._id); complete(commentResponse(commentRow({ liked: true, likeCount: 1 })));
  await assert.rejects(writing, error => error.code === 'POST_NOT_FOUND'); assert.equal(removed.service.cachedComment(row._id), null);
});

test('仅预取前两个未折叠回复组，点击展开复用在途请求与新鲜缓存', async () => {
  const finishes = [];
  const f = client(() => new Promise(resolve => finishes.push(resolve)));
  const rows = [commentRow({ folded: true, replyCount: 5 }), ...[1, 2, 3].map(i => commentRow({ _id: 'root' + i, replyCount: 2 }))];
  f.service.warmReplyChildren(post()._id, rows); assert.equal(f.calls.length, 2);
  const expanding = f.service.listChildren(post()._id, 'root1'); assert.equal(f.calls.length, 2);
  for (const finish of finishes) finish({ result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } });
  await expanding; await f.service.listChildren(post()._id, 'root1'); assert.equal(f.calls.length, 2);
});

test('发布图片后立即同步列表、详情和相册；删除动态移除其所有图片，退出清理相册缓存', async () => {
  const images = ['cloud://test.bucket/square-media/alice/a.jpg', 'cloud://test.bucket/square-media/alice/b.jpg'];
  const f = client(data => ({ result: { success: true, square: data.action === 'publishSquarePost' ? { post: post({ images, isOwn: true }) } :
    data.action === 'deleteSquarePost' ? { deletedId: post()._id } : { items: [], hasMore: false, nextOffset: 0 } } }));
  await f.service.album(); await f.service.publish('图文', 'images-request-00001', ['cloud://test.bucket/square-uploads/alice/a.jpg']);
  assert.equal(f.calls.at(-1).post.images.length, 1);
  assert.equal(f.service.cachedOwnFeed().items[0].images.length, 2);
  assert.equal(f.service.cachedPost(post()._id).images.length, 2);
  assert.equal(f.service.cachedAlbum().items.length, 2); assert.equal(f.service.cachedAlbum().nextOffset, 1);
  await f.service.deletePost(post()._id);
  assert.equal(f.service.cachedAlbum().items.length, 0); assert.equal(f.service.cachedAlbum().nextOffset, 0);
  f.users.logout(); assert.equal(f.service.cachedAlbum(), null);
});

test('迟到相册读取不能覆盖刚发图片，也不能污染切换后的账号', async () => {
  let finish;
  const imagePost = post({ images: ['cloud://test.bucket/square-media/alice/a.jpg'] });
  const f = client(data => data.action === 'listSquareAlbum' ? new Promise(resolve => { finish = resolve; }) : { result: { success: true, square: { post: imagePost } } });
  const pending = f.service.album();
  await f.service.publish('图', 'images-request-00001', ['cloud://test.bucket/square-uploads/alice/a.jpg']);
  finish({ result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } });
  await pending; assert.equal(f.service.cachedAlbum().items.length, 1);
  const late = f.service.album({ force: true }); f.login({ ...user, _id: 'bob' });
  finish({ result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } });
  await assert.rejects(late, error => error.code === 'SESSION_CHANGED'); assert.equal(f.service.cachedAlbum(), null);
});

test('客户端拒绝转发操作，不发送云请求或伪造操作成功', async () => {
  const f = client(() => { throw new Error('不得调用云端'); });
  await assert.rejects(f.service.react(post()._id, 'repost', true), error => error.code === 'INVALID_POST');
  assert.equal(f.calls.length, 0);
});

const likeResponse = (liked, extra = {}) => ({ result: { success: true, square: { post: post({ liked, likeCount: liked ? 1 : 0, ...extra }) } } });
const settleLikes = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('点赞立即同步两个列表，快速取消即时复原并串行保存最后选择，旧响应不反弹', async () => {
  const writes = [];
  const f = client(data => data.action === 'setSquareReaction' ? new Promise(resolve => writes.push({ data, resolve })) :
    { result: { success: true, square: { mine: true, items: [post()], hasMore: false, nextOffset: 1 } } });
  await f.service.list(); await f.service.list({ mine: true });
  const notifications = [], stop = f.service.subscribePost(row => notifications.push([row.liked, row.likeCount]));
  const liking = f.service.react(post()._id, 'like', true);
  assert.equal(f.service.cachedFeed().items[0].liked, true);
  assert.equal(f.service.cachedOwnFeed().items[0].likeCount, 1);
  const cancelling = f.service.react(post()._id, 'like', false);
  assert.equal(liking, cancelling); assert.equal(writes.length, 1);
  assert.equal(f.service.cachedFeed().items[0].liked, false);
  assert.equal(f.service.cachedFeed().items[0].likeCount, 0);
  writes[0].resolve(likeResponse(true)); await settleLikes();
  assert.equal(writes.length, 2); assert.equal(writes[1].data.active, false);
  assert.equal(f.service.cachedPost(post()._id).liked, false);
  writes[1].resolve(likeResponse(false)); await cancelling;
  assert.equal(f.service.cachedOwnFeed().items[0].liked, false);
  assert.equal(f.service.cachedPost(post()._id).likeCount, 0);
  stop(); assert.ok(notifications.length >= 3);
});

test('多次切换合并为最新目标；保存失败恢复已确认状态，并允许再次操作', async () => {
  const writes = [];
  const f = client(data => data.action === 'setSquareReaction' ? new Promise((resolve, reject) => writes.push({ data, resolve, reject })) :
    { result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } });
  await f.service.list();
  const pending = f.service.react(post()._id, 'like', true);
  f.service.react(post()._id, 'like', false); f.service.react(post()._id, 'like', true);
  assert.equal(writes.length, 1); assert.equal(f.service.cachedPost(post()._id).likeCount, 1);
  writes[0].resolve(likeResponse(true)); await pending;
  assert.equal(writes.length, 1);
  const cancelling = f.service.react(post()._id, 'like', false);
  assert.equal(f.service.cachedPost(post()._id).likeCount, 0);
  const rejection = assert.rejects(cancelling, /连接/);
  writes[1].reject(new Error('offline')); await rejection;
  assert.equal(f.service.cachedPost(post()._id).liked, true);
  assert.equal(f.service.cachedFeed().items[0].likeCount, 1);
  const retry = f.service.react(post()._id, 'like', false);
  writes[2].resolve(likeResponse(false)); await retry;
  assert.equal(f.service.cachedFeed().items[0].likeCount, 0);
});

test('后台刷新不覆盖等待保存的爱心，点赞响应不覆盖同时增加的评论数量', async () => {
  let finishLike;
  const f = client(data => data.action === 'setSquareReaction' ? new Promise(resolve => { finishLike = resolve; }) :
    { result: { success: true, square: data.action === 'publishSquareReply'
      ? { post: post({ replyCount: 1 }), reply: { _id: 'reply', content: '并行评论' } }
      : { items: [post()], hasMore: false, nextOffset: 1 } } });
  await f.service.list(); const pending = f.service.react(post()._id, 'like', true);
  await f.service.list({ force: true });
  assert.equal(f.service.cachedFeed().items[0].liked, true);
  assert.equal(f.service.cachedFeed().items[0].likeCount, 1);
  await f.service.reply(post()._id, '并行评论', 'parallel-reply-000001');
  finishLike(likeResponse(true)); await pending;
  assert.equal(f.service.cachedPost(post()._id).replyCount, 1);
  assert.equal(f.service.cachedPost(post()._id).likeCount, 1);
});

test('服务返回未确认的目标状态时停止保存并回退，不无限重试', async () => {
  const f = client(data => data.action === 'setSquareReaction' ? likeResponse(false) :
    { result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } });
  await f.service.list();
  await assert.rejects(f.service.react(post()._id, 'like', true), /状态未确认/);
  assert.equal(f.calls.filter(call => call.action === 'setSquareReaction').length, 1);
  assert.equal(f.service.cachedPost(post()._id).liked, false);
  assert.equal(f.service.cachedFeed().items[0].likeCount, 0);
});

test('点赞响应在切换账号或删除动态后到达，不能恢复旧状态或被删除的卡片', async () => {
  let finish;
  const f = client(data => data.action === 'setSquareReaction' ? new Promise(resolve => { finish = resolve; }) :
    { result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } });
  await f.service.list(); const pending = f.service.react(post()._id, 'like', true);
  f.users.logout(); f.login({ ...user, _id: 'bob' });
  const rejection = assert.rejects(pending, error => error.code === 'SESSION_CHANGED');
  finish(likeResponse(true)); await rejection;
  assert.equal(f.service.cachedPost(post()._id), null);
  let finishDeleted;
  const g = client(data => data.action === 'setSquareReaction' ? new Promise(resolve => { finishDeleted = resolve; }) :
    { result: { success: true, square: data.action === 'deleteSquarePost' ? { deletedId: post()._id } : { items: [post()], hasMore: false, nextOffset: 1 } } });
  await g.service.list(); const writing = g.service.react(post()._id, 'like', true);
  await g.service.deletePost(post()._id);
  const deleted = assert.rejects(writing, error => error.code === 'POST_NOT_FOUND');
  finishDeleted(likeResponse(true)); await deleted;
  assert.equal(g.service.cachedPost(post()._id), null); assert.equal(g.service.cachedFeed().items.length, 0);
});

test('个人动态真实总数跨分页保留，发布与删除同步更新总数，重复删除不再扣减', async () => {
  const addedId = 'p_' + 'c'.repeat(40);
  const f = client(data => ({ result: { success: true, square:
    data.action === 'publishSquarePost' ? { post: post({ _id: addedId, isOwn: true }) } :
    data.action === 'deleteSquarePost' ? { deletedId: addedId } :
    { mine: true, items: [post()], hasMore: true, nextOffset: data.offset ? 40 : 20, ...(data.offset ? {} : { total: 45 }) } } }));
  await f.service.list({ mine: true }); await f.service.list({ mine: true, offset: 20 });
  assert.equal(f.service.cachedOwnFeed().total, 45);
  await f.service.publish('新增动态', 'total-post-request-001'); assert.equal(f.service.cachedOwnFeed().total, 46);
  await f.service.deletePost(addedId); assert.equal(f.service.cachedOwnFeed().total, 45);
  await f.service.deletePost(addedId); assert.equal(f.service.cachedOwnFeed().total, 45);
});

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

test('内容声明跟随真实发布响应同步广场、个人和详情缓存，显示文案不混入正文且旧动态不显示声明', async () => {
  const f = client(async data => ({ result: { success: true, square: { post: post({
    content: data.post.content, declaration: data.post.declaration || 'none', images: ['cloud://test.bucket/square-media/alice/a.jpg'],
  }) } } }));
  const row = await f.service.publish('真实图文', 'declaration-client001', ['cloud://test.bucket/square-uploads/alice/a.jpg'], 'ai');
  assert.equal(f.calls[0].post.declaration, 'ai');
  for (const value of [row, f.service.cachedFeed().items[0], f.service.cachedOwnFeed().items[0], f.service.cachedPost(row._id)]) {
    assert.equal(value.declaration, 'ai'); assert.equal(value.content, '真实图文');
    assert.equal(postView(value).declarationText, '内容由AI生成'); assert.equal(value.images.length, 1);
  }
  await f.service.publish('无需声明', 'declaration-none0001'); assert.equal(f.calls.at(-1).post.declaration, undefined);
  const { declarations } = require('../miniprogram/utils/content-declaration');
  for (const item of declarations) assert.equal(postView(post({ declaration: item.key })).declarationText, item.key === 'none' ? '' : item.label);
  assert.equal(postView(post()).declarationText, '');
  assert.equal(postView(post({ declaration: 'arbitrary', declarationText: '不能伪造展示' })).declarationText, '');
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

test('失败删除保留动态，账号切换后旧删除结果不能清理新账号缓存', async () => {
  let failed = true, finish;
  const f = client(data => {
    if (data.action === 'deleteSquarePost') return failed ? Promise.resolve({ result: { success: false, code: 'FORBIDDEN', message: '只能删除自己的动态' } }) : new Promise(resolve => { finish = resolve; });
    return Promise.resolve({ result: { success: true, square: { ...(data.mine ? { mine: true } : {}), items: [post()], hasMore: false, nextOffset: 1 } } });
  });
  await f.service.list(); await f.service.list({ mine: true });
  await assert.rejects(f.service.deletePost(post()._id), error => error.code === 'FORBIDDEN');
  assert.equal(f.service.cachedPost(post()._id)._id, post()._id);
  failed = false;
  const deleting = f.service.deletePost(post()._id);
  f.users.logout(); f.login({ ...user, _id: 'bob' }); await f.service.list();
  finish({ result: { success: true, square: { deletedId: post()._id } } });
  await assert.rejects(deleting, error => error.code === 'SESSION_CHANGED');
  assert.equal(f.service.cachedFeed().items.length, 1);
});

const { composerFixture: pageFixture } = require('./helpers/square-composer-fixture');

test('发布页普通用户直接输入，仅明确保存后恢复草稿，并限制150字', async () => {
  const f = pageFixture(); await f.attach();
  f.page.onInput({ detail: { value: '未认证同学的想法' } });
  assert.equal(f.page.data.canPublish, true);
  assert.equal(f.storage.size, 0); f.page.saveAndClose();
  assert.equal(f.storage.get('square.draft.alice').content, '未认证同学的想法');
  const reopened = pageFixture({ storage: f.storage }); await reopened.attach();
  assert.equal(reopened.page.data.content, '未认证同学的想法');
  reopened.page.onInput({ detail: { value: '😊'.repeat(151) } });
  assert.equal(reopened.page.data.count, 150);
  assert.equal(reopened.page.data.canPublish, true);
  assert.equal(reopened.page.data.limitHintVisible, true);
  await reopened.page.publish(); assert.equal(reopened.calls.length, 1);
  assert.equal(Array.from(reopened.calls[0].content).length, 150);
});

test('发布请求失败保留编辑内容和幂等标识，不自动保存草稿，成功才收起面板', async () => {
  let failed = true;
  const f = pageFixture({ publish: async () => { if (failed) throw new Error('暂时无法连接'); return post(); } });
  await f.attach(); f.page.onInput({ detail: { value: '失败后可以重试' } });
  await f.page.publish();
  assert.equal(f.page.data.error, '暂时无法连接'); assert.equal(f.events.length, 0);
  assert.equal(f.page.data.content, '失败后可以重试'); assert.equal(f.storage.size, 0);
  failed = false; await f.page.publish();
  assert.equal(f.calls[0].id, f.calls[1].id);
  f.flushClose(); assert.equal(f.events.at(-1).detail.published, true); assert.equal(f.storage.size, 0);
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
