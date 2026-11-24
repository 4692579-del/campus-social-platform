const ID = /^p_[a-f0-9]{40}$/;
// 只读取数据库中的当前成品；不保存客户端传来的引用快照或私有原图路径。
function createQuoteReader(db, profilesFor, declarations, excludeBlockedPosts) {
  return async function quoteViews(rows, viewer) {
    const records = new Map();
    let ids = rows.map(row => row.quotePostId).filter(id => ID.test(id || ''));
    for (let depth = 0; depth < 3 && ids.length; depth++) {
      const missing = [...new Set(ids)].filter(id => !records.has(id));
      for (let start = 0; start < missing.length; start += 20) {
        const batch = missing.slice(start, start + 20);
        const result = await db.collection('square_posts').where({ _id: db.command.in(batch) }).limit(20).get();
        for (const id of batch) records.set(id, null);
        for (const row of result.data) if (row.scope === 'square' && row.status === 'published') records.set(row._id, row);
      }
      ids = missing.map(id => records.get(id)?.quotePostId).filter(id => ID.test(id || ''));
    }
    const visible = await excludeBlockedPosts([...records.values()].filter(Boolean), viewer);
    const allowed = new Map(visible.map(row => [row._id, row]));
    const authors = await profilesFor([...new Set(visible.map(row => row.authorId))]);
    function view(id, seen = new Set(), depth = 0) {
      if (!ID.test(id || '')) return null;
      if (depth >= 3 || seen.has(id)) return { _id: id, collapsed: true };
      const row = allowed.get(id);
      if (!row) return { _id: id, unavailable: true };
      const next = new Set([...seen, id]);
      return { _id: id, author: authors.get(row.authorId), content: row.content || '', images: row.images || [], ...(row.media ? { media: row.media } : {}),
        createdAt: row.createdAt, declaration: declarations.includes(row.declaration) ? row.declaration : 'none',
        ...(row.quotePostId ? { quote: view(row.quotePostId, next, depth + 1) } : {}) };
    }
    return new Map(rows.filter(row => row.quotePostId).map(row => [row._id, view(row.quotePostId, new Set([row._id]))]));
  };
}
module.exports = { createQuoteReader };
