const users = require('./user');
const TTL = 60000;
let owner, generation = 0, feed = null, ownFeed = null, mutation = 0, removals = 0, published = false;
const posts = new Map(), postTimes = new Map(), replies = new Map(), pending = new Map(), revisions = new Map();
const deleted = new Set();
const children = new Map(), comments = new Map(), commentVersions = new Map();
function session() {
  const current = users.getCachedUser();
  const key = `${current ? current._id : 'guest'}:${users.getSessionVersion()}`;
  if (key !== owner) { owner = key; generation += 1; feed = null; ownFeed = null; published = false; posts.clear(); postTimes.clear(); replies.clear(); children.clear(); comments.clear(); commentVersions.clear(); pending.clear(); revisions.clear(); deleted.clear(); }
  return key;
}
function cachedFeed() { session(); return feed && feed.value; }
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
function saveComment(row, changed = false) {
  comments.set(row._id, row);
  if (changed) commentVersions.set(row._id, ++mutation);
  for (const list of [...replies.values(), ...children.values()]) list.items = list.items.map(item => item._id === row._id ? row : item);
}
function previewPost(post) {
  const content = post.fullContent || post.content;
  return { ...post, content: Array.from(content).slice(0, 280).join(''), fullContent: content, truncated: Array.from(content).length > 280 };
}
function updatePost(post, prepend = false) {
  if (deleted.has(post._id)) return;
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
    }
  } else if (prepend) ownFeed = { time: 0, value: { items: [previewPost(post)], hasMore: true, nextOffset: 0 } };
}
function unavailable(id) {
  if (deleted.has(id)) throw Object.assign(new Error('动态不存在或已不可见'), { code: 'POST_NOT_FOUND' });
}
function removePost(id) {
  if (!deleted.has(id)) removals += 1;
  deleted.add(id);
  revisions.set(id, ++mutation);
  posts.delete(id); postTimes.delete(id); replies.delete(id);
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
    const currentItems = result.items.filter(post => !deleted.has(post._id)).map(post => before.get(post._id) !== revisions.get(post._id) && posts.has(post._id) ? previewPost(posts.get(post._id)) : post);
    const timestamp = post => new Date(post.createdAt && post.createdAt.$date || post.createdAt).getTime() || 0;
    const latest = mine ? ownFeed : feed;
    const items = (requestOffset || revision !== mutation) && latest ? [...new Map([...latest.value.items, ...currentItems].map(item => [item._id, item])).values()].sort((a, b) => timestamp(b) - timestamp(a)) : currentItems;
    const saved = { value: { ...result, items }, time: Date.now() };
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
    return result.post;
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
  const store = rootId ? children : replies, key = rootId ? `${id}:${rootId}` : id;
  if (!force && !offset && store.has(key) && Date.now() - store.get(key).time < TTL) return Promise.resolve(store.get(key));
  return merged(`replies:${key}:${offset}`, async () => {
    const revision = revisions.get(id);
    const versions = new Map(commentVersions);
    const result = await call(rootId ? 'listSquareReplyChildren' : 'listSquareReplies', { postId: id, offset, ...(rootId ? { rootId } : {}) });
    unavailable(id);
    const previous = store.get(key);
    const rows = result.items.map(row => versions.get(row._id) !== commentVersions.get(row._id) && comments.has(row._id) ? comments.get(row._id) : row);
    const value = { ...result, time: Date.now(), items: (offset || revision !== revisions.get(id)) && previous ? [...new Map([...previous.items, ...rows].map(item => [item._id, item])).values()] : rows };
    const timestamp = item => new Date(item.createdAt && item.createdAt.$date || item.createdAt).getTime() || 0;
    value.items.sort((a, b) => timestamp(a) - timestamp(b));
    store.set(key, value);
    for (const row of value.items) comments.set(row._id, row);
    return value;
  });
}
async function publish(content, requestId) {
  const result = await call('publishSquarePost', { post: { content, requestId, scope: 'square' } }, true);
  revisions.set(result.post._id, ++mutation);
  updatePost(result.post, true);
  published = true;
  return result.post;
}
async function react(id, kind, active) {
  const result = await call('setSquareReaction', { postId: id, kind, active }, true);
  unavailable(id);
  revisions.set(id, ++mutation);
  updatePost(result.post);
  return result.post;
}
async function reply(id, content, requestId, replyToId) {
  const result = await call('publishSquareReply', { post: { postId: id, content, requestId, scope: 'square', ...(replyToId ? { replyToId } : {}) } }, true);
  unavailable(id);
  revisions.set(id, ++mutation);
  updatePost(result.post);
  const rootId = result.reply.rootId;
  const store = rootId ? children : replies, key = rootId ? `${id}:${rootId}` : id;
  const existing = store.get(key);
  if (existing) existing.items = [...new Map([...existing.items, result.reply].map(item => [item._id, item])).values()];
  else store.set(key, { items: [result.reply], hasMore: true, nextOffset: 0, time: 0 });
  saveComment(result.reply, true);
  if (result.root) saveComment(result.root, true);
  return result;
}
async function commentState(id, replyId, kind, active) {
  const result = await call('setSquareCommentState', { postId: id, replyId, kind, active }, true);
  unavailable(id);
  saveComment(result.reply, true);
  return result.reply;
}
async function deletePost(id) {
  const result = await call('deleteSquarePost', { postId: id }, true);
  if (result.deletedId !== id) throw new Error('删除未确认，请重试');
  removePost(id);
  return id;
}
async function reportPost(id, reason) {
  return call('reportSquarePost', { postId: id, reason }, true);
}
async function recordShare(id, requestId) {
  const result = await call('recordSquareShare', { postId: id, requestId }, true);
  unavailable(id);
  revisions.set(id, ++mutation);
  updatePost(result.post);
  return result.post;
}
function consumePublication() { session(); const value = published; published = false; return value; }
module.exports = { cachedFeed, cachedOwnFeed, cachedPost, cachedReplies, cachedChildren, consumePublication, list, detail, listReplies, listChildren, commentState, publish, react, reply, deletePost, reportPost, recordShare };
