const crypto = require('crypto');
const followsModule = require('./square-follows');
const searchModule = require('./square-search');
const { BOT_ID, BOT, createSquareAI } = require('./square-ai');
const { messageFor: aiMessageFor } = require('./ai-errors');
const { createSquarePolisher, POLISH_CODES } = require('./square-polish');
const { checkUnavailableMessage } = require('./wechat-content-check');
const { createReplyHistory } = require('./square-history');
const { createQuoteReader } = require('./square-quotes');
const { createAccountIdService } = require('./account-id');

const SQUARE_ACTIONS = ['getSquareOwnStats', 'listSquarePosts', 'listSquareAlbum', 'getSquarePost', 'publishSquarePost', 'setSquareReaction', 'listSquareReplies', 'listSquareReplyChildren', 'setSquareCommentState', 'publishSquareReply', 'processSquareAIReply', 'deleteSquarePost', 'reportSquarePost', 'deleteSquareReply', 'reportSquareReply', 'optimizeSquareContent'];
const REPORT_REASONS = ['spam', 'illegal', 'sexual', 'abuse', 'other'];
SQUARE_ACTIONS.push('listSquareOwnReplies', 'getSquareReplyContext');
const DECLARATIONS = ['none', 'ai', 'opinion', 'repost', 'fiction', 'marketing'];
const SQUARE_CODES = ['INVALID_POST', 'POST_NOT_FOUND', 'CONTENT_REJECTED', 'CONTENT_CHECK_UNAVAILABLE', 'REQUEST_CONFLICT', 'INVALID_IMAGES', 'IMAGE_UPLOAD_UNAVAILABLE', ...POLISH_CODES];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
SQUARE_CODES.push('QUOTE_UNAVAILABLE');
SQUARE_ACTIONS.push('setSquareProfilePin');
SQUARE_ACTIONS.push('getSquarePublicProfile', 'getSquarePublicAccountInfo');
SQUARE_ACTIONS.push(searchModule.ACTION, ...followsModule.ACTIONS);
SQUARE_CODES.push(...searchModule.CODES);
SQUARE_CODES.push(...followsModule.CODES);
SQUARE_CODES.push('PIN_EXISTS', 'PIN_CHANGED', 'PROFILE_NOT_FOUND');
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
function imageFiles(value, user, identity, maximum = 9) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length) fail('INVALID_IMAGES', `一次最多发送 ${maximum} 张不同的图片`);
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
  const ai = createSquareAI(db, options);
  const accounts = createAccountIdService(db, options);
  async function profileOwner(accountId, viewer) {
    active(viewer);
    const found = await accounts.find(accountId);
    if (!found) fail('PROFILE_NOT_FOUND', '该用户不存在或暂不可查看');
    const owner = (await db.collection('users').doc(found._id).get()).data;
    if (!owner || owner.status !== 'active' || owner.accountId !== accountId || !['user', 'student', 'admin'].includes(owner.role)) fail('PROFILE_NOT_FOUND', '该用户不存在或暂不可查看');
    return owner;
  }
  async function recheckProfile(owner) {
    const current = (await db.collection('users').doc(owner._id).get()).data;
    if (!current || current.accountId !== owner.accountId || current.status !== 'active' || !['user', 'student', 'admin'].includes(current.role)) fail('PROFILE_NOT_FOUND', '该用户不存在或暂不可查看');
    return current;
  }
  profileReads.set(BOT_ID, Promise.resolve(BOT));
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
      return { _id: row._id, content: row.content, images: row.images || [], author: profiles.get(row.authorId), createdAt: row.createdAt, sortKey: row.sortKey || '',
        rootId: row.rootId || '', replyToId: row.replyToId || '', replyToName: row.replyToAuthorId ? profiles.get(row.replyToAuthorId).nickname : '',
        ancestorIds: row.ancestorIds || [], replyCount: row.replyCount || 0, likeCount: row.likeCount || 0,
        isOwn: Boolean(viewer && viewer._id === row.authorId), liked: Boolean(state && state.liked), folded: Boolean(state && state.folded),
        aiStatus: row.askAI === true || row.aiStatus === 'done' ? row.aiStatus || '' : '', aiCanManage: Boolean(row.askAI === true && row.aiStatus && viewer && viewer._id === row.authorId),
        aiMessage: row.aiErrorCode && viewer && viewer._id === row.authorId ? aiMessageFor(row.aiErrorCode) : '',
        aiCanRetry: Boolean(row.askAI === true && row.aiStatus === 'failed' && viewer && viewer._id === row.authorId && (row.aiAttempts || 0) < 2) };
    });
  }
  async function checked(content, identity) {
    if (!options.checkText) fail('CONTENT_CHECK_UNAVAILABLE', '文字校验服务暂不可用，请稍后重试');
    let permitted;
    try { permitted = await options.checkText(content, identity.openid); }
    catch (error) { fail('CONTENT_CHECK_UNAVAILABLE', checkUnavailableMessage(error)); }
    if (!permitted) fail('CONTENT_REJECTED', '这段内容暂时无法发布，请修改后重试');
  }
  const quoteViews = createQuoteReader(db, profilesFor, DECLARATIONS);
  async function present(rows, viewer, preview = false) {
    if (!rows.length) return [];
    const authorIds = [...new Set(rows.map(row => row.authorId))];
    const [authors, quotes, states, quoted] = await Promise.all([profilesFor(authorIds), quoteViews(rows), viewer ? reactions.where({ userId: viewer._id, postId: db.command.in(rows.map(row => row._id)), active: true }).limit(40).get().then(result => result.data) : Promise.resolve([]),
      viewer ? posts.aggregate().match({ scope: 'square', status: 'published', authorId: viewer._id,
        quotePostId: db.command.in(rows.map(row => row._id)) }).group({ _id: '$quotePostId' }).end().then(result => new Set(result.list.map(row => row._id))) : Promise.resolve(new Set())]);
    return rows.map(row => ({ _id: row._id, content: preview ? Array.from(row.content).slice(0, 280).join('') : row.content,
      ...(preview ? { fullContent: row.content } : {}), images: row.images || [], declaration: DECLARATIONS.includes(row.declaration) ? row.declaration : 'none',
      truncated: preview && Array.from(row.content).length > 280, author: authors.get(row.authorId), createdAt: row.createdAt,
      ...(row.quotePostId ? { quotePostId: row.quotePostId, quote: quotes.get(row._id) } : {}), quoteCount: Math.max(0, row.quoteCount || 0), quoteVersion: row.quoteVersion || 0,
      likeCount: row.likeCount || 0, replyCount: row.replyCount || 0, repostCount: 0,
      isOwn: Boolean(viewer && viewer._id === row.authorId),
      liked: states.some(state => state.postId === row._id && state.kind === 'like'),
      quoted: quoted.has(row._id), reposted: false }));
  }
  function pagination(event) {
    const offset = event.offset === undefined ? 0 : event.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) fail('INVALID_POST', '分页参数不正确');
    return offset;
  }
  async function optionalPost(id, viewer) {
    if (!id) return null;
    const row = (await posts.doc(id).get()).data;
    return row && row.scope === 'square' && row.status === 'published' ? (await present([row], viewer))[0] : null;
  }
  const search = searchModule.createSearch(db, { active, fail, profileOwner, recheckProfile, present });
  const follows = followsModule.createFollows(db, { active, fail, profileOwner, recheckProfile, present });
  const history = createReplyHistory(db, { active, fail, postId, commentId, getPost, getComment, presentComments, profilesFor });
  return async function square(action, event, user, identity) {
    // 仅复用本次可信身份查询的资料，不跨请求缓存认证或账号状态。
    if (user) profileReads.set(user._id, Promise.resolve(author(user)));
    if (action === searchModule.ACTION) return search(event, user);
    if (followsModule.ACTIONS.includes(action)) return follows(action, event, user);
    if (action === 'getSquarePublicAccountInfo') {
      const owner = await recheckProfile(await profileOwner(event.accountId, user));
      const verified = author(owner).verified;
      const tracked = Number.isSafeInteger(owner.nicknameChangeCount) && owner.nicknameChangeCount >= 0 && Boolean(owner.nicknameTrackingStartedAt) && typeof owner.nicknameHistoryComplete === 'boolean';
      // 关于此账号单独列出公开字段，不复用本人的资料响应，也不替他人初始化历史。
      return { accountInfo: { user: { accountId: owner.accountId, nickname: owner.nickname, avatarFileID: owner.avatarFileID || '',
        createdAt: owner.createdAt || null, isVerified: verified, schoolName: verified ? owner.schoolName || '' : '' },
        nicknameHistory: { changeCount: tracked ? owner.nicknameChangeCount : null, lastChangedAt: tracked ? owner.nicknameLastChangedAt || null : null,
          trackingStartedAt: tracked ? owner.nicknameTrackingStartedAt : null, historyComplete: tracked ? owner.nicknameHistoryComplete : false } } };
    }
    if (action === 'getSquarePublicProfile') {
      let owner = await profileOwner(event.accountId, user);
      const filter = { scope: 'square', status: 'published', authorId: owner._id };
      const [count, likes] = await Promise.all([posts.where(filter).count(), posts.aggregate().match(filter).group({ _id: null, receivedLikes: db.command.aggregate.sum('$likeCount') }).end()]);
      owner = await recheckProfile(owner);
      return { profile: { accountId: owner.accountId, nickname: owner.nickname, avatarFileID: owner.avatarFileID || '', coverFileID: owner.coverFileID || '',
        bio: owner.bio || '', createdAt: owner.createdAt || null, isVerified: author(owner).verified,
        postCount: count.total, receivedLikes: Math.max(0, likes.list[0] && likes.list[0].receivedLikes || 0) } };
    }
    if (action === 'listSquareOwnReplies' || action === 'getSquareReplyContext') {
      const owner = action === 'listSquareOwnReplies' && event.profileAccountId !== undefined ? await profileOwner(event.profileAccountId, user) : null;
      const result = await history(action, event, user, owner && owner._id);
      if (owner) await recheckProfile(owner);
      return result;
    }
    if (action === 'listSquareAlbum') {
      active(user);
      const owner = event.profileAccountId !== undefined ? await profileOwner(event.profileAccountId, user) : user;
      const offset = pagination(event);
      const rows = (await posts.where({ scope: 'square', status: 'published', authorId: owner._id, hasImages: true })
        .orderBy('sortKey', 'desc').skip(offset).limit(21).get()).data;
      if (event.profileAccountId !== undefined) await recheckProfile(owner);
      return { ...(event.profileAccountId !== undefined ? { profileAccountId: owner.accountId } : {}), items: rows.slice(0, 20).flatMap(row => (row.images || []).map((fileID, index) => ({
        _id: `${row._id}_${index}`, postId: row._id, fileID, createdAt: row.createdAt, index,
      }))), hasMore: rows.length > 20, nextOffset: offset + Math.min(rows.length, 20) };
    }
    if (action === 'listSquarePosts') {
      const offset = pagination(event);
      const mine = event.mine === true;
      const profile = event.profileAccountId !== undefined ? await profileOwner(event.profileAccountId, user) : null;
      if (mine && profile) fail('INVALID_POST', '动态来源参数不正确');
      const postType = event.postType === undefined ? 'all' : event.postType;
      if (!['all', 'posts', 'quotes'].includes(postType) || !mine && !profile && postType !== 'all') fail('INVALID_POST', '动态分类参数不正确');
      if (mine) active(user);
      const base = { scope: 'square', status: 'published', ...(mine || profile ? { authorId: profile ? profile._id : user._id } : {}) };
      // 普通发布不写 quotePostId；引用归属只看最终保存的关系，来源失效也不改变分类。
      const filter = { ...base, ...(postType !== 'all' ? { quotePostId: db.command.exists(postType === 'quotes') } : {}) };
      const [result, count, allCount] = await Promise.all([
        posts.where(filter).orderBy('sortKey', 'desc').skip(offset).limit(21).get(),
        // 总数是导航展示附加信息，读取失败不阻断原有帖子列表。
        (mine || profile) && !offset ? posts.where(filter).count().catch(() => null) : Promise.resolve(null),
        (mine || profile) && !offset && postType !== 'all' ? posts.where(base).count().catch(() => null) : Promise.resolve(null),
      ]);
      const rows = result.data;
      let items = rows.slice(0, 20), profilePin = {};
      if ((mine || profile) && postType === 'posts') {
        const owner = profile || (await db.collection('users').doc(user._id).get()).data;
        active(owner);
        const pinned = owner.squarePinnedPostId ? (await posts.doc(owner.squarePinnedPostId).get()).data : null;
        const valid = pinned && pinned.authorId === owner._id && pinned.scope === 'square' && pinned.status === 'published' && !pinned.quotePostId;
        const pinnedPostId = valid ? pinned._id : '';
        profilePin = { pinnedPostId, pinVersion: owner.squarePinVersion || 0 };
        // 自然时间分页的游标不含额外置顶行，旧动态置顶也不会跳过或重复普通动态。
        items = items.filter(row => row._id !== pinnedPostId);
        if (valid) items.unshift(pinned);
      }
      const presented = await present(items, mine || profile || event.personalize === true ? user : null, true);
      if (profile) await recheckProfile(profile);
      return { ...profilePin, ...(profile ? { profileAccountId: profile.accountId, postType } : {}), ...(mine ? { mine: true, postType } : {}), ...(count ? { total: count.total } : {}), ...(allCount ? { allTotal: allCount.total } : {}), items: presented, hasMore: rows.length > 20, nextOffset: offset + Math.min(rows.length, 20) };
    }
    if (action === 'getSquarePost') return { post: (await present([await getPost(event.postId)], event.personalize === true ? user : null))[0] };
    if (action === 'listSquareReplies' || action === 'listSquareReplyChildren') {
      const id = postId(event.postId), offset = pagination(event);
      const children = action === 'listSquareReplyChildren';
      if (children) commentId(event.rootId);
      const [, root, result] = await Promise.all([getPost(id), children ? getComment(event.rootId, id) : Promise.resolve(null),
        db.collection(children ? 'square_reply_children' : 'square_replies').where({ postId: id, status: 'published',
          ...(children ? { rootId: event.rootId } : {}) }).orderBy('sortKey', children ? 'asc' : 'desc').skip(offset).limit(21).get()]);
      if (root && root.rootId) fail('INVALID_POST', '回复分组不正确');
      const rows = result.data;
      const items = await presentComments(rows.slice(0, 20), event.personalize === true ? user : null);
      return { items, hasMore: rows.length > 20, nextOffset: offset + items.length };
    }
    active(user);
    if (action === 'setSquareProfilePin') {
      const id = postId(event.postId);
      if (typeof event.pinned !== 'boolean') fail('INVALID_POST', '置顶参数不正确');
      let committed;
      await db.runTransaction(async transaction => {
        const ownerRef = transaction.collection('users').doc(user._id), owner = (await ownerRef.get()).data;
        active(owner);
        const row = visible((await transaction.collection('square_posts').doc(id).get()).data);
        if (row.authorId !== user._id) fail('FORBIDDEN', '只能置顶自己的动态');
        if (row.quotePostId) fail('INVALID_POST', '只能置顶动态标签下的普通动态');
        const previous = owner.squarePinnedPostId || '';
        const old = previous && previous !== id ? (await transaction.collection('square_posts').doc(previous).get()).data : row;
        const validOld = previous && old && old.authorId === user._id && old.scope === 'square' && old.status === 'published' && !old.quotePostId;
        if (event.pinned && validOld && previous !== id) fail('PIN_EXISTS', '请先取消当前动态的置顶');
        if (!event.pinned && validOld && previous !== id) fail('PIN_CHANGED', '置顶状态已变化，请刷新后重试');
        const pinnedPostId = event.pinned ? id : '';
        const changed = previous !== pinnedPostId, pinVersion = (owner.squarePinVersion || 0) + (changed ? 1 : 0);
        if (changed) await ownerRef.update({ data: { squarePinnedPostId: pinnedPostId, squarePinVersion: pinVersion } });
        committed = { pinnedPostId, pinVersion, row };
      });
      return { pinnedPostId: committed.pinnedPostId, pinVersion: committed.pinVersion, post: (await present([committed.row], user, true))[0] };
    }
    if (action === 'getSquareOwnStats') {
      // 由可信会话限定本人，聚合全部已发布动态，不受列表分页范围影响。
      const result = await posts.aggregate().match({ scope: 'square', status: 'published', authorId: user._id })
        .group({ _id: null, receivedLikes: db.command.aggregate.sum('$likeCount') }).end();
      const count = result.list.length ? result.list[0].receivedLikes : 0;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid received likes');
      return { receivedLikes: count };
    }
    if (action === 'optimizeSquareContent') return createSquarePolisher(db, options)(event.content, user, identity, imageFiles(event.images, user, identity));
    if (action === 'processSquareAIReply') {
      const id = postId(event.postId), targetId = commentId(event.replyId);
      const result = await ai.process(id, targetId, user, identity);
      const target = await getComment(targetId, id);
      const rootId = target.rootId || target._id;
      const root = rootId === targetId ? target : await getComment(rootId, id);
      const botReply = result.replyId ? await getComment(result.replyId, id) : null;
      return { ...result, target: (await presentComments([target], user))[0], root: (await presentComments([root], user))[0],
        ...(botReply ? { reply: (await presentComments([botReply], user))[0] } : {}), post: (await present([await getPost(id)], user))[0] };
    }
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
    if (action === 'deleteSquareReply') {
      const id = postId(event.postId), target = commentId(event.replyId);
      let committed;
      await db.runTransaction(async transaction => {
        active((await transaction.collection('users').doc(user._id).get()).data);
        const postRef = transaction.collection('square_posts').doc(id), post = visible((await postRef.get()).data);
        const ref = transaction.collection(commentTable(target)).doc(target), row = (await ref.get()).data;
        if (!row || row.postId !== id) fail('POST_NOT_FOUND', '评论不存在或已不可见');
        if (row.authorId !== user._id) fail('FORBIDDEN', '只能删除自己的评论');
        const root = row.rootId ? await getComment(row.rootId, id, transaction) : null;
        let updatedPost = post, updatedRoot = root;
        if (row.status !== 'deleted') {
          if (row.status !== 'published') fail('POST_NOT_FOUND', '评论不存在或已不可见');
          // 一级评论作为整组的可见性开关，无需批量改写全部楼中回复。
          const removedCount = root ? 1 : 1 + (row.replyCount || 0);
          updatedPost = { ...post, replyCount: Math.max(0, (post.replyCount || 0) - removedCount) };
          if (root) updatedRoot = { ...root, replyCount: Math.max(0, (root.replyCount || 0) - 1) };
          await ref.update({ data: { status: 'deleted', deletedAt: db.serverDate() } });
          await postRef.update({ data: { replyCount: updatedPost.replyCount } });
          if (root) await transaction.collection('square_replies').doc(root._id).update({ data: { replyCount: updatedRoot.replyCount } });
        }
        committed = { post: updatedPost, root: updatedRoot, rootId: row.rootId || '' };
      });
      return { deletedId: target, rootId: committed.rootId, post: (await present([committed.post], user))[0],
        ...(committed.root ? { root: (await presentComments([committed.root], user))[0] } : {}) };
    }
    if (action === 'reportSquareReply') {
      const id = postId(event.postId), target = commentId(event.replyId), reason = event.reason;
      if (!REPORT_REASONS.includes(reason)) fail('INVALID_POST', '请选择举报原因');
      const reportId = hash(`report:comment:${user._id}:${target}`);
      let alreadyReported = false;
      await db.runTransaction(async transaction => {
        active((await transaction.collection('users').doc(user._id).get()).data);
        visible((await transaction.collection('square_posts').doc(id).get()).data);
        const row = await getComment(target, id, transaction);
        if (row.rootId) await getComment(row.rootId, id, transaction);
        if (row.authorId === user._id) fail('FORBIDDEN', '不能举报自己的评论');
        const ref = transaction.collection('square_reports').doc(reportId);
        if ((await ref.get()).data) { alreadyReported = true; return; }
        await ref.set({ data: { targetType: 'comment', postId: id, replyId: target, rootId: row.rootId || '',
          reporterId: user._id, authorId: row.authorId, reason, status: 'pending', createdAt: db.serverDate(), commentContent: row.content, commentImages: row.images || [] } });
      });
      return { reportId, alreadyReported };
    }
    if (action === 'deleteSquarePost') {
      const id = postId(event.postId);
      let quotedId = '';
      await db.runTransaction(async transaction => {
        const ownerRef = transaction.collection('users').doc(user._id), owner = (await ownerRef.get()).data;
        active(owner);
        const ref = transaction.collection('square_posts').doc(id), post = (await ref.get()).data;
        if (!post || post.scope !== 'square') fail('POST_NOT_FOUND', '动态不存在或已不可见');
        if (post.authorId !== user._id) fail('FORBIDDEN', '只能删除自己发布的动态');
        const quoteRef = post.quotePostId && transaction.collection('square_posts').doc(post.quotePostId);
        const quote = quoteRef ? (await quoteRef.get()).data : null;
        if (owner.squarePinnedPostId === id) await ownerRef.update({ data: { squarePinnedPostId: '', squarePinVersion: (owner.squarePinVersion || 0) + 1 } });
        if (post.status !== 'deleted') {
          await ref.update({ data: { status: 'deleted', deletedAt: db.serverDate() } });
          if (quote && quote.scope === 'square') await quoteRef.update({ data: { quoteCount: Math.max(0, (quote.quoteCount || 0) - 1), quoteVersion: (quote.quoteVersion || 0) + 1 } });
        }
        if (quote && quote.status === 'published') quotedId = quote._id;
      });
      const quotedPost = await optionalPost(quotedId, user);
      return { deletedId: id, ...(quotedPost ? { quotedPost } : {}) };
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
      if (Object.keys(input).some(key => !['content', 'requestId', 'scope', 'images', ...(isReply ? ['postId', 'replyToId', 'askAI'] : ['declaration', 'quotePostId'])].includes(key))) fail('INVALID_POST', '发布参数不正确，请重新打开发布页');
      if (isReply && input.askAI !== undefined && typeof input.askAI !== 'boolean') fail('INVALID_POST', 'AI 唤起参数不正确');
      const askAI = isReply && input.askAI === true;
      if (input.scope !== 'square') fail('INVALID_POST', '该发布入口仅支持动态广场');
      const declaration = !isReply && input.declaration !== undefined ? input.declaration : 'none';
      if (!DECLARATIONS.includes(declaration)) fail('INVALID_POST', '请选择有效的内容声明');
      const quoteId = !isReply && input.quotePostId !== undefined ? postId(input.quotePostId) : '';
      async function quoted(source = db) {
        if (!quoteId) return null;
        const row = (await source.collection('square_posts').doc(quoteId).get()).data;
        if (!row || row.scope !== 'square' || row.status !== 'published') fail('QUOTE_UNAVAILABLE', '被引用的动态已删除或不可见，请移除引用后重试');
        return row;
      }
      const sources = imageFiles(input.images, user, identity, isReply ? 3 : 9);
      // 动态与回复都按原始 Unicode 码点计数，空格、换行和标点也占额度。
      const maximum = isReply ? 50 : 150;
      if (typeof input.content === 'string' && Array.from(input.content).length > maximum) fail('INVALID_POST', `最多输入${maximum}字（含空格和标点）`);
      const content = (sources.length || quoteId) && typeof input.content === 'string' && !input.content.trim() ? '' : text(input.content, maximum);
      const token = requestId(input.requestId);
      const parentId = isReply ? postId(input.postId) : '';
      if (isReply && input.replyToId !== undefined) commentId(input.replyToId);
      const child = isReply && Boolean(input.replyToId);
      const id = `${child ? 'c' : isReply ? 'r' : 'p'}_${hash(`${user._id}:${isReply ? parentId : 'square'}:${token}`).slice(0, 40)}`;
      if (quoteId === id) fail('INVALID_POST', '不能引用本次发布的动态');
      const collectionName = child ? 'square_reply_children' : isReply ? 'square_replies' : 'square_posts';
      const [parent, target, previous] = await Promise.all([isReply ? getPost(parentId) : Promise.resolve(null),
        child ? getComment(input.replyToId, parentId) : Promise.resolve(null), db.collection(collectionName).doc(id).get()]);
      if (target && (target.ancestorIds || []).length >= 64) fail('INVALID_POST', '回复层级过多，请直接回复这条一级评论');
      const rootId = target ? target.rootId || target._id : '';
      const existing = previous.data;
      const conflicts = saved => saved.content !== content || (saved.replyToId || '') !== (target ? target._id : '') ||
        isReply && Boolean(saved.askAI) !== askAI ||
        JSON.stringify(saved.imageSources || []) !== JSON.stringify(sources) || !isReply && ((saved.declaration || 'none') !== declaration || (saved.quotePostId || '') !== quoteId);
      if (existing && conflicts(existing)) fail('REQUEST_CONFLICT', '相同提交标识的内容或回复对象已变更，请重新提交');
      if (!existing) await quoted();
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
        const latestQuote = saved ? null : await quoted(transaction);
        if (saved) {
          if (conflicts(saved)) fail('REQUEST_CONFLICT', '本次内容已提交，请勿重复修改请求');
          return;
        }
        const aiFields = isReply ? await ai.enqueue(transaction, { _id: id, authorId: user._id, postId: parent._id, content, askAI,
          ancestorIds: target ? [...(latestTarget.ancestorIds || []), latestTarget._id] : [] }) : {};
        await ref.set({ data: { scope: 'square', status: 'published', authorId: user._id, content, ...aiFields,
          createdAt: db.serverDate(), sortKey: `${String(Date.now()).padStart(16, '0')}_${id}`,
          ...(isReply ? { postId: parent._id, likeCount: 0, replyCount: 0, askAI, images, imageSources: sources,
            ...(target ? { rootId, replyToId: target._id, replyToAuthorId: latestTarget.authorId, ancestorIds: [...(latestTarget.ancestorIds || []), latestTarget._id] } : {}) }
            : { likeCount: 0, replyCount: 0, repostCount: 0, quoteCount: 0, quoteVersion: 0, images, imageSources: sources, hasImages: images.length > 0, declaration, ...(quoteId ? { quotePostId: quoteId } : {}) }) } });
        if (parentRef) await parentRef.update({ data: { replyCount: (latestParent.replyCount || 0) + 1 } });
        if (root) await transaction.collection('square_replies').doc(rootId).update({ data: { replyCount: (root.replyCount || 0) + 1 } });
        if (latestQuote) await transaction.collection('square_posts').doc(quoteId).update({ data: { quoteCount: (latestQuote.quoteCount || 0) + 1, quoteVersion: (latestQuote.quoteVersion || 0) + 1 } });
      });
      if (isReply) {
        const [saved, root, post] = await Promise.all([db.collection(collectionName).doc(id).get(),
          rootId ? getComment(rootId, parent._id) : Promise.resolve(null), getPost(parent._id)]);
        const [displayComments, displayPosts] = await Promise.all([presentComments([saved.data, ...(root ? [root] : [])], user), present([post], user)]);
        return { reply: displayComments[0], ...(root ? { root: displayComments[1] } : {}), post: displayPosts[0] };
      }
      const quotedPost = await optionalPost(quoteId, user);
      return { post: (await present([await getPost(id)], user))[0], ...(quotedPost ? { quotedPost } : {}) };
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
