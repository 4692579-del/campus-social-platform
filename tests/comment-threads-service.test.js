const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/certification-fixture');
let sequence = 0;
const publish = (f, content = '动态') => f.handle({ action: 'publishSquarePost', post: { scope: 'square', content, requestId: `thread-post-${String(++sequence).padStart(8, '0')}` } }, f.alice);
const reply = (f, postId, replyToId, identity = f.alice, token) => f.handle({ action: 'publishSquareReply', post: {
  scope: 'square', postId, content: '真实回复', requestId: token || `thread-reply-${String(++sequence).padStart(8, '0')}`, ...(replyToId ? { replyToId } : {}) } }, identity);
const list = (f, postId, identity = f.alice, rootId) => f.handle({ action: rootId ? 'listSquareReplyChildren' : 'listSquareReplies',
  postId, personalize: true, ...(rootId ? { rootId } : {}) }, identity);
const state = (f, postId, replyId, kind, active, identity = f.alice) => f.handle({ action: 'setSquareCommentState', postId, replyId, kind, active,
  userId: 'forged-other-user' }, identity);
async function setup(options) {
  const f = fixture(options); const alice = await f.login(), bob = await f.login(f.bob);
  f.users.get(alice._id).nickname = '甲'; f.users.get(bob._id).nickname = '乙';
  const postId = (await publish(f)).square.post._id;
  const rootId = (await reply(f, postId)).square.reply._id;
  return { f, postId, rootId, alice, bob };
}

test('SDK直接返回事务回调值时，评论点赞和心碎仍正确返回已保存状态', async () => {
  const { f, postId, rootId } = await setup(); f.hooks.transactionResult = 'direct';
  const liked = await state(f, postId, rootId, 'like', true);
  assert.equal(liked.success, true, liked.message); assert.equal(liked.square.reply.liked, true); assert.equal(liked.square.reply.likeCount, 1);
  const folded = await state(f, postId, rootId, 'fold', true);
  assert.equal(folded.success, true, folded.message); assert.equal(folded.square.reply.folded, true);
});

test('事务内逐条读取兼容旧SDK，点赞与一级及楼中回复均能完成，回滚仍原子', async () => {
  const { f, postId, rootId } = await setup(); f.hooks.serialTransactionReads = true;
  const liked = await state(f, postId, rootId, 'like', true);
  assert.equal(liked.success, true, liked.message);
  const first = await reply(f, postId); assert.equal(first.success, true, first.message);
  const child = await reply(f, postId, rootId); assert.equal(child.success, true, child.message);
  assert.equal(f.squareReplies.get(rootId).replyCount, 1);
  assert.equal(f.squarePosts.get(postId).replyCount, 3);
});

test('二十条不同作者的评论批量读取资料，权限和认证仍使用当前请求的真实账号', async () => {
  const { f, postId } = await setup(); f.squareReplies.clear();
  const authors = [];
  for (let i = 0; i < 20; i++) {
    const user = await f.login({ openid: `comment-author-${i}`, env: 'test' }); authors.push(user._id);
    f.users.get(user._id).nickname = `同学${i}`;
    f.squareReplies.set(`r_${String(i).padStart(40, '0')}`, { _id: `r_${String(i).padStart(40, '0')}`, postId,
      content: `内容${i}`, status: 'published', authorId: user._id, sortKey: String(i).padStart(3, '0'), likeCount: i });
  }
  f.queries.length = 0; f.docReads.length = 0;
  const result = await list(f, postId);
  assert.equal(result.success, true); assert.equal(result.square.items.length, 20);
  assert.equal(result.square.items[19].author.nickname, '同学19');
  assert.equal(f.queries.filter(query => query.name === 'users' && query.condition._id.operation === 'in').length, 1);
  assert.equal(f.queries.filter(query => query.name === 'users').length, 2); // 一次可信身份查询、一次作者批量查询。
  assert.equal(f.docReads.filter(read => read.name === 'users').length, 0);
  f.users.get(authors[0]).status = 'banned';
  assert.equal((await list(f, postId)).square.items[0].author.nickname, '账号暂不可用');
});

test('评论反应直接返回已提交事务的真实状态，不再串行重读评论和个人状态', async () => {
  const { f, postId, rootId } = await setup();
  f.queries.length = 0; f.docReads.length = 0;
  const response = await state(f, postId, rootId, 'like', true);
  assert.equal(response.square.reply.liked, true); assert.equal(response.square.reply.likeCount, 1);
  assert.equal(f.squareReplies.get(rootId).likeCount, 1);
  assert.equal(f.queries.filter(query => query.name === 'square_comment_states').length, 0);
  assert.equal(f.docReads.filter(read => !read.inTransaction && ['square_replies', 'square_comment_states'].includes(read.name)).length, 0);
});

test('回复发送仍等待文字校验和事务确认，校验拒绝不写评论或增加计数', async () => {
  let permitted = true;
  const { f, postId, rootId } = await setup({ checkText: async () => permitted }); permitted = false;
  const result = await reply(f, postId, rootId);
  assert.equal(result.code, 'CONTENT_REJECTED'); assert.equal(f.squareReplyChildren.size, 0);
  assert.equal(f.squareReplies.get(rootId).replyCount, 0); assert.equal(f.squarePosts.get(postId).replyCount, 1);
});

test('旧评论保留为一级评论；回复关系由云端派生，回复他人及楼中楼均归属真实分组', async () => {
  const { f, postId, rootId } = await setup();
  delete f.squareReplies.get(rootId).likeCount; delete f.squareReplies.get(rootId).replyCount;
  assert.equal((await list(f, postId)).square.items[0].replyCount, 0);
  const first = await reply(f, postId, rootId, f.bob); assert.equal(first.success, true, first.message);
  const child = first.square.reply;
  assert.equal(child.rootId, rootId); assert.equal(child.replyToName, '甲'); assert.equal(first.square.root.replyCount, 1);
  const nested = (await reply(f, postId, child._id)).square.reply;
  assert.equal(nested.rootId, rootId); assert.equal(nested.replyToId, child._id); assert.equal(nested.replyToName, '乙');
  assert.deepEqual(nested.ancestorIds, [rootId, child._id]);
  const roots = (await list(f, postId)).square.items;
  assert.equal(roots.length, 1); assert.equal(roots[0].replyCount, 2);
  assert.equal((await list(f, postId, f.bob, rootId)).square.items.length, 2);
  assert.equal(f.squarePosts.get(postId).replyCount, 3);
  assert.equal(child.authorId, undefined); assert.equal(child.replyToAuthorId, undefined);
});

test('并发重试回复只写入一次，目标不可伪造、不能跨动态回复，失败事务回滚所有计数', async () => {
  const { f, postId, rootId } = await setup();
  const results = await Promise.all(Array.from({ length: 4 }, () => reply(f, postId, rootId, f.bob, 'same-child-request-0001')));
  assert.ok(results.every(result => result.success)); assert.equal(f.squareReplyChildren.size, 1);
  assert.equal(f.squareReplies.get(rootId).replyCount, 1); assert.equal(f.squarePosts.get(postId).replyCount, 2);
  const another = (await reply(f, postId)).square.reply._id;
  assert.equal((await reply(f, postId, another, f.bob, 'same-child-request-0001')).code, 'REQUEST_CONFLICT');
  const otherPost = (await publish(f, '另一条动态')).square.post._id;
  assert.equal((await reply(f, otherPost, rootId)).code, 'POST_NOT_FOUND');
  assert.equal((await f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId, rootId, content: '伪造分组', requestId: 'forged-thread-00001' } }, f.alice)).code, 'INVALID_POST');
  const failed = await setup({ failCollection: 'square_reply_children' });
  assert.equal((await reply(failed.f, failed.postId, failed.rootId)).success, false);
  assert.equal(failed.f.squareReplyChildren.size, 0); assert.equal(failed.f.squareReplies.get(failed.rootId).replyCount, 0);
  assert.equal(failed.f.squarePosts.get(failed.postId).replyCount, 1);
});

test('评论点赞真实计数且可取消；心碎只影响当前账号，并保留该账号的点赞状态', async () => {
  const { f, postId, rootId, alice } = await setup();
  await Promise.all(Array.from({ length: 4 }, () => state(f, postId, rootId, 'like', true)));
  assert.equal(f.squareReplies.get(rootId).likeCount, 1);
  await state(f, postId, rootId, 'like', true, f.bob); assert.equal(f.squareReplies.get(rootId).likeCount, 2);
  const folded = await state(f, postId, rootId, 'fold', true);
  assert.equal(folded.square.reply.folded, true); assert.equal(folded.square.reply.liked, true);
  assert.equal((await list(f, postId)).square.items[0].folded, true);
  assert.equal((await list(f, postId, f.bob)).square.items[0].folded, false);
  const guest = await f.handle({ action: 'listSquareReplies', postId }, { openid: 'guest' });
  assert.equal(guest.square.items[0].folded, false); assert.equal(guest.square.items[0].liked, false);
  assert.equal(f.squareReplies.get(rootId).status, 'published'); assert.equal(f.squarePosts.get(postId).replyCount, 1);
  assert.equal([...f.squareCommentStates.values()].filter(row => row.folded)[0].userId, alice._id);
  assert.equal((await state(f, postId, rootId, 'fold', false)).square.reply.folded, false);
  assert.equal((await state(f, postId, rootId, 'like', false)).square.reply.likeCount, 1);
});

test('子回复同样支持点赞与个人折叠；隐藏根评论、隐藏动态及停用账号不能继续写入', async () => {
  const { f, postId, rootId, alice } = await setup(); const child = (await reply(f, postId, rootId)).square.reply;
  assert.equal((await state(f, postId, child._id, 'like', true)).square.reply.likeCount, 1);
  assert.equal((await state(f, postId, child._id, 'fold', true)).square.reply.folded, true);
  f.squareReplies.get(rootId).status = 'hidden';
  assert.equal((await reply(f, postId, child._id)).code, 'POST_NOT_FOUND');
  assert.equal((await state(f, postId, child._id, 'like', false)).code, 'POST_NOT_FOUND');
  assert.equal((await list(f, postId, f.bob, rootId)).code, 'POST_NOT_FOUND');
  f.squareReplies.get(rootId).status = 'published'; f.squarePosts.get(postId).status = 'deleted';
  assert.equal((await state(f, postId, rootId, 'fold', true)).code, 'POST_NOT_FOUND');
  f.squarePosts.get(postId).status = 'published'; f.users.get(alice._id).status = 'banned';
  assert.equal((await state(f, postId, rootId, 'like', true)).code, 'ACCOUNT_DISABLED');
  assert.equal((await state(f, postId, rootId, 'like', true, { openid: 'guest' })).code, 'NOT_REGISTERED');
});

test('新版评论集合未建时返回配置错误类别，缓存读取失败不再被笼统归为未知错误', async () => {
  const f = fixture({ readError: { collection: 'square_comment_states', code: 'DATABASE_COLLECTION_NOT_EXIST', message: 'collection not exists' } });
  await f.login(); const postId = (await publish(f)).square.post._id;
  f.squareReplies.set('r_' + 'a'.repeat(40), { _id: 'r_' + 'a'.repeat(40), postId, authorId: [...f.users.keys()][0], status: 'published', content: '原有评论', sortKey: '1' });
  const result = await list(f, postId);
  assert.equal(result.code, 'COMMENTS_STORAGE_NOT_READY'); assert.match(result.message, /尚未配置完成/);
  assert.equal(f.squareReplies.size, 1);
});

test('心碎后点赞同时恢复可见，原已点赞时仅恢复且并发重试不增加计数，根评论与子回复一致', async () => {
  const { f, postId, rootId } = await setup();
  const childId = (await reply(f, postId, rootId)).square.reply._id;
  for (const id of [rootId, childId]) {
    await state(f, postId, id, 'fold', true);
    await state(f, postId, id, 'fold', true, f.bob);
    let restored = (await state(f, postId, id, 'like', true)).square.reply;
    assert.equal(restored.folded, false); assert.equal(restored.liked, true); assert.equal(restored.likeCount, 1);
    await state(f, postId, id, 'fold', true);
    const repeated = await Promise.all(Array.from({ length: 4 }, () => state(f, postId, id, 'like', true)));
    assert.ok(repeated.every(result => result.square.reply.folded === false && result.square.reply.liked === true));
    restored = repeated.at(-1).square.reply; assert.equal(restored.likeCount, 1);
    const bob = (await list(f, postId, f.bob, id === rootId ? undefined : rootId)).square.items.find(row => row._id === id);
    assert.equal(bob.folded, true); assert.equal(bob.liked, false);
    assert.equal((await state(f, postId, id, 'like', false)).square.reply.likeCount, 0);
  }
});
