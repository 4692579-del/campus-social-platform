const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/certification-fixture');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createUserService } = require('../cloudfunctions/userService/service');
const publish = (f, content = '今天也有值得分享的小事。', identity = f.alice, requestId = 'post-request-00000001') =>
  f.handle({ action: 'publishSquarePost', post: { scope: 'square', content, requestId } }, identity);
const reaction = (f, id, active = true, kind = 'like', identity = f.alice) =>
  f.handle({ action: 'setSquareReaction', postId: id, kind, active }, identity);

test('真实云函数入口兼容微信自动附带的userInfo，发帖回复仍使用可信上下文身份', async () => {
  const f = fixture(); const alice = await f.login(); await f.login(f.bob);
  const context = { exports: {}, process: { env: {} }, require: name => name === './service' ? { createUserService } : name === './content-check' ? require('../cloudfunctions/userService/content-check') : name === './deepseek' ? require('../cloudfunctions/userService/deepseek') : name === './ai-images' ? require('../cloudfunctions/userService/ai-images') : name === './ai-compose-images' ? require('../cloudfunctions/userService/ai-compose-images') : name === './square-images' ? require('../cloudfunctions/userService/square-images') : {
    init() {}, database: () => f.db, getWXContext: () => ({ OPENID: f.alice.openid, ENV: f.alice.env }),
    openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/userService/index.js'), 'utf8'), context);
  const injected = { appId: 'runtime-app', openId: f.bob.openid };
  const result = await context.exports.main({ action: 'publishSquarePost', post: { scope: 'square', content: '你好呀', requestId: 'runtime-request-00001' },
    userInfo: injected, wxCloudApiToken: 'synthetic-runtime-metadata', platformMetadata: { opaque: true } });
  assert.equal(result.success, true, result.message);
  assert.equal(f.squarePosts.get(result.square.post._id).authorId, alice._id);
  const reply = await context.exports.main({ action: 'publishSquareReply', post: { scope: 'square', postId: result.square.post._id,
    content: '真实云端回复', requestId: 'runtime-reply-0000001' }, userInfo: injected, wxCloudApiToken: 'synthetic-runtime-metadata' });
  assert.equal(reply.success, true, reply.message);
  assert.equal([...f.squareReplies.values()][0].authorId, alice._id);
  const invalid = await context.exports.main({ action: 'publishSquarePost', post: { scope: 'campus', content: '不能跨板块', requestId: 'runtime-invalid-0001' }, userInfo: injected });
  assert.equal(invalid.code, 'INVALID_POST');
  const spoof = await context.exports.main({ action: 'publishSquarePost', post: { scope: 'square', authorId: 'bob', content: '不能伪造作者', requestId: 'runtime-spoof-000001' }, userInfo: injected });
  assert.equal(spoof.code, 'INVALID_POST');
});

test('真实入口将已发布配图通过云SDK接入Flash识图，身份仍取可信上下文', async () => {
  const f = fixture(); const alice = await f.login();
  const published = await publish(f), id = published.square.post._id;
  const image = `cloud://test.bucket/square-media/${alice._id}/${id}/0-${'a'.repeat(24)}.jpg`;
  f.squarePosts.get(id).images = [image];
  const calls = [], imageURL = 'https://test.bucket.tcb.qcloud.la/synthetic.jpg?sign=synthetic';
  const cloud = { init() {}, database: () => f.db, getWXContext: () => ({ OPENID: f.alice.openid, ENV: f.alice.env }),
    getTempFileURL: async args => { calls.push(args); return { fileList: [{ fileID: image, status: 0, tempFileURL: imageURL }] }; },
    openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } } };
  const context = { exports: {}, process: { env: {} }, require: name => {
    if (name === 'wx-server-sdk') return cloud;
    if (name === './deepseek') return { createDeepseek: () => async (input, attachments) => {
      assert.equal(input.imageCount, 1); assert.deepEqual(attachments.images, [imageURL]); return '图中是一份食堂菜单。';
    } };
    return require('../cloudfunctions/userService/' + name.slice(2));
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/userService/index.js'), 'utf8'), context);
  const question = await context.exports.main({ action: 'publishSquareReply', post: { scope: 'square', postId: id,
    content: '@小萃 图中是什么？', askAI: true, requestId: 'runtime-vision-question-001' } });
  assert.equal(question.success, true, question.message);
  const result = await context.exports.main({ action: 'processSquareAIReply', postId: id, replyId: question.square.reply._id });
  assert.equal(result.success, true, result.message); assert.equal(result.square.status, 'done');
  assert.equal(result.square.reply.content, '图中是一份食堂菜单。'); assert.equal(calls.length, 1);
});

test('真实入口发布仅图片文案经私有下载校验、短效地址、图文模型和文字审核，不公开图片', async () => {
  const f = fixture(); const alice = await f.login();
  const image = `cloud://test.bucket/square-uploads/${alice._id}/photo.png`;
  const imageURL = 'https://test.bucket.tcb.qcloud.la/private-photo.png?sign=synthetic';
  const reads = [], checks = [];
  const cloud = { init() {}, database: () => f.db, getWXContext: () => ({ OPENID: f.alice.openid, ENV: f.alice.env }),
    downloadFile: async args => { reads.push(args.fileID); return { fileContent: Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(40)]) }; },
    getTempFileURL: async args => { assert.equal(args.fileList[0].maxAge, 120); return { fileList: [{ fileID: image, status: 0, tempFileURL: imageURL }] }; },
    uploadFile: () => assert.fail('识图不得公开未发布图片'),
    openapi: { security: { msgSecCheck: async args => { checks.push(args); return { result: { suggest: 'pass' } }; } } } };
  const context = { exports: {}, process: { env: {} }, require: name => {
    if (name === 'wx-server-sdk') return cloud;
    if (name === './deepseek') return { createDeepseek: options => async (input, attachments) => {
      assert.equal(options.purpose, 'polish'); assert.equal(input.content, ''); assert.equal(input.imageCount, 1);
      assert.deepEqual(attachments.images, [imageURL]); return '把好心情装进镜头里。';
    } };
    return require('../cloudfunctions/userService/' + name.slice(2));
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/userService/index.js'), 'utf8'), context);
  const result = await context.exports.main({ action: 'optimizeSquareContent', content: '', images: [image], userInfo: { openId: 'forged' } });
  assert.equal(result.success, true, result.message); assert.equal(result.square.content, '把好心情装进镜头里。');
  assert.deepEqual(reads, [image]); assert.equal(checks.length, 1); assert.equal(f.squarePosts.size, 0);
  assert.ok(!/https|sign=|photo.png/.test(JSON.stringify(result)));
});

test('未认证普通用户可发布广场文字；真实身份绑定、服务器归属及展示字段受控', async () => {
  const f = fixture();
  const user = await f.login();
  const result = await publish(f);
  assert.equal(result.success, true);
  assert.equal(result.square.post.author.verified, false);
  assert.equal(result.square.post.author.accountId, user.accountId);
  assert.equal(result.square.post.likeCount, 0);
  assert.equal(f.squarePosts.size, 1);
  const record = [...f.squarePosts.values()][0];
  assert.equal(record.authorId, user._id);
  assert.equal(record.scope, 'square');
  assert.equal(result.square.post.openid, undefined);
  assert.equal(result.square.post.authorId, undefined);
  for (const extra of [{ scope: 'campus' }, { authorId: 'other' }, { likeCount: 99 }, { schoolId: 'school' }, { openid: 'bob' }]) {
    assert.equal((await f.handle({ action: 'publishSquarePost', post: { scope: 'square', content: '不能伪造', requestId: 'post-request-spoof01', ...extra } }, f.alice)).code, 'INVALID_POST');
  }
});

test('游客只读浏览；未注册、停用账号不能发布或互动，角色撤回后仍可使用广场', async () => {
  const f = fixture();
  assert.equal((await publish(f)).code, 'NOT_REGISTERED');
  const user = await f.login();
  const { square } = await publish(f);
  const guest = await f.handle({ action: 'listSquarePosts' }, f.bob);
  assert.equal(guest.square.items.length, 1);
  assert.equal((await reaction(f, square.post._id, true, 'like', f.bob)).code, 'NOT_REGISTERED');
  f.users.get(user._id).status = 'banned';
  assert.equal((await publish(f, '被停用')).code, 'ACCOUNT_DISABLED');
  assert.equal((await reaction(f, square.post._id)).code, 'ACCOUNT_DISABLED');
  Object.assign(f.users.get(user._id), { status: 'active', role: 'user', certificationStatus: 'unverified', schoolId: '' });
  assert.equal((await publish(f, '撤回认证后依旧能发布', f.alice, 'post-request-next001')).success, true);
});

test('并发及重试发布只产生一条动态，相同提交标识不得更换内容', async () => {
  const f = fixture(); await f.login();
  const results = await Promise.all(Array.from({ length: 5 }, () => publish(f)));
  assert.ok(results.every(result => result.success));
  assert.equal(new Set(results.map(result => result.square.post._id)).size, 1);
  assert.equal(f.squarePosts.size, 1);
  assert.equal((await publish(f, '重试中换掉内容')).code, 'REQUEST_CONFLICT');
});

test('内容声明严格校验并真实保存，重试不能更换声明；广场、本人列表和详情读取一致', async () => {
  const f = fixture(); await f.login();
  for (const declaration of ['ai', 'opinion', 'repost', 'fiction', 'marketing', 'none']) {
    const post = { scope: 'square', content: '声明不混进正文', requestId: `declaration-${declaration}-request001`, declaration };
    const first = await f.handle({ action: 'publishSquarePost', post }, f.alice);
    assert.equal(first.success, true, first.message);
    const id = first.square.post._id;
    assert.equal(f.squarePosts.get(id).declaration, declaration); assert.equal(f.squarePosts.get(id).content, post.content);
    const retry = await f.handle({ action: 'publishSquarePost', post }, f.alice);
    assert.equal(retry.square.post._id, id);
    const conflict = await f.handle({ action: 'publishSquarePost', post: { ...post, declaration: declaration === 'ai' ? 'none' : 'ai' } }, f.alice);
    assert.equal(conflict.code, 'REQUEST_CONFLICT');
    for (const args of [{ action: 'listSquarePosts' }, { action: 'listSquarePosts', mine: true }, { action: 'getSquarePost', postId: id }]) {
      const result = await f.handle(args, f.alice);
      const row = result.square.post || result.square.items.find(row => row._id === id);
      assert.equal(row.declaration, declaration);
    }
  }
  for (const declaration of [null, 1, {}, [], 'other', '内容由AI生成']) {
    const result = await f.handle({ action: 'publishSquarePost', post: { scope: 'square', content: '拒绝伪造', requestId: 'declaration-invalid001', declaration } }, f.alice);
    assert.equal(result.code, 'INVALID_POST');
  }
  const legacy = await publish(f);
  delete f.squarePosts.get(legacy.square.post._id).declaration;
  assert.equal((await publish(f)).success, true);
  assert.equal((await f.handle({ action: 'getSquarePost', postId: legacy.square.post._id }, f.alice)).square.post.declaration, 'none');
  const reply = await f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId: legacy.square.post._id, content: '评论没有声明选项', requestId: 'declaration-reply001', declaration: 'ai' } }, f.alice);
  assert.equal(reply.code, 'INVALID_POST');
});

test('个人动态从可信账号筛选、按时间分页，隐藏内容及其他作者不会混入', async () => {
  const f = fixture(); const alice = await f.login(); await f.login(f.bob);
  for (let i = 0; i < 23; i++) {
    const result = await publish(f, `本人动态${i}`, f.alice, `profile-request-${String(i).padStart(4, '0')}`);
    f.squarePosts.get(result.square.post._id).sortKey = String(i).padStart(4, '0');
  }
  await publish(f, '另一位同学的动态', f.bob, 'profile-bob-00000001');
  const hidden = [...f.squarePosts.values()].find(row => row.content === '本人动态22'); hidden.status = 'hidden';
  const campus = [...f.squarePosts.values()].find(row => row.content === '本人动态21'); campus.scope = 'campus';
  const first = await f.handle({ action: 'listSquarePosts', mine: true, authorId: 'bob', userId: 'bob' }, f.alice);
  assert.equal(first.success, true); assert.equal(first.square.mine, true);
  assert.equal(first.square.items.length, 20); assert.equal(first.square.hasMore, true);
  assert.equal(first.square.total, 21);
  assert.equal(first.square.items[0].content, '本人动态20');
  assert.ok(first.square.items.every(post => post.author.accountId === alice.accountId));
  const second = await f.handle({ action: 'listSquarePosts', mine: true, offset: first.square.nextOffset }, f.alice);
  assert.equal(second.square.items.length, 1); assert.equal(second.square.items[0].content, '本人动态0');
  assert.equal(second.square.hasMore, false);
  assert.equal(f.queries.filter(query => query.name === 'square_posts').at(-1).condition.authorId, alice._id);
  const guest = { openid: 'unregistered', env: 'test' };
  assert.equal((await f.handle({ action: 'listSquarePosts', mine: true }, guest)).code, 'NOT_REGISTERED');
  assert.equal((await f.handle({ action: 'listSquarePosts' }, guest)).success, true);
});

test('内容长度、文字校验拒绝和服务异常均不写入动态', async () => {
  const f = fixture(); await f.login();
  for (const content of ['', '   ', '字'.repeat(151), '非法\u0001字符']) assert.equal((await publish(f, content)).code, 'INVALID_POST');
  const rejected = fixture({ checkText: async () => false }); await rejected.login();
  assert.equal((await publish(rejected)).code, 'CONTENT_REJECTED');
  assert.equal(rejected.squarePosts.size, 0);
  const failed = fixture({ checkText: async () => { throw new Error('timeout'); } }); await failed.login();
  assert.equal((await publish(failed)).code, 'CONTENT_CHECK_UNAVAILABLE');
  assert.equal(failed.squarePosts.size, 0);
});

test('动态150字包含空格、换行和标点且不按UTF16拆分表情，回复单独限制50字', async () => {
  const f = fixture(); await f.login();
  for (const [index, content] of ['字'.repeat(149) + '！', '😊'.repeat(150), '字'.repeat(148) + ' \n'].entries()) {
    const result = await publish(f, content, f.alice, `length-valid-request${index}`);
    assert.equal(result.success, true, result.message);
  }
  for (const content of ['字'.repeat(150) + '！', '字'.repeat(150) + ' ', '\n' + '字'.repeat(150), '😊'.repeat(151)]) {
    assert.equal((await publish(f, content)).code, 'INVALID_POST');
  }
  const id = (await publish(f)).square.post._id;
  const reply = await f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId: id, content: '回'.repeat(50), requestId: 'reply-length-500001' } }, f.alice);
  assert.equal(reply.success, true, reply.message);
  for (const content of ['😊'.repeat(51), '回'.repeat(50) + ' ', '\n' + '回'.repeat(50)]) {
    assert.equal((await f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId: id, content, requestId: 'reply-over-limit-0001' } }, f.alice)).code, 'INVALID_POST');
  }
});

test('点赞采用目标状态，重复和并发请求不会虚增计数，可取消', async () => {
  const f = fixture(); await f.login();
  const id = (await publish(f)).square.post._id;
  const results = await Promise.all(Array.from({ length: 5 }, () => reaction(f, id)));
  assert.ok(results.every(result => result.success));
  assert.equal(f.squarePosts.get(id).likeCount, 1);
  assert.equal((await reaction(f, id, false)).square.post.likeCount, 0);
  assert.equal((await reaction(f, id, false)).square.post.likeCount, 0);
  await f.login(f.bob);
  await reaction(f, id, true, 'like', f.bob);
  const guest = await f.handle({ action: 'getSquarePost', postId: id }, f.bob);
  assert.equal(guest.square.post.liked, false);
  const signedIn = await f.handle({ action: 'getSquarePost', postId: id, personalize: true }, f.bob);
  assert.equal(signedIn.square.post.liked, true);
});

test('转发接口已禁用，历史计数不再展示或被修改，点赞不受影响', async () => {
  const f = fixture(); await f.login();
  const id = (await publish(f)).square.post._id;
  f.squarePosts.get(id).repostCount = 3;
  assert.equal((await reaction(f, id, true, 'repost')).code, 'INVALID_POST');
  assert.equal((await reaction(f, id, false, 'repost')).code, 'INVALID_POST');
  assert.equal(f.squareInteractions.size, 0);
  assert.equal(f.squarePosts.get(id).repostCount, 3);
  const liked = await reaction(f, id);
  assert.equal(liked.square.post.likeCount, 1);
  assert.equal(liked.square.post.repostCount, 0);
  assert.equal(liked.square.post.reposted, false);
});

test('回复与计数同时提交、重试不重复；失败事务不留下半条回复或错误数量', async () => {
  const f = fixture(); await f.login();
  const id = (await publish(f)).square.post._id;
  const input = { action: 'publishSquareReply', post: { scope: 'square', postId: id, content: '这是一条真实回复', requestId: 'reply-request-000001' } };
  const results = await Promise.all([f.handle(input, f.alice), f.handle(input, f.alice)]);
  assert.ok(results.every(result => result.success));
  assert.equal(f.squareReplies.size, 1);
  assert.equal(f.squarePosts.get(id).replyCount, 1);
  assert.equal((await f.handle({ action: 'listSquareReplies', postId: id }, f.bob)).square.items[0].content, input.post.content);
  const failed = fixture({ failCollection: 'square_replies' }); await failed.login();
  const parent = (await publish(failed)).square.post._id;
  assert.equal((await failed.handle({ ...input, post: { ...input.post, postId: parent } }, failed.alice)).success, false);
  assert.equal(failed.squareReplies.size, 0);
  assert.equal(failed.squarePosts.get(parent).replyCount, 0);
});

test('预览截取280字，详情展示全文；认证徽章随作者实际状态变化，非广场及隐藏动态不外泄', async () => {
  const f = fixture(); const user = await f.login();
  const content = '😊'.repeat(400), id = (await publish(f, '旧版已发布动态')).square.post._id;
  f.squarePosts.get(id).content = content;
  const preview = (await f.handle({ action: 'listSquarePosts' }, f.bob)).square.items[0];
  assert.equal(Array.from(preview.content).length, 280);
  assert.equal(preview.truncated, true);
  assert.equal((await f.handle({ action: 'getSquarePost', postId: id }, f.bob)).square.post.content, content);
  Object.assign(f.users.get(user._id), { role: 'student', schoolId: 'real-school', certificationStatus: 'approved' });
  assert.equal((await f.handle({ action: 'getSquarePost', postId: id }, f.bob)).square.post.author.verified, true);
  f.users.get(user._id).certificationStatus = 'unverified';
  assert.equal((await f.handle({ action: 'getSquarePost', postId: id }, f.bob)).square.post.author.verified, false);
  f.squarePosts.get(id).scope = 'campus';
  assert.equal((await f.handle({ action: 'listSquarePosts' }, f.bob)).square.items.length, 0);
  assert.equal((await f.handle({ action: 'getSquarePost', postId: id }, f.bob)).code, 'POST_NOT_FOUND');
  assert.equal((await reaction(f, id)).code, 'POST_NOT_FOUND');
});

test('动态操作菜单使用可信归属；只允许本人删除，重复删除幂等且内容和回复不再公开', async () => {
  const f = fixture(); await f.login(); await f.login(f.bob);
  const id = (await publish(f)).square.post._id;
  const own = await f.handle({ action: 'getSquarePost', postId: id, personalize: true }, f.alice);
  const other = await f.handle({ action: 'getSquarePost', postId: id, personalize: true }, f.bob);
  assert.equal(own.square.post.isOwn, true); assert.equal(other.square.post.isOwn, false);
  assert.equal((await f.handle({ action: 'deleteSquarePost', postId: id, userId: own._id, isOwn: true }, f.bob)).code, 'FORBIDDEN');
  await f.handle({ action: 'publishSquareReply', post: { postId: id, scope: 'square', content: '一条评论', requestId: 'before-delete-000001' } }, f.bob);
  for (let i = 0; i < 2; i++) assert.equal((await f.handle({ action: 'deleteSquarePost', postId: id }, f.alice)).square.deletedId, id);
  assert.equal(f.squarePosts.get(id).status, 'deleted');
  assert.equal((await f.handle({ action: 'listSquarePosts' }, f.bob)).square.items.length, 0);
  for (const action of ['getSquarePost', 'listSquareReplies']) assert.equal((await f.handle({ action, postId: id }, f.bob)).code, 'POST_NOT_FOUND');
  assert.equal((await reaction(f, id)).code, 'POST_NOT_FOUND');
  assert.equal((await publish(f)).code, 'POST_NOT_FOUND');
  assert.equal(f.squarePosts.get(id).status, 'deleted');
});

test('举报真实保存待处理原因和内容，同人重复提交不重复建档，自己及不可见动态不能举报', async () => {
  const f = fixture(); const alice = await f.login(); const bob = await f.login(f.bob);
  const id = (await publish(f)).square.post._id;
  assert.equal((await f.handle({ action: 'reportSquarePost', postId: id, reason: 'spam' }, f.alice)).code, 'FORBIDDEN');
  assert.equal((await f.handle({ action: 'reportSquarePost', postId: id, reason: 'untrusted' }, f.bob)).code, 'INVALID_POST');
  const reports = await Promise.all(Array.from({ length: 3 }, () => f.handle({ action: 'reportSquarePost', postId: id, reason: 'spam', reporterId: alice._id, status: 'approved' }, f.bob)));
  assert.ok(reports.every(result => result.success));
  assert.equal(f.squareReports.size, 1);
  const saved = [...f.squareReports.values()][0];
  assert.equal(saved.reporterId, bob._id); assert.equal(saved.authorId, alice._id);
  assert.equal(saved.reason, 'spam'); assert.equal(saved.status, 'pending'); assert.equal(saved.postContent, f.squarePosts.get(id).content);
  assert.equal(reports.filter(result => result.square.alreadyReported).length, 2);
  assert.equal(f.squarePosts.get(id).status, 'published');
  f.squarePosts.get(id).status = 'hidden';
  assert.equal((await f.handle({ action: 'reportSquarePost', postId: id, reason: 'other' }, f.bob)).code, 'POST_NOT_FOUND');
});

test('动态分享接口已移除，不再创建分享记录或返回分享计数', async () => {
  const f = fixture(); await f.login();
  const id = (await publish(f)).square.post._id;
  assert.equal((await f.handle({ action: 'recordSquareShare', postId: id, requestId: 'removed-share-00001' }, f.alice)).code, 'INVALID_ACTION');
  assert.equal(f.squareInteractions.size, 0);
  assert.equal(f.squarePosts.get(id).shareCount, undefined);
  f.squarePosts.get(id).shareCount = 7;
  assert.equal((await f.handle({ action: 'getSquarePost', postId: id }, f.alice)).square.post.shareCount, undefined);
});

test('删除和举报遇到账号失效或写入失败不提示成功、不留下部分更改', async () => {
  const f = fixture(); const alice = await f.login(); await f.login(f.bob);
  const id = (await publish(f)).square.post._id;
  f.hooks.beforeTransaction = () => { f.users.get(alice._id).status = 'banned'; };
  assert.equal((await f.handle({ action: 'deleteSquarePost', postId: id }, f.alice)).code, 'ACCOUNT_DISABLED');
  assert.equal(f.squarePosts.get(id).status, 'published');
  const failed = fixture({ failCollection: 'square_reports' }); await failed.login(); await failed.login(failed.bob);
  const failedId = (await publish(failed)).square.post._id;
  assert.equal((await failed.handle({ action: 'reportSquarePost', postId: failedId, reason: 'abuse' }, failed.bob)).success, false);
  assert.equal(failed.squareReports.size, 0);
});


test('普通及楼中回复按50个码点限制，空格换行计入，@小萃前缀也计入', async () => {
  const f = fixture(); await f.login(); const id = (await publish(f)).square.post._id;
  const send = (content, requestId, extra = {}) => f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId: id, content, requestId, ...extra } }, f.alice);
  const root = await send('😊'.repeat(50), 'comment-emoji-limit-01'); assert.equal(root.success, true);
  const rootId = root.square.reply._id;
  const child = await send('回'.repeat(50), 'comment-child-limit-01', { replyToId: rootId }); assert.equal(child.success, true);
  for (const [i, content] of ['😊'.repeat(51), '字'.repeat(50) + ' ', '\n' + '字'.repeat(50), '@小萃 ' + '问'.repeat(47)].entries()) {
    for (const nested of [false, true]) assert.equal((await send(content, 'comment-over-limit-' + i + '-' + nested, nested ? { replyToId: rootId } : {})).code, 'INVALID_POST');
  }
  assert.equal((await send('@小萃 ' + '问'.repeat(46), 'comment-ai-limit-001', { askAI: true })).success, true);
});
