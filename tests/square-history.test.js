const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture } = require('./helpers/certification-fixture');
const id = (prefix, n) => prefix + '_' + crypto.createHash('sha1').update(String(n)).digest('hex');
const key = (n, value) => `${String(n).padStart(16, '0')}_${value}`;
async function setup() {
  const f = fixture(), alice = await f.login(), bob = await f.login(f.bob);
  const postId = id('p', 1), rootId = id('r', 1);
  f.squarePosts.set(postId, { _id: postId, scope: 'square', status: 'published', authorId: bob._id, content: '原动态', images: ['public-image'], sortKey: key(1, postId) });
  f.squareReplies.set(rootId, { _id: rootId, postId, scope: 'square', status: 'published', authorId: bob._id, content: '原评论', images: [], replyCount: 90, sortKey: key(1, rootId) });
  function seed(n, child = true, authorId = alice._id, extra = {}) {
    const value = id(child ? 'c' : 'r', n);
    const row = { _id: value, postId, scope: 'square', status: 'published', authorId, content: `回复${n}`, images: [], sortKey: key(n, value),
      ...(child ? { rootId, replyToId: rootId, replyToAuthorId: bob._id, ancestorIds: [rootId] } : {}), ...extra };
    (child ? f.squareReplyChildren : f.squareReplies).set(value, row); return row;
  }
  const list = cursor => f.handle({ action: 'listSquareOwnReplies', ...(cursor ? { cursor } : {}) }, f.alice);
  const focus = replyId => f.handle({ action: 'getSquareReplyContext', postId, replyId }, f.alice);
  return { f, alice, bob, postId, rootId, seed, list, focus };
}
test('本人回复合并一级和楼中回复，游标稳定、作者不可伪造、返回不含私有字段', async () => {
  const { f, alice, bob, seed, list } = await setup();
  for (let n = 10; n < 58; n++) seed(n, n % 2 === 0, alice._id, { imageSources: ['private-original'], aiJobId: 'private-task' });
  seed(100, true, bob._id);
  const first = await f.handle({ action: 'listSquareOwnReplies', authorId: bob._id, mine: false }, f.alice);
  assert.equal(first.success, true, first.message); assert.equal(first.square.items.length, 20);
  assert.equal(first.square.items[0].reply.content, '回复57'); assert.equal(first.square.hasMore, true);
  seed(101); // 新记录不会让第二页重复或漏掉旧记录。
  const second = await list(first.square.nextCursor), third = await list(second.square.nextCursor);
  const rows = [...first.square.items, ...second.square.items, ...third.square.items];
  assert.equal(rows.length, 48); assert.equal(new Set(rows.map(row => row._id)).size, 48);
  assert.equal(third.square.hasMore, false);
  assert.ok(rows.every(row => row.reply.isOwn));
  const serialized = JSON.stringify(rows);
  for (const forbidden of ['private-original', 'private-task', 'authorId', 'imageSources', 'openid']) assert.ok(!serialized.includes(forbidden));
  assert.equal(rows.find(row => !row.reply.rootId).context.content, '原动态');
  assert.equal(rows.find(row => row.reply.rootId).context.content, '原评论');
  assert.equal((await f.handle({ action: 'listSquareOwnReplies', cursor: 'bad' }, f.alice)).code, 'INVALID_POST');
  assert.equal((await f.handle({ action: 'listSquareOwnReplies' }, { openid: 'not-registered', env: f.alice.env })).success, false);
});
test('删除动态或根评论隐藏历史，删除中间回复保留自己的回复并显示上文不可用', async () => {
  const { f, seed, list, rootId, postId } = await setup();
  const parent = seed(10), child = seed(11, true, undefined, { replyToId: parent._id, ancestorIds: [rootId, parent._id] });
  f.squareReplyChildren.get(parent._id).status = 'deleted';
  const first = await list();
  assert.equal(first.square.items.length, 1); assert.equal(first.square.items[0]._id, child._id);
  assert.equal(first.square.items[0].context.unavailable, true);
  f.squareReplies.get(rootId).status = 'deleted'; assert.equal((await list()).square.items.length, 0);
  f.squareReplies.get(rootId).status = 'published'; f.squarePosts.get(postId).status = 'deleted';
  assert.equal((await list()).square.items.length, 0);
});
test('整批不可见记录仍推进游标，后续有效记录可以加载', async () => {
  const { f, postId, seed, list } = await setup();
  const hidden = id('p', 2);
  f.squarePosts.set(hidden, { ...f.squarePosts.get(postId), _id: hidden, status: 'deleted' });
  for (let n = 20; n < 45; n++) seed(n, true, undefined, { postId: hidden });
  const good = seed(10, false);
  const first = await list(); assert.equal(first.square.items.length, 0); assert.equal(first.square.hasMore, true);
  const second = await list(first.square.nextCursor); assert.equal(second.square.items[0]._id, good._id);
});
test('深层历史回复直接读取目标窗口，保留向前和向后分页，不靠首屏猜位置', async () => {
  const { f, seed, focus, rootId, postId } = await setup();
  const rows = Array.from({ length: 85 }, (_, i) => seed(i + 10));
  const result = await focus(rows[63]._id);
  assert.equal(result.success, true, result.message);
  assert.equal(result.square.root._id, rootId); assert.equal(result.square.targetId, rows[63]._id);
  assert.equal(result.square.startOffset, 60); assert.equal(result.square.nextOffset, 80);
  assert.equal(result.square.hasMore, true); assert.equal(result.square.items.length, 20);
  assert.ok(result.square.items.some(row => row._id === rows[63]._id));
  f.squarePosts.get(postId).status = 'deleted'; assert.equal((await focus(rows[63]._id)).code, 'POST_NOT_FOUND');
});
test('历史上文遵守本人心碎折叠，不展开已折叠祖先；其他账号仍可见', async () => {
  const { f, alice, seed, list, focus, rootId, postId } = await setup();
  const row = seed(10);
  const folded = await f.handle({ action: 'setSquareCommentState', postId, replyId: rootId, kind: 'fold', active: true }, f.alice);
  assert.equal(folded.success, true, folded.message);
  const item = (await list()).square.items[0];
  assert.equal(item.reply.folded, true); assert.equal(item.reply.content, ''); assert.deepEqual(item.reply.images, []);
  assert.equal(item.context.folded, true);
  const located = await focus(row._id); assert.equal(located.square.blocked, true); assert.equal(located.square.targetId, rootId);
  const other = await f.handle({ action: 'getSquareReplyContext', postId, replyId: row._id }, f.bob);
  assert.equal(other.square.root.folded, false); assert.equal(other.square.items[0].content, row.content);
  assert.ok(alice._id);
});
