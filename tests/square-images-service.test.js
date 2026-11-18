const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/certification-fixture');
const { createSquareImageProcessor, imageType, MAX_IMAGE_BYTES } = require('../cloudfunctions/userService/square-images');
const source = (user, n = 0) => `cloud://test.bucket/square-uploads/${user._id}/picture_${n}.jpg`;
const publish = (f, images, content = '图文动态', requestId = 'images-request-00001') => f.handle({ action: 'publishSquarePost', post: { scope: 'square', content, images, requestId } }, f.alice);
const processor = async (files, { userId, postId }) => files.map((file, i) => `cloud://test.bucket/square-media/${userId}/${postId}/${i}.jpg`);

test('未认证用户可发布九图及纯图片；图片顺序、归属、列表、详情与本人相册一致，不暴露私有原件', async () => {
  const calls = [];
  const f = fixture({ processSquareImages: async (...args) => { calls.push(args); return processor(...args); } });
  const user = await f.login();
  const files = Array.from({ length: 9 }, (_, i) => source(user, i));
  const result = await f.handle({ action: 'publishSquarePost', post: { scope: 'square', content: '', images: files, declaration: 'ai', requestId: 'images-request-00001' } }, f.alice);
  assert.equal(result.success, true, result.message);
  const post = result.square.post;
  assert.equal(post.content, ''); assert.equal(post.images.length, 9);
  assert.equal(post.declaration, 'ai');
  assert.deepEqual(calls[0][0], files); assert.equal(calls[0][1].userId, user._id);
  assert.equal(post.imageSources, undefined);
  assert.deepEqual(f.squarePosts.get(post._id).imageSources, files);
  const feed = await f.handle({ action: 'listSquarePosts' }, f.alice);
  const detail = await f.handle({ action: 'getSquarePost', postId: post._id }, f.alice);
  assert.deepEqual(feed.square.items[0].images, post.images); assert.deepEqual(detail.square.post.images, post.images);
  assert.equal(feed.square.items[0].declaration, 'ai'); assert.equal(detail.square.post.declaration, 'ai');
  const album = await f.handle({ action: 'listSquareAlbum' }, f.alice);
  assert.deepEqual(album.square.items.map(image => image.fileID), post.images);
  assert.equal(album.square.items[0].content, undefined);
  await f.login(f.bob);
  assert.equal((await f.handle({ action: 'listSquareAlbum', authorId: user._id }, f.bob)).square.items.length, 0);
  await f.handle({ action: 'deleteSquarePost', postId: post._id }, f.alice);
  assert.equal((await f.handle({ action: 'listSquareAlbum' }, f.alice)).square.items.length, 0);
});

test('拒绝十图、重复、外链、其他账号、其他环境和非图片目录；回复入口不接受图片', async () => {
  let processed = 0;
  const f = fixture({ processSquareImages: async (...args) => { processed++; return processor(...args); } });
  const user = await f.login(), bob = await f.login(f.bob);
  for (const files of [Array.from({ length: 10 }, (_, i) => source(user, i)), [source(user), source(user)],
    ['https://example.com/photo.jpg'], [source(bob)], [source(user).replace('test.bucket', 'other.bucket')],
    [source(user).replace('square-uploads', 'certification-proofs')], ['cloud://test.bucket/square-uploads/../photo.jpg'], 'invalid']) {
    assert.equal((await publish(f, files)).code, 'INVALID_IMAGES');
  }
  assert.equal(processed, 0); assert.equal(f.squarePosts.size, 0);
  const post = await publish(f, []);
  assert.equal((await f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId: post.square.post._id, content: '回复',
    images: [source(user)], requestId: 'reply-image-request1' } }, f.alice)).code, 'INVALID_POST');
  assert.equal((await f.handle({ action: 'listSquareAlbum' }, { openid: 'guest', env: 'test' })).code, 'NOT_REGISTERED');
});

test('图片重试幂等，原件已清理仍返回原动态，更换图片必须新提交；处理失败不写入半条动态', async () => {
  let attempts = 0;
  const f = fixture({ processSquareImages: async (...args) => { attempts++; return processor(...args); } });
  const user = await f.login();
  const first = await publish(f, [source(user)]), second = await publish(f, [source(user)]);
  assert.equal(first.square.post._id, second.square.post._id); assert.equal(attempts, 1); assert.equal(f.squarePosts.size, 1);
  assert.equal((await publish(f, [source(user, 1)])).code, 'REQUEST_CONFLICT');
  const failed = fixture({ processSquareImages: async () => { throw new Error('offline'); } });
  const failedUser = await failed.login();
  assert.equal((await publish(failed, [source(failedUser)])).code, 'IMAGE_UPLOAD_UNAVAILABLE');
  assert.equal(failed.squarePosts.size, 0);
  const unavailable = fixture(); const inactiveUser = await unavailable.login();
  assert.equal((await publish(unavailable, [source(inactiveUser)])).code, 'IMAGE_UPLOAD_UNAVAILABLE');
});

test('相册按图文动态分页，不含文字、他人、删除或隐藏动态，分页图片不丢失', async () => {
  const f = fixture({ processSquareImages: processor }); const user = await f.login();
  for (let i = 0; i < 22; i++) await publish(f, [source(user, i)], '图', `album-request-${String(i).padStart(8, '0')}`);
  await publish(f, [], '纯文字', 'album-text-request01');
  const first = await f.handle({ action: 'listSquareAlbum' }, f.alice);
  assert.equal(first.square.items.length, 20); assert.equal(first.square.hasMore, true); assert.equal(first.square.nextOffset, 20);
  const next = await f.handle({ action: 'listSquareAlbum', offset: first.square.nextOffset }, f.alice);
  assert.equal(next.square.items.length, 2); assert.equal(next.square.hasMore, false);
  assert.equal(new Set([...first.square.items, ...next.square.items].map(image => image._id)).size, 22);
  assert.deepEqual(f.queries.at(-1).ordering, [['sortKey', 'desc']]);
});

test('服务端校验实际图片字节与大小，生成稳定不可覆盖的公开文件路径并保持九图顺序', async () => {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)]);
  assert.equal(imageType(png), 'png'); assert.equal(imageType(Buffer.from('this is not a real photo')), '');
  assert.equal(imageType(Buffer.alloc(MAX_IMAGE_BYTES + 1)), '');
  const uploads = [], files = Array.from({ length: 9 }, (_, i) => String(i));
  const process = createSquareImageProcessor({ downloadFile: async ({ fileID }) => {
    await new Promise(resolve => setTimeout(resolve, (9 - Number(fileID)) % 3));
    return { fileContent: png };
  }, uploadFile: async ({ cloudPath }) => { uploads.push(cloudPath); return { fileID: 'cloud://test.bucket/' + cloudPath }; } });
  const result = await process(files, { userId: 'alice', postId: 'post' });
  for (let i = 0; i < 9; i++) assert.match(result[i], new RegExp(`/square-media/alice/post/${i}-[a-f0-9]{24}\\.png$`));
  assert.equal(uploads.length, 9);
  const invalid = createSquareImageProcessor({ downloadFile: async () => ({ fileContent: Buffer.from('not an image file') }),
    uploadFile: async () => assert.fail('非法图片不能公开') });
  await assert.rejects(invalid(['bad'], { userId: 'alice', postId: 'post' }), error => error.code === 'INVALID_IMAGES');
});
