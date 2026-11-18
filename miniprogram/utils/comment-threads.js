const { postView } = require('./post-view');

function rowView(row) {
  const value = postView(row);
  return { ...value, likeCount: row.likeCount || 0, replyCount: row.replyCount || 0,
    timeText: /^\d+(分钟|小时)$/.test(value.timeText) ? `${value.timeText}前` : value.timeText,
    threadId: row.rootId || row._id, addressed: Boolean(row.rootId && row.replyToId !== row.rootId) };
}
function commentGroups(roots, threads) {
  return roots.map(root => {
    const thread = threads.get(root._id) || { items: [], fresh: new Set() };
    const folded = new Set(thread.items.filter(row => row.folded).map(row => row._id));
    const rows = thread.items.filter(row => !(row.ancestorIds || []).some(id => folded.has(id))).map(rowView);
    const fresh = rows.filter(row => thread.fresh.has(row._id));
    return { ...rowView(root), children: !root.folded && thread.open ? rows.filter(row => !thread.fresh.has(row._id)) : [],
      freshChildren: root.folded ? [] : fresh, threadLoading: thread.loading || false, threadError: thread.error || '',
      threadHasMore: thread.hasMore || false, threadOpen: Boolean(thread.open),
      remainingCount: Math.max(0, (root.replyCount || 0) - fresh.length),
      showExpand: !root.folded && !thread.open && (root.replyCount || 0) > fresh.length,
      showCollapse: !root.folded && Boolean(thread.open || fresh.length) };
  });
}
module.exports = { commentGroups };
