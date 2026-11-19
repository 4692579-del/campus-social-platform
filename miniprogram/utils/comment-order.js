function timeOf(row) {
  const raw = row.createdAt;
  const value = raw && typeof raw === 'object' && '$date' in raw ? raw.$date : raw;
  return new Date(value || 0).getTime() || 0;
}
function compareNewest(a, b) {
  if (Boolean(a.pending) !== Boolean(b.pending)) return a.pending ? -1 : 1;
  // 服务端提供的排序键还包含同毫秒内的稳定次序，分页与本地显示保持一致。
  if (a.sortKey && b.sortKey) return b.sortKey.localeCompare(a.sortKey);
  return timeOf(b) - timeOf(a);
}
function newestComments(rows) {
  return rows.slice().sort(compareNewest);
}
function oldestComments(rows) {
  return rows.slice().sort((a, b) => -compareNewest(a, b));
}
module.exports = { newestComments, oldestComments };
