const crypto = require('crypto');
const { articleOf, bodyOf, digest, imageUrls, publicUrl } = require('./news-adapter');
const { createWorldNewsClient, NEWS_CODES, newsError } = require('./world-news');

const PAGE_SIZE = 10, TTL = 20 * 60000, MAX_OFFSET = 10000, LEASE = 35000;
const DAY = 86400000, MAX_STALE = 7 * DAY;
const unbox = value => value && Object.prototype.hasOwnProperty.call(value, 'result') ? value.result : value;

function createNewsService(db, { request = createWorldNewsClient(), now = Date.now } = {}) {
  const pending = new Map();
  const cache = () => db.collection('news_cache');
  const articles = () => db.collection('news_articles');

  async function upstream(path, query, waitForInterval = true) {
    const owner = crypto.randomBytes(12).toString('hex');
    const blocked = unbox(await db.runTransaction(async tx => {
      const ref = tx.collection('news_cache').doc('upstream'), row = (await ref.get()).data;
      const time = now();
      if (row?.retryAt > time) return row.errorCode;
      if (row?.leaseUntil > time) return 'NEWS_BUSY';
      if (row?.nextAt > time) return row.nextAt - time;
      await ref.set({ data: { owner, leaseUntil: time + LEASE, nextAt: time + 1000 } });
      return '';
    }));
    if (typeof blocked === 'number') {
      if (!waitForInterval) throw newsError('NEWS_BUSY');
      await new Promise(resolve => setTimeout(resolve, blocked));
      return upstream(path, query, false);
    }
    if (blocked) throw newsError(blocked);
    let code = '', diagnostic = '';
    try { return await request(path, query); }
    catch (error) { code = error.code; diagnostic = error.diagnostic || ''; throw error; }
    finally {
      await db.runTransaction(async tx => {
        const ref = tx.collection('news_cache').doc('upstream'), row = (await ref.get()).data;
        if (row?.owner !== owner) return;
        const retryAt = code === 'NEWS_QUOTA_EXHAUSTED' ? (Math.floor(now() / DAY) + 1) * DAY :
          code === 'NEWS_RATE_LIMITED' ? now() + 60000 : code === 'NEWS_AUTH_FAILED' ? now() + TTL : 0;
        await ref.update({ data: { owner: '', leaseUntil: 0, retryAt, errorCode: code || '', diagnostic } });
      });
    }
  }

  function merged(key, read) {
    if (pending.has(key)) return pending.get(key);
    const task = read().finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  async function saveArticle(article) {
    const { _id, ...fields } = article;
    await db.runTransaction(async tx => {
      const ref = tx.collection('news_articles').doc(_id), previous = (await ref.get()).data;
      if (!previous) { await ref.set({ data: { ...fields, likeCount: 0, replyCount: 0 } }); return; }
      await ref.update({ data: { ...fields, status: previous.status, content: previous.content || fields.content,
        summary: fields.summary || previous.summary,
        images: imageUrls([...(previous.images || []), ...(previous.feedImages || []), ...fields.images]) } });
    });
  }

  async function loadPage(language, offset, anchor) {
    const key = offset ? `page_${language}_${anchor}_${offset}` : `head_${language}`;
    return merged(key, async () => {
      const ref = cache().doc(key), previous = (await ref.get()).data;
      if (previous?.fetchedAt > now() - TTL) return previous;
      const upper = offset ? anchor : Math.floor(now() / 1000) * 1000;
      if (offset) {
        const parent = (await cache().doc(`page_${language}_${anchor}_${offset - PAGE_SIZE}`).get()).data;
        if (!parent?.hasMore || parent.nextOffset !== offset || parent.anchor !== anchor) throw newsError('NEWS_INVALID_PAGE');
      }
      const leaseKey = `load_${key}`;
      const owner = crypto.randomBytes(12).toString('hex');
      const acquired = unbox(await db.runTransaction(async tx => {
        const lease = tx.collection('news_cache').doc(leaseKey), row = (await lease.get()).data;
        if (row?.until > now()) return false;
        await lease.set({ data: { owner, until: now() + LEASE } });
        return true;
      }));
      if (!acquired) {
        if (previous?.fetchedAt > now() - MAX_STALE) return { ...previous, stale: true, warning: newsError('NEWS_BUSY').message };
        throw newsError('NEWS_BUSY');
      }
      try {
        const latest = (await ref.get()).data;
        if (latest?.fetchedAt > now() - TTL) return latest;
        const publishTime = value => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
        const response = await upstream('search-news', { language, offset, number: PAGE_SIZE, sort: 'publish-time', 'sort-direction': 'DESC',
          'earliest-publish-date': publishTime(upper - 7 * DAY), 'latest-publish-date': publishTime(upper) });
        if (!Array.isArray(response?.news) || response.news.length > PAGE_SIZE || !Number.isSafeInteger(response.available) || response.available < 0 ||
            (response.offset !== undefined && response.offset !== offset)) throw newsError('NEWS_INVALID_RESPONSE');
        const seen = new Set(), urls = new Set(), rows = [];
        for (const raw of response.news) {
          const article = articleOf(raw);
          if (!article || seen.has(article._id) || urls.has(article.urlKey)) continue;
          seen.add(article._id); urls.add(article.urlKey); rows.push(article);
        }
        if (response.news.length && !rows.length) throw newsError('NEWS_INVALID_RESPONSE');
        for (const row of rows) await saveArticle(row);
        const nextOffset = offset + PAGE_SIZE;
        const page = { ids: rows.map(row => row._id), anchor: upper, fetchedAt: now(), nextOffset,
          hasMore: response.news.length === PAGE_SIZE && nextOffset < response.available && nextOffset <= MAX_OFFSET };
        await cache().doc(`page_${language}_${upper}_${offset}`).set({ data: page });
        if (!offset) await ref.set({ data: page });
        return page;
      } catch (error) {
        if (previous?.fetchedAt > now() - MAX_STALE) return { ...previous, stale: true,
          warning: newsError(NEWS_CODES.includes(error.code) ? error.code : 'NEWS_UPSTREAM_ERROR').message };
        throw error;
      } finally {
        await db.runTransaction(async tx => {
          const lease = tx.collection('news_cache').doc(leaseKey);
          if ((await lease.get()).data?.owner === owner) await lease.update({ data: { until: 0 } });
        });
      }
    });
  }

  async function list(event) {
    const { language = 'en', offset = 0, anchor = 0 } = event;
    if (!['en', 'zh'].includes(language) || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET || offset % PAGE_SIZE ||
        (offset && (!Number.isSafeInteger(anchor) || anchor > now() || anchor < now() - MAX_STALE))) throw newsError('NEWS_INVALID_PAGE');
    const page = await loadPage(language, offset, anchor);
    const fetched = page.ids.length ? (await articles().where({ _id: db.command.in(page.ids) }).limit(PAGE_SIZE).get()).data : [];
    const byId = new Map(fetched.filter(row => row.status === 'published' && row.scope === 'news' && row.contentType === 'news').map(row => [row._id, row]));
    return { ...page, rows: page.ids.map(id => byId.get(id)).filter(Boolean) };
  }

  async function enrich(article) {
    return merged(`article:${article._id}`, async () => {
      if ((article.content && article.images.length > 1) || article.detailRetryAt > now()) return article;
      const leaseId = `detail_${digest(article._id)}`;
      const claimed = unbox(await db.runTransaction(async tx => {
        const ref = tx.collection('news_cache').doc(leaseId), lease = (await ref.get()).data;
        if (lease?.until > now()) return false;
        await ref.set({ data: { until: now() + LEASE } });
        return true;
      }));
      if (!claimed) return article;
      const ref = articles().doc(article._id);
      const changes = {};
      // 若首次 Retrieve 仍缺正文，待上游间隔允许后在同一次详情读取中尝试 Extract。
      try {
        if (!article.content && !article.retrieved) {
          const response = await upstream('retrieve-news', { ids: article.externalId });
          if (!Array.isArray(response?.news)) throw newsError('NEWS_INVALID_RESPONSE');
          const retrieved = articleOf(response.news.find(row => row?.id === article.externalId));
          changes.retrieved = true;
          if (retrieved?.content) changes.content = retrieved.content;
          if (retrieved?.images.length) changes.images = imageUrls([...article.images, ...retrieved.images]);
          changes.detailRetryAt = now() + 60000;
        }
        if (!(changes.content || article.content) || (!changes.retrieved && article.images.length <= 1)) {
          const url = publicUrl(article.url);
          if (!url) throw newsError('NEWS_INVALID_RESPONSE');
          const extracted = await upstream('extract-news', { url, analyze: 'false' });
          if (!extracted || typeof extracted !== 'object' || (!Array.isArray(extracted.images) && typeof extracted.text !== 'string')) throw newsError('NEWS_INVALID_RESPONSE');
          const content = bodyOf(extracted?.text);
          if (!article.content && content) changes.content = content;
          if (Array.isArray(extracted?.images)) changes.images = imageUrls([...extracted.images, ...(changes.images || article.images)]);
          changes.detailRetryAt = now() + (content || changes.images?.length > 1 ? 7 * DAY : TTL);
        }
      } catch (error) {
        changes.detailRetryAt = now() + (error.code === 'NEWS_BUSY' ? 10000 : TTL);
      }
      await db.runTransaction(async tx => {
        const target = tx.collection('news_articles').doc(article._id), current = (await target.get()).data;
        if (!current || current.status !== 'published') return;
        if (changes.images) changes.images = imageUrls([...changes.images, ...current.images]);
        if (current.content) delete changes.content;
        await target.update({ data: changes });
      });
      return (await ref.get()).data;
    });
  }

  return { list, enrich };
}

module.exports = { createNewsService, PAGE_SIZE, TTL };
