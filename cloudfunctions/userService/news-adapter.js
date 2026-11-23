const { createHash } = require('crypto');

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 40);
const isNewsId = value => typeof value === 'string' && /^n_[a-f0-9]{40}$/.test(value);
const plain = value => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '';
function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || !/\.[a-z][a-z0-9-]+$/.test(host) || /\.(localhost|local|internal|test|invalid|example|onion)$/.test(host)) return '';
    url.hash = '';
    return url.href;
  } catch (_) { return ''; }
}

function canonicalUrl(value) {
  const url = new URL(value);
  for (const name of [...url.searchParams.keys()]) {
    if (/^(utm_\w+|fbclid|gclid|mc_cid|mc_eid)$/i.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}${url.search}`;
}

function imageUrls(list) {
  const images = new Map();
  for (const item of list) {
    const url = publicUrl(typeof item === 'string' ? item : item?.url);
    if (!url || (item?.width > 0 && item.width < 100) || (item?.height > 0 && item.height < 75) ||
        /(?:^|[./_-])(ads?|adserver|doubleclick|track(?:ing)?|pixel|beacon|favicon|logos?|icons?|spacer)(?:[./_?&=-]|$)/i.test(url)) continue;
    const https = url.replace(/^http:/, 'https:');
    const key = canonicalUrl(https);
    if (!images.has(key)) images.set(key, https);
    if (images.size >= 9) break;
  }
  return [...images.values()];
}

function articleOf(row) {
  const url = publicUrl(row?.url), title = plain(row?.title);
  const externalId = row?.id;
  if (!Number.isSafeInteger(externalId) || externalId <= 0 || !url || !title || title.length > 1000) return null;
  const published = plain(row.publish_date).replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/, '$1T$2Z');
  const time = Date.parse(published);
  if (!Number.isFinite(time)) return null;
  const images = imageUrls([row.image, ...(Array.isArray(row.images) ? row.images : [])]);
  return { _id: `n_${digest(`worldnews:${externalId}`)}`, externalId, url, urlKey: canonicalUrl(url), title,
    content: bodyOf(row.text), summary: plain(row.summary).slice(0, 1600), images, feedImages: images,
    createdAt: new Date(time).toISOString(), authors: (Array.isArray(row.authors) ? row.authors : [row.author]).map(plain).filter(Boolean).slice(0, 20).map(name => name.slice(0, 160)),
    language: plain(row.language).slice(0, 10), sourceCountry: plain(row.source_country).slice(0, 10), category: plain(row.category).slice(0, 100),
    source: new URL(url).hostname.replace(/^www\./, ''), scope: 'news', contentType: 'news', status: 'published' };
}

function bodyOf(value) {
  const body = plain(value);
  // 超过单篇传输预算时保留摘要和原文入口，避免截断正文并伪称完整。
  return body && !/^\.{3}$/.test(body) && Buffer.byteLength(body) <= 400 * 1024 ? body : '';
}

function newsView(row, detail) {
  const summary = row.summary || row.content || '';
  return { _id: row._id, contentType: 'news', title: row.title, content: detail ? row.content || row.summary : Array.from(summary).slice(0, 280).join(''),
    detailReady: detail, ...(detail ? { sourceUrl: row.url, authors: row.authors, bodyMissing: !row.content } : {}),
    images: detail ? row.images : row.feedImages || row.images.slice(0, 1), createdAt: row.createdAt, category: row.category, language: row.language,
    sourceCountry: row.sourceCountry, newsUrlKey: row.urlKey, author: { nickname: row.source, avatarFileID: '/images/interface/news-source.svg', accountId: '' },
    likeCount: row.likeCount || 0, replyCount: row.replyCount || 0, isOwn: false };
}

module.exports = { articleOf, bodyOf, canonicalUrl, digest, imageUrls, isNewsId, newsView, publicUrl };
