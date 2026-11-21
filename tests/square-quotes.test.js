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


test('个人动态与引用按最终引用关系在云端互斥分页，旧普通记录和失效来源保持正确分类', async () => {
  const { f, source, send, alice, bob } = await setup();
  const ordinary = await send('已移除引用，普通发布', '', 'profile-ordinary-0001');
  const quoted = await send('保留引用', source._id, 'profile-quote-000001');
  const normalRow = f.squarePosts.get(ordinary.square.post._id), quoteRow = f.squarePosts.get(quoted.square.post._id);
  assert.equal(Object.hasOwn(normalRow, 'quotePostId'), false);
  f.squarePosts.delete(normalRow._id); f.squarePosts.delete(quoteRow._id);
  const expected = { posts: [], quotes: [] };
  for (let n = 0; n < 45; n++) {
    const kind = n % 2 ? 'quotes' : 'posts';
    const row = { ...(kind === 'quotes' ? quoteRow : normalRow), _id: 'p_' + n.toString(16).padStart(40, '0'), sortKey: String(n).padStart(8, '0') };
    f.squarePosts.set(row._id, row); expected[kind].unshift(row._id);
  }
  f.squarePosts.set('p_' + 'e'.repeat(40), { ...quoteRow, _id: 'p_' + 'e'.repeat(40), authorId: bob._id });
  f.squarePosts.set('p_' + 'f'.repeat(40), { ...normalRow, _id: 'p_' + 'f'.repeat(40), status: 'deleted' });
  f.squarePosts.get(source._id).status = 'deleted';
  for (const postType of ['posts', 'quotes']) {
    const first = await f.handle({ action: 'listSquarePosts', mine: true, postType, authorId: bob._id }, f.alice);
    assert.equal(first.success, true, first.message); assert.equal(first.square.postType, postType);
    assert.equal(first.square.total, expected[postType].length); assert.equal(first.square.allTotal, 45);
    assert.equal(first.square.items.length, 20); assert.equal(first.square.hasMore, true);
    const second = await f.handle({ action: 'listSquarePosts', mine: true, postType, offset: first.square.nextOffset }, f.alice);
    assert.equal(second.success, true, second.message); assert.equal(second.square.hasMore, false);
    assert.deepEqual([...first.square.items, ...second.square.items].map(row => row._id), expected[postType]);
    assert.ok(first.square.items.every(row => row.isOwn && Boolean(row.quotePostId) === (postType === 'quotes')));
    if (postType === 'quotes') assert.ok(first.square.items.every(row => row.quote.unavailable));
  }
  assert.equal((await f.handle({ action: 'listSquarePosts', postType: 'quotes' }, f.alice)).code, 'INVALID_POST');
  assert.equal((await f.handle({ action: 'listSquarePosts', mine: true, postType: 'invalid' }, f.alice)).code, 'INVALID_POST');
});


test('引用状态仅属于当前账号，成功后变蓝，多次引用删到最后一条才恢复且他人引用不误点亮', async () => {
  const { f, source, send } = await setup();
  const read = identity => f.handle({ action: 'getSquarePost', postId: source._id, personalize: true }, identity);
  assert.equal((await read(f.alice)).square.post.quoted, false);
  const first = await send('我的第一次引用', source._id, 'state-alice-first-001');
  assert.equal(first.square.quotedPost.quoted, true);
  const second = await send('我的第二次引用', source._id, 'state-alice-second-01');
  const other = await send('其他人的引用', source._id, 'state-bob-first-0001', {}, f.bob);
  assert.equal(other.square.quotedPost.quoted, true);
  const feed = await f.handle({ action: 'listSquarePosts', personalize: true }, f.alice);
  assert.equal(feed.square.items.find(row => row._id === source._id).quoted, true);
  const anonymous = await f.handle({ action: 'getSquarePost', postId: source._id }, f.alice);
  assert.equal(anonymous.square.post.quoted, false);
  const removedFirst = await f.handle({ action: 'deleteSquarePost', postId: first.square.post._id }, f.alice);
  assert.equal(removedFirst.square.quotedPost.quoted, true);
  const removedLast = await f.handle({ action: 'deleteSquarePost', postId: second.square.post._id }, f.alice);
  assert.equal(removedLast.square.quotedPost.quoted, false); assert.equal(removedLast.square.quotedPost.quoteCount, 1);
  assert.equal((await read(f.alice)).square.post.quoted, false);
  assert.equal((await read(f.bob)).square.post.quoted, true);
  const plain = await send('没有保留引用的普通发布', '', 'state-plain-post-001');
  assert.equal(plain.success, true); assert.equal((await read(f.alice)).square.post.quoted, false);
});
