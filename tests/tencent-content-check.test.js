const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTextChecker } = require('../cloudfunctions/userService/content-check');
const { checkUnavailableMessage } = require('../cloudfunctions/userService/wechat-content-check');
const { fixture: serviceFixture } = require('./helpers/certification-fixture');
function fixture(options = {}) {
  const env = { TEXT_CHECK_PROVIDER: 'tencent_tms', TMS_SECRET_ID: 'synthetic-secret-id', TMS_SECRET_KEY: 'synthetic-secret-key', TMS_BIZ_TYPE: 'campus_social_text', ...options.env };
  const calls = []; let cloudCalls = 0, destroyed = 0;
  const request = (url, config, callback) => {
    const req = new EventEmitter(); req.destroy = () => { destroyed++; };
    req.end = body => {
      calls.push({ url, config, body });
      queueMicrotask(() => {
        if (options.networkError) { req.emit('error', new Error('secret and private content')); return; }
        if (options.hang) return;
        const response = new EventEmitter(); response.statusCode = options.status || 200; response.setEncoding = () => {};
        callback(response);
        if (options.aborted) { response.emit('aborted'); return; }
        const result = options.result ? options.result() : { Response: { Suggestion: 'Pass', RequestId: 'test-request' } };
        response.emit('data', options.raw === undefined ? JSON.stringify(result) : options.raw);
        response.emit('end');
      });
    };
    return req;
  };
  const check = createTextChecker({ getEnv: () => env, request, now: () => 1795132800000, timeoutMs: 10,
    getSecret: () => '', cloudCheck: async () => { cloudCalls++; throw { errCode: 45009 }; } });
  return { check, calls, env, cloudCalls: () => cloudCalls, destroyed: () => destroyed };
}

test('腾讯云请求按UTF8/Base64送审，固定端点与版本，TC3签名符合独立Python计算的固定向量', async () => {
  const f = fixture(); assert.equal(await f.check('你好，😀', 'private-openid'), true);
  const { url, config, body } = f.calls[0];
  assert.equal(url, 'https://tms.tencentcloudapi.com/'); assert.equal(config.method, 'POST');
  assert.deepEqual(JSON.parse(body), { Content: '5L2g5aW977yM8J+YgA==', BizType: 'campus_social_text', Type: 'TEXT', SourceLanguage: 'zh' });
  assert.equal(Buffer.from(JSON.parse(body).Content, 'base64').toString('utf8'), '你好，😀');
  assert.equal(config.headers['X-TC-Version'], '2020-12-29'); assert.equal(config.headers['X-TC-Region'], 'ap-guangzhou');
  assert.equal(config.headers['Content-Length'], Buffer.byteLength(body));
  assert.equal(config.headers.Authorization, 'TC3-HMAC-SHA256 Credential=synthetic-secret-id/2026-11-20/tms/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=da24de555f03adcf43c8f7050bcea658924acbd11120843c3abdc80de516dfb9');
  assert.doesNotMatch(body, /private-openid|synthetic-secret/); assert.equal(f.cloudCalls(), 0);
  f.env.TMS_SECRET_ID = 'rotated-id'; f.env.TMS_SECRET_KEY = 'rotated-key';
  await f.check('轮换后'); assert.match(f.calls[1].config.headers.Authorization, /Credential=rotated-id\//);
  assert.notEqual(f.calls[1].config.headers.Authorization, config.headers.Authorization);
});

test('仅Pass放行，Review和Block拒绝，未知或缺失结果报服务故障', async () => {
  for (const Suggestion of ['Review', 'Block']) assert.equal(await fixture({ result: () => ({ Response: { Suggestion } }) }).check('文字'), false);
  for (const result of [{}, { Response: {} }, { Response: { Suggestion: 'pass' } }, { Response: null }]) {
    await assert.rejects(fixture({ result: () => result }).check('文字'), error => error.errCode === 'TMS_RESPONSE_INVALID');
  }
});

test('鉴权、额度、策略错误保留安全错误码，不记录正文密钥，不回退微信或自动重试', async () => {
  for (const code of ['AuthFailure.SignatureFailure', 'UnauthorizedOperation', 'LimitExceeded', 'RequestLimitExceeded', 'ResourceUnavailable', 'InvalidParameterValue.BizType']) {
    const f = fixture({ result: () => ({ Response: { Error: { Code: code, Message: 'private body synthetic-secret-key' } } }) });
    await assert.rejects(f.check('private body'), error => {
      assert.equal(error.errCode, code); assert.equal(error.checkTransport, 'tencent_tms');
      assert.doesNotMatch(JSON.stringify(error) + error.message + checkUnavailableMessage(error), /private body|synthetic-secret/);
      assert.match(checkUnavailableMessage(error), /腾讯云/); return true;
    });
    assert.equal(f.calls.length, 1); assert.equal(f.cloudCalls(), 0);
  }
  const f = fixture({ result: () => ({ Response: { Suggestion: 'Pass', Error: { Code: 'private body with secret' } } }) });
  await assert.rejects(f.check('文字'), error => error.errCode === 'TMS_ERROR');
});

test('缺少配置、错误provider和无效正文在网络请求前失败，不误用微信额度', async () => {
  for (const env of [{ TMS_SECRET_ID: '' }, { TMS_SECRET_KEY: '' }, { TMS_BIZ_TYPE: '' }, { TMS_BIZ_TYPE: 'bad value' }, { TMS_REGION: 'bad host/path' }, { TEXT_CHECK_PROVIDER: 'tencent_typo' }]) {
    const f = fixture({ env }); await assert.rejects(f.check('文字'));
    assert.equal(f.calls.length, 0); assert.equal(f.cloudCalls(), 0);
  }
  for (const content of ['', ' ', null, '字'.repeat(10001)]) {
    const f = fixture(); await assert.rejects(f.check(content)); assert.equal(f.calls.length, 0);
  }
  const f = fixture({ env: { TEXT_CHECK_PROVIDER: '' } });
  await assert.rejects(f.check('文字'), error => String(error.errCode) === '45009');
  assert.equal(f.cloudCalls(), 1); assert.equal(f.calls.length, 0);
});

test('网络故障、超时、断流、超大响应、无效JSON和HTTP故障均停止提交', async () => {
  for (const options of [{ networkError: true }, { hang: true }, { aborted: true }, { raw: 'x'.repeat(128 * 1024 + 1) }, { raw: 'invalid-json' }, { status: 503 }]) {
    const f = fixture(options);
    await assert.rejects(f.check('private body'), error => error.checkTransport === 'tencent_tms' && !error.message.includes('private body'));
    assert.equal(f.calls.length, 1); assert.equal(f.cloudCalls(), 0);
    if (options.hang || (options.raw && options.raw.length > 128 * 1024)) assert.equal(f.destroyed(), 1);
  }
});

test('发帖、普通评论、AI回复与润色原文及结果均实际经过腾讯云检查，违规或故障不落库', async () => {
  let suggestion = 'Pass';
  const tms = fixture({ result: () => ({ Response: { Suggestion: suggestion } }) });
  const f = serviceFixture({ checkText: tms.check, generateAI: async () => '小萃回答', optimizeAI: async () => '优化结果' });
  await f.login();
  const post = await f.handle({ action: 'publishSquarePost', post: { scope: 'square', content: '动态原文', requestId: 'tms-post-request0001' } }, f.alice);
  assert.equal(post.success, true, post.message); const postId = post.square.post._id;
  const reply = await f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId, content: '@小萃 问题', askAI: true, requestId: 'tms-reply-request001' } }, f.alice);
  assert.equal(reply.success, true, reply.message);
  const ai = await f.handle({ action: 'processSquareAIReply', postId, replyId: reply.square.reply._id }, f.alice);
  assert.equal(ai.success, true, ai.message); assert.equal(ai.square.status, 'done');
  const polish = await f.handle({ action: 'optimizeSquareContent', content: '润色原文' }, f.alice);
  assert.equal(polish.success, true, polish.message);
  assert.deepEqual(tms.calls.map(call => Buffer.from(JSON.parse(call.body).Content, 'base64').toString('utf8')), ['动态原文', '@小萃 问题', '小萃回答', '润色原文', '优化结果']);
  suggestion = 'Block';
  const denied = await f.handle({ action: 'publishSquarePost', post: { scope: 'square', content: '拒绝内容', requestId: 'tms-denied-request01' } }, f.alice);
  assert.equal(denied.code, 'CONTENT_REJECTED'); assert.equal(f.squarePosts.size, 1);
  suggestion = undefined;
  const failed = await f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId, content: '故障内容', requestId: 'tms-failed-request01' } }, f.alice);
  assert.equal(failed.code, 'CONTENT_CHECK_UNAVAILABLE'); assert.match(failed.message, /腾讯云.*TMS_RESPONSE_INVALID/);
  assert.equal(f.squareReplies.size, 1); assert.equal(tms.cloudCalls(), 0);
});
