const test = require('node:test');
const assert = require('node:assert/strict');
const { newestComments, oldestComments } = require('../miniprogram/utils/comment-order');
const { commentGroups } = require('../miniprogram/utils/comment-threads');
const row = (id, key) => ({ _id: id, sortKey: key, content: id, author: { nickname: id }, createdAt: '2026-11-19T00:00:00Z' });
test('本地时间倒序兼容云端日期与排序键，待发送行置顶且不改变原始数组', () => {
  const rows = [row('old', '001'), row('new', '003'), row('middle', '002')];
  assert.deepEqual(newestComments(rows).map(row => row._id), ['new', 'middle', 'old']);
  assert.deepEqual(oldestComments(rows).map(row => row._id), ['old', 'middle', 'new']);
  assert.deepEqual(rows.map(row => row._id), ['old', 'new', 'middle']);
  assert.equal(newestComments([...rows, { ...row('pending', ''), pending: true }])[0]._id, 'pending');
  assert.equal(oldestComments([...rows, { ...row('pending', ''), pending: true }]).at(-1)._id, 'pending');
  assert.equal(newestComments([{ _id: 'old', createdAt: { $date: '2026-11-18T00:00:00Z' } }, { _id: 'new', createdAt: '2026-11-19T00:00:00Z' }])[0]._id, 'new');
});
test('一级评论倒序，展开后新旧回复合并按发送时间正序，折叠与心碎隐藏逻辑保留', () => {
  const roots = [{ ...row('root', '010'), replyCount: 3 }, row('later-root', '020')];
  const items = [row('old', '001'), row('fresh', '003'), row('newer-other', '004')];
  const thread = { items, fresh: new Set(['fresh']), open: true };
  const threads = new Map([['root', thread]]);
  let groups = commentGroups(roots, threads); assert.equal(groups[0]._id, 'later-root');
  assert.deepEqual(groups[1].visibleChildren.map(row => row._id), ['old', 'fresh', 'newer-other']);
  thread.open = false; groups = commentGroups(roots, threads);
  assert.deepEqual(groups[1].freshChildren.map(row => row._id), ['fresh']); assert.equal(groups[1].remainingCount, 2);
  assert.equal(groups[1].showExpand, true); assert.equal(groups[1].showCollapse, false);
  roots[0].folded = true; thread.open = true; groups = commentGroups(roots, threads);
  assert.equal(groups[1].visibleChildren.length, 0); assert.equal(groups[1].freshChildren.length, 0);
});
