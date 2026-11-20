const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture(options = {}) {
  let user = { _id: 'alice' }, version = 0, serial = 0;
  const calls = [], uploads = [], previews = [];
  const users = { getCachedUser: () => user, getSessionVersion: () => version };
  const wx = { cloud: {
    uploadFile: async args => { uploads.push(args); return options.upload ? options.upload(args) : { fileID: 'cloud://test.bucket/' + args.cloudPath }; },
    getTempFileURL: async ({ fileList }) => { calls.push(['getTempFileURL', fileList]); return { fileList: fileList.map(fileID => ({ fileID, status: 0, tempFileURL: 'https://image.test/' + fileID.split('/').pop() })) }; },
    deleteFile: async args => calls.push(['deleteFile', args]),
  } };
  const results = { showActionSheet: { tapIndex: options.camera ? 1 : 0 },
    chooseMedia: { tempFiles: [{ tempFilePath: '/tmp/photo.jpg', size: 100 }] },
    getImageInfo: { type: 'jpeg', width: options.large ? 4000 : 1200, height: 1200 },
    compressImage: { tempFilePath: '/tmp/compressed.jpg' }, getFileInfo: { size: 100 } };
  for (const name of [...Object.keys(results), 'previewImage']) wx[name] = args => {
    calls.push([name, args]);
    if (name === 'previewImage') previews.push(args);
    args.success(results[name] || {});
  };
  const context = { module: { exports: {} }, wx, require: name => name === './user' ? users : { token: () => `photo_${++serial}` } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/services/post-images.js'), 'utf8'), context);
  return { service: context.module.exports, calls, uploads, previews, wx, setUser(value) { user = value; version++; } };
}
const image = (key = 'one') => ({ key, path: '/tmp/' + key + '.jpg', type: 'jpg', fileID: '' });

test('原生选图明确支持相册和拍照，数量只使用剩余位置，大图先压缩', async () => {
  for (const camera of [false, true]) {
    const f = fixture({ camera, large: true });
    const images = await f.service.chooseImages(2);
    const args = f.calls.find(([name]) => name === 'chooseMedia')[1];
    assert.equal(args.count, 2); assert.equal(args.sourceType[0], camera ? 'camera' : 'album'); assert.equal(args.mediaType[0], 'image');
    assert.equal(images[0].path, '/tmp/compressed.jpg'); assert.equal(images[0].type, 'jpg');
    assert.equal(f.calls.find(([name]) => name === 'compressImage')[1].compressedWidth, 2048);
    assert.equal((await f.service.chooseImages(0)).length, 0);
  }
});

test('部分上传失败保留完成结果，重试仅上传剩余图片，不超过九张', async () => {
  let fail = true;
  const f = fixture({ upload: async args => { if (args.cloudPath.includes('/two.') && fail) throw new Error('offline'); return { fileID: 'cloud://test.bucket/' + args.cloudPath }; } });
  const files = [image('one'), image('two')];
  await assert.rejects(f.service.uploadImages(files, (index, fileID) => { files[index].fileID = fileID; }), /offline/);
  assert.match(files[0].fileID, /square-uploads\/alice\/one.jpg$/); assert.equal(files[1].fileID, '');
  fail = false;
  const result = await f.service.uploadImages(files);
  assert.equal(result.length, 2); assert.equal(f.uploads.length, 3);
  await assert.rejects(f.service.uploadImages(Array.from({ length: 10 }, () => image())), /最多发布 9/);
  assert.equal(f.uploads.length, 3);
});

test('上传迟到响应不能写入新账号；预览解析云文件并复用缓存，清理只删除本人暂存文件', async () => {
  let finish;
  const f = fixture({ upload: () => new Promise(resolve => { finish = resolve; }) });
  let patched = false;
  const pending = f.service.uploadImages([image()], () => { patched = true; });
  f.setUser({ _id: 'bob' }); finish({ fileID: 'cloud://test.bucket/square-uploads/alice/one.jpg' });
  await assert.rejects(pending, error => error.code === 'SESSION_CHANGED'); assert.equal(patched, false);
  const files = ['cloud://test.bucket/square-media/alice/a.jpg', 'cloud://test.bucket/square-media/alice/b.jpg'];
  await f.service.previewImages(files, files[1]);
  assert.equal(f.previews[0].urls.length, 2); assert.equal(f.previews[0].current, 'https://image.test/b.jpg');
  await f.service.previewImages(files, files[0]);
  assert.equal(f.calls.filter(([name]) => name === 'getTempFileURL').length, 1);
  await f.service.discardUploads([...files, 'cloud://test.bucket/square-uploads/alice/one.jpg', 'cloud://test.bucket/square-uploads/bob/two.jpg']);
  const deleted = f.calls.find(([name]) => name === 'deleteFile')[1].fileList;
  assert.equal(deleted.length, 1); assert.match(deleted[0], /bob\/two.jpg$/);
});

test('图片轮播预览使用当前动态全部图片与点击位置，预览期间不能重复调用，也不触发详情跳转', async () => {
  let definition, finish;
  const previews = [], events = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/components/square-post/index.js'), 'utf8'), {
    Component: value => { definition = value; }, require: name => name.includes('post-image-layout') ? require('../miniprogram/utils/post-image-layout') : ({ previewImages: (...args) => { previews.push(args); return new Promise(resolve => { finish = resolve; }); } }), wx: { showToast() {} },
  });
  const files = ['cloud://test.bucket/a.jpg', 'cloud://test.bucket/b.jpg'];
  const component = { ...definition.methods, data: { post: { _id: 'post', images: files }, imageIndex: 0 }, setData(values) { Object.assign(this.data, values); }, triggerEvent: (...args) => events.push(args) };
  component.imageChanged({ detail: { current: 1 } }); assert.equal(component.data.imageIndex, 1);
  const event = { currentTarget: { dataset: { index: 1 } } };
  const pending = component.previewImage(event); await component.previewImage(event);
  assert.equal(previews.length, 1); assert.equal(previews[0][0], files); assert.equal(previews[0][1], files[1]);
  assert.equal(events.length, 0); finish(); await pending;
});

test('图文卡片往返页面与大图预览时不重建图片，保留当前图片和展开正文，同组图片更新不复位', () => {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/components/square-post/index.js'), 'utf8'), {
    Component: value => { definition = value; }, require: () => require('../miniprogram/utils/post-image-layout'), wx: {},
  });
  const post = { _id: 'first', content: '真实正文', author: { nickname: '真实用户' }, images: ['one', 'two', 'three'] };
  const changes = [];
  const c = { ...definition.methods, data: { ...structuredClone(definition.data), post },
    setData(values) { changes.push(values); Object.assign(this.data, values); } };
  definition.observers['post._id'].call(c, post._id);
  definition.observers['post.images'].call(c, post.images);
  c.toggleExpanded(); c.imageChanged({ detail: { current: 2 } });
  const originalPost = c.data.post, originalFiles = c.data.imageFiles, initialChanges = changes.length;
  for (let i = 0; i < 20; i++) {
    definition.pageLifetimes.hide.call(c);
    // 隐藏和显示只标记生命周期，不写入视图或替换轮播节点。
    c.imageChanged({ detail: { current: 0 } }); assert.equal(c.data.imageIndex, 2);
    definition.observers['post._id'].call(c, post._id);
    definition.observers['post.images'].call(c, [...post.images]);
    assert.equal(c.data.expanded, true); assert.equal(c.data.imageIndex, 2);
    definition.pageLifetimes.show.call(c);
    assert.equal(c.data.imageFiles, originalFiles); assert.equal(c.data.post, originalPost);
    assert.equal(c.data.post.content, '真实正文'); assert.equal(c.data.post.author.nickname, '真实用户');
  }
  assert.equal(changes.length, initialChanges);
  c.imageChanged({ detail: { current: 9 } }); assert.equal(c.data.imageIndex, 2);
  definition.observers['post.images'].call(c, ['three', 'two', 'one']);
  assert.deepEqual(Array.from(c.data.imageFiles), ['three', 'two', 'one']);
  assert.notEqual(c.data.imageFiles, originalFiles); assert.equal(c.data.imageIndex, 2);
  definition.observers['post.images'].call(c, []); assert.equal(c.data.imageFiles.length, 0);
  assert.equal(c.data.imageIndex, 0);
  definition.observers['post.images'].call(c, ['one']); assert.equal(c.data.imageIndex, 0);
  definition.observers['post._id'].call(c, 'other'); assert.equal(c.data.expanded, false);
  definition.lifetimes.detached.call(c); const count = changes.length;
  definition.pageLifetimes.hide.call(c); definition.pageLifetimes.show.call(c); c.imageChanged({ detail: { current: 1 } });
  assert.equal(changes.length, count);
});

test('图片存储规则保留头像公开读取，限制原件为创建者访问，禁止客户端写公开成品及认证材料', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/square-images-storage.rules.json'), 'utf8'));
  assert.deepEqual(rules, JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/certification-storage.rules.json'), 'utf8')));
  const allow = (action, file, creator, viewer) => Boolean(vm.runInNewContext(rules[action], { resource: { path: file, openid: creator }, auth: { openid: viewer, uid: viewer } }));
  assert.equal(allow('read', 'square-media/alice/post/one.jpg', 'server', 'guest'), true);
  assert.equal(allow('write', 'square-media/alice/post/one.jpg', 'alice', 'alice'), false);
  assert.equal(allow('read', 'square-uploads/alice/one.jpg', 'alice', 'alice'), true);
  assert.equal(allow('write', 'square-uploads/alice/one.jpg', 'alice', 'alice'), true);
  assert.equal(allow('read', 'square-uploads/alice/one.jpg', 'alice', 'bob'), false);
  assert.equal(allow('write', 'square-uploads/alice/one.jpg', 'alice', 'bob'), false);
  for (const action of ['read', 'write']) assert.equal(allow(action, 'certification-proofs/alice/proof.png', 'alice', 'alice'), false);
  assert.equal(allow('read', 'avatars/alice/avatar.jpg', 'alice', 'bob'), true);
  assert.equal(allow('write', 'avatars/alice/avatar.jpg', 'alice', 'bob'), false);
});
