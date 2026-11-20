const users = require('./user');
const { projectComment, reactComment } = require('../utils/comment-state');
const { newestComments, oldestComments } = require('../utils/comment-order');
const TTL = 60000;
let owner, generation = 0, feed = null, ownFeed = null, albumFeed = null, mutation = 0, removals = 0, published = false;
const posts = new Map(), postTimes = new Map(), replies = new Map(), pending = new Map(), revisions = new Map();
const deleted = new Set();
const likeWrites = new Map(), postListeners = new Set();
const children = new Map(), comments = new Map(), commentVersions = new Map();
const commentWrites = new Map(), commentListeners = new Set();
const aiWrites = new Map(), aiListeners = new Set();
const deletedComments = new Set();
let commentRemovals = 0;
const commentGone = row => deletedComments.has(row._id) || row.rootId && deletedComments.has(row.rootId);
function subscribeAI(listener) { aiListeners.add(listener); return () => aiListeners.delete(listener); }
function session() {
  const current = users.getCachedUser();
  const key = `${current ? current._id : 'guest'}:${users.getSessionVersion()}`;
  if (key !== owner) { owner = key; generation += 1; feed = null; ownFeed = null; albumFeed = null; published = false; posts.clear(); postTimes.clear(); replies.clear(); children.clear(); comments.clear(); commentVersions.clear(); commentWrites.clear(); aiWrites.clear(); pending.clear(); revisions.clear(); deleted.clear(); deletedComments.clear(); commentRemovals = 0; likeWrites.clear(); }
  return key;
}
function cachedFeed() { session(); return feed && feed.value; }
function cachedAlbum() { session(); return albumFeed && albumFeed.value; }
function cachedOwnFeed() {
  session();
  if (!ownFeed && feed) {
    const user = users.getCachedUser();
    const items = user && user.accountId ? feed.value.items.filter(post => post.author.accountId === user.accountId) : [];
    // 首页已有的本人动态先展示，分页完整性仍由后台的本人查询确认。
    if (items.length) ownFeed = { time: 0, value: { items, hasMore: true, nextOffset: 0 } };
  }
  if (!ownFeed) return null;
  ownFeed.value.items = ownFeed.value.items.map(post => posts.has(post._id) ? previewPost(posts.get(post._id)) : post);
  return ownFeed.value;
}
function cachedPost(id) { session(); return posts.get(id) || (feed && feed.value.items.find(item => item._id === id)) || null; }
function cachedReplies(id) { session(); return replies.get(id) || null; }
function cachedChildren(id, rootId) { session(); return children.get(`${id}:${rootId}`) || null; }
function cachedComment(id) { session(); return comments.get(id) || null; }
function subscribeComment(listener) { commentListeners.add(listener); return () => commentListeners.delete(listener); }
function saveComment(row, changed = false, notify = false) {
  if (commentGone(row)) return;
  comments.set(row._id, row);
  if (changed) commentVersions.set(row._id, ++mutation);
  for (const list of [...replies.values(), ...children.values()]) list.items = list.items.map(item => item._id === row._id ? row : item);
  if (notify) for (const listener of commentListeners) {
    try { listener(row); } catch (error) { /* 展示订阅不能影响后台保存。 */ }
  }
}
function pendingComment(row) { const write = commentWrites.get(row._id); return write ? projectComment(row, write.desired) : row; }
function previewPost(post) {
  const content = post.fullContent || post.content;
  return { ...post, content: Array.from(content).slice(0, 280).join(''), fullContent: content, truncated: Array.from(content).length > 280 };
}
function likedPost(post, liked) {
  if (!post) return null;
  const delta = Boolean(post.liked) === liked ? 0 : liked ? 1 : -1;
  return { ...post, liked, likeCount: Math.max(0, (Number(post.likeCount) || 0) + delta) };
}
function pendingLike(post) {
  const write = likeWrites.get(post._id);
  return write ? likedPost(post, write.desired) : post;
}
function subscribePost(listener) { postListeners.add(listener); return () => postListeners.delete(listener); }
function updatePost(post, prepend = false) {
  if (deleted.has(post._id)) return;
  post = pendingLike(post);
  posts.set(post._id, post);
  postTimes.set(post._id, Date.now());
  if (feed) {
    const found = feed.value.items.some(item => item._id === post._id);
    feed.value.items = feed.value.items.map(item => item._id === post._id ? previewPost(post) : item);
    if (prepend && !found) feed.value.items.unshift(previewPost(post));
  } else if (prepend) feed = { time: 0, value: { items: [previewPost(post)], hasMore: true, nextOffset: 0 } };
  if (ownFeed) {
    const found = ownFeed.value.items.some(item => item._id === post._id);
    ownFeed.value.items = ownFeed.value.items.map(item => item._id === post._id ? previewPost(post) : item);
    if (prepend && !found) {
      ownFeed.value.items.unshift(previewPost(post));
      ownFeed.value.nextOffset += 1;
      if (Number.isSafeInteger(ownFeed.value.total)) ownFeed.value.total += 1;
    }
  } else if (prepend) ownFeed = { time: 0, value: { items: [previewPost(post)], hasMore: true, nextOffset: 0 } };
  for (const listener of postListeners) {
    try { listener(post); } catch (error) { /* 页面观察者不能影响已完成的保存或缓存更新。 */ }
  }
}
function unavailable(id) {
  if (deleted.has(id)) throw Object.assign(new Error('动态不存在或已不可见'), { code: 'POST_NOT_FOUND' });
}
function removePost(id, knownOwn = false) {
  const newlyRemoved = !deleted.has(id);
  const row = posts.get(id) || (ownFeed && ownFeed.value.items.find(item => item._id === id));
  const own = knownOwn || Boolean(row && (row.isOwn || row.author && users.getCachedUser() && users.getCachedUser().accountId && row.author.accountId === users.getCachedUser().accountId));
  if (!deleted.has(id)) removals += 1;
  deleted.add(id);
  if (albumFeed) {
    if (albumFeed.value.items.some(item => item.postId === id)) albumFeed.value.nextOffset = Math.max(0, albumFeed.value.nextOffset - 1);
    albumFeed.value.items = albumFeed.value.items.filter(item => item.postId !== id);
    albumFeed.time = 0;
  }
  revisions.set(id, ++mutation);
  posts.delete(id); postTimes.delete(id); replies.delete(id);
  if (newlyRemoved && own && ownFeed && Number.isSafeInteger(ownFeed.value.total)) ownFeed.value.total = Math.max(0, ownFeed.value.total - 1);
  for (const key of children.keys()) if (key.startsWith(`${id}:`)) children.delete(key);
  for (const cached of [feed, ownFeed]) if (cached) {
    const removed = cached.value.items.some(post => post._id === id);
    cached.value.items = cached.value.items.filter(post => post._id !== id);
    if (removed) cached.value.nextOffset = Math.max(0, cached.value.nextOffset - 1);
    cached.time = 0;
  }
}
async function call(action, data = {}, authenticated = false) {
  session();
  if (authenticated && !users.getCachedUser()) throw Object.assign(new Error('请先登录'), { code: 'UNAUTHENTICATED' });
  const version = generation;
  let response;
  try { response = await wx.cloud.callFunction({ name: 'userService', data: { action, ...data, ...(!authenticated ? { personalize: Boolean(users.getCachedUser()) } : {}) } }); }
  catch (error) { throw new Error('暂时无法连接广场，请稍后重试'); }
  session();
  if (version !== generation) throw Object.assign(new Error('登录状态已变更，请重试'), { code: 'SESSION_CHANGED' });
  const result = response.result;
  if (!result || !result.success) {
    if (result && ['ACCOUNT_DISABLED', 'NOT_REGISTERED', 'UNAUTHENTICATED', 'INVALID_ROLE'].includes(result.code)) users.logout();
    throw Object.assign(new Error(result && result.code !== 'INVALID_ACTION' ? result.message :
      ['processSquareAIReply', 'optimizeSquareContent'].includes(action) ? 'AI 服务需要更新，请重新部署整个 userService' : action === 'listSquareAlbum' ? '相册服务需要更新，请重新部署 userService 云函数' :
        ['listSquareReplyChildren', 'setSquareCommentState'].includes(action) ? '评论服务需要更新，请重新部署 userService 云函数' : '动态广场暂时无法连接，请稍后重试'), { code: result && result.code });
  }
  if (!result.square) throw new Error('动态读取失败，请重试');
  return result.square;
}
function merged(key, request) {
  if (pending.has(key)) return pending.get(key);
  const promise = request().finally(() => { if (pending.get(key) === promise) pending.delete(key); });
  pending.set(key, promise);
  return promise;
}
function list({ force = false, offset = 0, mine = false } = {}) {
  session();
  const cached = mine ? ownFeed : feed;
  if (!force && !offset && cached && Date.now() - cached.time < TTL) return Promise.resolve(cached.value);
  return merged(`${mine ? 'own' : 'feed'}:${offset}`, async () => {
    const revision = mutation;
    const before = new Map(revisions);
    let requestOffset = offset, removalVersion = removals;
    let result = await call('listSquarePosts', { offset: requestOffset, ...(mine ? { mine: true } : {}) }, mine);
    // 删除会移动服务端分页位置，旧分页返回时重新对齐首页，防止跳过一条动态。
    if (removalVersion !== removals) {
      requestOffset = 0; removalVersion = removals;
      result = await call('listSquarePosts', { offset: 0, ...(mine ? { mine: true } : {}) }, mine);
      if (removalVersion !== removals) throw new Error('动态列表已更新，请刷新后重试');
    }
    if (mine && result.mine !== true) throw new Error('个人动态服务需要更新，请重新部署 userService 云函数');
    const currentItems = result.items.filter(post => !deleted.has(post._id)).map(post => pendingLike(before.get(post._id) !== revisions.get(post._id) && posts.has(post._id) ? previewPost(posts.get(post._id)) : post));
    const timestamp = post => new Date(post.createdAt && post.createdAt.$date || post.createdAt).getTime() || 0;
    const latest = mine ? ownFeed : feed;
    const items = (requestOffset || revision !== mutation) && latest ? [...new Map([...latest.value.items, ...currentItems].map(item => [item._id, item])).values()].sort((a, b) => timestamp(b) - timestamp(a)) : currentItems;
    const total = mine && latest && (requestOffset || revision !== mutation) && Number.isSafeInteger(latest.value.total) ? latest.value.total : result.total;
    const saved = { value: { ...result, ...(mine && Number.isSafeInteger(total) ? { total } : {}), items }, time: Date.now() };
    if (mine) ownFeed = saved;
    else feed = saved;
    for (const post of items) if (!post.truncated || typeof post.fullContent === 'string') {
      posts.set(post._id, { ...post, content: post.fullContent || post.content, truncated: false }); postTimes.set(post._id, Date.now());
    }
    return saved.value;
  });
}
function detail(id, force = false) {
  session();
  try { unavailable(id); } catch (error) { return Promise.reject(error); }
  if (!force && posts.has(id) && Date.now() - postTimes.get(id) < TTL) return Promise.resolve(posts.get(id));
  return merged(`post:${id}`, async () => {
    const revision = revisions.get(id);
    let result;
    try { result = await call('getSquarePost', { postId: id }); }
    catch (error) { if (error.code === 'POST_NOT_FOUND') removePost(id); throw error; }
    unavailable(id);
    if (revision !== revisions.get(id) && posts.has(id)) return posts.get(id);
    updatePost(result.post);
    return posts.get(id);
  });
}
function listReplies(id, { offset = 0, force = false } = {}) {
  return readComments(id, '', { offset, force });
}
function listChildren(id, rootId, { offset = 0, force = false } = {}) {
  return readComments(id, rootId, { offset, force });
}
function readComments(id, rootId, { offset, force }) {
  session();
  try { unavailable(id); } catch (error) { return Promise.reject(error); }
  if (rootId && deletedComments.has(rootId)) return Promise.reject(new Error('评论不存在或已不可见'));
  const store = rootId ? children : replies, key = rootId ? `${id}:${rootId}` : id;
  if (!force && !offset && store.has(key) && Date.now() - store.get(key).time < TTL) return Promise.resolve(store.get(key));
  return merged(`replies:${key}:${offset}`, async () => {
    const revision = revisions.get(id);
    const versions = new Map(commentVersions);
    const beforeRemovals = commentRemovals;
    let result = await call(rootId ? 'listSquareReplyChildren' : 'listSquareReplies', { postId: id, offset, ...(rootId ? { rootId } : {}) });
    if (beforeRemovals !== commentRemovals) {
      const currentRemovals = commentRemovals;
      result = await call(rootId ? 'listSquareReplyChildren' : 'listSquareReplies', { postId: id, offset: 0, ...(rootId ? { rootId } : {}) });
      offset = 0;
      if (currentRemovals !== commentRemovals) throw new Error('评论已更新，请重试');
    }
    unavailable(id);
    if (rootId && deletedComments.has(rootId)) throw new Error('评论不存在或已不可见');
    const previous = store.get(key);
    const rows = result.items.map(row => pendingComment(versions.get(row._id) !== commentVersions.get(row._id) && comments.has(row._id) ? comments.get(row._id) : row));
    const value = { ...result, time: Date.now(), items: (offset || revision !== revisions.get(id)) && previous ? [...new Map([...previous.items, ...rows].map(item => [item._id, item])).values()] : rows };
    value.items = (rootId ? oldestComments : newestComments)(value.items.filter(row => !commentGone(row)));
    store.set(key, value);
    for (const row of value.items) comments.set(row._id, row);
    return value;
  });
}
async function publish(content, requestId, images = [], declaration = 'none') {
  const result = await call('publishSquarePost', { post: { content, requestId, scope: 'square', ...(images.length ? { images } : {}),
    ...(declaration !== 'none' ? { declaration } : {}) } }, true);
  revisions.set(result.post._id, ++mutation);
  updatePost(result.post, true);
  const added = (result.post.images || []).map((fileID, index) => ({ _id: `${result.post._id}_${index}`, postId: result.post._id, fileID, createdAt: result.post.createdAt, index }));
  if (added.length) {
    const previous = albumFeed && albumFeed.value;
    albumFeed = { time: 0, value: { items: [...added, ...(previous ? previous.items.filter(item => item.postId !== result.post._id) : [])],
      hasMore: previous ? previous.hasMore : true, nextOffset: previous ? previous.nextOffset + (previous.items.some(item => item.postId === result.post._id) ? 0 : 1) : 0 } };
  }
  published = true;
  return result.post;
}
function album({ force = false, offset = 0 } = {}) {
  session();
  if (!force && !offset && albumFeed && Date.now() - albumFeed.time < TTL) return Promise.resolve(albumFeed.value);
  return merged(`album:${offset}`, async () => {
    const revision = mutation, beforeRemovals = removals;
    let result = await call('listSquareAlbum', { offset }, true);
    if (beforeRemovals !== removals) {
      const removalVersion = removals;
      result = await call('listSquareAlbum', { offset: 0 }, true); offset = 0;
      if (removalVersion !== removals) throw new Error('相册已更新，请刷新后重试');
    }
    const previous = albumFeed && albumFeed.value;
    const incoming = result.items.filter(item => !deleted.has(item.postId));
    const items = (offset || revision !== mutation) && previous ? [...new Map([...previous.items, ...incoming].map(item => [item._id, item])).values()] : incoming;
    albumFeed = { time: Date.now(), value: { ...result, items } };
    return albumFeed.value;
  });
}
function react(id, kind, active, sourcePost) {
  session();
  if (kind !== 'like' || typeof active !== 'boolean') return Promise.reject(Object.assign(new Error('该互动功能暂未开放'), { code: 'INVALID_POST' }));
  if (!users.getCachedUser()) return Promise.reject(Object.assign(new Error('请先登录'), { code: 'UNAUTHENTICATED' }));
  try { unavailable(id); } catch (error) { return Promise.reject(error); }
  const existing = likeWrites.get(id);
  const write = existing || { confirmed: cachedPost(id) || sourcePost || null, version: generation };
  write.desired = active;
  likeWrites.set(id, write);
  revisions.set(id, ++mutation);
  const cached = cachedPost(id) || write.confirmed;
  if (cached) updatePost(likedPost(cached, active));
  if (existing) return write.promise;
  write.promise = saveLike(id, write);
  return write.promise;
}
async function saveLike(id, write) {
  const valid = () => { session(); return generation === write.version && likeWrites.get(id) === write; };
  const merge = row => {
    const latest = posts.get(id);
    return latest ? { ...latest, liked: Boolean(row.liked), likeCount: row.likeCount || 0 } : row;
  };
  try {
    do {
      const target = write.desired;
      const result = await call('setSquareReaction', { postId: id, kind: 'like', active: target }, true);
      if (!valid()) throw Object.assign(new Error('登录状态已变更，请重试'), { code: 'SESSION_CHANGED' });
      unavailable(id);
      if (!result.post || typeof result.post.liked !== 'boolean') throw new Error('点赞状态未确认，请重试');
      write.confirmed = merge(result.post);
      if (result.post.liked !== target) throw new Error('点赞状态未确认，请重试');
      revisions.set(id, ++mutation);
      if (write.desired === Boolean(result.post.liked)) {
        likeWrites.delete(id);
        updatePost(write.confirmed);
        return posts.get(id);
      }
      updatePost(write.confirmed);
    } while (valid());
  } catch (error) {
    if (valid()) {
      likeWrites.delete(id);
      revisions.set(id, ++mutation);
      if (write.confirmed) updatePost(merge(write.confirmed));
      if (feed) feed.time = 0;
      if (ownFeed) ownFeed.time = 0;
      postTimes.delete(id);
    }
    throw error;
  }
}
async function reply(id, content, requestId, replyToId, askAI = false, images = []) {
  if (!Array.isArray(images) || images.length > 3 || new Set(images).size !== images.length || images.some(file => typeof file !== 'string' || !file.startsWith('cloud://')))
    throw Object.assign(new Error('一次最多发送3张已上传图片'), { code: 'INVALID_IMAGES' });
  if (typeof content !== 'string' || !content.trim() && !images.length || Array.from(content).length > 50) throw Object.assign(new Error('评论最多输入50字（含空格和标点）'), { code: 'INVALID_POST' });
  const result = await call('publishSquareReply', { post: { postId: id, content, requestId, scope: 'square', ...(replyToId ? { replyToId } : {}), ...(askAI === true ? { askAI: true } : {}), ...(images.length ? { images: [...images] } : {}) } }, true);
  unavailable(id);
  revisions.set(id, ++mutation);
  updatePost(result.post);
  const rootId = result.reply.rootId;
  const store = rootId ? children : replies, key = rootId ? `${id}:${rootId}` : id;
  const existing = store.get(key);
  if (existing) existing.items = (rootId ? oldestComments : newestComments)([...new Map([...existing.items, result.reply].map(item => [item._id, item])).values()]);
  else store.set(key, { items: [result.reply], hasMore: true, nextOffset: 0, time: 0 });
  result.reply = pendingComment(result.reply);
  saveComment(result.reply, true);
  if (result.root) { result.root = pendingComment(result.root); saveComment(result.root, true); }
  return result;
}
function processAIReply(id, replyId) {
  session();
  if (deletedComments.has(replyId)) return Promise.reject(new Error('评论不存在或已不可见'));
  if (aiWrites.has(replyId)) return aiWrites.get(replyId);
  const version = generation, beforeRemovals = commentRemovals;
  const request = call('processSquareAIReply', { postId: id, replyId }, true).then(async result => {
    unavailable(id);
    if ([result.target, result.root, result.reply].filter(Boolean).some(commentGone)) throw new Error('评论不存在或已不可见');
    if (beforeRemovals !== commentRemovals) {
      // 删除与生成交错时重新取任务的已完成结果，不沿用删除前的数量快照。
      const removalVersion = commentRemovals, created = result.created;
      result = { ...await call('processSquareAIReply', { postId: id, replyId }, true), created };
      unavailable(id);
      if (removalVersion !== commentRemovals || [result.target, result.root, result.reply].filter(Boolean).some(commentGone)) throw new Error('评论已更新，请重试');
    }
    revisions.set(id, ++mutation);
    const before = cachedPost(id);
    if (result.post) updatePost({ ...result.post, replyCount: Math.max(result.post.replyCount || 0, before && before.replyCount || 0) });
    for (const row of [result.target, result.root].filter(Boolean)) saveComment(pendingComment({ ...row,
      replyCount: Math.max(row.replyCount || 0, comments.get(row._id) && comments.get(row._id).replyCount || 0) }), true, true);
    if (result.reply) {
      const row = pendingComment(result.reply), key = `${id}:${row.rootId}`, previous = children.get(key);
      children.set(key, { ...(previous || { hasMore: true, nextOffset: 0, time: 0 }),
        items: oldestComments([...new Map([...(previous ? previous.items : []), row].map(item => [item._id, item])).values()]) });
      saveComment(row, true);
      for (const listener of aiListeners) { try { listener({ postId: id, ...result, reply: row }); } catch (error) { /* 页面展示不影响已提交回复。 */ } }
    }
    return result;
  }).catch(error => {
    session();
    if (generation === version && !deleted.has(id) && error.code !== 'SESSION_CHANGED') {
      const row = comments.get(replyId);
      if (row) saveComment({ ...row, aiStatus: 'failed', aiCanRetry: true, aiMessage: error.message || 'AI 请求失败，请重试' }, true, true);
    }
    throw error;
  }).finally(() => {
    session();
    if (generation === version && users.invalidateAIUsage) users.invalidateAIUsage();
    if (aiWrites.get(replyId) === request) aiWrites.delete(replyId);
  });
  aiWrites.set(replyId, request);
  return request;
}
function warmReplyChildren(id, rows) {
  session();
  // 只预取最靠前的两个回复组，展开时复用同一请求，不为所有评论建请求。
  for (const row of rows.filter(row => !row.folded && row.replyCount > 0).slice(0, 2)) listChildren(id, row._id).catch(() => {});
}
function commentState(id, replyId, kind, active, sourceRow) {
  session();
  if (!['like', 'fold'].includes(kind) || typeof active !== 'boolean') return Promise.reject(new Error('评论操作参数不正确'));
  if (!users.getCachedUser()) return Promise.reject(Object.assign(new Error('请先登录'), { code: 'UNAUTHENTICATED' }));
  try { unavailable(id); } catch (error) { return Promise.reject(error); }
  const existing = commentWrites.get(replyId), row = comments.get(replyId) || sourceRow;
  if (deletedComments.has(replyId) || row && commentGone(row)) return Promise.reject(new Error('评论不存在或已不可见'));
  if (!row) return call('setSquareCommentState', { postId: id, replyId, kind, active }, true).then(result => {
    unavailable(id); saveComment(result.reply, true, true); return result.reply;
  });
  const write = existing || { confirmed: row, version: generation, postId: id, initial: { kind, active } };
  const optimistic = reactComment(row, kind, active);
  write.desired = { liked: optimistic.liked, folded: optimistic.folded };
  commentWrites.set(replyId, write);
  saveComment(optimistic, true, true);
  if (existing) return write.promise;
  write.promise = saveCommentState(replyId, write);
  return write.promise;
}
async function saveCommentState(replyId, write) {
  const valid = () => { session(); return generation === write.version && commentWrites.get(replyId) === write; };
  let first = true;
  try {
    while (valid()) {
      const target = { ...write.desired };
      const kind = Boolean(write.confirmed.liked) !== target.liked ? 'like' : Boolean(write.confirmed.folded) !== target.folded ? 'fold' : first ? write.initial.kind : '';
      if (!kind) break;
      const active = kind === 'like' ? target.liked : target.folded;
      first = false;
      const result = await call('setSquareCommentState', { postId: write.postId, replyId, kind, active }, true);
      if (!valid()) throw Object.assign(new Error('登录状态已变更，请重试'), { code: 'SESSION_CHANGED' });
      unavailable(write.postId);
      const row = result.reply;
      if (!row || row._id !== replyId || Boolean(row[kind === 'like' ? 'liked' : 'folded']) !== active || kind === 'like' && active && row.folded) throw new Error('评论状态未确认，请重试');
      write.confirmed = { ...(comments.get(replyId) || write.confirmed), liked: Boolean(row.liked), folded: Boolean(row.folded), likeCount: row.likeCount || 0 };
      saveComment(projectComment(write.confirmed, write.desired), true, true);
    }
    if (!valid()) throw Object.assign(new Error('登录状态已变更，请重试'), { code: 'SESSION_CHANGED' });
    commentWrites.delete(replyId);
    saveComment(write.confirmed, true, true);
    return write.confirmed;
  } catch (error) {
    if (valid()) {
      commentWrites.delete(replyId);
      if (!deleted.has(write.postId)) {
        const latest = comments.get(replyId) || write.confirmed;
        saveComment({ ...latest, liked: Boolean(write.confirmed.liked), folded: Boolean(write.confirmed.folded), likeCount: write.confirmed.likeCount || 0 }, true, true);
      } else comments.delete(replyId);
      if (replies.has(write.postId)) replies.get(write.postId).time = 0;
      for (const [key, cached] of children) if (key.startsWith(`${write.postId}:`)) cached.time = 0;
    }
    throw error;
  }
}
async function deletePost(id) {
  const result = await call('deleteSquarePost', { postId: id }, true);
  if (result.deletedId !== id) throw new Error('删除未确认，请重试');
  removePost(id, true);
  return id;
}
async function deleteReply(id, replyId) {
  const result = await call('deleteSquareReply', { postId: id, replyId }, true);
  if (result.deletedId !== replyId || !result.post) throw new Error('删除未确认，请重试');
  unavailable(id);
  deletedComments.add(replyId); commentRemovals += 1;
  revisions.set(id, ++mutation);
  for (const [key, row] of comments) if (commentGone(row)) {
    comments.delete(key); commentWrites.delete(key); commentVersions.set(key, ++mutation);
  }
  for (const [key, cached] of [...replies, ...children]) {
    const removed = cached.items.filter(row => commentGone(row)).length;
    cached.items = cached.items.filter(row => !commentGone(row));
    cached.nextOffset = Math.max(0, cached.nextOffset - removed); cached.time = 0;
    if (!result.rootId && key === `${id}:${replyId}`) children.delete(key);
  }
  updatePost(result.post);
  if (result.root) saveComment(pendingComment(result.root), true, true);
  for (const listener of commentListeners) {
    try { listener({ _id: replyId, rootId: result.rootId || '', postId: id, status: 'deleted' }); } catch (error) { /* 页面展示不影响删除提交。 */ }
  }
  return result;
}
function reportReply(id, replyId, reason) { return call('reportSquareReply', { postId: id, replyId, reason }, true); }
function optimizeContent(content, images = []) {
  session();
  if (typeof content !== 'string' || Array.from(content).length > 150 || !Array.isArray(images) || images.length > 9 ||
    new Set(images).size !== images.length || images.some(file => typeof file !== 'string' || !file.startsWith('cloud://')) || !content.trim() && !images.length)
    throw new Error('请写入150字以内的文案或选择图片');
  images = [...images];
  const version = generation;
  return merged(`polish:${JSON.stringify([content, images])}`, async () => {
    try {
    const result = await call('optimizeSquareContent', { content, ...(images.length ? { images } : {}) }, true);
    if (!result || typeof result.content !== 'string' || !result.content.trim()) throw new Error('暂未生成优化内容，请重试');
    return Array.from(result.content).slice(0, 150).join('');
    } finally { session(); if (generation === version && users.invalidateAIUsage) users.invalidateAIUsage(); }
  });
}
async function reportPost(id, reason) {
  return call('reportSquarePost', { postId: id, reason }, true);
}
function consumePublication() { session(); const value = published; published = false; return value; }
module.exports = { cachedFeed, cachedOwnFeed, cachedAlbum, album, cachedPost, cachedReplies, cachedChildren, cachedComment, subscribePost, subscribeComment, subscribeAI, processAIReply, warmReplyChildren, consumePublication, list, detail, listReplies, listChildren, commentState, publish, react, reply, deletePost, reportPost, deleteReply, reportReply, optimizeContent };
