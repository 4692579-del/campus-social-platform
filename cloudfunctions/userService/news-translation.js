const { randomBytes } = require('crypto');
const { createAIUsage, HOURLY_CHARS } = require('./ai-usage');
const { messageFor } = require('./ai-errors');
const { digest, newsView } = require('./news-adapter');
const { checkUnavailableMessage } = require('./wechat-content-check');

const CODES = ['NEWS_TRANSLATION_FAILED', 'NEWS_TRANSLATION_BUSY', 'NEWS_TRANSLATION_CHANGED', 'NEWS_TRANSLATION_TOO_LONG', 'NEWS_TRANSLATION_QUOTA'];
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const changed = () => fail('NEWS_TRANSLATION_CHANGED', '新闻原文已更新，请刷新后重试');
const invalid = () => fail('NEWS_TRANSLATION_FAILED', '小萃未能返回完整译文，请重试');

function readSource(row, id, version) {
  if (!row || row._id !== id || row.scope !== 'news' || row.contentType !== 'news' || row.status !== 'published') {
    fail('POST_NOT_FOUND', '新闻不存在或已不可见');
  }
  const { title, content, translationVersion } = newsView(row, true);
  if (translationVersion !== version) changed();
  return { title, content };
}

function translatedText(raw, sourceLines) {
  let result;
  try { result = JSON.parse(raw); } catch (_) { invalid(); }
  const validLine = value => typeof value === 'string' && value.trim() && !/[\r\n]/.test(value) && !CONTROL.test(value);
  const lines = sourceLines.filter(line => line.trim());
  if (!validLine(result?.title) || !Array.isArray(result.lines) || result.lines.length !== lines.length || !result.lines.every(validLine)) invalid();
  let i = 0;
  return { title: result.title.trim(), content: sourceLines.map(line => line.trim() ? result.lines[i++].trim() : line).join('\n') };
}

async function review(text, identity, checkText) {
  // 微信和腾讯云都走既有审核器。分段仅用于审核，译文仍完整显示。
  const points = Array.from(text), checks = [];
  for (let start = 0; start < points.length; start += 2000) {
    const chunk = points.slice(start, start + 2000).join('').trim();
    if (chunk) checks.push(Promise.resolve().then(() => checkText(chunk, identity.openid)));
  }
  let results;
  try { results = await Promise.all(checks); }
  catch (error) { fail('CONTENT_CHECK_UNAVAILABLE', checkUnavailableMessage(error)); }
  if (results.some(result => result !== true)) fail('CONTENT_REJECTED', '译文未通过内容检查');
}

async function translateNews(db, options, active, id, version, user, identity) {
  active(user);
  const read = async source => readSource((await source.collection('news_articles').doc(id).get()).data, id, version);
  const cacheId = `translation_${digest(`${id}:zh-CN:${version}`)}`;
  const cache = source => source.collection('news_cache').doc(cacheId);
  const account = async source => active((await source.collection('users').doc(user._id).get()).data);
  const owner = randomBytes(16).toString('hex');
  const result = await db.runTransaction(async tx => {
    await account(tx);
    const { title, content } = await read(tx);
    const ref = cache(tx), current = (await ref.get()).data;
    if (current?.translation) return { cached: current.translation };
    if (current?.until > Date.now()) fail('NEWS_TRANSLATION_BUSY', '小萃正在翻译这篇新闻，请稍后再试');
    if (!options.translateAI || !options.checkText) fail('NEWS_TRANSLATION_FAILED', '小萃翻译尚未配置，请联系管理员');
    const sourceLines = content.split('\n');
    if (title.length + content.length > 16000 || sourceLines.length > 500) {
      fail('NEWS_TRANSLATION_TOO_LONG', '这篇新闻超出单次翻译长度，可继续阅读原文');
    }
    await ref.set({ data: { owner, until: Date.now() + 120000 } });
    return { title, sourceLines };
  });
  const { cached, title, sourceLines } = Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result;
  if (cached) return cached;

  const usage = createAIUsage(db, options);
  let reservation, saved = false;
  try {
    reservation = await usage.reserve(user._id, HOURLY_CHARS);
    let raw;
    try { raw = await options.translateAI({ title, lines: sourceLines.filter(line => line.trim()) }); }
    catch (error) {
      const message = error.code === 'AI_TIMEOUT' ? '小萃翻译超时，请重试' :
        error.code === 'AI_RESPONSE_INVALID' ? '小萃未能返回完整译文，请重试' : messageFor(error.code || 'AI_NETWORK');
      fail('NEWS_TRANSLATION_FAILED', message);
    }
    const translation = { version, ...translatedText(raw, sourceLines) };
    const translated = `${translation.title}\n${translation.content}`.trim();
    const count = Array.from(translation.title).length + Array.from(translation.content).length;
    if (count > HOURLY_CHARS) fail('NEWS_TRANSLATION_TOO_LONG', '这篇新闻的译文超出单次翻译长度，可继续阅读原文');
    if (count > reservation.chars) fail('NEWS_TRANSLATION_QUOTA', '剩余额度不足以显示完整译文，请在额度重置后重试');
    await review(translated, identity, options.checkText);
    await db.runTransaction(async tx => {
      await account(tx);
      await read(tx);
      const ref = cache(tx), lease = (await ref.get()).data;
      if (lease?.owner !== owner || lease.until <= Date.now()) fail('NEWS_TRANSLATION_BUSY', '翻译请求已过期，请重试');
      await usage.commit(tx, reservation, count);
      await ref.set({ data: { translation } });
    });
    saved = true;
    return translation;
  } finally {
    if (!saved) {
      await Promise.all([usage.release(reservation), db.runTransaction(async tx => {
        const ref = cache(tx);
        if ((await ref.get()).data?.owner === owner) await ref.update({ data: { until: 0 } });
      }).catch(() => console.error('userService news translation lease release failed'))]);
    }
  }
}

module.exports = { translateNews, CODES };
