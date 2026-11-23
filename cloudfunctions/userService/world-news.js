const https = require('https');

const MESSAGES = {
  NEWS_KEY_MISSING: '全球新闻尚未配置 API Key，请联系管理员',
  NEWS_AUTH_FAILED: '全球新闻来源鉴权失败，请联系管理员',
  NEWS_QUOTA_EXHAUSTED: '全球新闻今日接口额度已用完，请稍后再试',
  NEWS_RATE_LIMITED: '全球新闻更新频繁，请稍后再试',
  NEWS_BUSY: '全球新闻正在更新，请稍后再试',
  NEWS_TIMEOUT: '全球新闻来源响应超时，请稍后再试',
  NEWS_UPSTREAM_ERROR: '全球新闻来源暂不可用，请稍后再试',
  NEWS_INVALID_RESPONSE: '全球新闻来源数据异常，请稍后重试',
  NEWS_INVALID_PAGE: '新闻分页已失效，请下拉刷新',
};
const newsError = (code, diagnostic = '') => Object.assign(new Error(MESSAGES[code]), { code, diagnostic });

function createWorldNewsClient({ getKey = () => process.env.WORLD_NEWS_API_KEY, get = https.get, timeout = 6000 } = {}) {
  return async function request(path, query) {
    const key = String(getKey() || '').trim();
    if (!key) throw newsError('NEWS_KEY_MISSING');
    const url = new URL(`https://api.worldnewsapi.com/${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return new Promise((resolve, reject) => {
      let timer;
      const fail = (code, diagnostic) => { clearTimeout(timer); reject(newsError(code, diagnostic)); };
      const req = get(url, { headers: { 'x-api-key': key, Accept: 'application/json' } }, res => {
        if (res.statusCode !== 200) {
          res.destroy();
          fail(({ 401: 'NEWS_AUTH_FAILED', 403: 'NEWS_AUTH_FAILED', 402: 'NEWS_QUOTA_EXHAUSTED', 429: 'NEWS_RATE_LIMITED' })[res.statusCode] || 'NEWS_UPSTREAM_ERROR', `HTTP_${res.statusCode}`);
          return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 6 * 1024 * 1024) { fail('NEWS_INVALID_RESPONSE'); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on('error', () => fail('NEWS_UPSTREAM_ERROR', 'RESPONSE_INTERRUPTED'));
        res.on('end', () => {
          clearTimeout(timer);
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (_) { fail('NEWS_INVALID_RESPONSE'); }
        });
      });
      req.on('error', error => fail('NEWS_UPSTREAM_ERROR', /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code || '') ? error.code : 'CONNECTION_FAILED'));
      timer = setTimeout(() => { fail('NEWS_TIMEOUT'); req.destroy(); }, timeout);
    });
  };
}

module.exports = { createWorldNewsClient, NEWS_CODES: Object.keys(MESSAGES), newsError };
