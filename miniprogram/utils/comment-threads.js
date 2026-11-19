const { postView } = require('./post-view');
const { newestComments, oldestComments } = require('./comment-order');

function rowView(row) {
  const value = postView(row);
  return { ...value, likeCount: row.likeCount || 0, replyCount: row.replyCount || 0,
    timeText: /^\d+(分钟|小时)$/.test(value.timeText) ? `${value.timeText}前` : value.timeText,
    threadId: row.rootId || row._id, addressed: Boolean(row.rootId && row.replyToId !== row.rootId) };
}
function commentGroups(roots, threads) {
  return newestComments(roots).map(root => {
    const thread = threads.get(root._id) || { items: [], fresh: new Set() };
    const folded = new Set(thread.items.filter(row => row.folded).map(row => row._id));
    const rows = oldestComments(thread.items).filter(row => !(row.ancestorIds || []).some(id => folded.has(id))).map(rowView);
    const fresh = rows.filter(row => thread.fresh.has(row._id));
    const remainingCount = Math.max(0, (root.replyCount || 0) - fresh.length);
    return { ...rowView(root), children: !root.folded && thread.open ? rows.filter(row => !thread.fresh.has(row._id)) : [],
      visibleChildren: !root.folded && thread.open ? rows : [],
      freshChildren: root.folded ? [] : fresh, threadLoading: thread.loading || false, threadError: thread.error || '',
      threadHasMore: thread.hasMore || false, threadOpen: Boolean(thread.open),
      remainingCount,
      showExpand: !root.folded && !thread.open && remainingCount > 0,
      showCollapse: !root.folded && Boolean(thread.open || (fresh.length && !remainingCount)) };
  });
}
module.exports = { commentGroups };
