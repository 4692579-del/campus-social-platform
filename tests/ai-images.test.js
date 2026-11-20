const test = require('node:test');
const assert = require('node:assert/strict');
const { createAIImageResolver } = require('../cloudfunctions/userService/ai-images');
const postId = 'p_' + 'a'.repeat(40), authorId = 'u_' + 'b'.repeat(32);
const file = i => `cloud://test.bucket/square-media/${authorId}/${postId}/${i}-${'c'.repeat(24)}.jpg`;
const url = i => `https://test.bucket.tcb.qcloud.la/square-media/${authorId}/${postId}/${i}.jpg?sign=synthetic-only`;
const post = (count = 3) => ({ _id: postId, authorId, images: Array.from({ length: count }, (_, i) => file(i)) });
const identity = { env: 'test' };

test('识图仅将服务端公开成品转换为短效HTTPS地址，SDK乱序结果仍保持动态九图顺序', async () => {
  const calls = [], source = post(9);
  const resolve = createAIImageResolver({ getTempFileURL: async args => {
    calls.push(args);
    return { fileList: [...source.images].reverse().map(fileID => ({ fileID, status: 0, tempFileURL: url(source.images.indexOf(fileID)) })) };
  } });
  assert.deepEqual(await resolve(source, identity), source.images.map((_, i) => url(i)));
  assert.deepEqual(calls, [{ fileList: source.images.map(fileID => ({ fileID, maxAge: 120 })) }]);
});

test('拒绝私有原件、认证材料、外链、跨环境、其他动态或作者、路径穿越、重复及超出九图', async () => {
  const resolve = createAIImageResolver({ getTempFileURL: async () => assert.fail('校验失败不能请求云存储') });
  const originals = post();
  for (const images of [[], post(10).images, [file(0), file(0)], ['https://example.com/photo.jpg'],
    [file(0).replace('test.bucket', 'foreign.bucket')], [file(0).replace('square-media', 'square-uploads')],
    [file(0).replace('square-media', 'certification-proofs')], [file(0).replace(authorId, 'another-user')],
    [file(0).replace(postId, 'p_' + 'd'.repeat(40))], [file(0).replace('0-', '../0-')],
    [file(0).replace('.jpg', '.svg')], [file(0) + '?file=other'], [null]]) {
    await assert.rejects(resolve({ ...originals, images }, identity), error => error.code === 'AI_IMAGES_UNAVAILABLE');
  }
  await assert.rejects(resolve(originals, {}), error => error.code === 'AI_IMAGES_UNAVAILABLE');
});

test('缺图、不可读文件及非云存储HTTPS地址均失败，不悄悄丢图或改走文字回答', async () => {
  for (const results of [[], [{ fileID: file(0), status: -1 }], [{ fileID: file(0), status: 0, tempFileURL: 'http://test.bucket.tcb.qcloud.la/photo.jpg' }],
    [{ fileID: file(0), status: 0, tempFileURL: 'https://example.com/photo.jpg' }],
    [{ fileID: file(0), status: 0, tempFileURL: 'https://test.bucket.tcb.qcloud.la.attacker.test/photo.jpg' }],
    [{ fileID: file(0), status: 0, tempFileURL: 'https://user:password@test.bucket.tcb.qcloud.la/photo.jpg' }],
    [{ fileID: file(0), status: 0, tempFileURL: 'https://test.bucket.tcb.qcloud.la:8080/photo.jpg' }]]) {
    const resolve = createAIImageResolver({ getTempFileURL: async () => ({ fileList: results }) });
    await assert.rejects(resolve(post(1), identity), error => error.code === 'AI_IMAGES_UNAVAILABLE' && !error.message.includes('https:'));
  }
});

test('SDK失败及超时仅抛安全码，不回显地址、签名或原始错误', async () => {
  for (const getTempFileURL of [async () => { throw new Error('secret-token private-file https://bad.example'); }, () => new Promise(() => {})]) {
    const resolve = createAIImageResolver({ getTempFileURL }, { timeoutMs: 5 });
    await assert.rejects(resolve(post(1), identity), error => error.code === 'AI_IMAGES_UNAVAILABLE' && !/secret|private|https/.test(error.message));
  }
});
