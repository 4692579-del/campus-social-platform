const crypto = require('crypto');
const ACTIONS = ['getSquareFollowProfile', 'getSquareFollowStates', 'setSquareFollow', 'listSquareFollowing'];
const CODES = ['INVALID_FOLLOW', 'FOLLOW_SELF', 'FOLLOW_CHANGED'];
const edgeId = (from, to) => 'f_' + crypto.createHash('sha256').update(`${from}:${to}`).digest('hex');
const count = n => Number.isSafeInteger(n) && n > 0 ? n : 0;

function createFollows(db, { active, fail, profileOwner, recheckProfile, present }) {
  const edges = () => db.collection('user_follows');
  const stats = user => ({ accountId: user.accountId, followingCount: count(user.followingCount), followerCount: count(user.followerCount), version: count(user.followStatsVersion) });
  async function states(viewer, ids) {
    const rows = [];
    for (let start = 0; start < ids.length; start += 20) rows.push(...(await edges().where({ _id: db.command.in(ids.slice(start, start + 20).map(id => edgeId(viewer._id, id))) }).limit(20).get()).data);
    return new Map(rows.map(row => [row.targetAccountId, row]));
  }
  return async (action, event, viewer) => {
    active(viewer);
    if (action === 'getSquareFollowStates') {
      const ids = event.accountIds;
      if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => !/^[1-9][0-9]{7}$/.test(id))) fail('INVALID_FOLLOW', '关注账号参数不正确');
      const found = await states(viewer, [...new Set(ids)]);
      return { items: [...new Set(ids)].map(accountId => { const row = found.get(accountId); return { accountId, following: Boolean(row && row.active), version: count(row && row.version) }; }) };
    }
    if (action === 'getSquareFollowProfile') {
      const target = event.accountId === undefined || event.accountId === viewer.accountId ? (await db.collection('users').doc(viewer._id).get()).data : await profileOwner(event.accountId, viewer);
      active(target);
      const row = (await states(viewer, [target.accountId])).get(target.accountId);
      await recheckProfile(target);
      return { profile: { ...stats(target), following: Boolean(row && row.active), relationVersion: count(row && row.version) } };
    }
    if (action === 'setSquareFollow') {
      if (typeof event.following !== 'boolean') fail('INVALID_FOLLOW', '关注参数不正确');
      const target = await profileOwner(event.accountId, viewer);
      if (target._id === viewer._id) fail('FOLLOW_SELF', '不能关注自己');
      let result;
      await db.runTransaction(async tx => {
        // 事务内串行读取，始终使用可信会话，不接受客户端的用户主键或统计值。
        const actorRef = tx.collection('users').doc(viewer._id), actor = (await actorRef.get()).data;
        active(actor);
        const targetRef = tx.collection('users').doc(target._id), current = (await targetRef.get()).data;
        if (!current || current.accountId !== target.accountId || current.status !== 'active' || !['user', 'student', 'admin'].includes(current.role)) fail('PROFILE_NOT_FOUND', '该用户暂不可查看');
        const ref = tx.collection('user_follows').doc(edgeId(viewer._id, target.accountId)), old = (await ref.get()).data;
        const changed = Boolean(old && old.active) !== event.following;
        const version = count(old && old.version) + Number(changed);
        if (changed) {
          const delta = event.following ? 1 : -1;
          actor.followingCount = Math.max(0, count(actor.followingCount) + delta); actor.followStatsVersion = count(actor.followStatsVersion) + 1;
          current.followerCount = Math.max(0, count(current.followerCount) + delta); current.followStatsVersion = count(current.followStatsVersion) + 1;
          await ref.set({ data: { followerId: actor._id, targetId: current._id, targetAccountId: current.accountId, active: event.following, version, updatedAt: db.serverDate() } });
          await actorRef.update({ data: { followingCount: actor.followingCount, followStatsVersion: actor.followStatsVersion } });
          await targetRef.update({ data: { followerCount: current.followerCount, followStatsVersion: current.followStatsVersion } });
        }
        result = { state: { accountId: target.accountId, following: event.following, version }, viewer: stats(actor), profile: { ...stats(current), following: event.following, relationVersion: version } };
      });
      return result;
    }
    if (action === 'listSquareFollowing') {
      const cursor = event.cursor || '';
      if (typeof cursor !== 'string' || cursor.length > 100 || /[\u0000-\u0020]/.test(cursor)) fail('INVALID_FOLLOW', '分页参数不正确');
      const actor = (await db.collection('users').doc(viewer._id).get()).data; active(actor);
      if (!count(actor.followingCount)) return { items: [], hasMore: false, nextCursor: '', followVersion: count(actor.followStatsVersion) };
      let after = cursor, selected = [], hasMore = false;
      // 用唯一时间游标扫描公开时间线，再用确定主键批量校验关注关系。
      // 每次至多检查400条，不将全部关注ID放进in查询，也不受关注人数上限限制。
      for (let page = 0; page < 4 && selected.length < 20; page++) {
        const rows = (await db.collection('square_posts').where({ scope: 'square', status: 'published', ...(after ? { sortKey: db.command.lt(after) } : {}) }).orderBy('sortKey', 'desc').limit(100).get()).data;
        if (!rows.length) { hasMore = false; break; }
        const authors = [...new Set(rows.map(row => row.authorId))], followed = new Set();
        // 关系主键用公开ID，作者读取只在服务端完成，不暴露内部ID。
        for (let start = 0; start < authors.length; start += 20) {
          const people = (await db.collection('users').where({ _id: db.command.in(authors.slice(start, start + 20)) }).limit(20).get()).data.filter(user => user.status === 'active');
          const found = await states(viewer, people.map(user => user.accountId).filter(Boolean));
          for (const person of people) if (found.get(person.accountId)?.active) followed.add(person._id);
        }
        let used = 0;
        for (const row of rows) { after = row.sortKey; used++; if (followed.has(row.authorId)) selected.push(row); if (selected.length === 20) break; }
        hasMore = used < rows.length || rows.length === 100;
        if (!hasMore) break;
      }
      const items = await present(selected, viewer, true);
      const latest = (await db.collection('users').doc(viewer._id).get()).data; active(latest);
      if (count(latest.followStatsVersion) !== count(actor.followStatsVersion)) fail('FOLLOW_CHANGED', '关注关系已更新，请刷新');
      return { items, hasMore, nextCursor: hasMore ? after : '', followVersion: count(actor.followStatsVersion) };
    }
  };
}
module.exports = { createFollows, ACTIONS, CODES, edgeId };
