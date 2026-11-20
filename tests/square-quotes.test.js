const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/certification-fixture');
async function setup(options = {}) {
  const f = fixture(options), alice = await f.login(), bob = await f.login(f.bob);
  const send = (content, quotePostId, requestId, extra = {}, identity = f.alice) => f.handle({ action: 'publishSquarePost',
    post: { scope: 'square', content, requestId, ...(quotePostId ? { quotePostId } : {}), ...extra } }, identity);
  const source = await send('原动态完整正文', '', 'quote-source-00000001', {}, f.bob);
  assert.equal(source.success, true, source.message);
  return { f, alice, bob, source: source.square.post, send };
}
test('普通未认证账号可仅引用发布；只保存真实ID、云端读取全文与公开图，去重计数原子提交', async () => {
  const { f, source, send, bob } = await setup();
  const image = `cloud://test.bucket/square-media/${bob._id}/${source._id}/0-public.jpg`;
  Object.assign(f.squarePosts.get(source._id), { images: [image], imageSources: ['private-original'], secret: 'never-send' });
  const result = await send('', source._id, 'quote-send-000000001');
  assert.equal(result.success, true, result.message);
  assert.equal(result.square.post.content, ''); assert.equal(result.square.post.quotePostId, source._id);
  assert.equal(result.square.post.quote.content, source.content);
  assert.deepEqual(result.square.post.quote.images, [image]);
  assert.equal(result.square.quotedPost.quoteCount, 1);
  const saved = f.squarePosts.get(result.square.post._id);
  assert.equal(saved.quotePostId, source._id); assert.equal(saved.quote, undefined);
  assert.ok(!JSON.stringify(result).includes('private-original')); assert.ok(!JSON.stringify(result).includes('never-send'));
  const duplicate = await send('', source._id, 'quote-send-000000001');
  assert.equal(duplicate.success, true); assert.equal(f.squarePosts.get(source._id).quoteCount, 1);
  const changed = await send('换了内容', source._id, 'quote-send-000000001'); assert.equal(changed.code, 'REQUEST_CONFLICT');
  const spoof = await send('伪造上文', source._id, 'quote-spoof-00000001', { quote: { content: '伪造内容' } }); assert.equal(spoof.code, 'INVALID_POST');
  f.hooks.serialTransactionReads = true;
  const second = await send('追加自己的想法', source._id, 'quote-send-000000002');
  assert.equal(second.success, true, second.message); assert.equal(f.squarePosts.get(source._id).quoteCount, 2);
});
test('引用可附加自己的图片，原帖图片不复制到新动态图片，相册仅记录本次真实上传', async () => {
  const { f, alice, source, send } = await setup({ processSquareImages: async (files, context) =>
    files.map((_, i) => `cloud://test.bucket/square-media/${context.userId}/${context.postId}/${i}-new.jpg`) });
  f.squarePosts.get(source._id).images = ['cloud://test.bucket/square-media/bob/source/original.jpg'];
  const result = await send('配图补充', source._id, 'quote-images-00000001', { images: [`cloud://test.bucket/square-uploads/${alice._id}/mine.jpg`] });
  assert.equal(result.success, true, result.message); assert.equal(result.square.post.images.length, 1);
  assert.ok(result.square.post.images[0].endsWith('/0-new.jpg'));
  const album = await f.handle({ action: 'listSquareAlbum' }, f.alice);
  assert.deepEqual(album.square.items.map(row => row.fileID), result.square.post.images);
});
test('原动态删除或越权板块不能新引用，审核拒绝或事务失败不留下引用记录及计数', async () => {
  const { f, source, send } = await setup();
  f.squarePosts.get(source._id).scope = 'campus';
  assert.equal((await send('不能绕过', source._id, 'quote-invalid-0000001')).code, 'QUOTE_UNAVAILABLE');
  f.squarePosts.get(source._id).scope = 'square';
  f.hooks.beforeTransaction = tables => { tables.get('square_posts').get(source._id).status = 'deleted'; };
  assert.equal((await send('提交时已删除', source._id, 'quote-invalid-0000002')).code, 'QUOTE_UNAVAILABLE');
  assert.equal(f.squarePosts.size, 1); assert.equal(f.squarePosts.get(source._id).quoteCount || 0, 0);
  const rejected = await setup({ checkText: async text => !text.includes('拒绝') });
  assert.equal((await rejected.send('拒绝内容', rejected.source._id, 'quote-rejected-00001')).code, 'CONTENT_REJECTED');
  assert.equal(rejected.f.squarePosts.get(rejected.source._id).quoteCount || 0, 0);
});
test('删除引用动态只扣一次真实计数；删除原动态后框不可用，已成功请求仍可确认且不重复扣额', async () => {
  const { f, source, send } = await setup();
  const result = await send('引用', source._id, 'quote-delete-00000001');
  const id = result.square.post._id;
  for (let n = 0; n < 2; n++) {
    const removed = await f.handle({ action: 'deleteSquarePost', postId: id }, f.alice);
    assert.equal(removed.success, true, removed.message); assert.equal(removed.square.quotedPost.quoteCount, 0);
  }
  const other = await send('', source._id, 'quote-delete-00000002');
  f.squarePosts.get(source._id).status = 'deleted';
  const detail = await f.handle({ action: 'getSquarePost', postId: other.square.post._id }, f.alice);
  assert.equal(detail.square.post.quote.unavailable, true); assert.equal(detail.square.post.quote.content, undefined);
  const repeat = await send('', source._id, 'quote-delete-00000002');
  assert.equal(repeat.success, true, repeat.message); assert.equal(repeat.square.post._id, other.square.post._id);
  assert.equal((await send('', source._id, 'quote-after-delete-01')).code, 'QUOTE_UNAVAILABLE');
});
test('引用链有限批量读取，循环或深层记录改为详情入口，不复制整条引用链到数据库', async () => {
  const { f, source, send } = await setup();
  let last = source;
  for (let n = 0; n < 5; n++) {
    const result = await send(`第${n}次引用`, last._id, `quote-chain-${String(n).padStart(8, '0')}`);
    assert.equal(result.success, true, result.message); last = result.square.post;
  }
  let quote = last.quote, visible = 0;
  while (quote && !quote.collapsed) { visible++; quote = quote.quote; }
  assert.equal(visible, 3); assert.equal(quote.collapsed, true);
  const list = await f.handle({ action: 'listSquarePosts' }, f.alice);
  assert.ok(list.square.items.some(row => row.quotePostId));
  assert.ok([...f.squarePosts.values()].every(row => !Object.hasOwn(row, 'quote')));
});
test('并发重复发布只计一次，事务失败不会只保存引用或只增加计数', async () => {
  const options = {}, { f, source, send } = await setup(options);
  const results = await Promise.all([send('', source._id, 'quote-concurrent-0001'), send('', source._id, 'quote-concurrent-0001')]);
  assert.ok(results.every(result => result.success)); assert.equal(results[0].square.post._id, results[1].square.post._id);
  assert.equal(f.squarePosts.get(source._id).quoteCount, 1); assert.equal(f.squarePosts.get(source._id).quoteVersion, 1);
  options.failCollection = 'square_posts';
  const result = await send('事务失败', source._id, 'quote-fail-transaction');
  assert.equal(result.success, false); assert.equal(f.squarePosts.size, 2);
  assert.equal(f.squarePosts.get(source._id).quoteCount, 1);
});
