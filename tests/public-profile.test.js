const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { fixture } = require('./helpers/certification-fixture');
const { applyPageData, loadPostActions } = require('./helpers/post-actions-fixture');
const postId = n => 'p_' + n.toString(16).padStart(40, '0');

test('访客资料严格筛选公开字段，普通未认证用户可互看；目标失效不泄露资料', async () => {
  const f = fixture(), alice = await f.login(), bob = await f.login(f.bob);
  Object.assign(f.users.get(bob._id), { nickname: '对方', bio: '公开简介', avatarFileID: 'cloud://test/avatars/bob/photo.jpg', coverFileID: 'cloud://test/avatars/bob/cover.jpg',
    birthDate: '2000-01-01', realName: 'private-name', squarePinnedPostId: postId(1), certificationProof: 'private-proof' });
  f.squarePosts.set(postId(1), { _id: postId(1), authorId: bob._id, scope: 'square', status: 'published', content: '公开', likeCount: 7, sortKey: '01' });
  f.squarePosts.set(postId(2), { _id: postId(2), authorId: bob._id, scope: 'square', status: 'deleted', content: '已删除', likeCount: 99, sortKey: '02' });
  f.squarePosts.set(postId(3), { _id: postId(3), authorId: bob._id, scope: 'campus', status: 'published', content: '校园', likeCount: 99, sortKey: '03' });
  const read = identity => f.handle({ action: 'getSquarePublicProfile', accountId: bob.accountId }, identity);
  const result = await read(f.alice); assert.equal(result.success, true, result.message);
  assert.deepEqual(Object.keys(result.square.profile).sort(), ['accountId', 'nickname', 'avatarFileID', 'coverFileID', 'bio', 'createdAt', 'isVerified', 'postCount', 'receivedLikes'].sort());
  assert.equal(result.square.profile.postCount, 1); assert.equal(result.square.profile.receivedLikes, 7);
  const opposite = await f.handle({ action: 'getSquarePublicProfile', accountId: alice.accountId }, f.bob); assert.equal(opposite.success, true);
  assert.equal((await f.handle({ action: 'getSquarePublicProfile', accountId: 'bad' }, f.alice)).code, 'INVALID_ACCOUNT_ID');
  assert.equal((await read({ openid: 'not-registered', env: 'test' })).code, 'NOT_REGISTERED');
  f.users.get(bob._id).status = 'disabled'; assert.equal((await read(f.alice)).code, 'PROFILE_NOT_FOUND');
});

test('官方账号显示官方认证并保留普通账号的学校权限', async () => {
  const f = fixture();
  const cui = await f.login(f.bob);
  await f.login();
  Object.assign(f.users.get(cui._id), { nickname: 'Cui', officialVerified: true, publicJoinedMonth: '2026-11' });

  const own = await f.handle({ action: 'getProfile' }, f.bob);
  assert.equal(own.user.nickname, 'Cui');
  assert.equal(own.user.officialVerified, true);
  assert.equal(own.user.role, 'user');
  assert.equal(own.user.certificationStatus, 'unverified');
  assert.equal(own.user.joinedMonth, '2026年11月');
  assert.equal(own.user.createdAt, null);

  const visitor = await f.handle({ action: 'getSquarePublicProfile', accountId: cui.accountId }, f.alice);
  assert.equal(visitor.square.profile.officialVerified, true);
  assert.equal(visitor.square.profile.isVerified, false);
  assert.equal(visitor.square.profile.joinedMonth, '2026年11月');

  const info = await f.handle({ action: 'getSquarePublicAccountInfo', accountId: cui.accountId }, f.alice);
  assert.equal(info.square.accountInfo.user.officialVerified, true);
  assert.equal(info.square.accountInfo.user.schoolName, '');
  assert.equal(info.square.accountInfo.user.createdAt, null);

  const publication = await f.handle({ action: 'publishSquarePost', post: { content: '官方动态', scope: 'square', requestId: 'cui-official-post-01' } }, f.bob);
  assert.equal(publication.square.post.author.officialVerified, true);
  assert.equal(publication.square.post.author.verified, false);
});

test('官方账号关闭评论后，保留旧评论并同时拒绝一级评论、楼中回复和 AI 任务', async () => {
  const f = fixture();
  const cui = await f.login(f.bob);
  await f.login();
  const account = f.users.get(cui._id);
  account.officialVerified = true;
  const created = await f.handle({ action: 'publishSquarePost', post: { content: '官方动态', scope: 'square', requestId: 'closed-official-post-01' } }, f.bob);
  const postId = created.square.post._id;
  const reply = (requestId, extra = {}) => f.handle({ action: 'publishSquareReply', post: { postId, content: '留言', scope: 'square', requestId, ...extra } }, f.alice);
  const before = await reply('closed-official-before', { askAI: true });
  assert.equal(before.success, true);
  const replyId = before.square.reply._id;
  f.users.get(cui._id).squareCommentsDisabled = true;

  const list = await f.handle({ action: 'listSquareReplies', postId }, f.alice);
  assert.equal(list.square.commentsDisabled, true);
  assert.equal(list.square.items[0]._id, replyId);
  assert.equal((await f.handle({ action: 'getSquarePost', postId }, f.alice)).square.post.author.commentsDisabled, true);
  assert.equal((await reply('closed-official-first')).code, 'COMMENTS_DISABLED');
  assert.equal((await reply('closed-official-child', { replyToId: replyId })).code, 'COMMENTS_DISABLED');
  assert.equal((await f.handle({ action: 'processSquareAIReply', postId, replyId }, f.alice)).code, 'COMMENTS_DISABLED');
  assert.equal(f.squarePosts.get(postId).replyCount, 1);
});

test('公开动态/引用/相册限定目标和square已发布成品，置顶可见但访客不能管理', async () => {
  const f = fixture(), alice = await f.login(), bob = await f.login(f.bob);
  for (let n = 1; n <= 24; n++) f.squarePosts.set(postId(n), { _id: postId(n), authorId: bob._id, scope: 'square', status: 'published', content: String(n),
    sortKey: String(n).padStart(4, '0'), createdAt: `2026-11-${String(n).padStart(2, '0')}T00:00:00Z`,
    ...(n === 24 ? { quotePostId: postId(1) } : {}), images: n === 2 ? ['cloud://test/square-media/bob/public.jpg'] : [],
    imageSources: ['cloud://test/square-uploads/bob/private.jpg'], hasImages: n === 2 });
  f.users.get(bob._id).squarePinnedPostId = postId(1);
  f.squarePosts.set(postId(99), { _id: postId(99), authorId: alice._id, scope: 'square', status: 'published', content: '本人不应混入', sortKey: '9999' });
  const read = (kind, extra = {}) => f.handle({ action: 'listSquarePosts', profileAccountId: bob.accountId, postType: kind, ...extra }, f.alice);
  const first = (await read('posts')).square, next = (await read('posts', { offset: first.nextOffset })).square;
  assert.equal(first.profileAccountId, bob.accountId); assert.equal(first.pinnedPostId, postId(1)); assert.equal(first.items[0]._id, postId(1));
  assert.equal(new Set([...first.items, ...next.items].map(row => row._id)).size, 23);
  assert.ok(first.items.every(row => row.author.accountId === bob.accountId && row.isOwn === false && row.imageSources === undefined));
  const quotes = (await read('quotes')).square; assert.equal(quotes.items.length, 1); assert.equal(quotes.items[0]._id, postId(24));
  const album = await f.handle({ action: 'listSquareAlbum', profileAccountId: bob.accountId }, f.alice);
  assert.equal(album.square.items.length, 1); assert.equal(album.square.items[0].fileID, 'cloud://test/square-media/bob/public.jpg');
  assert.equal((await f.handle({ action: 'setSquareProfilePin', postId: postId(1), pinned: true, profileAccountId: bob.accountId }, f.alice)).code, 'FORBIDDEN');
  assert.equal((await f.handle({ action: 'deleteSquarePost', postId: postId(1), authorId: bob._id }, f.alice)).code, 'FORBIDDEN');
  f.users.get(bob._id).status = 'disabled'; assert.equal((await read('posts')).code, 'PROFILE_NOT_FOUND');
});

test('他人回复历史使用浏览者自己的心碎状态，不泄露目标用户的个人折叠', async () => {
  const f = fixture(); await f.login(); const bob = await f.login(f.bob);
  const post = (await f.handle({ action: 'publishSquarePost', post: { content: '原动态', scope: 'square', requestId: 'public-profile-post-01' } }, f.alice)).square.post;
  const reply = (await f.handle({ action: 'publishSquareReply', post: { content: '公开回复', postId: post._id, scope: 'square', requestId: 'public-profile-reply-01' } }, f.bob)).square.reply;
  const fold = who => f.handle({ action: 'setSquareCommentState', postId: post._id, replyId: reply._id, kind: 'fold', active: true }, who);
  await fold(f.bob);
  const read = () => f.handle({ action: 'listSquareOwnReplies', profileAccountId: bob.accountId }, f.alice);
  const first = (await read()).square; assert.equal(first.items[0].reply.folded, false); assert.equal(first.items[0].reply.isOwn, false);
  await fold(f.alice); assert.equal((await read()).square.items[0].reply.folded, true);
  await f.handle({ action: 'deleteSquarePost', postId: post._id }, f.alice);
  assert.equal((await read()).square.items.length, 0);
});

const viewer = { _id: 'alice', accountId: '12345678', nickname: '本人', role: 'user' };
const target = { accountId: '87654321', nickname: '对方', avatarFileID: 'avatar', coverFileID: 'cover', bio: '简介', isVerified: true, postCount: 2, receivedLikes: 8 };
function pageFixture(options = {}) {
  let definition, current = options.viewer === undefined ? viewer : options.viewer, version = 0;
  const calls = [], routes = [], cache = new Map();
  if (options.cached !== false) cache.set(target.accountId, options.profile || target);
  const users = { getCachedUser: () => current, getSessionVersion: () => version, restore: async () => { if (options.restore) current = await options.restore(); return current; },
    getCachedPublicProfile: id => current && cache.get(id), getPublicProfile: async id => { calls.push({ type: 'profile', id }); return options.read ? options.read(id) : target; } };
  const contents = new Map();
  const row = { _id: postId(1), author: { accountId: target.accountId }, content: '对方动态', images: ['photo'], createdAt: '2026-11-20T00:00:00Z' };
  const square = { cachedPublicContent: (id, kind) => contents.get(id + ':' + kind),
    listPublicContent: async (id, kind, args) => { calls.push({ type: kind, id, ...args }); const result = options.list ? await options.list(id, kind, args) : { profileAccountId: id, items: kind === 'posts' ? [row] : [], hasMore: false, nextOffset: 1, allTotal: 2 }; contents.set(id + ':' + kind, result); return result; },
    cachedPost: () => null, cachedOwnFeed() { throw new Error('访客不能查询本人动态缓存'); }, cachedAlbum() { throw new Error('访客不能查询本人相册'); } };
  if (options.content) contents.set(target.accountId + ':posts', options.content);
  const wx = { getWindowInfo: () => ({ windowWidth: 375, windowHeight: 800, statusBarHeight: 44 }), getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32 }),
    navigateTo: args => routes.push(args.url), navigateBack: args => routes.push({ back: args.delta }), switchTab: args => routes.push(args.url), showToast() {} };
  const context = { module: { exports: {} }, require: name => name.includes('services/user') ? users : name.includes('services/square') ? square : require('../miniprogram/utils/user-role'), wx };
  vm.runInNewContext(fs.readFileSync('miniprogram/utils/public-profile.js', 'utf8'), context);
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/profile/index.js', 'utf8'), { wx, Page: value => { definition = value; },
    require: name => name.includes('utils/public-profile') ? context.module.exports : name.includes('services/user') ? users : name.includes('services/square') ? square : name.includes('post-actions') ? loadPostActions(users, square, wx) :
      name.includes('services/post-images') ? {} : require('../miniprogram/utils/' + name.split('/').pop()), getCurrentPages: () => options.pages || [] });
  const page = { ...definition, route: 'pages/profile/index', data: structuredClone(definition.data), setData(patch) { applyPageData(this.data, patch); } };
  return { page, calls, routes, contents, users, switchUser(value) { current = value; version++; cache.clear(); contents.clear(); page.applyUser(value); } };
}

test('从搜索页侧栏打开自己的主页时，返回搜索页并预先恢复其侧栏', () => {
  const pages = [], prepared = [];
  const f = pageFixture({ pages, viewer: null });
  pages.push({ route: 'pages/search/index', prepareMenuReturn() { prepared.push('search'); } }, f.page);
  f.page.onLoad();
  f.page.backToHome();
  assert.deepEqual(prepared, ['search']);
  assert.equal(f.routes.length, 1);
  assert.equal(f.routes[0].back, 1);
});

test('访客模式同步展示缓存，viewer与主页作者分离，只有目标公开内容被请求', async () => {
  const f = pageFixture(); f.page.onLoad({ accountId: target.accountId });
  assert.equal(f.page.data.user._id, viewer._id); assert.equal(f.page.data.profileUser.nickname, target.nickname); assert.equal(f.page.data.authChecking, false);
  await f.page.onShow(); assert.equal(f.page.data.ownPosts[0].author.accountId, target.accountId);
  assert.equal(f.page.data.likeCount, 8); assert.equal(f.page.data.followerCount, '—');
  f.page.editProfile(); f.page.openAdmin(); f.page.openCertification(); await f.page.chooseCover();
  assert.equal(f.routes.length, 0);
  await f.page.selectContent({ currentTarget: { dataset: { key: 'reposts' } } });
  await f.page.selectContent({ currentTarget: { dataset: { key: 'album' } } });
  assert.ok(f.calls.some(call => call.type === 'quotes')); assert.ok(f.calls.some(call => call.type === 'album'));
  assert.ok(f.calls.every(call => call.id === target.accountId));
  f.page.backToHome(); assert.equal(f.routes[0].back, 1);
});

test('后台资料刷新保留已经确认的真实关注统计，不先清空为破折号', () => {
  const f = pageFixture(); f.page.onLoad({ accountId: target.accountId });
  f.page.setData({ followingCount: 18, followerCount: 36, profileFollowing: true, followKnown: true });
  f.page.applyPublicProfile({ ...target, bio: '后台更新的简介' });
  assert.equal(f.page.data.followingCount, 18); assert.equal(f.page.data.followerCount, 36);
  assert.equal(f.page.data.profileFollowing, true);
});

test('访客主页加入日期进入该账号的公开详情，连续点击不重复跳页',()=>{
  const f=pageFixture();f.page.onLoad({accountId:target.accountId});f.page.openAccountAbout();f.page.openAccountAbout();
  assert.equal(f.routes.length,1);assert.equal(f.routes[0],'/pages/account-about/index?accountId='+target.accountId);
});

test('后台失败保留缓存；隐藏、切账号后的迟到资料不覆盖新会话', async () => {
  const failed = pageFixture({ read: () => Promise.reject(new Error('offline')) }); failed.page.onLoad({ accountId: target.accountId }); await failed.page.onShow();
  assert.equal(failed.page.data.profileUser.nickname, target.nickname); assert.equal(failed.page.data.error, 'offline');
  let finish; const f = pageFixture({ read: () => new Promise(resolve => { finish = resolve; }) });
  f.page.onLoad({ accountId: target.accountId }); const pending = f.page.onShow(); await new Promise(resolve => setImmediate(resolve));
  f.switchUser({ ...viewer, _id: 'new-viewer' }); finish({ ...target, nickname: '迟到旧资料' }); await pending;
  assert.equal(f.page.data.profileUser, null); assert.equal(f.page.data.user._id, 'new-viewer'); assert.equal(f.page.data.ownPosts.length, 0);
});

test('目标不可查看时清理公开卡片，不展示残存姓名头像或个人操作', async () => {
  const f = pageFixture({ read: () => Promise.reject(Object.assign(new Error('不可查看'), { code: 'PROFILE_NOT_FOUND' })) });
  f.page.onLoad({ accountId: target.accountId }); await f.page.onShow();
  assert.equal(f.page.data.profileUnavailable, true); assert.equal(f.page.data.profileUser, null); assert.equal(f.page.data.coverFileID, '');
  assert.equal(f.page.data.ownPosts.length, 0); assert.equal(f.page.data.pinnedPostId, '');
});

test('首次会话恢复完成前只检查登录，不先弹登录表单；恢复后继续读取目标主页', async () => {
  let finish; const f = pageFixture({ viewer: null, cached: false, restore: () => new Promise(resolve => { finish = resolve; }) });
  f.page.onLoad({ accountId: target.accountId }); const pending = f.page.onShow();
  assert.equal(f.page.data.authChecking, true); assert.equal(f.page.data.loginSheetOpen, false);
  finish(viewer); await pending;
  assert.equal(f.page.data.profileUser.accountId, target.accountId); assert.equal(f.page.data.user._id, viewer._id);
  assert.equal(f.page.data.authChecking, false); assert.equal(f.page.data.loginSheetOpen, false);
});
