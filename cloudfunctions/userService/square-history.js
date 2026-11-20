// 本人的回复时间线。作者只取可信会话，分页使用不可变的发布时间键。
function createReplyHistory(db, { active, fail, postId, commentId, getPost, getComment, presentComments, profilesFor }) {
  const published = row => row && row.status === 'published' && row.scope === 'square';
  async function readIds(table, ids) {
    const unique = [...new Set(ids.filter(Boolean))], result = new Map();
    for (let i = 0; i < unique.length; i += 20) {
      const rows = await db.collection(table).where({ _id: db.command.in(unique.slice(i, i + 20)) }).limit(20).get();
      for (const row of rows.data) result.set(row._id, row);
    }
    return result;
  }
  async function commentsById(ids) {
    const [roots, children] = await Promise.all([
      readIds('square_replies', ids.filter(id => id.startsWith('r_'))),
      readIds('square_reply_children', ids.filter(id => id.startsWith('c_'))),
    ]);
    return new Map([...roots, ...children]);
  }
  async function views(rows, user) {
    const result = new Map(), unique = [...new Map(rows.map(row => [row._id, row])).values()];
    for (let i = 0; i < unique.length; i += 20) {
      for (const row of await presentComments(unique.slice(i, i + 20), user)) result.set(row._id, row);
    }
    return result;
  }
  function compact(row, view) {
    if (!published(row) || !view) return { unavailable: true };
    return { _id: row._id, author: view.author, content: view.folded ? '' : Array.from(row.content || '').slice(0, 100).join(''),
      imageCount: view.folded ? 0 : (row.images || []).length, folded: Boolean(view.folded), createdAt: row.createdAt };
  }
  return async function history(action, event, user) {
    active(user);
    if (action === 'listSquareOwnReplies') {
      const cursor = event.cursor === undefined ? '' : event.cursor;
      if (typeof cursor !== 'string' || cursor && !/^\d{16}_[rc]_[a-f0-9]{40}$/.test(cursor)) fail('INVALID_POST', '回复分页参数不正确');
      const condition = { scope: 'square', status: 'published', authorId: user._id, ...(cursor ? { sortKey: db.command.lt(cursor) } : {}) };
      const batches = await Promise.all(['square_replies', 'square_reply_children'].map(table =>
        db.collection(table).where(condition).orderBy('sortKey', 'desc').limit(21).get()));
      const all = batches.flatMap(batch => batch.data).sort((a, b) => b.sortKey.localeCompare(a.sortKey));
      const page = all.slice(0, 20);
      const [posts, context] = await Promise.all([
        readIds('square_posts', page.map(row => row.postId)),
        commentsById(page.flatMap(row => [row.rootId, row.replyToId, ...(row.ancestorIds || [])].filter(Boolean))),
      ]);
      const valid = page.filter(row => published(posts.get(row.postId)) && (!row.rootId ||
        published(context.get(row.rootId)) && context.get(row.rootId).postId === row.postId));
      const safeContext = [...context.values()].filter(row => published(row) && posts.has(row.postId));
      const presented = await views([...valid, ...safeContext], user);
      const profiles = await profilesFor([...new Set(valid.map(row => posts.get(row.postId).authorId))]);
      const items = valid.map(row => {
        const post = posts.get(row.postId), reply = presented.get(row._id);
        const blocked = [...(row.ancestorIds || []), row.rootId].filter(Boolean).some(id => presented.get(id)?.folded);
        const parent = row.rootId ? context.get(row.replyToId) : post;
        const parentView = row.rootId ? presented.get(row.replyToId) : { author: profiles.get(post.authorId) };
        return { _id: row._id, postId: row.postId, sortKey: row.sortKey,
          reply: blocked ? { ...reply, content: '', images: [], folded: true, hiddenByAncestor: true } : reply,
          context: blocked ? { folded: true, content: '', imageCount: 0 } : row.rootId && parent && parent.postId !== row.postId ? { unavailable: true } : compact(parent, parentView),
          contextKind: row.rootId ? 'comment' : 'post' };
      });
      // 空页也推进游标，避免已删除的上文使时间线停在同一页。
      return { items, hasMore: all.length > 20, nextCursor: page.length ? page[page.length - 1].sortKey : cursor };
    }
    const id = postId(event.postId), targetId = commentId(event.replyId);
    await getPost(id);
    const target = await getComment(targetId, id), root = target.rootId ? await getComment(target.rootId, id) : target;
    if (!published(root) || !published(target)) fail('POST_NOT_FOUND', '评论不存在或已不可见');
    if (root.rootId) fail('POST_NOT_FOUND', '评论不存在或已不可见');
    const ancestors = await commentsById(target.ancestorIds || []);
    const contextViews = await views([root, target, ...[...ancestors.values()].filter(row => published(row) && row.postId === id)], user);
    const blocked = [...(target.ancestorIds || []), root._id].find(key => key !== targetId && contextViews.get(key)?.folded);
    if (blocked) return { root: contextViews.get(root._id), targetId: blocked,
      items: blocked === root._id ? [] : [contextViews.get(blocked)], startOffset: 0, nextOffset: 0, hasMore: true, blocked: true };
    if (!target.rootId) return { root: contextViews.get(root._id), targetId, items: [], startOffset: 0, nextOffset: 0, hasMore: false };
    const table = db.collection('square_reply_children'), condition = { postId: id, rootId: root._id, status: 'published' };
    const before = await table.where({ ...condition, sortKey: db.command.lt(target.sortKey) }).count();
    const startOffset = Math.floor(before.total / 20) * 20;
    const rows = (await table.where(condition).orderBy('sortKey', 'asc').skip(startOffset).limit(21).get()).data;
    const window = rows.slice(0, 20).filter(published);
    const windowAncestors = await commentsById(window.flatMap(row => row.ancestorIds || []));
    const ancestorViews = await views([...windowAncestors.values()].filter(row => published(row) && row.postId === id), user);
    const presented = await views(window, user);
    for (const row of window) if ((row.ancestorIds || []).some(key => ancestorViews.get(key)?.folded))
      presented.set(row._id, { ...presented.get(row._id), content: '', images: [], folded: true, hiddenByAncestor: true });
    if (!presented.has(targetId)) fail('POST_NOT_FOUND', '评论已更新，请重试');
    await getPost(id); await getComment(root._id, id); await getComment(targetId, id);
    return { root: contextViews.get(root._id), targetId, items: [...presented.values()],
      startOffset, nextOffset: startOffset + Math.min(rows.length, 20), hasMore: rows.length > 20 };
  };
}
module.exports = { createReplyHistory };
