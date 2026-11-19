const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWeChatTextChecker, safeCheckCode, checkUnavailableMessage } = require('../cloudfunctions/userService/wechat-content-check');
const APPID = 'wx0123456789abcdef';
function fixture(options = {}) {
  const calls = []; let clock = 100000, cloudCalls = 0, secret = 'synthetic-secret';
  const request = (url, config, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => {
      const call = { url, config, body: JSON.parse(body) }; calls.push(call);
      const response = new EventEmitter(); response.setEncoding = () => {}; response.statusCode = options.httpStatus || 200;
      queueMicrotask(() => {
        callback(response);
        const result = options.response ? options.response(call) : url.includes('stable_token')
          ? { access_token: 'synthetic-token', expires_in: 7200 } : { errcode: 0, result: { suggest: 'pass' } };
        response.emit('data', options.invalidJSON ? 'not-json' : JSON.stringify(result)); response.emit('end');
      });
    };
    return req;
  };
  const checker = createWeChatTextChecker({ request, getAppId: () => options.appid || APPID, getSecret: () => options.cloud ? '' : secret, now: () => clock,
    cloudCheck: async value => { cloudCalls++; return options.cloudCheck ? options.cloudCheck(value) : { result: { suggest: 'pass' } }; } });
  return { checker, calls, cloudCalls: () => cloudCalls, tick: ms => { clock += ms; }, rotate: () => { secret = 'rotated-synthetic-secret'; } };
}

test('直连同一微信文本检查接口，可信AppID、版本及openid保留，稳定token不强制刷新且并发合并', async () => {
  const f = fixture();
  const results = await Promise.all([f.checker('正文', 'trusted-viewer'), f.checker('回复', 'other-viewer')]);
  assert.deepEqual(results, [true, true]); assert.equal(f.cloudCalls(), 0);
  const tokens = f.calls.filter(row => row.url.endsWith('stable_token'));
  assert.equal(tokens.length, 1); assert.equal(tokens[0].body.appid, APPID); assert.equal(tokens[0].body.force_refresh, false);
  const checks = f.calls.filter(row => row.url.includes('/wxa/msg_sec_check?'));
  assert.equal(checks.length, 2); assert.equal(checks[0].body.openid, 'trusted-viewer');
  assert.equal(checks[0].body.version, 2); assert.equal(checks[0].body.scene, 3);
  assert.equal(checks[1].body.content, '回复');
  assert.ok(f.calls.every(row => row.url.startsWith('https://api.weixin.qq.com/')));
  await f.checker('另一段', 'trusted-viewer'); assert.equal(f.calls.length, 4);
  f.tick(7200000); await f.checker('过期', 'trusted-viewer'); assert.equal(f.calls.length, 6);
  f.rotate(); await f.checker('密钥轮换', 'trusted-viewer'); assert.equal(f.calls.length, 8);
});

test('未配置AppSecret时保留云调用，正常通过及非pass拒绝，87014不误报为服务故障', async () => {
  assert.equal(await fixture({ cloud: true }).checker('原文', 'trusted-viewer'), true);
  for (const suggest of ['review', 'risky', 'block']) assert.equal(await fixture({ cloud: true, cloudCheck: () => ({ result: { suggest } }) }).checker('文字', 'trusted-viewer'), false);
  assert.equal(await fixture({ cloud: true, cloudCheck: () => { throw { errCode: 87014 }; } }).checker('文字', 'trusted-viewer'), false);
  const f = fixture({ response: call => call.url.includes('stable_token') ? { access_token: 'synthetic-token', expires_in: 7200 } : { errcode: 87014 } });
  assert.equal(await f.checker('文字', 'trusted-viewer'), false);
});

test('云调用和HTTPS各自保留限流错误，既不放行也不自动切换路径或反复请求', async () => {
  const cloud = fixture({ cloud: true, cloudCheck: () => { throw { errCode: -604100, errMsg: 'error code: 45009 private-content' }; } });
  await assert.rejects(cloud.checker('文字', 'trusted-viewer'), error => error.checkTransport === 'cloud' && safeCheckCode(error) === '45009' && !error.message.includes('private-content'));
  assert.equal(cloud.cloudCalls(), 1); assert.equal(cloud.calls.length, 0);
  for (const at of ['token', 'check']) {
    const f = fixture({ response: call => at === 'token' || !call.url.includes('stable_token') ? { errcode: 45009, errmsg: 'private-content' } : { access_token: 'synthetic-token', expires_in: 7200 } });
    await assert.rejects(f.checker('文字', 'trusted-viewer'), error => error.checkTransport === 'https' && safeCheckCode(error) === '45009');
    assert.equal(f.calls.length, at === 'token' ? 1 : 2); assert.equal(f.cloudCalls(), 0);
  }
  assert.match(checkUnavailableMessage({ errCode: 45009, checkTransport: 'cloud' }), /云调用/);
  assert.match(checkUnavailableMessage({ errCode: 45009, checkTransport: 'https' }), /直连/);
  assert.match(checkUnavailableMessage({ errCode: 45009, checkTransport: 'https' }), /未上架小程序每日仅100次/);
  assert.doesNotMatch(checkUnavailableMessage({ errCode: 45009, checkTransport: 'https', checkStage: 'token' }), /100次/);
});

test('异常JSON、缺少审核结论、错误HTTP状态和错误AppID均关闭发布通路，错误中不带密钥token或正文', async () => {
  for (const options of [{ invalidJSON: true }, { httpStatus: 500 }, { response: () => ({ errcode: 0 }) }, { appid: 'invalid' }]) {
    const f = fixture(options);
    await assert.rejects(f.checker('private-content', 'trusted-viewer'), error => !/synthetic|private-content/.test(error.message));
    assert.equal(f.cloudCalls(), 0);
  }
});
