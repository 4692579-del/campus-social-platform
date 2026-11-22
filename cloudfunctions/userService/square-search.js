const ACTION = 'searchSquareContent';
const CODES = ['INVALID_SEARCH', 'SEARCH_SCOPE_UNAVAILABLE'];
const accountIdPattern = /^[1-9][0-9]{7}$/;
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function createSearch(db, { active, fail, profileOwner, recheckProfile, present }) {
  const person = user => ({ accountId: user.accountId, nickname: user.nickname, avatarFileID: user.avatarFileID || '', bio: user.bio || '',
    isVerified: user.role === 'student' && user.certificationStatus === 'approved' && Boolean(user.schoolId),
    ...(user.officialVerified === true ? { officialVerified: true } : {}) });
  return async (event, viewer) => {
    const kind = event.kind || 'square', accountId = event.accountId || '', cursor = event.cursor || '';
    if (kind === 'campus') fail('SEARCH_SCOPE_UNAVAILABLE', '校园圈搜索暂未开放');
    if (!['square', 'users'].includes(kind) || typeof event.keyword !== 'string') fail('INVALID_SEARCH', '搜索参数不正确');
    const keyword = event.keyword.trim();
    if (Array.from(keyword).length > 100 || /[\u0000-\u001f\u007f]/.test(keyword) || !keyword && !accountId ||
      typeof accountId !== 'string' || accountId && !accountIdPattern.test(accountId) || typeof cursor !== 'string' || cursor.length > 100 || /[\u0000-\u0020]/.test(cursor)) fail('INVALID_SEARCH', '请输入有效的搜索内容');
    const owner = accountId ? await profileOwner(accountId, viewer) : null;
    const query = { kind, keyword, accountId };
    if (kind === 'users') {
      active(viewer);
      // 胶囊是明确的账号条件；空关键词或切到用户栏均查看该账号。
      if (owner) return { ...query, items: [person(await recheckProfile(owner))], hasMore: false, nextCursor: '' };
      if (cursor && !/^u_[a-f0-9]{32}$/.test(cursor)) fail('INVALID_SEARCH', '分页参数不正确');
      const term = keyword.replace(/^@/, '');
      if (!term) fail('INVALID_SEARCH', '请输入用户名或ID');
      const regex = db.RegExp({ regexp: escapeRegExp(term), options: 'i' });
      const base = { status: 'active', role: db.command.in(['user', 'student', 'admin']), ...(cursor ? { _id: db.command.lt(cursor) } : {}) };
      const results = await Promise.all(['nickname', 'accountId'].map(field => db.collection('users').where({ ...base, [field]: regex }).orderBy('_id', 'desc').limit(21).get()));
      const all = [...new Map(results.flatMap(result => result.data).map(row => [row._id, row])).values()].sort((a, b) => b._id.localeCompare(a._id));
      const rows = all.slice(0, 20);
      return { ...query, items: rows.filter(row => accountIdPattern.test(row.accountId || '')).map(person), hasMore: all.length > 20,
        nextCursor: all.length > 20 ? rows[rows.length - 1]._id : '' };
    }
    const filter = { scope: 'square', status: 'published', ...(owner ? { authorId: owner._id } : {}),
      ...(keyword ? { content: db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' }) } : {}), ...(cursor ? { sortKey: db.command.lt(cursor) } : {}) };
    const rows = (await db.collection('square_posts').where(filter).orderBy('sortKey', 'desc').limit(21).get()).data;
    const items = (await present(rows.slice(0, 20), viewer, true)).filter(row => accountIdPattern.test(row.author && row.author.accountId || ''));
    if (owner) await recheckProfile(owner);
    return { ...query, items, hasMore: rows.length > 20, nextCursor: rows.length > 20 ? rows[19].sortKey : '' };
  };
}
module.exports = { createSearch, ACTION, CODES, escapeRegExp };
