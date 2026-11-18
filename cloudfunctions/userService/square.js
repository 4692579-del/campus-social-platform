const crypto = require('crypto');

const SQUARE_ACTIONS = ['listSquarePosts', 'listSquareAlbum', 'getSquarePost', 'publishSquarePost', 'setSquareReaction', 'listSquareReplies', 'listSquareReplyChildren', 'setSquareCommentState', 'publishSquareReply', 'deleteSquarePost', 'reportSquarePost'];
const REPORT_REASONS = ['spam', 'illegal', 'sexual', 'abuse', 'other'];
const DECLARATIONS = ['none', 'ai', 'opinion', 'repost', 'fiction', 'marketing'];
const SQUARE_CODES = ['INVALID_POST', 'POST_NOT_FOUND', 'CONTENT_REJECTED', 'CONTENT_CHECK_UNAVAILABLE', 'REQUEST_CONFLICT', 'INVALID_IMAGES', 'IMAGE_UPLOAD_UNAVAILABLE'];
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
function imageFiles(value, user, identity) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 9 || new Set(value).size !== value.length) fail('INVALID_IMAGES', '一次最多发布 9 张不同的图片');
  const prefix = `cloud://${identity.env}.`;
  const path = new RegExp(`^square-uploads/${user._id}/[A-Za-z0-9_-]+\\.(jpg|jpeg|png|webp)$`);
  if (value.some(file => typeof file !== 'string' || file.length > 512 || !identity.env || !file.startsWith(prefix) || !path.test(file.slice(file.indexOf('/', 8) + 1)))) {
    fail('INVALID_IMAGES', '请上传当前账号的图片，不能使用外链或其他账号的图片');
  }
  return value;
}

function createSquareService(db, options = {}) {
  const posts = db.collection('square_posts'), replies = db.collection('square_replies'), reactions = db.collection('square_interactions');
  const profileReads = new Map();
  async function profilesFor(ids) {
    const missing = [...new Set(ids)].filter(id => !profileReads.has(id));
    for (let start = 0; start < missing.length; start += 20) {
      const batch = missing.slice(start, start + 20);
      const reading = db.collection('users').where({ _id: db.command.in(batch) }).limit(20).get()
        .then(result => new Map(result.data.map(row => [row._id, row])));
      for (const id of batch) profileReads.set(id, reading.then(rows => author(rows.get(id))));
    }
    return new Map(await Promise.all(ids.map(async id => [id, await profileReads.get(id)])));
  }
  async function getPost(id) { return visible((await posts.doc(postId(id)).get()).data); }
  async function getComment(id, parentId, source = db) {
    commentId(id);
    const row = (await source.collection(commentTable(id)).doc(id).get()).data;
    if (!row || row.postId !== parentId || row.status !== 'published') fail('POST_NOT_FOUND', '评论不存在或已不可见');
    return row;
  }
  async function presentComments(rows, viewer, knownStates) {
    if (!rows.length) return [];
    const ids = [...new Set(rows.flatMap(row => [row.authorId, row.replyToAuthorId].filter(Boolean)))];
    // 使用主键批量读取本人状态，避免为仅个人可见的状态额外配置复合索引。
    const [profiles, states] = await Promise.all([profilesFor(ids), knownStates ? Promise.resolve(knownStates) : viewer ? db.collection('square_comment_states').where({
      _id: db.command.in(rows.map(row => hash(`comment:${viewer._id}:${row._id}`))) }).limit(20).get().then(result => result.data) : Promise.resolve([])]);
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
    const [authors, states] = await Promise.all([profilesFor(authorIds), viewer ? reactions.where({ userId: viewer._id, postId: db.command.in(rows.map(row => row._id)), active: true }).limit(40).get().then(result => result.data) : Promise.resolve([])]);
    return rows.map(row => ({ _id: row._id, content: preview ? Array.from(row.content).slice(0, 280).join('') : row.content,
      ...(preview ? { fullContent: row.content } : {}), images: row.images || [], declaration: DECLARATIONS.includes(row.declaration) ? row.declaration : 'none',
      truncated: preview && Array.from(row.content).length > 280, author: authors.get(row.authorId), createdAt: row.createdAt,
      likeCount: row.likeCount || 0, replyCount: row.replyCount || 0, repostCount: 0,
      isOwn: Boolean(viewer && viewer._id === row.authorId),
      liked: states.some(state => state.postId === row._id && state.kind === 'like'),
      reposted: false }));
  }
  function pagination(event) {
    const offset = event.offset === undefined ? 0 : event.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) fail('INVALID_POST', '分页参数不正确');
    return offset;
  }
  return async function square(action, event, user, identity) {
    // 仅复用本次可信身份查询的资料，不跨请求缓存认证或账号状态。
    if (user) profileReads.set(user._id, Promise.resolve(author(user)));
    if (action === 'listSquareAlbum') {
      active(user);
      const offset = pagination(event);
      const rows = (await posts.where({ scope: 'square', status: 'published', authorId: user._id, hasImages: true })
        .orderBy('sortKey', 'desc').skip(offset).limit(21).get()).data;
      return { items: rows.slice(0, 20).flatMap(row => (row.images || []).map((fileID, index) => ({
        _id: `${row._id}_${index}`, postId: row._id, fileID, createdAt: row.createdAt, index,
      }))), hasMore: rows.length > 20, nextOffset: offset + Math.min(rows.length, 20) };
    }
    if (action === 'listSquarePosts') {
      const offset = pagination(event);
      const mine = event.mine === true;
      if (mine) active(user);
      const filter = { scope: 'square', status: 'published', ...(mine ? { authorId: user._id } : {}) };
      const [result, count] = await Promise.all([
        posts.where(filter).orderBy('sortKey', 'desc').skip(offset).limit(21).get(),
        // 总数是导航展示附加信息，读取失败不阻断原有帖子列表。
        mine && !offset ? posts.where(filter).count().catch(() => null) : Promise.resolve(null),
      ]);
      const rows = result.data;
      return { ...(mine ? { mine: true } : {}), ...(count ? { total: count.total } : {}), items: await present(rows.slice(0, 20), mine || event.personalize === true ? user : null, true), hasMore: rows.length > 20, nextOffset: offset + Math.min(rows.length, 20) };
    }
    if (action === 'getSquarePost') return { post: (await present([await getPost(event.postId)], event.personalize === true ? user : null))[0] };
    if (action === 'listSquareReplies' || action === 'listSquareReplyChildren') {
      const id = postId(event.postId), offset = pagination(event);
      const children = action === 'listSquareReplyChildren';
      if (children) commentId(event.rootId);
      const [, root, result] = await Promise.all([getPost(id), children ? getComment(event.rootId, id) : Promise.resolve(null),
        db.collection(children ? 'square_reply_children' : 'square_replies').where({ postId: id, status: 'published',
          ...(children ? { rootId: event.rootId } : {}) }).orderBy('sortKey', 'asc').skip(offset).limit(21).get()]);
      if (root && root.rootId) fail('INVALID_POST', '回复分组不正确');
      const rows = result.data;
      const items = await presentComments(rows.slice(0, 20), event.personalize === true ? user : null);
      return { items, hasMore: rows.length > 20, nextOffset: offset + items.length };
    }
    active(user);
    if (action === 'setSquareCommentState') {
      const id = postId(event.postId), target = commentId(event.replyId), kind = event.kind;
      if (!['like', 'fold'].includes(kind) || typeof event.active !== 'boolean') fail('INVALID_POST', '评论操作参数不正确');
      const key = hash(`comment:${user._id}:${target}`);
      let committed;
      await db.runTransaction(async transaction => {
        // 事务内部按顺序读取；不同 SDK 的事务返回包装也不作为业务依赖。
        active((await transaction.collection('users').doc(user._id).get()).data);
        visible((await transaction.collection('square_posts').doc(id).get()).data);
        const row = await getComment(target, id, transaction);
        if (row.rootId) await getComment(row.rootId, id, transaction);
        const ref = transaction.collection('square_comment_states').doc(key);
        const old = (await ref.get()).data;
        const field = kind === 'like' ? 'liked' : 'folded';
        const unfold = kind === 'like' && event.active && Boolean(old && old.folded);
        const changed = Boolean(old && old[field]) !== event.active;
        const state = { userId: user._id, postId: id, replyId: target, liked: Boolean(old && old.liked), folded: Boolean(old && old.folded),
          [field]: event.active, ...(unfold ? { folded: false } : {}) };
        const likeCount = kind === 'like' && changed ? Math.max(0, (row.likeCount || 0) + (event.active ? 1 : -1)) : row.likeCount || 0;
        if (changed || unfold) {
          await ref.set({ data: { ...state, updatedAt: db.serverDate() } });
          if (kind === 'like' && changed) await transaction.collection(commentTable(target)).doc(target).update({ data: { likeCount } });
        }
        committed = { row: { ...row, likeCount }, state };
      });
      // 只有上面的事务提交成功才会执行到这里；重试以最后一次回调的快照为准。
      return { reply: (await presentComments([committed.row], user, [committed.state]))[0] };
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
    if (action === 'publishSquarePost' || action === 'publishSquareReply') {
      const isReply = action === 'publishSquareReply';
      // 顶层 event 还会带有云平台的调用元数据，只校验独立的业务对象。
      const input = event.post;
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_POST', '发布页面需要更新，请重新编译后重试');
      if (Object.keys(input).some(key => !['content', 'requestId', 'scope', ...(isReply ? ['postId', 'replyToId'] : ['images', 'declaration'])].includes(key))) fail('INVALID_POST', '发布参数不正确，请重新打开发布页');
      if (input.scope !== 'square') fail('INVALID_POST', '该发布入口仅支持动态广场');
      const declaration = !isReply && input.declaration !== undefined ? input.declaration : 'none';
      if (!DECLARATIONS.includes(declaration)) fail('INVALID_POST', '请选择有效的内容声明');
      const sources = isReply ? [] : imageFiles(input.images, user, identity);
      const content = !isReply && sources.length && typeof input.content === 'string' && !input.content.trim() ? '' : text(input.content, isReply ? 300 : 1000);
      const token = requestId(input.requestId);
      const parentId = isReply ? postId(input.postId) : '';
      if (isReply && input.replyToId !== undefined) commentId(input.replyToId);
      const child = isReply && Boolean(input.replyToId);
      const id = `${child ? 'c' : isReply ? 'r' : 'p'}_${hash(`${user._id}:${isReply ? parentId : 'square'}:${token}`).slice(0, 40)}`;
      const collectionName = child ? 'square_reply_children' : isReply ? 'square_replies' : 'square_posts';
      const [parent, target, previous] = await Promise.all([isReply ? getPost(parentId) : Promise.resolve(null),
        child ? getComment(input.replyToId, parentId) : Promise.resolve(null), db.collection(collectionName).doc(id).get()]);
      if (target && (target.ancestorIds || []).length >= 64) fail('INVALID_POST', '回复层级过多，请直接回复这条一级评论');
      const rootId = target ? target.rootId || target._id : '';
      const existing = previous.data;
      const conflicts = saved => saved.content !== content || (saved.replyToId || '') !== (target ? target._id : '') ||
        !isReply && (JSON.stringify(saved.imageSources || []) !== JSON.stringify(sources) || (saved.declaration || 'none') !== declaration);
      if (existing && conflicts(existing)) fail('REQUEST_CONFLICT', '相同提交标识的内容或回复对象已变更，请重新提交');
      if (!existing && content) await checked(content, identity);
      let images = existing && existing.images || [];
      if (!existing && sources.length) {
        if (!options.processSquareImages) fail('IMAGE_UPLOAD_UNAVAILABLE', '图片发布服务尚未更新，请重新部署 userService');
        try { images = await options.processSquareImages(sources, { userId: user._id, postId: id, identity }); }
        catch (error) {
          if (error.code === 'INVALID_IMAGES') throw error;
          fail('IMAGE_UPLOAD_UNAVAILABLE', '图片保存失败，请稍后重试');
        }
        if (!Array.isArray(images) || images.length !== sources.length || images.some(file => typeof file !== 'string' || !file.startsWith(`cloud://${identity.env}.`))) fail('IMAGE_UPLOAD_UNAVAILABLE', '图片保存未确认，请重试');
      }
      await db.runTransaction(async transaction => {
        active((await transaction.collection('users').doc(user._id).get()).data);
        const ref = transaction.collection(collectionName).doc(id);
        const parentRef = parent && transaction.collection('square_posts').doc(parent._id);
        const saved = (await ref.get()).data;
        const latestParent = parentRef ? visible((await parentRef.get()).data) : null;
        const latestTarget = target ? await getComment(target._id, parent._id, transaction) : null;
        const root = target && (rootId === target._id ? latestTarget : await getComment(rootId, parent._id, transaction));
        if (saved) {
          if (conflicts(saved)) fail('REQUEST_CONFLICT', '本次内容已提交，请勿重复修改请求');
          return;
        }
        await ref.set({ data: { scope: 'square', status: 'published', authorId: user._id, content,
          createdAt: db.serverDate(), sortKey: `${String(Date.now()).padStart(16, '0')}_${id}`,
          ...(isReply ? { postId: parent._id, likeCount: 0, replyCount: 0,
            ...(target ? { rootId, replyToId: target._id, replyToAuthorId: latestTarget.authorId, ancestorIds: [...(latestTarget.ancestorIds || []), latestTarget._id] } : {}) }
            : { likeCount: 0, replyCount: 0, repostCount: 0, images, imageSources: sources, hasImages: images.length > 0, declaration }) } });
        if (parentRef) await parentRef.update({ data: { replyCount: (latestParent.replyCount || 0) + 1 } });
        if (root) await transaction.collection('square_replies').doc(rootId).update({ data: { replyCount: (root.replyCount || 0) + 1 } });
      });
      if (isReply) {
        const [saved, root, post] = await Promise.all([db.collection(collectionName).doc(id).get(),
          rootId ? getComment(rootId, parent._id) : Promise.resolve(null), getPost(parent._id)]);
        const [displayComments, displayPosts] = await Promise.all([presentComments([saved.data, ...(root ? [root] : [])], user), present([post], user)]);
        return { reply: displayComments[0], ...(root ? { root: displayComments[1] } : {}), post: displayPosts[0] };
      }
      return { post: (await present([await getPost(id)], user))[0] };
    }
    if (action === 'setSquareReaction') {
      const id = postId(event.postId), kind = event.kind;
      if (kind !== 'like' || typeof event.active !== 'boolean') fail('INVALID_POST', '当前仅支持点赞互动');
      const key = hash(`${id}:${user._id}:${kind}`);
      await db.runTransaction(async transaction => {
        active((await transaction.collection('users').doc(user._id).get()).data);
        const postRef = transaction.collection('square_posts').doc(id), post = visible((await postRef.get()).data);
        const stateRef = transaction.collection('square_interactions').doc(key), state = (await stateRef.get()).data;
        if (Boolean(state && state.active) === event.active) return;
        await stateRef.set({ data: { userId: user._id, postId: id, kind, active: event.active } });
        await postRef.update({ data: { likeCount: Math.max(0, (post.likeCount || 0) + (event.active ? 1 : -1)) } });
      });
      return { post: (await present([await getPost(id)], user))[0] };
    }
    fail('INVALID_ACTION', '不支持此操作');
  };
}

module.exports = { createSquareService, SQUARE_ACTIONS, SQUARE_CODES };
