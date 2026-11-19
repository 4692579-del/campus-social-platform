const https = require('https');
const crypto = require('crypto');
function safeCheckCode(error) {
  const nested = String(error && error.errMsg || '').match(/error\s*code\s*:\s*(-?\d{1,10})(?!\d)/i);
  const raw = nested ? nested[1] : error && (error.errCode ?? error.errcode ?? error.code);
  return /^-?\d{1,10}$/.test(String(raw)) ? String(raw) : /^[A-Z_]{1,40}$/.test(String(raw)) ? String(raw) : 'UNKNOWN';
}
function checkUnavailableMessage(error) {
  if (error && error.checkTransport === 'config') return '文字检查服务配置有误，请核对TEXT_CHECK_PROVIDER';
  if (error && error.checkTransport === 'tencent_tms') {
    const raw = String(error.errCode || '');
    const code = /^(?:TMS_[A-Z_]+|[A-Za-z]+(?:\.[A-Za-z0-9_]+)?)$/.test(raw) && raw.length <= 90 ? raw : 'TMS_ERROR';
    if (/^TMS_CONFIG_/.test(code)) return `腾讯云文字审核配置不完整或有误（${code}），请核对TMS环境变量`;
    if (/^(AuthFailure|UnauthorizedOperation)/.test(code)) return `腾讯云文字审核鉴权失败（${code}），请核对密钥及子用户权限`;
    if (/^(LimitExceeded|RequestLimitExceeded)/.test(code)) return `腾讯云文字审核调用受限（${code}），请核对额度及调用频率`;
    if (/^ResourceUnavailable/.test(code)) return `腾讯云文字审核服务不可用（${code}），请核对服务开通状态及余额`;
    return `腾讯云文字审核暂不可用（${code}），请稍后重试`;
  }
  const code = safeCheckCode(error), route = error && error.checkTransport === 'https' ? '直连' : error && error.checkTransport === 'cloud' ? '云调用' : '';
  if (code === '45009' && error && error.checkStage === 'token') return '微信接口凭证获取受限（45009），请核对凭证接口调用额度';
  if (code === '45009') return `微信文字检查${route}额度受限（45009）；未上架小程序每日仅100次`;
  if (code === '40164') return '微信文字检查直连IP未获授权（40164），请检查服务端IP白名单';
  if (code === '40125' || code === '40013') return `微信文字检查配置不匹配（${code}），请核对小程序AppID及AppSecret`;
  return `微信文字检查${route}暂不可用（${code}），请稍后重试`;
}
const failure = code => Object.assign(new Error('WeChat content check failed'), { errCode: code });
function createWeChatTextChecker(options) {
  const request = options.request || https.request, now = options.now || Date.now;
  let cached = null, tokenRequest = null;
  function post(path, payload) {
    return new Promise((resolve, reject) => {
      let settled = false, timer, req;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const body = JSON.stringify(payload);
      req = request('https://api.weixin.qq.com' + path, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      } }, response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('error', () => finish(failure('WECHAT_NETWORK')));
        response.on('data', chunk => { data += chunk; if (Buffer.byteLength(data) > 128 * 1024) { finish(failure('WECHAT_RESPONSE_INVALID')); req.destroy(); } });
        response.on('end', () => {
          if (response.statusCode !== 200) { finish(failure('WECHAT_HTTP_ERROR')); return; }
          try { finish(null, JSON.parse(data)); } catch (error) { finish(failure('WECHAT_RESPONSE_INVALID')); }
        });
      });
      req.on('error', () => finish(failure('WECHAT_NETWORK')));
      timer = setTimeout(() => { finish(failure('WECHAT_TIMEOUT')); req.destroy(); }, options.timeoutMs || 8000);
      req.end(body);
    });
  }
  async function accessToken(appid, secret) {
    const key = crypto.createHash('sha256').update(appid + ':' + secret).digest('hex');
    if (cached && cached.key === key && cached.expiresAt > now()) return cached.token;
    if (tokenRequest && tokenRequest.key === key) return tokenRequest.promise;
    const entry = { key };
    entry.promise = post('/cgi-bin/stable_token', { grant_type: 'client_credential', appid, secret, force_refresh: false }).then(result => {
      if (result.errcode) throw failure(result.errcode);
      if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw failure('WECHAT_RESPONSE_INVALID');
      cached = { key, token: result.access_token, expiresAt: now() + Math.max(0, result.expires_in * 1000 - 60000) };
      return result.access_token;
    }).finally(() => { if (tokenRequest === entry) tokenRequest = null; });
    tokenRequest = entry;
    return entry.promise;
  }
  function permitted(result) {
    if (!result || typeof result !== 'object') throw failure('WECHAT_RESPONSE_INVALID');
    const code = result.errcode ?? result.errCode;
    if (Number(code) === 87014) return false;
    if (code !== undefined && Number(code) !== 0) throw failure(code);
    if (!result.result || !['pass', 'review', 'risky', 'block'].includes(result.result.suggest)) throw failure('WECHAT_RESPONSE_INVALID');
    return result.result.suggest === 'pass';
  }
  return async (content, openid) => {
    // AppID来自可信云运行上下文，AppSecret仅取服务端环境变量。
    const secret = String(options.getSecret ? options.getSecret() || '' : process.env.WECHAT_APP_SECRET || '').trim();
    const transport = secret ? 'https' : 'cloud';
    let stage = 'check';
    try {
      if (transport === 'cloud') return permitted(await options.cloudCheck({ content, openid, version: 2, scene: 3 }));
      const appid = options.getAppId();
      if (!/^wx[0-9a-fA-F]{16}$/.test(appid || '')) throw failure('WECHAT_APPID_MISSING');
      stage = 'token';
      const token = await accessToken(appid, secret);
      stage = 'check';
      const result = await post('/wxa/msg_sec_check?access_token=' + encodeURIComponent(token), { content, openid, version: 2, scene: 3 });
      if ([40001, 40014, 42001].includes(Number(result.errcode)) && cached && cached.token === token) cached = null;
      // 限额、拒绝或其他故障都不自动重试，不切换路径跳过检查。
      return permitted(result);
    } catch (error) {
      if (safeCheckCode(error) === '87014') return false;
      const safe = failure(safeCheckCode(error)); safe.checkTransport = transport; safe.checkStage = stage;
      console.error('userService text check:', transport, stage, 'code:', safe.errCode);
      throw safe;
    }
  };
}
module.exports = { createWeChatTextChecker, safeCheckCode, checkUnavailableMessage };
