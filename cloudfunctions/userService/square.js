const crypto = require('crypto');

const SQUARE_ACTIONS = ['listSquarePosts', 'getSquarePost', 'publishSquarePost', 'setSquareReaction', 'listSquareReplies', 'listSquareReplyChildren', 'setSquareCommentState', 'publishSquareReply', 'deleteSquarePost', 'reportSquarePost', 'recordSquareShare'];
const REPORT_REASONS = ['spam', 'illegal', 'sexual', 'abuse', 'other'];
const SQUARE_CODES = ['INVALID_POST', 'POST_NOT_FOUND', 'CONTENT_REJECTED', 'CONTENT_CHECK_UNAVAILABLE', 'REQUEST_CONFLICT'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function active(user) {
  if (!user) fail('NOT_REGISTERED', '请先登录');
  if (user.status !== 'active') fail('ACCOUNT_DISABLED', '当前账号暂不可使用');
  if (!['user', 'student', 'admin'].includes(user.role)) fail('INVALID_ROLE', '账号身份异常');
}
function text(value, max) {
  const content = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
  if (!content || Array.from(content).length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(content)) fail('INVALID_POST', `请输入 1—${max} 个字的内容`);
  return content;
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value)) fail('INVALID_POST', '提交标识无效，请重新打开发布页');
  return value;
}
function postId(value) {
  if (typeof value !== 'string' || !/^p_[a-f0-9]{40}$/.test(value)) fail('POST_NOT_FOUND', '动态不存在或已不可见');
  return value;
}
function commentId(value) {
  if (typeof value !== 'string' || !/^[rc]_[a-f0-9]{40}$/.test(value)) fail('INVALID_POST', '评论不存在或已不可见');
  return value;
}
const commentTable = id => id.startsWith('c_') ? 'square_reply_children' : 'square_replies';
function author(user) {
  return user && user.status === 'active' ? { nickname: user.nickname, avatarFileID: user.avatarFileID || '', accountId: user.accountId || '',
    verified: user.role === 'student' && user.certificationStatus === 'approved' && Boolean(user.schoolId) }
    : { nickname: '账号暂不可用', avatarFileID: '', accountId: '', verified: false };
}
function visible(post) {
  if (!post || post.scope !== 'square' || post.status !== 'published') fail('POST_NOT_FOUND', '动态不存在或已不可见');
  return post;
}

function createSquareService(db, options = {}) {
  const posts = db.collection('square_posts'), replies = db.collection('square_replies'), reactions = db.collection('square_interactions');
  async function getPost(id) { return visible((await posts.doc(postId(id)).get()).data); }
  async function getComment(id, parentId, source = db) {
    commentId(id);
    const row = (await source.collection(commentTable(id)).doc(id).get()).data;
    if (!row || row.postId !== parentId || row.status !== 'published') fail('POST_NOT_FOUND', '评论不存在或已不可见');
    return row;
  }
  async function presentComments(rows, viewer) {
    if (!rows.length) return [];
    const ids = [...new Set(rows.flatMap(row => [row.authorId, row.replyToAuthorId].filter(Boolean)))];
    const profiles = new Map(await Promise.all(ids.map(async id => [id, author((await db.collection('users').doc(id).get()).data)])));
    // 使用主键批量读取本人状态，避免为仅个人可见的状态额外配置复合索引。
    const states = viewer ? (await db.collection('square_comment_states').where({
      _id: db.command.in(rows.map(row => hash(`comment:${viewer._id}:${row._id}`))) }).limit(20).get()).data : [];
    return rows.map(row => {
      const state = states.find(value => value.replyId === row._id);
      return { _id: row._id, content: row.content, author: profiles.get(row.authorId), createdAt: row.createdAt,
        rootId: row.rootId || '', replyToId: row.replyToId || '', replyToName: row.replyToAuthorId ? profiles.get(row.replyToAuthorId).nickname : '',
        ancestorIds: row.ancestorIds || [], replyCount: row.replyCount || 0, likeCount: row.likeCount || 0,
        liked: Boolean(state && state.liked), folded: Boolean(state && state.folded) };
    });
  }
  async function checked(content, identity) {
    if (!options.checkText) fail('CONTENT_CHECK_UNAVAILABLE', '文字校验服务暂不可用，请稍后重试');
    let permitted;
    try { permitted = await options.checkText(content, identity.openid); }
    catch (error) { fail('CONTENT_CHECK_UNAVAILABLE', '文字校验服务暂不可用，请稍后重试'); }
    if (!permitted) fail('CONTENT_REJECTED', '这段内容暂时无法发布，请修改后重试');
  }
  async function present(rows, viewer, preview = false) {
    if (!rows.length) return [];
    const authorIds = [...new Set(rows.map(row => row.authorId))];
    const profiles = await Promise.all(authorIds.map(async id => [id, author((await db.collection('users').doc(id).get()).data)]));
    const authors = new Map(profiles);
    const states = viewer ? (await reactions.where({ userId: viewer._id, postId: db.command.in(rows.map(row => row._id)), active: true }).limit(40).get()).data : [];
    return rows.map(row => ({ _id: row._id, content: preview ? Array.from(row.content).slice(0, 280).join('') : row.content,
      ...(preview ? { fullContent: row.content } : {}),
      truncated: preview && Array.from(row.content).length > 280, author: authors.get(row.authorId), createdAt: row.createdAt,
      likeCount: row.likeCount || 0, replyCount: row.replyCount || 0, repostCount: row.repostCount || 0, shareCount: row.shareCount || 0,
      isOwn: Boolean(viewer && viewer._id === row.authorId),
      liked: states.some(state => state.postId === row._id && state.kind === 'like'),
      reposted: states.some(state => state.postId === row._id && state.kind === 'repost') }));
  }
  function pagination(event) {
    const offset = event.offset === undefined ? 0 : event.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) fail('INVALID_POST', '分页参数不正确');
    return offset;
  }
  return async function square(action, event, user, identity) {
    if (action === 'listSquarePosts') {
      const offset = pagination(event);
      const mine = event.mine === true;
      if (mine) active(user);
      const rows = (await posts.where({ scope: 'square', status: 'published', ...(mine ? { authorId: user._id } : {}) }).orderBy('sortKey', 'desc').skip(offset).limit(21).get()).data;
      return { ...(mine ? { mine: true } : {}), items: await present(rows.slice(0, 20), mine || event.personalize === true ? user : null, true), hasMore: rows.length > 20, nextOffset: offset + Math.min(rows.length, 20) };
    }
    if (action === 'getSquarePost') return { post: (await present([await getPost(event.postId)], event.personalize === true ? user : null))[0] };
    if (action === 'listSquareReplies' || action === 'listSquareReplyChildren') {
      const post = await getPost(event.postId), offset = pagination(event);
      const children = action === 'listSquareReplyChildren';
      if (children) {
        const root = await getComment(event.rootId, post._id);
        if (root.rootId) fail('INVALID_POST', '回复分组不正确');
      }
      const rows = (await db.collection(children ? 'square_reply_children' : 'square_replies').where({ postId: post._id, status: 'published',
        ...(children ? { rootId: event.rootId } : {}) }).orderBy('sortKey', 'asc').skip(offset).limit(21).get()).data;
      const items = await presentComments(rows.slice(0, 20), event.personalize === true ? user : null);
      return { items, hasMore: rows.length > 20, nextOffset: offset + items.length };
    }
    active(user);
    if (action === 'setSquareCommentState') {
      const id = postId(event.postId), target = commentId(event.replyId), kind = event.kind;
      if (!['like', 'fold'].includes(kind) || typeof event.active !== 'boolean') fail('INVALID_POST', '评论操作参数不正确');
      const key = hash(`comment:${user._id}:${target}`);
      await db.runTransaction(async transaction => {
        active((await transaction.collection('users').doc(user._id).get()).data);
        visible((await transaction.collection('square_posts').doc(id).get()).data);
        const row = await getComment(target, id, transaction);
        if (row.rootId) await getComment(row.rootId, id, transaction);
        const ref = transaction.collection('square_comment_states').doc(key), old = (await ref.get()).data;
        const field = kind === 'like' ? 'liked' : 'folded';
        if (Boolean(old && old[field]) === event.active) return;
        await ref.set({ data: { userId: user._id, postId: id, replyId: target, liked: Boolean(old && old.liked), folded: Boolean(old && old.folded),
          [field]: event.active, updatedAt: db.serverDate() } });
        if (kind === 'like') await transaction.collection(commentTable(target)).doc(target).update({ data: { likeCount: Math.max(0, (row.likeCount || 0) + (event.active ? 1 : -1)) } });
      });
      return { reply: (await presentComments([await getComment(target, id)], user))[0] };
    }
    if (action === 'deleteSquarePost') {
      const id = postId(event.postId);
      await db.runTransaction(async transaction => {
        active((await transaction.collection('users').doc(user._id).get()).data);
        const ref = transaction.collection('square_posts').doc(id), post = (await ref.get()).data;
        if (!post || post.scope !== 'square') fail('POST_NOT_FOUND', '动态不存在或已不可见');
        if (post.authorId !== user._id) fail('FORBIDDEN', '只能删除自己发布的动态');
        if (post.status !== 'deleted') await ref.update({ data: { status: 'deleted', deletedAt: db.serverDate() } });
      });
      return { deletedId: id };
    }
    if (action === 'reportSquarePost') {
      const id = postId(event.postId), reason = event.reason;
      if (!REPORT_REASONS.includes(reason)) fail('INVALID_POST', '请选择举报原因');
      const reportId = hash(`report:${user._id}:${id}`);
      let alreadyReported = false;
      await db.runTransaction(async transaction => {
        active((await transaction.collection('users').doc(user._id).get()).data);
        const post = visible((await transaction.collection('square_posts').doc(id).get()).data);
        if (post.authorId === user._id) fail('FORBIDDEN', '不能举报自己的动态');
        const ref = transaction.collection('square_reports').doc(reportId);
        if ((await ref.get()).data) { alreadyReported = true; return; }
        await ref.set({ data: { postId: id, reporterId: user._id, authorId: post.authorId, reason,
          status: 'pending', createdAt: db.serverDate(), postContent: post.content } });
      });
      return { reportId, alreadyReported };
    }
    if (action === 'recordSquareShare') {
      const id = postId(event.postId), token = requestId(event.requestId);
      const key = hash(`share:${user._id}:${id}:${token}`);
      await db.runTransaction(async transaction => {
        active((await transaction.collection('users').doc(user._id).get()).data);
        const ref = transaction.collection('square_posts').doc(id), post = visible((await ref.get()).data);
        const record = transaction.collection('square_interactions').doc(key);
        if ((await record.get()).data) return;
        await record.set({ data: { userId: user._id, postId: id, kind: 'share', active: false, createdAt: db.serverDate() } });
        await ref.update({ data: { shareCount: (post.shareCount || 0) + 1 } });
      });
      return { post: (await present([await getPost(id)], user))[0] };
    }
    if (action === 'publishSquarePost' || action === 'publishSquareReply') {
      const isReply = action === 'publishSquareReply';
      // 顶层 event 还会带有云平台的调用元数据，只校验独立的业务对象。
      const input = event.post;
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_POST', '发布页面需要更新，请重新编译后重试');
      if (Object.keys(input).some(key => !['content', 'requestId', 'scope', ...(isReply ? ['postId', 'replyToId'] : [])].includes(key))) fail('INVALID_POST', '发布参数不正确，请重新打开发布页');
      if (input.scope !== 'square') fail('INVALID_POST', '该发布入口仅支持动态广场');
      const content = text(input.content, isReply ? 300 : 1000), token = requestId(input.requestId);
      const parent = isReply ? await getPost(input.postId) : null;
      if (isReply && input.replyToId !== undefined) commentId(input.replyToId);
      const target = isReply && input.replyToId ? await getComment(input.replyToId, parent._id) : null;
      if (target && (target.ancestorIds || []).length >= 64) fail('INVALID_POST', '回复层级过多，请直接回复这条一级评论');
      const rootId = target ? target.rootId || target._id : '';
      const id = `${target ? 'c' : isReply ? 'r' : 'p'}_${hash(`${user._id}:${isReply ? parent._id : 'square'}:${token}`).slice(0, 40)}`;
      const collectionName = target ? 'square_reply_children' : isReply ? 'square_replies' : 'square_posts';
      const existing = (await db.collection(collectionName).doc(id).get()).data;
      const conflicts = saved => saved.content !== content || (saved.replyToId || '') !== (target ? target._id : '');
      if (existing && conflicts(existing)) fail('REQUEST_CONFLICT', '相同提交标识的内容或回复对象已变更，请重新提交');
      if (!existing) await checked(content, identity);
      await db.runTransaction(async transaction => {
        active((await transaction.collection('users').doc(user._id).get()).data);
        const ref = transaction.collection(collectionName).doc(id), saved = (await ref.get()).data;
        const parentRef = parent && transaction.collection('square_posts').doc(parent._id);
        const latestParent = parentRef ? visible((await parentRef.get()).data) : null;
        const latestTarget = target && await getComment(target._id, parent._id, transaction);
        const root = target && await getComment(rootId, parent._id, transaction);
        if (saved) {
          if (conflicts(saved)) fail('REQUEST_CONFLICT', '本次内容已提交，请勿重复修改请求');
          return;
        }
        await ref.set({ data: { scope: 'square', status: 'published', authorId: user._id, content,
          createdAt: db.serverDate(), sortKey: `${String(Date.now()).padStart(16, '0')}_${id}`,
          ...(isReply ? { postId: parent._id, likeCount: 0, replyCount: 0,
            ...(target ? { rootId, replyToId: target._id, replyToAuthorId: latestTarget.authorId, ancestorIds: [...(latestTarget.ancestorIds || []), latestTarget._id] } : {}) }
            : { likeCount: 0, replyCount: 0, repostCount: 0, shareCount: 0 }) } });
        if (parentRef) await parentRef.update({ data: { replyCount: (latestParent.replyCount || 0) + 1 } });
        if (root) await transaction.collection('square_replies').doc(rootId).update({ data: { replyCount: (root.replyCount || 0) + 1 } });
      });
      if (isReply) return { reply: (await presentComments([(await db.collection(collectionName).doc(id).get()).data], user))[0],
        ...(rootId ? { root: (await presentComments([await getComment(rootId, parent._id)], user))[0] } : {}), post: (await present([await getPost(parent._id)], user))[0] };
      return { post: (await present([await getPost(id)], user))[0] };
    }
    if (action === 'setSquareReaction') {
      const id = postId(event.postId), kind = event.kind;
      if (!['like', 'repost'].includes(kind) || typeof event.active !== 'boolean') fail('INVALID_POST', '互动参数不正确');
      const key = hash(`${id}:${user._id}:${kind}`);
      await db.runTransaction(async transaction => {
        active((await transaction.collection('users').doc(user._id).get()).data);
        const postRef = transaction.collection('square_posts').doc(id), post = visible((await postRef.get()).data);
        const stateRef = transaction.collection('square_interactions').doc(key), state = (await stateRef.get()).data;
        if (Boolean(state && state.active) === event.active) return;
        const field = kind === 'like' ? 'likeCount' : 'repostCount';
        await stateRef.set({ data: { userId: user._id, postId: id, kind, active: event.active } });
        await postRef.update({ data: { [field]: Math.max(0, (post[field] || 0) + (event.active ? 1 : -1)) } });
      });
      return { post: (await present([await getPost(id)], user))[0] };
    }
    fail('INVALID_ACTION', '不支持此操作');
  };
}

module.exports = { createSquareService, SQUARE_ACTIONS, SQUARE_CODES };
