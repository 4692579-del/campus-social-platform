const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/certification-fixture');
const { createSquareImageProcessor } = require('../cloudfunctions/userService/square-images');
const { createAIImageResolver, createAICommentImageResolver } = require('../cloudfunctions/userService/ai-images');
const source = (user, i) => `cloud://test.bucket/square-uploads/${user._id}/comment_${i}.png`;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(40)]);
async function setup(options = {}) {
  const downloads = [], uploads = [];
  const cloud = {
    downloadFile: async args => { downloads.push(args.fileID); return { fileContent: png }; },
    uploadFile: async args => { uploads.push(args.cloudPath); return { fileID: 'cloud://test.bucket/' + args.cloudPath }; },
    getTempFileURL: async args => ({ fileList: [...args.fileList].reverse().map(({ fileID }) => ({ fileID, status: 0,
      tempFileURL: 'https://test.bucket.tcb.qcloud.la/' + fileID.split('/').slice(3).join('/') + '?sign=synthetic' })) }),
  };
  const f = fixture({ processSquareImages: createSquareImageProcessor(cloud),
    resolveAIImages: createAIImageResolver(cloud), resolveAICommentImages: createAICommentImageResolver(cloud), ...options });
  const user = await f.login(); await f.login(f.bob);
  const post = await f.handle({ action: 'publishSquarePost', post: { scope: 'square', content: '动态正文与配图上下文',
    images: Array.from({ length: options.postCount || 0 }, (_, i) => source(user, 'post_' + i)), requestId: 'comment-image-post001' } }, f.alice);
  assert.equal(post.success, true, post.message);
  const postId = post.square.post._id;
  const send = (content = '', images = [], extra = {}) => f.handle({ action: 'publishSquareReply', post: {
    scope: 'square', postId, content, images, requestId: 'comment-image-send01', ...extra } }, f.alice);
  const process = replyId => f.handle({ action: 'processSquareAIReply', postId, replyId }, f.alice);
  return { ...f, user, postId, send, process, downloads, uploads };
}

test('一级评论及楼中回复支持纯三图或图文，顺序和数量真实保存，幂等重试不复制图片、不加入个人相册', async () => {
  const f = await setup(), files = [0,1,2].map(i => source(f.user, i));
  const first = await f.send('', files); assert.equal(first.success, true, first.message);
  const root = first.square.reply;
  assert.equal(root.content, ''); assert.equal(root.images.length, 3); assert.equal(root.imageSources, undefined);
  assert.deepEqual(f.squareReplies.get(root._id).imageSources, files);
  root.images.forEach((file, i) => assert.match(file, new RegExp(`/square-media/${f.user._id}/${root._id}/${i}-[a-f0-9]{24}\\.png$`)));
  assert.equal(f.squarePosts.get(f.postId).replyCount, 1); assert.equal(f.aiJobs.size, 0);
  const retried = await f.send('', files); assert.equal(retried.square.reply._id, root._id); assert.equal(f.uploads.length, 3);
  assert.equal((await f.send('', files.slice(0, 2))).code, 'REQUEST_CONFLICT');
  const child = await f.send('楼中图片', files.slice(0, 2), { replyToId: root._id, requestId: 'comment-image-child01' });
  assert.equal(child.success, true, child.message); assert.equal(child.square.reply.images.length, 2);
  assert.equal(child.square.reply.rootId, root._id); assert.equal(f.squareReplies.get(root._id).replyCount, 1);
  const rows = await f.handle({ action: 'listSquareReplies', postId: f.postId }, f.bob);
  assert.deepEqual(rows.square.items[0].images, root.images);
  const children = await f.handle({ action: 'listSquareReplyChildren', postId: f.postId, rootId: root._id }, f.bob);
  assert.deepEqual(children.square.items[0].images, child.square.reply.images);
  assert.equal((await f.handle({ action: 'listSquareAlbum' }, f.alice)).square.items.length, 0);
  const report = await f.handle({ action: 'reportSquareReply', postId: f.postId, replyId: root._id, reason: 'other' }, f.bob);
  assert.equal(report.success, true); assert.deepEqual([...f.squareReports.values()][0].commentImages, root.images);
});

test('评论拒绝四图、外链、跨账号/环境、私密认证材料、重复及超50字，图片保存失败不写评论或增加计数', async () => {
  const f = await setup();
  const own = source(f.user, 0);
  for (const files of [[own, own], [0,1,2,3].map(i => source(f.user, i)), ['https://example.com/x.png'],
    [own.replace(f.user._id, 'another')], [own.replace('test.bucket', 'other.bucket')], [own.replace('square-uploads', 'certification-proofs')]]) {
    assert.equal((await f.send('', files)).code, 'INVALID_IMAGES');
  }
  assert.equal((await f.send('字'.repeat(51), [own])).code, 'INVALID_POST');
  assert.equal((await f.send('', [])).code, 'INVALID_POST');
  assert.equal(f.uploads.length, 0); assert.equal(f.squareReplies.size, 0);
  const failed = await setup({ processSquareImages: async () => { throw new Error('private storage details'); } });
  const result = await failed.send('', [source(failed.user, 0)]);
  assert.equal(result.code, 'IMAGE_UPLOAD_UNAVAILABLE'); assert.ok(!result.message.includes('private'));
  assert.equal(failed.squareReplies.size, 0); assert.equal(failed.squarePosts.get(failed.postId).replyCount, 0);
});

test('小萃同时读取动态九图及本条评论三图，区分来源、审核结果并原子扣双周期额度', async () => {
  let generated;
  const f = await setup({ postCount: 9, generateAI: async (context, attachments) => { generated = { context, attachments }; return '结合两组图片的真实回答。'; } });
  const sent = await f.send('@小萃 对比我发的图片', [0,1,2].map(i => source(f.user, i)), { askAI: true });
  const root = sent.square.reply, result = await f.process(root._id);
  assert.equal(result.success, true, result.message); assert.equal(result.square.status, 'done');
  assert.equal(generated.context.post, '动态正文与配图上下文'); assert.equal(generated.context.postImageCount, 9);
  assert.equal(generated.context.commentImageCount, 3); assert.equal(generated.context.imageCount, 12);
  assert.equal(generated.attachments.images.length, 12);
  assert.ok(generated.attachments.images.slice(0, 9).every(url => url.includes(f.postId)));
  assert.ok(generated.attachments.images.slice(9).every(url => url.includes(root._id)));
  for (const type of ['daily_usage', 'hourly_usage']) {
    const usage = [...f.aiJobs.values()].find(row => row.type === type);
    assert.equal(usage.usedChars, Array.from('结合两组图片的真实回答。').length);
  }
  assert.equal(f.squareReplyChildren.size, 1); await f.process(root._id); assert.equal(f.squareReplyChildren.size, 1);
  assert.equal((await f.handle({ action: 'listSquareAlbum' }, f.alice)).square.items.length, 9);
  assert.ok(!/https|sign=/.test(JSON.stringify([...f.aiJobs.values()])));
});

test('只有评论附图时也可识图；附图丢失或解析失败不丢图降级、不保存AI、不扣额度', async () => {
  for (const mode of ['ok', 'missing', 'partial']) {
    const f = await setup({ resolveAICommentImages: mode === 'missing' ? undefined : mode === 'partial' ? async () => [] : async () => ['https://test.tcb.qcloud.la/comment.png'],
      generateAI: async context => { assert.equal(mode, 'ok'); assert.equal(context.postImageCount, 0); assert.equal(context.commentImageCount, 1); return '这是你上传的图片。'; } });
    const row = (await f.send('@小萃 看看这个', [source(f.user, 0)], { askAI: true })).square.reply;
    const result = await f.process(row._id);
    assert.equal(result.square.status, mode === 'ok' ? 'done' : 'failed');
    assert.equal(f.squareReplyChildren.size, mode === 'ok' ? 1 : 0);
    if (mode !== 'ok') for (const usage of f.aiJobs.values()) if (usage.type.endsWith('_usage')) assert.equal(usage.usedChars, 0);
  }
});

test('评论图解析期间删除评论、以及模型返回前图片变化，均阻止迟到回答保存和额度结算', async () => {
  for (const mode of ['delete', 'change']) {
    let finish;
    const f = await setup({ resolveAICommentImages: mode === 'delete' ? () => new Promise(resolve => { finish = resolve; }) : async () => ['https://test.tcb.qcloud.la/comment.png'],
      generateAI: mode === 'delete' ? async () => assert.fail('删除后不能调用模型') : () => new Promise(resolve => { finish = resolve; }) });
    const row = (await f.send('@小萃 看图', [source(f.user, 0)], { askAI: true })).square.reply;
    const pending = f.process(row._id);
    for (let i = 0; i < 50 && !finish; i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(finish);
    if (mode === 'delete') {
      await f.handle({ action: 'deleteSquareReply', postId: f.postId, replyId: row._id }, f.alice);
      finish(['https://test.tcb.qcloud.la/comment.png']);
    } else { f.squareReplies.get(row._id).images = []; finish('不应保存的回答'); }
    await pending; assert.equal(f.squareReplyChildren.size, 0);
    for (const usage of f.aiJobs.values()) if (usage.type.endsWith('_usage')) assert.equal(usage.usedChars, 0);
  }
});

test('评论AI解析器只接受该评论作者和ID的三个服务端成品，不能挪用动态、其他评论或私有原件', async () => {
  const id = 'r_' + 'a'.repeat(40), owner = 'alice';
  const file = `cloud://test.bucket/square-media/${owner}/${id}/0-${'b'.repeat(24)}.png`;
  const resolve = createAICommentImageResolver({ getTempFileURL: async args => ({ fileList: args.fileList.map(({ fileID }) => ({ fileID, status: 0, tempFileURL: 'https://test.bucket.tcb.qcloud.la/photo.png' })) }) });
  const row = { _id: id, authorId: owner, images: [file] }, identity = { env: 'test' };
  assert.equal((await resolve(row, identity)).length, 1);
  for (const images of [[file.replace(id, 'p_' + 'c'.repeat(40))], [file.replace(id, 'c_' + 'd'.repeat(40))],
    [file.replace('/alice/', '/bob/')], [file.replace('square-media', 'square-uploads')],
    [file.replace('/0-', '/3-')], [file, file], [file.replace('test.bucket', 'other.bucket')]])
    await assert.rejects(resolve({ ...row, images }, identity), error => error.code === 'AI_IMAGES_UNAVAILABLE');
});
