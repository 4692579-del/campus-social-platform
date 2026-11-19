const https = require('https');
const crypto = require('crypto');
const HOST = 'tms.tencentcloudapi.com';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const SIGNED_HEADERS = 'content-type;host;x-tc-action';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
function safeTmsCode(value) {
  return /^(?:AuthFailure|UnauthorizedOperation|InvalidParameter|InvalidParameterValue|MissingParameter|LimitExceeded|RequestLimitExceeded|ResourceUnavailable|ResourceNotFound|FailedOperation|InternalError|UnsupportedOperation)(?:\.[A-Za-z0-9_]{1,60})?$/.test(String(value))
    || /^TMS_[A-Z_]{1,40}$/.test(String(value)) ? String(value) : 'TMS_ERROR';
}
function failure(code) {
  return Object.assign(new Error('Tencent content check failed'), {
    errCode: safeTmsCode(code), checkTransport: 'tencent_tms', checkStage: 'check',
  });
}
// TC3签名仅在服务端计算；请求域名、接口和版本固定，不接受客户端覆盖。
function headersFor(body, config, now) {
  const timestamp = Math.floor(now / 1000), date = new Date(now).toISOString().slice(0, 10);
  const scope = `${date}/tms/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:${CONTENT_TYPE}\nhost:${HOST}\nx-tc-action:textmoderation\n\n${SIGNED_HEADERS}\n${hash(body)}`;
  const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`;
  const key = hmac(hmac(hmac('TC3' + config.secretKey, date), 'tms'), 'tc3_request');
  return {
    'Content-Type': CONTENT_TYPE, 'Content-Length': Buffer.byteLength(body), Host: HOST,
    'X-TC-Action': 'TextModeration', 'X-TC-Version': '2020-12-29',
    'X-TC-Timestamp': timestamp, 'X-TC-Region': config.region,
    Authorization: `TC3-HMAC-SHA256 Credential=${config.secretId}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${hmac(key, toSign).toString('hex')}`,
  };
}
function createTencentTextChecker(options = {}) {
  const request = options.request || https.request;
  const getEnv = options.getEnv || (() => process.env);
  return async content => {
    try {
      const env = getEnv();
      const config = {
        secretId: String(env.TMS_SECRET_ID || '').trim(), secretKey: String(env.TMS_SECRET_KEY || '').trim(),
        bizType: String(env.TMS_BIZ_TYPE || '').trim(), region: String(env.TMS_REGION || 'ap-guangzhou').trim(),
      };
      if (!config.secretId || !config.secretKey || !config.bizType) throw failure('TMS_CONFIG_MISSING');
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.bizType) || !/^[a-z]+-[a-z]+(?:-\d+)?$/.test(config.region)) throw failure('TMS_CONFIG_INVALID');
      if (typeof content !== 'string' || !content.trim() || Array.from(content).length > 10000) throw failure('TMS_CONTENT_INVALID');
      const body = JSON.stringify({ Content: Buffer.from(content, 'utf8').toString('base64'), BizType: config.bizType, Type: 'TEXT', SourceLanguage: 'zh' });
      const headers = headersFor(body, config, (options.now || Date.now)());
      const result = await new Promise((resolve, reject) => {
        let settled = false, timer, req;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
        req = request(`https://${HOST}/`, { method: 'POST', headers }, response => {
          let data = '', bytes = 0;
          response.setEncoding('utf8');
          response.on('error', () => finish(failure('TMS_NETWORK')));
          response.on('aborted', () => finish(failure('TMS_NETWORK')));
          response.on('data', chunk => {
            if (settled) return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > 128 * 1024) { finish(failure('TMS_RESPONSE_INVALID')); req.destroy(); return; }
            data += chunk;
          });
          response.on('end', () => {
            if (settled) return;
            if (response.statusCode !== 200) { finish(failure('TMS_HTTP_ERROR')); return; }
            try { finish(null, JSON.parse(data)); } catch (error) { finish(failure('TMS_RESPONSE_INVALID')); }
          });
        });
        req.on('error', () => finish(failure('TMS_NETWORK')));
        timer = setTimeout(() => { finish(failure('TMS_TIMEOUT')); req.destroy(); }, options.timeoutMs || 8000);
        req.end(body);
      });
      const response = result && result.Response;
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw failure('TMS_RESPONSE_INVALID');
      if (response.Error) throw failure(response.Error.Code);
      if (!['Pass', 'Review', 'Block'].includes(response.Suggestion)) throw failure('TMS_RESPONSE_INVALID');
      return response.Suggestion === 'Pass';
    } catch (error) {
      const safe = failure(error && error.errCode);
      console.error('userService text check:', 'tencent_tms', 'check', 'code:', safe.errCode);
      throw safe;
    }
  };
}
module.exports = { createTencentTextChecker };
