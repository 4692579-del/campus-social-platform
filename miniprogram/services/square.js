const users = require('./user');
const { projectComment, reactComment } = require('../utils/comment-state');
const { newestComments, oldestComments } = require('../utils/comment-order');
const TTL = 60000;
let ownStats = null, statsRevision = 0;
let ownHistory = null, historyRevision = 0;
const historyListeners = new Set();
function subscribeHistory(listener) { historyListeners.add(listener); return () => historyListeners.delete(listener); }
function historyChanged(invalidate = false) {
  if (invalidate) { historyRevision++; if (ownHistory) ownHistory.time = 0; for (const cached of publicHistories.values()) cached.time = 0; }
  for (const listener of historyListeners) { try { listener({ invalidated: invalidate }); } catch (error) { /* 展示不影响保存。 */ } }
}
let owner, generation = 0, feed = null, ownFeed = null, albumFeed = null, mutation = 0, removals = 0, published = false;
const profileFeeds = new Map();
const searchFeeds = new Map();
const followStates = new Map(), followProfiles = new Map(), followWrites = new Map(), followListeners = new Set();
let followRevision = 0, followingFeed = null, followWorker = null;
const publicContent = new Map(), publicHistories = new Map(), publicEpoch = new Map();
const unavailablePublicAccounts = new Set();
function clearPublicAccount(accountId) {
  unavailablePublicAccounts.add(accountId);
  publicEpoch.set(accountId, (publicEpoch.get(accountId) || 0) + 1); historyRevision++;
  for (const key of publicContent.keys()) if (key.startsWith(accountId + ':')) publicContent.delete(key);
  publicHistories.delete(accountId);
  for (const [key, cached] of searchFeeds) if (cached.value.accountId === accountId) searchFeeds.delete(key);
}
let profilePin = null, pinRevision = 0, pinWrite = null;
function orderProfileItems(items, pinnedPostId) {
  const time = row => new Date(row.createdAt && row.createdAt.$date || row.createdAt).getTime() || 0;
  return items.slice().sort((a, b) => Number(b._id === pinnedPostId) - Number(a._id === pinnedPostId) || time(b) - time(a) || b._id.localeCompare(a._id));
}
function cachedProfilePin() { session(); return profilePin; }
function saveProfilePin(value) {
  if (typeof value.pinnedPostId !== 'string' || !Number.isSafeInteger(value.pinVersion) || value.pinVersion < 0) throw new Error('置顶状态暂不可用，请更新云函数');
  if (profilePin && profilePin.pinVersion > value.pinVersion) return;
  profilePin = { pinnedPostId: value.pinnedPostId, pinVersion: value.pinVersion };
  const cached = profileFeeds.get('posts');
  if (cached) Object.assign(cached.value, profilePin, { items: orderProfileItems(cached.value.items, profilePin.pinnedPostId) });
}
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
  if (key !== owner) { ownHistory = null; historyRevision++; profilePin = null; pinRevision++; pinWrite = null; }
  if (key !== owner) { for (const write of followWrites.values()) write.reject(Object.assign(new Error('登录状态已变更，请重试'), { code: 'SESSION_CHANGED' })); followWorker = null; followStates.clear(); followProfiles.clear(); followWrites.clear(); followRevision++; followingFeed = null; owner = key; generation += 1; searchFeeds.clear(); profileFeeds.clear(); publicContent.clear(); publicHistories.clear(); publicEpoch.clear(); unavailablePublicAccounts.clear(); ownStats = null; statsRevision += 1; feed = null; ownFeed = null; albumFeed = null; published = false; posts.clear(); postTimes.clear(); replies.clear(); children.clear(); comments.clear(); commentVersions.clear(); commentWrites.clear(); aiWrites.clear(); pending.clear(); revisions.clear(); deleted.clear(); deletedComments.clear(); commentRemovals = 0; likeWrites.clear(); }
  return key;
}
function subscribeFollow(listener) { followListeners.add(listener); return () => followListeners.delete(listener); }
function cachedFollowState(accountId) {
  session(); const confirmed = followStates.get(accountId)?.value || null, write = followWrites.get(accountId);
  return write ? { ...(confirmed || { accountId, version: 0 }), following: write.desired, pending: true } : confirmed;
}
function cachedFollowProfile(accountId) {
  session(); const cached = followProfiles.get(accountId);
  if (!cached) return null;
  const value = { ...cached.value }, viewer = users.getCachedUser();
  for (const [id, write] of followWrites) {
    if (!write.confirmed || write.confirmed.following === write.desired) continue;
    const delta = write.desired ? 1 : -1;
    if (viewer && accountId === viewer.accountId) value.followingCount = Math.max(0, value.followingCount + delta);
    if (accountId === id) value.followerCount = Math.max(0, value.followerCount + delta);
  }
  const state = cachedFollowState(accountId);
  if (state && typeof value.following === 'boolean') { value.following = state.following; value.pending = Boolean(state.pending); }
  return value;
}
function emitFollow(accountId, { rollback = false } = {}) {
  followRevision++;
  if (followingFeed) followingFeed.time = 0;
  const state = cachedFollowState(accountId), event = { ...(state || { accountId, following: false, version: 0 }), pending: Boolean(state?.pending), rollback, changed: true };
  for (const listener of followListeners) { try { listener(event); } catch (error) { /* 展示不阻断后台保存。 */ } }
}
function saveFollowState(value) {
  if (!value || !/^[1-9][0-9]{7}$/.test(value.accountId || '') || typeof value.following !== 'boolean' || !Number.isSafeInteger(value.version) || value.version < 0) throw new Error('关注服务需要更新，请部署 userService');
  const old = followStates.get(value.accountId);
  if (!old || value.version >= old.value.version) followStates.set(value.accountId, { value, time: Date.now() });
}
function saveFollowProfile(value) {
  if (!value || !/^[1-9][0-9]{7}$/.test(value.accountId || '') || !['followingCount', 'followerCount', 'version'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) throw new Error('关注统计暂不可用');
  const old = followProfiles.get(value.accountId);
  if (!old || value.version >= old.value.version) followProfiles.set(value.accountId, { value, time: Date.now() });
  if (typeof value.following === 'boolean') saveFollowState({ accountId: value.accountId, following: value.following, version: value.relationVersion });
}
function getFollowProfile(accountId, { force = false } = {}) {
  session(); const user = users.getCachedUser();
  if (!user) return Promise.reject(Object.assign(new Error('请先登录'), { code: 'UNAUTHENTICATED' }));
  const id = accountId || user.accountId, cached = followProfiles.get(id), revision = followRevision;
  if (followWrites.size) return cached ? Promise.resolve(cachedFollowProfile(id)) : Promise.reject(Object.assign(new Error('关注状态正在保存'), { code: 'FOLLOW_PENDING' }));
  if (!force && cached && Date.now() - cached.time < TTL) return Promise.resolve(cachedFollowProfile(id));
  return merged(`follow-profile:${id}:${revision}`, async () => {
    const result = await call('getSquareFollowProfile', { accountId: id }, true);
    if (result.profile?.accountId !== id) throw new Error('关注统计暂不可用');
    if (followWrites.size || revision !== followRevision) {
      const latest = cachedFollowProfile(id);
      if (latest) return latest;
      throw Object.assign(new Error('关注状态正在更新'), { code: 'FOLLOW_PENDING' });
    }
    saveFollowProfile(result.profile); return cachedFollowProfile(id);
  });
}
function getFollowStates(ids, { force = false } = {}) {
  session(); if (!users.getCachedUser()) return Promise.resolve([]);
  const unique = [...new Set(ids)].filter(id => /^[1-9][0-9]{7}$/.test(id || ''));
  const missing = unique.filter(id => !followWrites.has(id) && (force || !followStates.has(id) || Date.now() - followStates.get(id).time >= TTL)), revision = followRevision;
  return Promise.all(Array.from({ length: Math.ceil(missing.length / 50) }, (_, n) => {
    const batch = missing.slice(n * 50, n * 50 + 50).sort();
    return merged(`follow-states:${batch.join(',')}:${revision}`, async () => {
      const result = await call('getSquareFollowStates', { accountIds: batch }, true);
      if (!Array.isArray(result.items) || result.items.length !== batch.length || new Set(result.items.map(item => item.accountId)).size !== batch.length || result.items.some(item => !batch.includes(item.accountId))) throw new Error('关注状态暂不可用');
      if (revision === followRevision) result.items.forEach(item => { if (!followWrites.has(item.accountId)) saveFollowState(item); });
    });
  })).then(() => unique.map(id => cachedFollowState(id)).filter(Boolean));
}
function setFollow(accountId, following) {
  session(); const viewer = users.getCachedUser();
  if (!viewer) return Promise.reject(Object.assign(new Error('请先登录'), { code: 'UNAUTHENTICATED' }));
  if (!/^[1-9][0-9]{7}$/.test(accountId || '') || typeof following !== 'boolean' || accountId === viewer.accountId) return Promise.reject(new Error('关注参数不正确'));
  let write = followWrites.get(accountId);
  if (write) {
    if (write.desired !== following) { write.desired = following; emitFollow(accountId); }
    return write.promise;
  }
  write = { desired: following, confirmed: followStates.get(accountId)?.value || null, generation, resolve: null, reject: null };
  write.promise = new Promise((resolve, reject) => { write.resolve = resolve; write.reject = reject; });
  followWrites.set(accountId, write);
  emitFollow(accountId);
  drainFollowWrites();
  return write.promise;
}
async function drainFollowWrites() {
  if (followWorker) return;
  const worker = { generation }; followWorker = worker;
  try {
    // 同一会话串行保存，单个目标随时合并为最新意图；所有入口同步使用乐观投影。
    while (followWorker === worker && worker.generation === generation && followWrites.size) {
      const [accountId, write] = followWrites.entries().next().value, target = write.desired;
      try {
        const result = await call('setSquareFollow', { accountId, following: target }, true);
        if (followWorker !== worker || followWrites.get(accountId) !== write) continue;
        if (result.state?.accountId !== accountId || result.state.following !== target || result.profile?.accountId !== accountId || result.viewer?.accountId !== users.getCachedUser()?.accountId) throw new Error('关注状态确认失败，请刷新后重试');
        saveFollowState(result.state); saveFollowProfile(result.profile); saveFollowProfile(result.viewer);
        write.confirmed = followStates.get(accountId).value;
        if (write.desired === target) {
          followWrites.delete(accountId);
          if (!target && followingFeed) followingFeed.value.items = followingFeed.value.items.filter(post => post.author.accountId !== accountId);
          emitFollow(accountId); write.resolve(cachedFollowState(accountId));
        } else emitFollow(accountId);
      } catch (error) {
        session();
        if (followWorker !== worker || followWrites.get(accountId) !== write) continue;
        // 已被反向点击替代的失败不打断后续意图，下一次只保存用户最新选择。
        if (write.desired !== target && error.code !== 'SESSION_CHANGED') continue;
        followWrites.delete(accountId); emitFollow(accountId, { rollback: true }); write.reject(error);
      }
    }
  } finally { if (followWorker === worker) followWorker = null; }
}
function projectFollowing(result) {
  if (!result) return null;
  return { ...result, items: result.items.filter(post => {
    const write = followWrites.get(post.author.accountId);
    return !write || write.desired;
  }) };
}
function cachedFollowingFeed() { session(); return projectFollowing(followingFeed?.value || null); }
function listFollowing({ force = false, cursor = '' } = {}) {
  session(); const revision = followRevision, before = new Map(revisions), removed = removals;
  if (!force && !cursor && followingFeed && Date.now() - followingFeed.time < TTL) return Promise.resolve(projectFollowing(followingFeed.value));
  return merged(`following-feed:${cursor}:${revision}`, async () => {
    const result = await call('listSquareFollowing', { cursor }, true);
    if (revision !== followRevision || removed !== removals) throw Object.assign(new Error('关注动态已更新，请刷新'), { code: 'FOLLOW_CHANGED' });
    if (!Array.isArray(result.items) || typeof result.hasMore !== 'boolean' || typeof result.nextCursor !== 'string' || result.hasMore && (!result.nextCursor || result.nextCursor === cursor)) throw new Error('关注动态暂不可用');
    const rows = result.items.filter(post => !deleted.has(post._id)).map(post => pendingLike(before.get(post._id) !== revisions.get(post._id) && posts.has(post._id) ? previewPost(posts.get(post._id)) : post));
    const items = [...new Map([...(cursor && followingFeed ? followingFeed.value.items : []), ...rows].map(post => [post._id, post])).values()];
    followingFeed = { time: Date.now(), value: { ...result, items } };
    for (const post of rows) { posts.set(post._id, { ...post, content: post.fullContent || post.content, truncated: false }); postTimes.set(post._id, Date.now()); }
    return projectFollowing(followingFeed.value);
  });
}

function cachedOwnStats() { session(); return ownStats && ownStats.value; }
function invalidateOwnStats() { statsRevision += 1; if (ownStats) ownStats.time = 0; }
function getOwnStats() {
  session();
  if (!users.getCachedUser()) return Promise.reject(Object.assign(new Error('请先登录'), { code: 'UNAUTHENTICATED' }));
  if (ownStats && Date.now() - ownStats.time < TTL) return Promise.resolve(ownStats.value);
  const revision = statsRevision;
  return merged(`own-stats:${revision}`, async () => {
    const result = await call('getSquareOwnStats', {}, true);
    if (revision !== statsRevision) throw Object.assign(new Error('获赞数据已更新，请重试'), { code: 'STATS_CHANGED' });
    if (!Number.isSafeInteger(result.receivedLikes) || result.receivedLikes < 0) throw new Error('获赞数据暂不可用');
    ownStats = { time: Date.now(), value: { receivedLikes: result.receivedLikes } };
    return ownStats.value;
  });
}
function cachedFeed() { session(); return feed && feed.value; }
function cachedAlbum() { session(); return albumFeed && albumFeed.value; }
function ownCache(postType) { return postType === 'all' ? ownFeed : profileFeeds.get(postType); }
function ownMatches(post, postType) { return postType === 'all' || Boolean(post.quotePostId) === (postType === 'quotes'); }
function cachedOwnFeed(postType = 'all') {
  session();
  let cached = ownCache(postType);
  if (!cached && (ownFeed || feed)) {
    const user = users.getCachedUser(), source = ownFeed || feed;
    const items = user && user.accountId ? source.value.items.filter(post => post.author.accountId === user.accountId && ownMatches(post, postType)) : [];
    if (items.length) {
      cached = { time: 0, value: { items, hasMore: true, nextOffset: 0 } };
      if (postType === 'all') ownFeed = cached; else profileFeeds.set(postType, cached);
    }
  }
  if (!cached) return null;
  cached.value.items = cached.value.items.map(post => posts.has(post._id) ? previewPost(posts.get(post._id)) : post);
  if (postType === 'posts' && profilePin) Object.assign(cached.value, profilePin, { items: orderProfileItems(cached.value.items, profilePin.pinnedPostId) });
  return cached.value;
}
function cachedPost(id) { session(); return posts.get(id) || (feed && feed.value.items.find(item => item._id === id)) || null; }
function cachedReplies(id) { session(); return replies.get(id) || null; }
function cachedOwnReplies() { session(); return ownHistory && ownHistory.value; }
function listOwnReplies({ cursor = '', force = false, profileAccountId = '' } = {}) {
  session();
  const cached = profileAccountId ? publicHistories.get(profileAccountId) : ownHistory;
  if (!force && !cursor && cached && Date.now() - cached.time < TTL) return Promise.resolve(cached.value);
  const revision = historyRevision;
  return merged(`own-replies:${profileAccountId || 'self'}:${cursor}:${revision}`, async () => {
    const versions = new Map(commentVersions);
    let result;
    try { result = await call('listSquareOwnReplies', { cursor, ...(profileAccountId ? { profileAccountId } : {}) }, true); }
    catch (error) { if (profileAccountId && error.code === 'PROFILE_NOT_FOUND') clearPublicAccount(profileAccountId); throw error; }
    if (revision !== historyRevision) throw Object.assign(new Error('回复记录已更新，请重试'), { code: 'HISTORY_CHANGED' });
    if (profileAccountId && result.profileAccountId !== profileAccountId) throw new Error('个人回复服务需要更新');
    const previous = profileAccountId ? publicHistories.get(profileAccountId) : ownHistory;
    if (!Array.isArray(result.items) || typeof result.hasMore !== 'boolean' || typeof result.nextCursor !== 'string' ||
      result.hasMore && (!result.nextCursor || result.nextCursor === cursor)) throw new Error('回复记录暂不可用');
    const rows = result.items.filter(item => item.reply && item._id === item.reply._id && !deleted.has(item.postId) && !commentGone(item.reply)).map(item => {
      const current = comments.get(item._id);
      let reply = pendingComment(current && versions.get(item._id) !== commentVersions.get(item._id) ? current : item.reply);
      const blocked = Boolean(item.reply.hiddenByAncestor) || [...(reply.ancestorIds || []), reply.rootId].filter(Boolean).some(key => comments.get(key)?.folded);
      if (blocked) reply = { ...reply, content: '', images: [], folded: true, hiddenByAncestor: true };
      // 上文折叠是历史展示投影，不能伪装成本条评论自己的心碎状态写回共享缓存。
      if (!reply.hiddenByAncestor) saveComment(reply);
      const parent = comments.get(item.context._id);
      const context = blocked ? { folded: true, content: '', imageCount: 0 } : parent ? { ...item.context,
        folded: Boolean(parent.folded), content: parent.folded ? '' : Array.from(parent.content || '').slice(0, 100).join(''), imageCount: parent.folded ? 0 : (parent.images || []).length } : item.context;
      return { ...item, reply, context };
    });
    const items = [...new Map([...(cursor && previous ? previous.value.items : []), ...rows].map(item => [item._id, item])).values()]
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    const saved = { time: Date.now(), value: { ...result, items } };
    if (profileAccountId) { unavailablePublicAccounts.delete(profileAccountId); publicHistories.set(profileAccountId, saved); if (publicHistories.size > 32) publicHistories.delete(publicHistories.keys().next().value); } else ownHistory = saved;
    return saved.value;
  });
}
async function replyContext(id, replyId) {
  session(); unavailable(id);
  const revision = commentRemovals, versions = new Map(commentVersions);
  const result = await merged(`reply-context:${id}:${replyId}:${revision}`, () => call('getSquareReplyContext', { postId: id, replyId }, true));
  unavailable(id);
  if (revision !== commentRemovals || !result.root || commentGone(result.root) || deletedComments.has(replyId)) throw new Error('评论已更新，请重试');
  const project = row => pendingComment(versions.get(row._id) !== commentVersions.get(row._id) && comments.has(row._id) ? comments.get(row._id) : row);
  return { ...result, root: project(result.root), items: result.items.filter(row => !commentGone(row)).map(project) };
}
function replyWindow(id, rootId, { offset = 0 } = {}) {
  session();
  const revision = commentRemovals, versions = new Map(commentVersions);
  return merged(`reply-window:${id}:${rootId}:${offset}:${revision}`, async () => {
    unavailable(id);
    const result = await call('listSquareReplyChildren', { postId: id, rootId, offset });
    unavailable(id);
    if (revision !== commentRemovals || deletedComments.has(rootId)) throw new Error('评论已更新，请重试');
    return { ...result, items: result.items.filter(row => !commentGone(row)).map(row =>
      pendingComment(versions.get(row._id) !== commentVersions.get(row._id) && comments.has(row._id) ? comments.get(row._id) : row)) };
  });
}
function cachedChildren(id, rootId) { session(); return children.get(`${id}:${rootId}`) || null; }
function cachedComment(id) { session(); return comments.get(id) || null; }
function subscribeComment(listener) { commentListeners.add(listener); return () => commentListeners.delete(listener); }
function saveComment(row, changed = false, notify = false) {
  if (commentGone(row)) return;
  comments.set(row._id, row);
  if (changed) commentVersions.set(row._id, ++mutation);
  for (const list of [...replies.values(), ...children.values()]) list.items = list.items.map(item => item._id === row._id ? row : item);
  for (const history of [ownHistory, ...publicHistories.values()].filter(Boolean)) {
    history.value.items = history.value.items.map(item => {
      if (row.folded && [...(item.reply.ancestorIds || []), item.reply.rootId].includes(row._id)) return { ...item,
        reply: { ...item.reply, folded: true, hiddenByAncestor: true, content: '', images: [] }, context: { folded: true, content: '', imageCount: 0 } };
      if (item._id === row._id && !item.reply.hiddenByAncestor) return { ...item, reply: row };
      if (item.context._id === row._id) return { ...item, context: { ...item.context, folded: row.folded,
        content: row.folded ? '' : Array.from(row.content || '').slice(0, 100).join(''), imageCount: row.folded ? 0 : (row.images || []).length } };
      return item;
    });
    if (changed) history.time = 0;
  }
  if (notify) historyChanged();
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
  let value = write ? likedPost(post, write.desired) : post;
  const current = posts.get(post._id);
  if (current && (current.quoteVersion || 0) > (value.quoteVersion || 0)) value = { ...value, quoteCount: current.quoteCount, quoteVersion: current.quoteVersion, quoted: current.quoted };
  const quote = removedQuote(value.quote);
  return quote !== value.quote ? { ...value, quote } : value;
}
function subscribePost(listener) { postListeners.add(listener); return () => postListeners.delete(listener); }
function updatePost(post, prepend = false) {
  if (deleted.has(post._id)) return;
  post = pendingLike(post);
  const firstPublication = prepend && !posts.has(post._id);
  for (const cached of searchFeeds.values()) { if (prepend) cached.time = 0; if (cached.value.kind === 'square') cached.value.items = cached.value.items.map(row => row._id === post._id ? previewPost(post) : row); }
  posts.set(post._id, post);
  postTimes.set(post._id, Date.now());
  if (followingFeed) followingFeed.value.items = followingFeed.value.items.map(row => row._id === post._id ? previewPost(post) : row);
  if (feed) {
    const found = feed.value.items.some(item => item._id === post._id);
    feed.value.items = feed.value.items.map(item => item._id === post._id ? previewPost(post) : item);
    if (prepend && !found) feed.value.items.unshift(previewPost(post));
  } else if (prepend) feed = { time: 0, value: { items: [previewPost(post)], hasMore: true, nextOffset: 0 } };
  for (const postType of ['all', 'posts', 'quotes']) {
    const cached = ownCache(postType), matches = ownMatches(post, postType);
    if (cached) {
      const found = cached.value.items.some(item => item._id === post._id);
      cached.value.items = cached.value.items.map(item => item._id === post._id ? previewPost(post) : item);
      if (prepend && matches && !found) {
        cached.value.items.unshift(previewPost(post));
        cached.value.nextOffset += 1;
        if (Number.isSafeInteger(cached.value.total)) cached.value.total += 1;
      }
      if (firstPublication && Number.isSafeInteger(cached.value.allTotal)) cached.value.allTotal += 1;
    } else if (prepend && matches) {
      const saved = { time: 0, value: { items: [previewPost(post)], hasMore: true, nextOffset: 0 } };
      if (postType === 'all') ownFeed = saved; else profileFeeds.set(postType, saved);
    }
  }
  for (const [key, cached] of publicContent) if (!key.endsWith(':album')) cached.value.items = cached.value.items.map(row => row._id === post._id ? previewPost(post) : row);
  for (const listener of postListeners) {
    try { listener(post); } catch (error) { /* 页面观察者不能影响已完成的保存或缓存更新。 */ }
  }
}
function unavailable(id) {
  if (deleted.has(id)) throw Object.assign(new Error('动态不存在或已不可见'), { code: 'POST_NOT_FOUND' });
}
function removedQuote(quote, id) {
  if (!quote) return quote;
  if (quote._id === id || deleted.has(quote._id)) return quote.unavailable ? quote : { _id: quote._id, unavailable: true };
  const nested = removedQuote(quote.quote, id);
  return nested === quote.quote ? quote : { ...quote, quote: nested };
}
function removePost(id, knownOwn = false) {
  for (const cached of searchFeeds.values()) if (cached.value.kind === 'square') { cached.value.items = cached.value.items.filter(row => row._id !== id); cached.time = 0; }
  if (followingFeed) { followingFeed.value.items = followingFeed.value.items.filter(row => row._id !== id); followingFeed.time = 0; }
  if (profilePin && profilePin.pinnedPostId === id) { pinRevision++; saveProfilePin({ pinnedPostId: '', pinVersion: profilePin.pinVersion + 1 }); }
  for (const history of [ownHistory, ...publicHistories.values()].filter(Boolean)) history.value.items = history.value.items.filter(item => item.postId !== id);
  for (const [key, cached] of publicContent) { const oldLength = cached.value.items.length; cached.value.items = cached.value.items.filter(row => key.endsWith(':album') ? row.postId !== id : row._id !== id); if (!key.endsWith(':album') && cached.value.items.length !== oldLength) cached.value.nextOffset = Math.max(0, cached.value.nextOffset - 1); if (cached.value.pinnedPostId === id) cached.value.pinnedPostId = ''; cached.time = 0; }
  historyChanged(true);
  invalidateOwnStats();
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
  for (const [postType, cached] of [['feed', feed], ['all', ownFeed], ...profileFeeds]) if (cached) {
    const removed = cached.value.items.some(post => post._id === id);
    if (newlyRemoved && own && postType !== 'feed' && postType !== 'all' && row && Number.isSafeInteger(cached.value.total) && ownMatches(row, postType)) cached.value.total = Math.max(0, cached.value.total - 1);
    if (newlyRemoved && own && Number.isSafeInteger(cached.value.allTotal)) cached.value.allTotal = Math.max(0, cached.value.allTotal - 1);
    cached.value.items = cached.value.items.filter(post => post._id !== id);
    if (removed) cached.value.nextOffset = Math.max(0, cached.value.nextOffset - 1);
    cached.time = 0;
  }
  for (const post of [...posts.values()]) {
    const quote = removedQuote(post.quote, id);
    if (quote !== post.quote) updatePost({ ...post, quote });
  }
}
function publishConnectionError(error) {
  const detail = String(error?.errMsg || error?.message || '');
  const rawCode = error?.errCode ?? detail.match(/\berrCode:\s*(-\d+)/i)?.[1];
  const match = String(rawCode ?? '').match(/^-\d{4,8}$/);
  const code = match ? match[0] : '';
  const suffix = code ? `（${code}）` : '';
  let message = '未能确认视频是否发布，正文和附件已保留，请重试';
  if (/timed?\s*out|timeout|超时/i.test(detail)) message = '视频处理或云函数等待超时，正文和附件已保留，请重试';
  else if (/out of memory|memory limit|heap limit|内存/i.test(detail)) message = '云函数内存不足，请调高 userService 的运行内存后重试';
  else if (/cannot find module|module_not_found|require stack|function not exist|invalid env/i.test(detail)) message = '发布云函数未就绪，请检查 userService 的部署及依赖';
  return Object.assign(new Error(`${message}${suffix}`), { code: 'VIDEO_PUBLICATION_UNCONFIRMED' });
}
async function call(action, data = {}, authenticated = false) {
  session();
  if (authenticated && !users.getCachedUser()) throw Object.assign(new Error('请先登录'), { code: 'UNAUTHENTICATED' });
  const version = generation;
  let response;
  try { response = await wx.cloud.callFunction({ name: 'userService', data: { action, ...data, ...(!authenticated ? { personalize: Boolean(users.getCachedUser()) } : {}) } }); }
  catch (error) {
    session();
    if (version !== generation) throw Object.assign(new Error('登录状态已变更，请重试'), { code: 'SESSION_CHANGED' });
    if (action === 'publishSquarePost' && data.post?.media?.some(item => item.type === 'video')) throw publishConnectionError(error);
    throw new Error('暂时无法连接广场，请稍后重试');
  }
  session();
  if (version !== generation) throw Object.assign(new Error('登录状态已变更，请重试'), { code: 'SESSION_CHANGED' });
  const result = response.result;
  if (!result || !result.success) {
    if (result && ['ACCOUNT_DISABLED', 'NOT_REGISTERED', 'UNAUTHENTICATED', 'INVALID_ROLE'].includes(result.code)) users.logout();
    throw Object.assign(new Error(result && result.code !== 'INVALID_ACTION' ? result.message :
      ['processSquareAIReply', 'optimizeSquareContent'].includes(action) ? 'AI 服务需要更新，请重新部署整个 userService' : action === 'listSquareAlbum' ? '相册服务需要更新，请重新部署 userService 云函数' :
        ['listSquareReplyChildren', 'setSquareCommentState', 'listSquareOwnReplies', 'getSquareReplyContext'].includes(action) ? '评论服务需要更新，请重新部署 userService 云函数' : '动态广场暂时无法连接，请稍后重试'), { code: result && result.code });
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
function list({ force = false, offset = 0, mine = false, postType = 'all' } = {}) {
  session();
  const cached = mine ? ownCache(postType) : feed;
  if (!force && !offset && cached && Date.now() - cached.time < TTL) return Promise.resolve(cached.value);
  return merged(`${mine ? 'own:' + postType : 'feed'}:${offset}`, async () => {
    const pinBefore = pinRevision;
    const revision = mutation;
    const before = new Map(revisions);
    let requestOffset = offset, removalVersion = removals;
    let result = await call('listSquarePosts', { offset: requestOffset, ...(mine ? { mine: true, ...(postType !== 'all' ? { postType } : {}) } : {}) }, mine);
    // 删除会移动服务端分页位置，旧分页返回时重新对齐首页，防止跳过一条动态。
    if (removalVersion !== removals) {
      requestOffset = 0; removalVersion = removals;
      result = await call('listSquarePosts', { offset: 0, ...(mine ? { mine: true, ...(postType !== 'all' ? { postType } : {}) } : {}) }, mine);
      if (removalVersion !== removals) throw new Error('动态列表已更新，请刷新后重试');
    }
    if (mine && (result.mine !== true || postType !== 'all' && result.postType !== postType)) throw new Error('个人动态服务需要更新，请重新部署 userService 云函数');
    if (mine && postType === 'posts') {
      if (pinBefore !== pinRevision || profilePin && Number.isSafeInteger(result.pinVersion) && result.pinVersion < profilePin.pinVersion) throw Object.assign(new Error('置顶状态已更新，请重试'), { code: 'PIN_CHANGED' });
      if (typeof result.pinnedPostId === 'string') saveProfilePin(result);
    }
    const currentItems = result.items.filter(post => !deleted.has(post._id)).map(post => pendingLike(before.get(post._id) !== revisions.get(post._id) && posts.has(post._id) ? previewPost(posts.get(post._id)) : post));
    const timestamp = post => new Date(post.createdAt && post.createdAt.$date || post.createdAt).getTime() || 0;
    const latest = mine ? ownCache(postType) : feed;
    const items = (requestOffset || revision !== mutation) && latest ? [...new Map([...latest.value.items, ...currentItems].map(item => [item._id, item])).values()].sort((a, b) => timestamp(b) - timestamp(a)) : currentItems;
    const total = mine && latest && (requestOffset || revision !== mutation) && Number.isSafeInteger(latest.value.total) ? latest.value.total : result.total;
    const allTotal = mine && latest && (requestOffset || revision !== mutation) ? latest.value.allTotal : result.allTotal;
    const saved = { value: { ...result, ...(mine && Number.isSafeInteger(total) ? { total } : {}), ...(Number.isSafeInteger(allTotal) ? { allTotal } : {}), items }, time: Date.now() };
    if (mine && postType === 'all') ownFeed = saved;
    else if (mine) {
      if (postType === 'posts' && profilePin) Object.assign(saved.value, profilePin, { items: orderProfileItems(items, profilePin.pinnedPostId) });
      profileFeeds.set(postType, saved);
    }
    else feed = saved;
    for (const post of items) if (!post.truncated || typeof post.fullContent === 'string') {
      posts.set(post._id, { ...post, content: post.fullContent || post.content, truncated: false }); postTimes.set(post._id, Date.now());
    }
    return saved.value;
  });
}
function searchKey(keyword, accountId, kind) { return JSON.stringify([String(keyword || '').trim(), accountId || '', kind || 'square']); }
function cachedSearch({ keyword = '', accountId = '', kind = 'square' } = {}) {
  session(); const cached = searchFeeds.get(searchKey(keyword, accountId, kind));
  if (!cached) return null;
  if (kind === 'square') cached.value.items = cached.value.items.filter(row => !deleted.has(row._id)).map(row => posts.has(row._id) ? previewPost(posts.get(row._id)) : row);
  return cached.value;
}
function searchContent({ keyword = '', accountId = '', kind = 'square', cursor = '', force = false } = {}) {
  session(); keyword = String(keyword).trim(); const key = searchKey(keyword, accountId, kind), cached = searchFeeds.get(key);
  if (!force && !cursor && cached && Date.now() - cached.time < TTL) return Promise.resolve(cachedSearch({ keyword, accountId, kind }));
  const revision = removals, epoch = publicEpoch.get(accountId) || 0, before = new Map(revisions);
  return merged(`search:${key}:${cursor}:${revision}:${epoch}`, async () => {
    let result;
    try { result = await call('searchSquareContent', { keyword, accountId, kind, cursor }, Boolean(accountId || kind === 'users')); }
    catch (error) { if (accountId && error.code === 'PROFILE_NOT_FOUND') { clearPublicAccount(accountId); if (typeof users.invalidatePublicProfile === 'function') users.invalidatePublicProfile(accountId, { unavailable: true }); } throw error; }
    if (revision !== removals || epoch !== (publicEpoch.get(accountId) || 0)) throw Object.assign(new Error('搜索内容已更新，请重试'), { code: 'SEARCH_CHANGED' });
    if (result.kind !== kind || result.keyword !== keyword || result.accountId !== accountId || !Array.isArray(result.items) || typeof result.hasMore !== 'boolean' || typeof result.nextCursor !== 'string' || result.hasMore && (!result.nextCursor || result.nextCursor === cursor)) throw new Error('搜索服务需要更新，请部署完整 userService');
    const rows = kind === 'square' ? result.items.filter(row => !deleted.has(row._id)).map(row => pendingLike(before.get(row._id) !== revisions.get(row._id) && posts.has(row._id) ? previewPost(posts.get(row._id)) : row)) : result.items;
    const previous = searchFeeds.get(key), id = row => kind === 'square' ? row._id : row.accountId;
    const items = [...new Map([...(cursor && previous ? previous.value.items : []), ...rows].map(row => [id(row), row])).values()];
    searchFeeds.set(key, { value: { ...result, items }, time: Date.now() });
    if (searchFeeds.size > 32) searchFeeds.delete(searchFeeds.keys().next().value);
    if (kind === 'square') for (const row of rows) { posts.set(row._id, { ...row, content: row.fullContent || row.content, truncated: false }); postTimes.set(row._id, Date.now()); }
    return cachedSearch({ keyword, accountId, kind });
  });
}

function cachedProfileReplies(accountId) { session(); return unavailablePublicAccounts.has(accountId) ? null : publicHistories.get(accountId)?.value || null; }
function cachedPublicContent(accountId, kind) {
  session();
  if (!users.getCachedUser() || unavailablePublicAccounts.has(accountId)) return null;
  const key = `${accountId}:${kind}`;
  let cached = publicContent.get(key);
  if (!cached && ['posts', 'quotes', 'album'].includes(kind)) {
    const known = [...posts.values()].filter(row => row.author && row.author.accountId === accountId && !deleted.has(row._id));
    const items = kind === 'album' ? known.flatMap(row => (row.images || []).map((fileID, index) => ({ _id: `${row._id}_${index}`, postId: row._id, fileID, createdAt: row.createdAt, index }))) :
      orderProfileItems(known.filter(row => ownMatches(row, kind)).map(previewPost), '');
    if (items.length) { cached = { time: 0, value: { profileAccountId: accountId, items, hasMore: true, nextOffset: 0 } }; publicContent.set(key, cached); }
  }
  if (!cached) return null;
  if (kind !== 'album') cached.value.items = orderProfileItems(cached.value.items.filter(row => !deleted.has(row._id)).map(row => posts.has(row._id) ? previewPost(posts.get(row._id)) : row), kind === 'posts' ? cached.value.pinnedPostId : '');
  return cached.value;
}
function listPublicContent(accountId, kind, { force = false, offset = 0 } = {}) {
  session();
  if (!/^[1-9][0-9]{7}$/.test(accountId || '') || !['posts', 'quotes', 'album'].includes(kind)) return Promise.reject(new Error('个人主页参数不正确'));
  const key = `${accountId}:${kind}`, cached = publicContent.get(key);
  if (!force && !offset && cached && Date.now() - cached.time < TTL) return Promise.resolve(cachedPublicContent(accountId, kind));
  return merged(`public:${key}:${offset}`, async () => {
    const removalVersion = removals, before = new Map(revisions), epoch = publicEpoch.get(accountId) || 0;
    let result;
    try { result = await call(kind === 'album' ? 'listSquareAlbum' : 'listSquarePosts', { profileAccountId: accountId, offset,
      ...(kind !== 'album' ? { postType: kind } : {}) }, true); }
    catch (error) { if (error.code === 'PROFILE_NOT_FOUND') clearPublicAccount(accountId); throw error; }
    if (epoch !== (publicEpoch.get(accountId) || 0)) throw Object.assign(new Error('个人主页状态已变化'), { code: 'PROFILE_CHANGED' });
    if (result.profileAccountId !== accountId || !Array.isArray(result.items) || typeof result.hasMore !== 'boolean' || !Number.isSafeInteger(result.nextOffset)) throw new Error('个人主页服务需要更新，请部署 userService');
    if (removalVersion !== removals) throw new Error('动态已更新，请刷新后重试');
    const incoming = kind === 'album' ? result.items.filter(row => !deleted.has(row.postId)) : result.items.filter(row => !deleted.has(row._id)).map(row =>
      pendingLike(before.get(row._id) !== revisions.get(row._id) && posts.has(row._id) ? previewPost(posts.get(row._id)) : row));
    const previous = publicContent.get(key);
    let items = offset && previous ? [...new Map([...previous.value.items, ...incoming].map(row => [row._id, row])).values()] : incoming;
    if (kind !== 'album') {
      items = orderProfileItems(items, kind === 'posts' ? result.pinnedPostId : '');
      for (const post of items) { posts.set(post._id, { ...post, content: post.fullContent || post.content }); postTimes.set(post._id, Date.now()); }
    }
    unavailablePublicAccounts.delete(accountId);
    const saved = { time: Date.now(), value: { ...result, items } }; publicContent.set(key, saved);
    if (publicContent.size > 64) publicContent.delete(publicContent.keys().next().value);
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
async function publish(content, requestId, images = [], declaration = 'none', quotePostId = '', media) {
  if (quotePostId && !/^p_[a-f0-9]{40}$/.test(quotePostId)) throw new Error('引用的动态无效');
  let result;
  try {
    result = await call('publishSquarePost', { post: { content, requestId, scope: 'square', ...(images.length ? { images } : {}), ...(media ? { media } : {}),
      ...(declaration !== 'none' ? { declaration } : {}), ...(quotePostId ? { quotePostId } : {}) } }, true);
  } catch (error) {
    if (error.code !== 'VIDEO_PUBLICATION_UNCONFIRMED') throw error;
    try { result = await call('getSquarePublication', { requestId }, true); }
    catch (statusError) { if (statusError.code === 'SESSION_CHANGED') throw statusError; }
    if (!result?.post) throw error;
  }
  revisions.set(result.post._id, ++mutation);
  updatePost(result.post, true);
  if (result.quotedPost) updatePost(result.quotedPost);
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
      invalidateOwnStats();
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
      for (const cached of profileFeeds.values()) cached.time = 0;
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
  historyChanged(true);
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
    historyChanged(true);
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
  if (result.quotedPost) updatePost(result.quotedPost);
  return id;
}
async function setProfilePin(id, pinned) {
  session(); unavailable(id);
  if (pinWrite) throw new Error('正在更新置顶，请稍候');
  const ticket = {}; pinWrite = ticket;
  try {
    const result = await call('setSquareProfilePin', { postId: id, pinned }, true);
    unavailable(id);
    if (!result.post || result.post._id !== id || result.pinnedPostId !== (pinned ? id : '')) throw new Error('置顶未确认，请重试');
    if (profilePin && profilePin.pinVersion > result.pinVersion) throw Object.assign(new Error('置顶状态已变化，请刷新后重试'), { code: 'PIN_CHANGED' });
    pinRevision++;
    saveProfilePin(result);
    updatePost(result.post);
    const cached = profileFeeds.get('posts');
    if (cached) {
      if (!cached.value.items.some(row => row._id === id)) cached.value.items.push(previewPost(result.post));
      cached.value.items = orderProfileItems(cached.value.items, result.pinnedPostId);
      cached.time = 0;
    }
    return profilePin;
  } finally { if (pinWrite === ticket) pinWrite = null; }
}
async function deleteReply(id, replyId) {
  const result = await call('deleteSquareReply', { postId: id, replyId }, true);
  if (result.deletedId !== replyId || !result.post) throw new Error('删除未确认，请重试');
  unavailable(id);
  deletedComments.add(replyId); commentRemovals += 1;
  for (const history of [ownHistory, ...publicHistories.values()].filter(Boolean)) history.value.items = history.value.items.filter(item => !commentGone(item.reply)).map(item =>
    item.context._id === replyId ? { ...item, context: { unavailable: true } } : item);
  historyChanged(true);
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
module.exports = { cachedSearch, searchContent, subscribeFollow, cachedFollowState, cachedFollowProfile, getFollowProfile, getFollowStates, setFollow, cachedFollowingFeed, listFollowing, clearPublicAccount, cachedPublicContent, listPublicContent, cachedProfileReplies, cachedProfilePin, setProfilePin, cachedOwnReplies, listOwnReplies, subscribeHistory, replyContext, replyWindow, cachedOwnStats, getOwnStats, cachedFeed, cachedOwnFeed, cachedAlbum, album, cachedPost, cachedReplies, cachedChildren, cachedComment, subscribePost, subscribeComment, subscribeAI, processAIReply, warmReplyChildren, consumePublication, list, detail, listReplies, listChildren, commentState, publish, react, reply, deletePost, reportPost, deleteReply, reportReply, optimizeContent };
