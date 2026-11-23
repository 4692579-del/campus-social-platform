const { createHash } = require('crypto');

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 40);
const isNewsId = value => typeof value === 'string' && /^n_[a-f0-9]{40}$/.test(value);
const plain = value => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };
function displayText(value) {
  if (typeof value !== 'string') return '';
  const decode = (entity, number, hex, name) => {
    if (name) return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : entity;
    const point = hex ? parseInt(hex, 16) : Number(number);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  };
  const pattern = /&(?:#(\d+)|#[xX]([a-fA-F0-9]+)|([A-Za-z]+));/g;
  return plain(value.replace(pattern, decode).replace(pattern, decode));
}
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
    content: bodyOf(row.text), summary: plain(row.summary).slice(0, 1600), images,
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
  const body = displayText(row.content);
  const title = displayText(row.title), content = body || displayText(row.summary);
  return { _id: row._id, contentType: 'news', title, content, translationVersion: digest(JSON.stringify([title, content])),
    detailReady: detail, bodyMissing: !body, ...(detail ? { sourceUrl: row.url, authors: row.authors } : {}),
    images: imageUrls([...(row.images || []), ...(row.feedImages || [])]), createdAt: row.createdAt, category: row.category, language: row.language,
    sourceCountry: row.sourceCountry, newsUrlKey: row.urlKey, author: { nickname: row.source, avatarFileID: '/images/interface/news-source.svg', accountId: '' },
    likeCount: row.likeCount || 0, replyCount: row.replyCount || 0, isOwn: false };
}

module.exports = { articleOf, bodyOf, canonicalUrl, digest, imageUrls, isNewsId, newsView, publicUrl };
