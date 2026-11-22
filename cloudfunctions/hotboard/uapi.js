const https = require('https');
const TYPES = ['weibo', 'zhihu', 'bilibili', 'baidu', 'toutiao'];
function error(code, message) { return Object.assign(new Error(message), { code }); }
function parseBoard(body, type) {
  if (!body || body.type !== type || !Array.isArray(body.list) || body.list.length > 200 ||
    typeof body.update_time !== 'string' || !/Z$/.test(body.update_time) || !Number.isFinite(Date.parse(body.update_time)))
    throw error('HOTBOARD_INVALID_RESPONSE', '热榜数据格式异常，请稍后再试');
  const ranks = new Set();
  const list = body.list.map(row => {
    if (!row || !Number.isSafeInteger(row.index) || row.index < 1 || ranks.has(row.index) ||
      typeof row.title !== 'string' || !row.title.trim() || Array.from(row.title).length > 1000)
      throw error('HOTBOARD_INVALID_RESPONSE', '热榜数据格式异常，请稍后再试');
    ranks.add(row.index);
    return { rank: row.index, title: row.title.trim() };
  }).sort((a, b) => a.rank - b.rank);
  return { type, updateTime: body.update_time, list };
}
function createUapiClient({ getKey = () => process.env.UAPI_API_KEY || '', transport = https } = {}) {
  return type => new Promise((resolve, reject) => {
    if (!TYPES.includes(type)) { reject(error('HOTBOARD_INVALID_TYPE', '不支持的热榜平台')); return; }
    const key = getKey().trim();
    if (/[\r\n]/.test(key)) { reject(error('HOTBOARD_AUTH_FAILED', '热榜服务鉴权配置异常')); return; }
    const headers = { Accept: 'application/json', 'User-Agent': 'CampusHotboard/1.0' };
    if (key) headers.Authorization = `Bearer ${key}`;
    let settled = false, request, deadline;
    const finish = (failure, value) => {
      if (settled) return; settled = true; clearTimeout(deadline);
      if (failure) reject(failure); else resolve(value);
    };
    try {
      request = transport.get({ hostname: 'uapis.cn', port: 443, path: `/api/v1/misc/hotboard?type=${type}`, method: 'GET', headers }, response => {
        response.on('error', () => finish(error('HOTBOARD_UPSTREAM_ERROR', '热榜连接中断，请稍后再试')));
        const status = response.statusCode;
        if (status !== 200) {
          response.resume();
          const code = status === 401 || status === 403 ? 'HOTBOARD_AUTH_FAILED' : status === 402 ? 'HOTBOARD_QUOTA_EXHAUSTED' : status === 429 ? 'HOTBOARD_RATE_LIMITED' : 'HOTBOARD_UPSTREAM_ERROR';
          const message = code === 'HOTBOARD_AUTH_FAILED' ? '热榜服务鉴权失败，请联系管理员' : code === 'HOTBOARD_QUOTA_EXHAUSTED' ? '热榜服务额度不足，请稍后再试' : code === 'HOTBOARD_RATE_LIMITED' ? '热榜更新频繁，请稍后再试' : '热榜来源暂不可用，请稍后再试';
          finish(error(code, message)); return;
        }
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 1024 * 1024) { finish(error('HOTBOARD_INVALID_RESPONSE', '热榜数据格式异常，请稍后再试')); response.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          try { finish(null, parseBoard(JSON.parse(Buffer.concat(chunks).toString('utf8')), type)); }
          catch (failure) { finish(failure.code ? failure : error('HOTBOARD_INVALID_RESPONSE', '热榜数据格式异常，请稍后再试')); }
        });
      });
      request.on('error', () => finish(error('HOTBOARD_UPSTREAM_ERROR', '热榜连接失败，请稍后再试')));
      deadline = setTimeout(() => { finish(error('HOTBOARD_TIMEOUT', '热榜请求超时，请稍后再试')); request.destroy(); }, 8000);
    } catch (failure) { finish(error('HOTBOARD_UPSTREAM_ERROR', '热榜连接失败，请稍后再试')); }
  });
}
module.exports = { TYPES, createUapiClient, parseBoard };
