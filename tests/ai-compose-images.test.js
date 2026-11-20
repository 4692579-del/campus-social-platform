const test = require('node:test');
const assert = require('node:assert/strict');
const { createComposeImageResolver } = require('../cloudfunctions/userService/ai-compose-images');
const { MAX_IMAGE_BYTES } = require('../cloudfunctions/userService/square-images');
const user = { _id: 'alice' }, identity = { env: 'test' };
const file = i => `cloud://test.bucket/square-uploads/alice/photo_${i}.png`;
const url = i => `https://test.bucket.tcb.qcloud.la/square-uploads/alice/photo_${i}.png?sign=synthetic`;
const png = () => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(40)]);

test('发布识图只读取本人私有上传，校验文件签名和大小，九图保持顺序且不产生公开文件', async () => {
  const files = Array.from({ length: 9 }, (_, i) => file(i)), calls = []; let running = 0, peak = 0;
  const resolve = createComposeImageResolver({ downloadFile: async args => {
    calls.push(args.fileID); running++; peak = Math.max(peak, running); await Promise.resolve(); running--;
    return { fileContent: png() };
  }, getTempFileURL: async args => {
    assert.deepEqual(args.fileList, files.map(fileID => ({ fileID, maxAge: 120 })));
    return { fileList: [...files].reverse().map(fileID => ({ fileID, status: 0, tempFileURL: url(files.indexOf(fileID)) })) };
  }, uploadFile: () => assert.fail('未发布图片不能复制到公开目录') });
  assert.deepEqual(await resolve(files, user, identity), files.map((_, i) => url(i)));
  assert.equal(calls.length, 9); assert.ok(peak <= 2);
});

test('发布识图拒绝其他账号、环境、认证材料、已发布图片、外链、穿越、重复和超九图', async () => {
  const resolve = createComposeImageResolver({ downloadFile: () => assert.fail('非法路径不能访问存储') });
  for (const files of [[], Array.from({ length: 10 }, (_, i) => file(i)), [file(0), file(0)], [null],
    ['https://example.com/x.png'], [file(0).replace('/alice/', '/bob/')], [file(0).replace('test.bucket', 'foreign.bucket')],
    [file(0).replace('square-uploads', 'square-media')], [file(0).replace('square-uploads', 'certification-proofs')],
    [file(0).replace('photo_0', '../photo_0')], [file(0).replace('.png', '.svg')], [file(0) + '?x=1']]) {
    await assert.rejects(resolve(files, user, identity), error => error.code === 'AI_IMAGES_UNAVAILABLE');
  }
  await assert.rejects(resolve([file(0)], user, {}), error => error.code === 'AI_IMAGES_UNAVAILABLE');
});

test('读取失败、超时、假图片、超5MB及缺少一图时整次失败，不把图片地址或SDK错误返回前端', async () => {
  const cases = [
    { downloadFile: async () => { throw new Error('private-file secret-signature'); } },
    { downloadFile: () => new Promise(() => {}) },
    { downloadFile: async () => ({ fileContent: Buffer.from('not an image at all') }) },
    { downloadFile: async () => ({ fileContent: Buffer.alloc(MAX_IMAGE_BYTES + 1) }) },
    { getTempFileURL: async () => ({ fileList: [] }) },
    { getTempFileURL: async () => ({ fileList: [{ fileID: file(0), status: 0, tempFileURL: 'https://attacker.example/x' }] }) },
    { getTempFileURL: async () => ({ fileList: [{ fileID: file(0), status: -1, tempFileURL: url(0) }] }) },
  ];
  for (const options of cases) {
    const resolve = createComposeImageResolver({ downloadFile: async () => ({ fileContent: png() }), ...options }, { timeoutMs: 5 });
    await assert.rejects(resolve([file(0)], user, identity), error => error.code === 'AI_IMAGES_UNAVAILABLE' && !/private|secret|http/.test(error.message));
  }
});
