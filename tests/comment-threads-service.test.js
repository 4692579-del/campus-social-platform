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
