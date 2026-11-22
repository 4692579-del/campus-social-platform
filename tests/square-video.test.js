const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./helpers/certification-fixture');
const { createSquareVideoProcessor, videoSize } = require('../cloudfunctions/userService/square-videos');

function atom(type, ...parts) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0));
  header.write(type, 4);
  return Buffer.concat([header, ...parts]);
}

function clip(codec = 'avc1', rotated = false, codecConfig = Buffer.alloc(0)) {
  // 构造最小容器来验证格式、编码及方向读取，不模拟播放器解码。
  const tkhd = Buffer.alloc(84);
  tkhd.writeInt32BE(65536, rotated ? 44 : 40);
  tkhd.writeUInt32BE(640 * 65536, 76);
  tkhd.writeUInt32BE(360 * 65536, 80);
  const hdlr = Buffer.alloc(12);
  hdlr.write('vide', 8);
  const entryCount = Buffer.alloc(8);
  entryCount.writeUInt32BE(1, 4);
  const stsd = atom('stsd', entryCount, atom(codec, Buffer.alloc(78), codecConfig));
  const mdia = atom('mdia', atom('hdlr', hdlr), atom('minf', atom('stbl', stsd)));
  return Buffer.concat([atom('ftyp', Buffer.from('isom0000')), atom('moov', atom('trak', atom('tkhd', tkhd), mdia)), atom('mdat', Buffer.alloc(16))]);
}

test('云端从视频轨道读取画面及方向，只写入已校验的 MP4 成品', async () => {
  assert.deepEqual(videoSize(clip()), { width: 640, height: 360 });
  assert.deepEqual(videoSize(clip('avc1', true)), { width: 360, height: 640 });
  assert.throws(() => videoSize(clip('hvc1')), { code: 'INVALID_MEDIA' });
  assert.throws(() => videoSize(clip().subarray(0, -1)), { code: 'INVALID_MEDIA' });
  const cloud = {
    async getTempFileURL({ fileList }) {
      assert.equal(fileList[0].fileID, 'cloud://test.bucket/square-uploads/alice/clip.mp4');
      return { fileList: [{ fileID: fileList[0].fileID, status: 0, tempFileURL: 'https://test.bucket.tcb.qcloud.la/clip' }] };
    },
    async uploadFile({ cloudPath, fileContent }) {
      assert.match(cloudPath, /^square-media\/alice\/post\/0-[a-f0-9]{24}\.mp4$/);
      assert.deepEqual(fileContent, clip());
      return { fileID: `cloud://test.bucket/${cloudPath}` };
    },
  };
  const processVideo = createSquareVideoProcessor(cloud, { read: (_, destination) => fs.writeFile(destination, clip()) });
  const result = await processVideo('cloud://test.bucket/square-uploads/alice/clip.mp4', { userId: 'alice', postId: 'post', index: 0 });
  assert.equal(result.width, 640);
  assert.equal(result.height, 360);
});

test('H.264 MOV 进入自动转换，云存储读不到文件时返回读取错误', async () => {
  const fileID = 'cloud://test.bucket/square-uploads/alice/clip.video';
  const context = { userId: 'alice', postId: 'post', index: 0 };
  const mov = clip(); mov.write('qt  ', 8);
  let conversion = 0, uploads = 0, destination;
  const cloud = {
    getTempFileURL: async () => ({ fileList: [{ fileID, code: 'SUCCESS', tempFileURL: 'https://test.bucket.tcb.qcloud.la/clip' }] }),
    uploadFile: async ({ cloudPath, fileContent }) => {
      uploads++;
      assert.deepEqual(fileContent, clip());
      return { fileID: `cloud://test.bucket/${cloudPath}` };
    },
  };
  const process = createSquareVideoProcessor(cloud, {
    async read(_, input) { destination = input; await fs.writeFile(input, mov); },
    async convert(input, output) {
      conversion++;
      assert.deepEqual(await fs.readFile(input), mov);
      await fs.writeFile(output, clip());
    },
  });
  assert.equal((await process(fileID, context)).height, 360);
  assert.equal(conversion, 1); assert.equal(uploads, 1);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  cloud.getTempFileURL = async () => ({ fileList: [{ fileID, status: -1 }] });
  await assert.rejects(process(fileID, context), { code: 'VIDEO_READ_FAILED' });
  assert.equal(conversion, 1); assert.equal(uploads, 1);
});

test('可直接换容器的 H.264 MOV 不启动完整转码器', async () => {
  const mov = clip(); mov.write('qt  ', 8);
  const fileID = 'cloud://test.bucket/square-uploads/alice/clip.video';
  const cloud = {
    getTempFileURL: async () => ({ fileList: [{ fileID, status: 0, tempFileURL: 'https://test.bucket.tcb.qcloud.la/clip' }] }),
    uploadFile: async ({ cloudPath, fileContent }) => {
      assert.deepEqual(fileContent, clip());
      return { fileID: `cloud://test.bucket/${cloudPath}` };
    },
  };
  const process = createSquareVideoProcessor(cloud, {
    read: (_, input) => fs.writeFile(input, mov),
    async remux(input, output) { assert.deepEqual(await fs.readFile(input), mov); await fs.writeFile(output, clip()); return true; },
    convert: async () => assert.fail('兼容视频不需要完整转码'),
  });
  assert.equal((await process(fileID, { userId: 'alice', postId: 'post', index: 0 })).height, 360);
});

test('兼容的 8-bit HEVC MP4 保留原始画质，其他配置继续转码', async () => {
  const config = Buffer.alloc(23 + 3 * 7);
  config[0] = 1;
  config[1] = 1;
  config[12] = 123;
  config[16] = 1;
  config[22] = 3;
  for (const [index, type] of [32, 33, 34].entries()) {
    config.set([type, 0, 1, 0, 2, type << 1, 1], 23 + index * 7);
  }
  const compatible = clip('hvc1', true, atom('hvcC', config));
  config[17] = 2;
  const incompatible = clip('hvc1', false, atom('hvcC', config));
  const fileID = 'cloud://test.bucket/square-uploads/alice/clip.video';
  const uploaded = [];
  const cloud = {
    getTempFileURL: async () => ({ fileList: [{ fileID, status: 0, tempFileURL: 'https://test.bucket.tcb.qcloud.la/clip' }] }),
    uploadFile: async ({ cloudPath, fileContent }) => {
      uploaded.push(fileContent);
      return { fileID: `cloud://test.bucket/${cloudPath}` };
    },
  };
  let input = compatible;
  let conversions = 0;
  const process = createSquareVideoProcessor(cloud, {
    read: (_, destination) => fs.writeFile(destination, input),
    async convert(_, output) { conversions++; await fs.writeFile(output, clip()); },
  });
  const context = { userId: 'alice', postId: 'post', index: 0 };
  const first = await process(fileID, context);
  assert.equal(first.width, 360);
  assert.equal(first.height, 640);
  assert.equal(conversions, 0);
  assert.deepEqual(uploaded[0], compatible);
  input = incompatible;
  await process(fileID, context);
  assert.equal(conversions, 1);
  assert.deepEqual(uploaded[1], clip());
});

test('云存储未在处理期限内响应时返回视频处理超时', async () => {
  const stalled = () => new Promise(() => {});
  const fileID = 'cloud://test.bucket/square-uploads/alice/clip.video';
  const cloud = {
    getTempFileURL: stalled,
    uploadFile: stalled,
  };
  const process = createSquareVideoProcessor(cloud, { read: (_, destination) => fs.writeFile(destination, clip()) });
  const context = () => ({ userId: 'alice', postId: 'post', index: 0, deadline: Date.now() + 300 });
  await assert.rejects(process(fileID, context()), { code: 'VIDEO_PROCESS_TIMEOUT' });
  cloud.getTempFileURL = async () => ({ fileList: [{ fileID, status: 0, tempFileURL: 'https://test.bucket.tcb.qcloud.la/clip' }] });
  let startedUpload = false;
  cloud.uploadFile = () => { startedUpload = true; return stalled(); };
  await assert.rejects(process(fileID, context()), { code: 'VIDEO_PROCESS_TIMEOUT' });
  assert.equal(startedUpload, true);
});

test('混排发布保留选择顺序，视频和封面不进个人相册，重试不重复写入且拒绝超额或伪造来源', async () => {
  let videoCalls = 0;
  const f = fixture({
    processSquareVideo: async (_, { userId, postId }) => {
      videoCalls++;
      return { width: 360, height: 640, fileID: `cloud://test.bucket/square-media/${userId}/${postId}/clip.mp4` };
    },
    processSquareImages: async (files, { userId, postId }) => files.map(file => `cloud://test.bucket/square-media/${userId}/${postId}/${file.split('/').pop()}`),
  });
  const user = await f.login();
  const source = suffix => `cloud://test.bucket/square-uploads/${user._id}/${suffix}`;
  const photo = { type: 'image', fileID: source('photo.jpg') };
  const video = { type: 'video', fileID: source('clip.mp4'), poster: source('poster.jpg') };
  const send = (media, requestId = 'post-video-request01') => f.handle({ action: 'publishSquarePost', post: { scope: 'square', content: '', media, requestId } }, f.alice);
  for (const invalid of [[video, photo, photo, video], [video, video], [{ ...video, fileID: 'https://example.test/clip.mp4' }]]) {
    assert.equal((await send(invalid)).code, 'INVALID_MEDIA');
  }
  assert.equal(videoCalls, 0);
  const sent = await send([video, photo]);
  assert.equal(sent.success, true, sent.message);
  const post = sent.square.post;
  assert.equal(post.media[0].type, 'video'); assert.equal(post.media[1].fileID, post.images[0]);
  assert.equal(post.media[0].height, 640); assert.equal(post.mediaSources, undefined);
  assert.ok(!JSON.stringify(post).includes('square-uploads'));
  assert.equal((await send([video, photo])).square.post._id, post._id);
  assert.equal((await send([photo, video])).code, 'REQUEST_CONFLICT');
  assert.equal(videoCalls, 1);
  const detail = await f.handle({ action: 'getSquarePost', postId: post._id }, f.alice);
  assert.deepEqual(detail.square.post.media, post.media);
  const status = { action: 'getSquarePublication', requestId: 'post-video-request01' };
  assert.deepEqual((await f.handle(status, f.alice)).square.post.media, post.media);
  await f.login(f.bob);
  assert.equal((await f.handle(status, f.bob)).square.post, null);
  const album = await f.handle({ action: 'listSquareAlbum' }, f.alice);
  assert.deepEqual(album.square.items.map(item => item.fileID), post.images);
  assert.equal((await send([video], 'post-video-request02')).success, true);
});
