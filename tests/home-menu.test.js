const { loadPostActions, applyPageData } = require('./helpers/post-actions-fixture');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describeUser } = require('../miniprogram/utils/user-role');
const menuConfig = require('../miniprogram/utils/account-menu');

const user = { _id: 'alice', nickname: '真实昵称', avatarFileID: 'cloud://real/avatar.png', accountId: '12345678', role: 'user', certificationStatus: 'unverified', schoolId: '' };

test('广场关注与推荐来源独立，切换后旧分页不覆盖新来源，未登录不泄露关注列表', async () => {
  const row = suffix => ({ _id:'p_'+suffix.repeat(40),content:suffix,author:{accountId:'87654321'} });
  const recommended={items:[row('a')],hasMore:false,nextOffset:1};let finish;
  const f=fixture({cachedUser:user,cachedFeed:recommended,list:async()=>recommended,following:()=>new Promise(resolve=>{finish=resolve;})});
  f.page.onLoad();f.page.toggleTabMenu({currentTarget:{dataset:{key:'square'}}});
  f.page.selectTabFilter({currentTarget:{dataset:{key:'square',filter:'following'}}});
  const pending=f.page._feedPromise;assert.equal(f.page.data.posts.length,0);assert.equal(f.page.data.feedLoading,true);
  f.page.toggleTabMenu({currentTarget:{dataset:{key:'square'}}});f.page.selectTabFilter({currentTarget:{dataset:{key:'square',filter:'square'}}});
  await f.page._feedPromise;finish({items:[row('b')],hasMore:false,nextCursor:''});await pending;
  assert.equal(f.page.data.posts[0]._id,row('a')._id);
  const guest=fixture();guest.page.onLoad();guest.page.data.tabFilters.square='following';await guest.page.loadFeed();
  assert.equal(guest.page.data.posts.length,0);assert.equal(guest.page.data.feedLoading,false);
});

test('关注页使用真实游标继续空页，加载完成不重设图片数据',async()=>{
  const row={_id:'p_'+'e'.repeat(40),content:'图片',images:['cloud://test/photo'],author:{accountId:'87654321'}};
  const cursors=[],f=fixture({cachedUser:user,following:args=>{cursors.push(args.cursor);return Promise.resolve(args.cursor ? {items:[row],hasMore:false,nextCursor:''}:{items:[],hasMore:true,nextCursor:'cursor-1'});}});
  f.page.onLoad();f.page.toggleTabMenu({currentTarget:{dataset:{key:'square'}}});f.page.selectTabFilter({currentTarget:{dataset:{key:'square',filter:'following'}}});await f.page._feedPromise;
  assert.equal(f.page.data.feedHasMore,true);assert.equal(f.page.data.feedCursor,'cursor-1');await f.page.loadMoreFeed();
  assert.deepEqual(cursors,['','cursor-1']);assert.equal(f.page.data.posts[0]._id,row._id);
  const posts=f.page.data.posts;f.page.showFeed({items:[row],hasMore:false,nextCursor:''});assert.equal(f.page.data.posts,posts);
});

test('首页头像菜单按真实头像定位，点击立即更新关注并播放动画，不改帖子图片', async () => {
  const id = 'p_' + 'a'.repeat(40), feed = { items: [{ _id: id, content: '动态', images: ['cloud://real/photo.jpg'], author: { nickname: '同学', accountId: '87654321' } }], hasMore: false, nextOffset: 1 };
  const f = fixture({ cachedUser: user, cachedFeed: feed }); f.page.onLoad();
  const posts = f.page.data.posts;
  f.page.selectComponent = selector => selector === '#home-post-' + id ? { getAvatarRect: callback => callback({ left: 8, bottom: 200 }) } : null;
  f.page.openAuthorMenu({ detail: { id } });
  assert.equal(f.page.data.authorMenu.left, 12); assert.equal(f.page.data.authorMenu.top, 206);
  assert.equal(f.page.data.authorMenu.isOwn, false);
  const saving=f.page.selectAuthorAction({ currentTarget: { dataset: { action: 'follow' } } });
  assert.equal(f.page.data.followPreviews[id].followed,true);
  assert.equal(f.page.data.followPreviews[id].phase,'following');
  await saving;
  assert.equal(f.page.data.authorMenu, null); assert.equal(f.page.data.followPreviews[id].followed, true); assert.equal(f.toasts.length, 0);
  f.page.openAuthorMenu({ detail: { id } });
  f.page.selectAuthorAction({ currentTarget: { dataset: { action: 'profile' } } });
  assert.equal(f.requests.length, 0); assert.equal(f.toasts.length, 0);
  assert.equal(f.routes[0], '/pages/profile/index?accountId=87654321'); assert.equal(f.page.data.posts, posts);
});

test('不同作者、关闭或换账号后的迟到头像测量不重开旧菜单', () => {
  const first = 'p_' + 'a'.repeat(40), second = 'p_' + 'b'.repeat(40);
  const options = { cachedUser: user, cachedFeed: { items: [first, second].map(_id => ({ _id, content: '动态', author: { accountId: '87654321' }, isOwn: false })), hasMore: false, nextOffset: 2 } };
  const f = fixture(options); f.page.onLoad(); const callbacks = [];
  f.page.selectComponent = () => ({ getAvatarRect: callback => callbacks.push(callback) });
  f.page.openAuthorMenu({ detail: { id: first } }); f.page.openAuthorMenu({ detail: { id: second } });
  callbacks[1]({ left: 10, bottom: 160 }); callbacks[0]({ left: 10, bottom: 260 });
  assert.equal(f.page.data.authorMenu.id, second); assert.equal(f.page.data.authorMenu.isOwn, false);
  f.page.openAuthorMenu({ detail: { id: first } }); f.page.closeAuthorMenu(); callbacks[2]({ left: 10, bottom: 200 });
  assert.equal(f.page.data.authorMenu, null);
  f.page.openAuthorMenu({ detail: { id: first } }); options.cachedUser = { ...user, _id: 'bob' }; options.sessionVersion = 1;
  f.page.applyUser(options.cachedUser); callbacks[3]({ left: 10, bottom: 200 }); assert.equal(f.page.data.authorMenu, null);
});

test('点击本人动态头像不测量、不弹菜单、不显示未开放提示', () => {
  const id = 'p_' + 'c'.repeat(40);
  const f = fixture({ cachedUser: user, cachedFeed: { items: [{ _id: id, author: { accountId: user.accountId }, isOwn: true }], hasMore: false, nextOffset: 1 } });
  f.page.onLoad(); f.page.selectComponent = () => { throw new Error('本人头像不应测量菜单位置'); };
  f.page.openAuthorMenu({ detail: { id } });
  assert.equal(f.page.data.authorMenu, null); assert.equal(f.toasts.length, 0); assert.equal(f.routes.length, 0);
});

test('真实关注后两阶段动画；同作者同步，取关取消不写入，确认后恢复加号', async () => {
  const id = 'p_' + 'd'.repeat(40), second = 'p_' + 'e'.repeat(40);
  const feed = { items: [id, second].map(_id => ({ _id, content: '动态', images: ['cloud://real/image.jpg'], author: { accountId: '87654321', nickname: '同学', avatarFileID: 'cloud://real/avatar.jpg' } })), hasMore: false, nextOffset: 2 };
  const f = fixture({ cachedUser: user, cachedFeed: feed, manualRefreshTimers: true }); f.page.onLoad();
  const posts = f.page.data.posts;
  f.page.selectComponent = () => ({ getAvatarRect: callback => callback({ left: 8, bottom: 200 }) });
  const open = () => f.page.openAuthorMenu({ detail: { id } });
  const follow = () => f.page.selectAuthorAction({ currentTarget: { dataset: { action: 'follow' } } });
  open(); await follow(); assert.equal(f.page.data.authorMenu, null);
  assert.equal(f.page.data.followPreviews[id].phase, 'following');
  assert.equal(f.page.data.followPreviews[second].followed, true);
  f.runTimer(1250); assert.equal(f.page.data.followPreviews[id].phase, 'followed');
  open(); assert.equal(f.page.data.authorMenu.following, true); await follow();
  assert.equal(f.page.data.unfollowTarget.nickname, '同学'); assert.equal(f.bar.authBlocked, true);
  f.page.cancelUnfollow(); assert.equal(f.page.data.unfollowClosing, true); f.runTimer(200);
  assert.equal(f.page.data.followPreviews[id].followed, true); assert.equal(f.page.data.unfollowTarget, null);
  open(); await follow(); await f.page.confirmUnfollow();
  assert.equal(f.page.data.followPreviews[id].followed, false); assert.equal(f.page.data.followPreviews[second].followed, false);
  f.runTimer(200); assert.equal(f.page.data.unfollowTarget, null); assert.equal(f.bar.authBlocked, false);
  assert.equal(f.page.data.posts, posts); assert.equal(f.requests.length, 0); assert.equal(f.feedRequests.length, 0); assert.equal(f.routes.length, 0);
});

test('隐藏时结束关注动画并关闭确认，换账号清空显示，旧计时不能串号或重开面板', async () => {
  const id = 'p_' + 'f'.repeat(40), row = { _id: id, content: '动态', author: { accountId: '87654321', nickname: '同学' } };
  const options = { cachedUser: user, cachedFeed: { items: [row], hasMore: false, nextOffset: 1 }, manualRefreshTimers: true };
  const f = fixture(options); f.page.onLoad(); await f.square.setFollow(row.author.accountId, true); f.page.playFollowAnimation(f.page.data.posts[0]);
  f.page.onHide(); assert.equal(f.page.data.followPreviews[id].phase, 'followed');
  assert.equal([...f.delays.values()].includes(1250), false);
  f.page._visible = true; f.page.selectComponent = () => ({ getAvatarRect: callback => callback({ left: 8, bottom: 200 }) });
  f.page.openAuthorMenu({ detail: { id } }); await f.page.selectAuthorAction({ currentTarget: { dataset: { action: 'follow' } } });
  assert.ok(f.page.data.unfollowTarget);
  options.cachedUser = { ...user, _id: 'bob' }; options.sessionVersion = 1; f.page.applyUser(options.cachedUser);
  assert.equal(f.page.data.unfollowTarget, null); assert.equal(f.page.data.followPreviews[id].followed, false);
  assert.equal(f.page._followPreviewState.size, 0); await f.page.confirmUnfollow(); assert.equal(f.toasts.length, 0);
});

test('关于小萃AI排在设置前，进入额度页保留菜单直到新页面覆盖', async () => {
  const f = fixture({ cachedUser: user }); f.page.onLoad(); await f.page.onShow(); f.page.openMenu();
  const keys = menuConfig.utilityMenuItems.map(item => item.key); assert.equal(keys.indexOf('xiaocui') + 1, keys.indexOf('settings'));
  f.page.selectMenuItem({ currentTarget: { dataset: { key: 'xiaocui' } } });
  assert.equal(f.routes[0], '/pages/xiaocui-about/index'); assert.equal(f.page.data.menuOpen, true);
  f.page.onHide(); assert.equal(f.page.data.menuOpen, true);
  await f.page.onShow(); assert.equal(f.page.data.menuOpen, false);
});

function fixture(options = {}) {
  let definition;
  const timers = new Map(), delays = new Map(), brandStates = []; let timerId = 0;
  const setTimer = (fn, delay) => {
    const id = ++timerId; timers.set(id, fn); delays.set(id, delay);
    if (!options.manualRefreshTimers && delay !== 400) queueMicrotask(() => { if (timers.has(id)) { timers.delete(id); delays.delete(id); fn(); } });
    return id;
  };
  const clearTimer = id => { timers.delete(id); delays.delete(id); };
  const refreshContext = { module: { exports: {} }, require: () => require('../miniprogram/utils/cui-refresh-drawing'),
    setTimeout: setTimer, clearTimeout: clearTimer, Date: options.Date || Date, wx: {} };
  if (options.nextTick) refreshContext.wx.nextTick = options.nextTick;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/home-refresh.js'), 'utf8'), refreshContext);
  const routes = [], navigation = [], toasts = [], modals = [], requests = [], feedRequests = [], bar = {};
  const service = {
    getCachedUser: () => options.cachedUser || null,
    getSessionVersion: () => options.sessionVersion || 0,
    restore: async () => { requests.push('restore'); return options.restore ? options.restore() : { ...user }; },
    login: async () => { requests.push('login'); return options.login ? options.login() : { ...user }; },
    logout: () => requests.push('logout'),
  };
  const relations = new Map(); let relationSession;
  const relation = id => { const key = String(options.sessionVersion || 0); if (relationSession !== key) { relations.clear(); relationSession = key; } return relations.get(id) || { accountId:id, following:false, version:0 }; };
  const square = { cachedFollowState: relation,
    getFollowStates: async ids => ids.map(relation),
    setFollow: async (id, following) => { const old=relation(id); const next={accountId:id,following,version:old.version+1}; relations.set(id,next); return next; },
    cachedFollowingFeed: () => null, listFollowing: async args => options.following ? options.following(args) : {items:[],hasMore:false,nextCursor:''},
    cachedOwnStats: () => options.cachedOwnStats || null,
    getOwnStats: () => options.getOwnStats ? options.getOwnStats() : Promise.resolve({ receivedLikes: 0 }),
    cachedFeed: () => options.cachedFeed || null, consumePublication: () => false, list: async args => {
    feedRequests.push(args); return options.list ? options.list(args) : { items: [], hasMore: false, nextOffset: 0 };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/home/index.js'), 'utf8'), {
    Page: value => { definition = value; },
    setTimeout: setTimer, clearTimeout: clearTimer,
    require: name => name.includes('home-scroll-chrome') ? require('../miniprogram/utils/home-scroll-chrome') : name.includes('tab-page-motion') ? require('../miniprogram/utils/tab-page-motion') : name.includes('tab-page-layout') ? require('../miniprogram/utils/tab-page-layout') : name.includes('home-refresh') ? refreshContext.module.exports : name.includes('post-actions') ? loadPostActions(service, square, { showToast: args => toasts.push(args.title), navigateTo: args => routes.push(args.url) }) : name.includes('services/square') ? square : name.includes('post-view') ? require('../miniprogram/utils/post-view') : name.includes('account-menu') ? menuConfig : name.includes('user-role') ? { describeUser } : service,
    wx: { getWindowInfo: () => ({ statusBarHeight: 44 }), getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32 }),
      ...(options.nextTick ? { nextTick: options.nextTick } : {}),
      navigateTo: value => { routes.push(value.url); navigation.push(value); }, switchTab: value => routes.push(value.url),
      showToast: value => toasts.push(value.title), showModal: value => modals.push(value) },
  });
  const page = { ...definition, data: structuredClone(definition.data),
    selectComponent: () => ({ setState: state => brandStates.push(state) }),
    setData(value, callback) { applyPageData(this.data, value); if (callback) callback(); }, getTabBar: () => ({ setData: value => Object.assign(bar, value) }) };
  return { page, square, routes, navigation, toasts, modals, requests, feedRequests, bar, timers, delays, brandStates,
    runTimer(delay) { const entry = [...delays].find(([, ms]) => ms === delay); assert.ok(entry, '缺少指定时长计时器：' + delay); const fn = timers.get(entry[0]); clearTimer(entry[0]); fn(); },
  };
}

test('首页滚动同步收起标题栏和缩小底栏，返回及打开发布恢复，图文列表保持原节点数据', async () => {
  const result = { items: [{ _id: 'p_' + 'a'.repeat(40), content: '真实动态', images: ['cloud://real/photo.jpg'], author: { nickname: '同学' } }], hasMore: false, nextOffset: 1 };
  const f = fixture({ cachedUser: user, cachedFeed: result, list: () => result });
  f.page.onLoad(); await f.page.onShow(); const posts = f.page.data.posts;
  const touch = () => f.page.onHomeFeedTouchStart({ currentTarget: { dataset: { feed: 'square' } } });
  const scroll = top => f.page.onHomeFeedScroll({ currentTarget: { dataset: { feed: 'square' } }, detail: { scrollTop: top, scrollHeight: 2000 } });
  touch(); scroll(5); assert.equal(f.page.data.chromeCompact, true); assert.equal(f.bar.compact, true);
  scroll(40); scroll(36); assert.equal(f.page.data.chromeCompact, false); assert.equal(f.bar.compact, false);
  scroll(50); assert.equal(f.page.data.chromeCompact, true);
  f.page.openComposer(); assert.equal(f.page.data.chromeCompact, false); assert.equal(f.bar.compact, false);
  assert.equal(f.page.data.composerOpen, true);
  f.page.closeComposer({ detail: { published: false } });
  touch(); scroll(60); assert.equal(f.page.data.chromeCompact, true);
  f.page.onHide(); await f.page.onShow();
  assert.equal(f.page.data.chromeCompact, false); assert.equal(f.bar.compact, false);
  assert.equal(f.page.data.posts, posts);
});

test('原生标签切换过程中，首页迟到的导航同步不覆盖目标索引和已恢复的底栏尺寸', () => {
  const f = fixture();
  const bar = { _switching: true, data: { selected: 3, compact: false }, setData(values) { Object.assign(this.data, values); } };
  f.page.getTabBar = () => bar;
  f.page.data.chromeCompact = true; f.page.syncNavigation();
  assert.equal(bar.data.selected, 3); assert.equal(bar.data.compact, false);
});

test('顶部Cui点击回到当前列表顶部，重复下滑后可再次使用，保留动态和图片且不查询云端', () => {
  const post = { _id: 'normal', content: '图文动态', images: ['cloud://test/photo.jpg'], author: { nickname: '同学' } };
  const f = fixture({ cachedUser: user, cachedFeed: { items: [post], hasMore: false, nextOffset: 1 } });
  f.page.onLoad(); const posts = f.page.data.posts, writes = [], update = f.page.setData.bind(f.page);
  f.page.setData = (value, callback) => { writes.push(value); update(value, callback); };
  f.page.backToFeedTop(); assert.equal(f.page.data.squareTopTarget, 'home-square-top'); assert.equal(f.page.data.brandBouncing, true);
  assert.equal(f.timers.size, 1);
  f.page.backToFeedTop(); assert.equal(f.timers.size, 1); // 连点不反复重置正在进行的弹性动画。
  assert.deepEqual(writes.filter(value => Object.hasOwn(value, 'squareTopTarget')).map(value => value.squareTopTarget), ['', 'home-square-top', '', 'home-square-top']);
  f.page.finishBrandBounce(); assert.equal(f.page.data.brandBouncing, false); assert.equal(f.timers.size, 0);
  f.page.setData({ activeTab: 'campus' }); f.page.backToFeedTop(); assert.equal(f.page.data.campusTopTarget, 'home-campus-top');
  assert.equal(f.page.data.posts, posts); assert.equal(f.page.data.posts[0].images[0], post.images[0]);
  assert.equal(f.feedRequests.length, 0); assert.equal(f.requests.length, 0); f.page.stopBrandBounce();
});

test('顶部Cui不穿透菜单/登录/评论/发布遮罩，切页后不执行迟到回顶或保留动画计时', () => {
  for (const state of [{ menuOpen: true }, { tabMenuKey: 'square' }, { commentPostId: 'post' }, { composerOpen: true }, { loginSheetOpen: true }, { authChecking: true }]) {
    const f = fixture(); Object.assign(f.page.data, state); f.page.backToFeedTop();
    assert.equal(f.page.data.brandBouncing, false); assert.equal(f.page.data.squareTopTarget, ''); assert.equal(f.timers.size, 0);
  }
  const ticks = [], f = fixture({ nextTick: fn => ticks.push(fn) }); f.page.onLoad();
  f.page.backToFeedTop(); assert.equal(f.timers.size, 1); f.page.onHide();
  for (const tick of ticks) tick();
  assert.equal(f.timers.size, 0); assert.equal(f.page.data.brandBouncing, false); assert.equal(f.page.data.squareTopTarget, '');
  f.page.backToFeedTop(); assert.equal(f.timers.size, 0);
});

test('图文动态从菜单进入个人主页再返回保留完整卡片，相同缓存不重复写入列表，更新仍正常同步', async () => {
  const post = { _id: 'p_' + 'a'.repeat(40), content: '图片也有正文', author: { nickname: '真实昵称', accountId: user.accountId },
    images: ['cloud://test.bucket/square-media/alice/post/photo.png'], isOwn: true, likeCount: 1, liked: true };
  const cached = { items: [post], hasMore: false, nextOffset: 1 };
  const f = fixture({ cachedUser: user, cachedFeed: cached, list: () => cached });
  const updates = [], setData = f.page.setData.bind(f.page);
  f.page.setData = values => { updates.push(values); setData(values); };
  f.page.onLoad(); await f.page.onShow();
  const posts = f.page.data.posts;
  const initialWrites = updates.filter(value => Object.hasOwn(value, 'posts')).length;
  for (let i = 0; i < 10; i++) {
    f.page.openMenu(); f.page.openProfile(); f.page.onHide(); f.page.prepareMenuReturn(); await f.page.onShow();
    assert.equal(f.page.data.posts, posts);
    assert.equal(f.page.data.posts[0].author.nickname, '真实昵称'); assert.equal(f.page.data.posts[0].content, '图片也有正文');
    assert.equal(f.page.data.posts[0].likeCount, 1); assert.equal(f.page.data.posts[0].images.length, 1);
  }
  assert.equal(updates.filter(value => Object.hasOwn(value, 'posts')).length, initialWrites);
  f.page.showFeed({ ...cached, items: [{ ...post, likeCount: 2 }] });
  assert.equal(f.page.data.posts[0].likeCount, 2); assert.equal(f.page.data.posts[0].content, '图片也有正文');
  assert.equal(f.page.data.posts[0].images[0], post.images[0]);
});

test('首页使用已有账号立即开放菜单，后台校验期间不显示等待登录遮罩', async () => {
  let resolve;
  const f = fixture({ cachedUser: user, restore: () => new Promise(done => { resolve = done; }) });
  f.page.onLoad();
  const pending = f.page.onShow();
  f.page.openMenu();
  assert.equal(f.page.data.loading, false);
  assert.equal(f.page.data.menuOpen, true);
  assert.equal(f.page.data.authChecking, false);
  assert.equal(f.bar.authBlocked, false);
  resolve(user);
  await pending;
  assert.equal(f.page.data.menuOpen, true);
});

test('菜单收放及其他页面返回复用已加载头像，不重复写入图片源或重置加载状态', async () => {
  const options = { cachedUser: { ...user } };
  options.restore = () => ({ ...options.cachedUser });
  const f = fixture(options);
  f.page.onLoad();
  f.page.onHomeAvatarLoad({ currentTarget: { dataset: { source: user.avatarFileID } } });
  const avatarWrites = [], setData = f.page.setData.bind(f.page);
  f.page.setData = value => {
    if ('homeAvatarSource' in value || 'homeAvatarReady' in value) avatarWrites.push(value);
    setData(value);
  };
  for (let i = 0; i < 3; i++) {
    await f.page.onShow();
    f.page.openMenu(); f.page.closeMenu();
    f.page.openMenu(); f.page.openProfile(); f.page.onHide();
    await f.page.onShow();
    assert.equal(f.page.data.homeAvatarReady, true);
    assert.equal(f.page.data.homeAvatarSource, user.avatarFileID);
    assert.equal(f.page.data.menuOpen, false);
  }
  assert.equal(avatarWrites.length, 0);
});

test('头像失败不因返回重试闪烁，更新头像或退出时即时切换，旧图片事件不能覆盖新图', async () => {
  const options = { cachedUser: { ...user } };
  options.restore = () => ({ ...options.cachedUser });
  const f = fixture(options); f.page.onLoad();
  f.page.onAvatarError({ currentTarget: { dataset: { source: user.avatarFileID } } });
  await f.page.onShow();
  assert.equal(f.page.data.avatarFailed, true);
  assert.equal(f.page.data.homeAvatarSource, '/images/avatar.png');
  options.cachedUser = { ...user, avatarFileID: 'cloud://real/avatar-new.png' };
  f.page.onHide(); await f.page.onShow();
  assert.equal(f.page.data.homeAvatarSource, options.cachedUser.avatarFileID);
  assert.equal(f.page.data.homeAvatarReady, false);
  assert.equal(f.page.data.avatarFailed, false);
  f.page.onAvatarError({ currentTarget: { dataset: { source: user.avatarFileID } } });
  f.page.onHomeAvatarLoad({ currentTarget: { dataset: { source: user.avatarFileID } } });
  assert.equal(f.page.data.homeAvatarReady, false);
  assert.equal(f.page.data.homeAvatarSource, options.cachedUser.avatarFileID);
  f.page.onHomeAvatarLoad({ currentTarget: { dataset: { source: options.cachedUser.avatarFileID } } });
  assert.equal(f.page.data.homeAvatarReady, true);
  f.page.applyUser(null);
  assert.equal(f.page.data.homeAvatarSource, '/images/avatar.png');
  assert.equal(f.page.data.homeAvatarReady, true);
});

test('首页恢复真实头像及ID，头像入口与胶囊同排，菜单推动首页底栏并保留两个板块', async () => {
  const f = fixture();
  f.page.onLoad();
  await f.page.onShow();
  assert.equal(f.page.data.navTop, 52);
  assert.equal(f.page.data.navButtonHeight, 32);
  assert.equal(f.page.data.user.avatarFileID, user.avatarFileID);
  assert.equal(f.page.data.user.accountId, user.accountId);
  assert.equal(f.bar.selected, 0);
  assert.equal(f.bar.authBlocked, false);
  assert.equal(f.page.data.followerCount, '—');
  assert.deepEqual(f.page.data.menuItems, menuConfig.menuItems);
  f.page.toggleTabMenu({ currentTarget: { dataset: { key: 'square' } } });
  f.page.selectTabFilter({ currentTarget: { dataset: { key: 'square', filter: 'following' } } });
  f.page.openMenu();
  assert.equal(f.page.data.menuOpen, true);
  assert.equal(f.bar.menuOpen, true);
  f.page.selectTab({ currentTarget: { dataset: { key: 'campus' } } });
  assert.equal(f.page.data.activeTab, 'square');
  assert.equal(f.page.data.tabFilters.square, 'following');
  f.page.closeMenu();
  assert.equal(f.bar.menuOpen, false);
  f.page.selectTab({ currentTarget: { dataset: { key: 'campus' } } });
  assert.equal(f.page.data.activeTab, 'campus');
});

test('首页两个板块分别保留筛选，关注不读取广场流，离开关闭下拉并恢复导航', async () => {
  const f = fixture();
  await f.page.onShow();
  f.page.onAvatarError();
  assert.equal(f.page.data.avatarFailed, true);
  assert.deepEqual(Array.from(f.page.data.tabs, tab => tab.key), ['square', 'campus']);
  for (const key of ['square', 'campus']) {
    f.page.toggleTabMenu({ currentTarget: { dataset: { key } } });
    assert.equal(f.page.data.tabMenuKey, key);
    f.page.selectTabFilter({ currentTarget: { dataset: { key, filter: 'following' } } });
    assert.equal(f.page.data.activeTab, key);
    assert.equal(f.page.data.tabFilters[key], 'following');
    assert.equal(f.page.data.tabMenuKey, '');
  }
  const calls = f.feedRequests.length;
  await f.page.refreshFeed(); await f.page.loadMoreFeed();
  assert.equal(f.feedRequests.length, calls);
  f.page.selectTab({ currentTarget: { dataset: { key: 'square' } } });
  assert.equal(f.page.data.tabFilters.square, 'following');
  f.page.selectTab({ currentTarget: { dataset: { key: 'campus' } } });
  f.page.selectTab({ currentTarget: { dataset: { key: 'unknown' } } });
  assert.equal(f.page.data.activeTab, 'campus');
  f.page.toggleTabMenu({ currentTarget: { dataset: { key: 'square' } } });
  f.page.selectTabFilter({ currentTarget: { dataset: { key: 'square', filter: 'campus' } } });
  assert.equal(f.page.data.tabMenuKey, 'square');
  f.page.selectTabFilter({ currentTarget: { dataset: { key: 'square', filter: 'square' } } });
  assert.equal(f.page.isSquareFeed(), true);
  assert.equal(f.page.data.tabFilters.campus, 'following');
  f.page.toggleTabMenu({ currentTarget: { dataset: { key: 'square' } } });
  f.page.closeTabMenu(); assert.equal(f.page.data.tabMenuKey, '');
  f.page.openMenu();
  f.page.onHide();
  assert.equal(f.bar.menuOpen, false);
  await f.page.onShow();
  f.page.openMenu(); f.page.onUnload();
  assert.equal(f.bar.menuOpen, false);
});

test('往返切换同一帧提交板块和蓝条位置，保留已有动态及各板块筛选', async () => {
  const feed = { items: [{ _id: 'retained', content: '已有动态', author: { nickname: '同学' } }], hasMore: false, nextOffset: 1 };
  const f = fixture({ cachedFeed: feed, list: () => feed }); f.page.onLoad();
  const changes = [], setData = f.page.setData.bind(f.page);
  f.page.setData = value => { if ('activeTab' in value) changes.push(value); setData(value); };
  const original = f.page.tabIndicatorState('square');
  f.page.data.tabFilters.campus = 'following';
  for (const key of ['campus', 'square', 'campus', 'square']) {
    f.page.selectTab({ currentTarget: { dataset: { key } } });
    const state = changes.at(-1);
    assert.equal(state.activeTab, key);
    assert.equal(state.tabIndicatorLeft, f.page.tabIndicatorState(key).tabIndicatorLeft);
    assert.equal(state.tabIndicatorWidth, f.page.tabIndicatorState(key).tabIndicatorWidth);
    assert.equal(f.page.data.posts[0]._id, 'retained');
    assert.equal(f.page.data.tabFilters.campus, 'following');
  }
  assert.equal(f.page.data.tabIndicatorLeft, original.tabIndicatorLeft);
  assert.equal(f.page.data.tabIndicatorWidth, original.tabIndicatorWidth);
  assert.equal(changes.length, 4);
  await Promise.resolve();
});

test('蓝条按文字与箭头实际位置测量，异步测量使用当前标签且忽略过期页面', () => {
  const f = fixture(); f.page.onLoad();
  const reads = [];
  f.page.createSelectorQuery = () => {
    const query = { select: () => query, selectAll: () => query, boundingClientRect: () => query, exec: callback => reads.push(callback) };
    return query;
  };
  f.page.measureHomeTabs(); f.page.measureHomeTabs();
  const rects = [{ left: 12 }, [{ left: 58, width: 82 }, { left: 248, width: 66 }]];
  reads[0](rects); assert.equal(f.page.data.tabIndicatorLeft, 43.75);
  f.page.selectTab({ currentTarget: { dataset: { key: 'campus' } } });
  reads[1](rects);
  assert.equal(f.page.data.tabIndicatorLeft, 233); assert.equal(f.page.data.tabIndicatorWidth, 69);
  f.page.onResize({ size: { windowWidth: 430 } });
  assert.ok(Math.abs(f.page.data.tabIndicatorWidth - 138 * 430 / 750) < .001);
  const before = f.page.data.tabIndicatorLeft;
  f.page.onHide(); reads[2](rects);
  assert.equal(f.page.data.tabIndicatorLeft, before);
});

test('认证入口连接原有认证页，未登录头像先弹登录，其他菜单保持占位', async () => {
  const f = fixture();
  await f.page.onShow();
  f.page.openMenu();
  f.page.selectMenuItem({ currentTarget: { dataset: { key: 'certification' } } });
  assert.deepEqual(f.routes, ['/pages/certification/index']);
  assert.equal(f.bar.menuOpen, true);
  f.page.onHide();
  assert.equal(f.page.data.menuOpen, true);
  await f.page.onShow();
  assert.equal(f.bar.menuOpen, false);
  f.page.applyUser({ ...user, role: 'admin' });
  f.page.openMenu();
  f.page.selectMenuItem({ currentTarget: { dataset: { key: 'certification' } } });
  assert.equal(f.routes.length, 1);
  assert.equal(f.toasts.at(-1), '管理员账号无需学生认证');
  f.page.selectMenuItem({ currentTarget: { dataset: { key: 'friends' } } });
  assert.equal(f.toasts.at(-1), '萃友功能将在后续开放');
  const guest = fixture({ restore: () => null });
  await guest.page.onShow();
  guest.page.openMenu();
  assert.equal(guest.page.data.menuOpen, false);
  assert.equal(guest.page.data.loginSheetOpen, true);
  guest.page.logout();
  assert.equal(guest.modals.length, 0);
  guest.page.selectMenuItem({ currentTarget: { dataset: { key: 'certification' } } });
  assert.deepEqual(guest.routes, []);
  assert.deepEqual(guest.requests, ['restore']);
});

test('菜单头像与个人资料直接跳转，离开过程保持展开，返回时无动画恢复首页及底栏', async () => {
  const f = fixture();
  await f.page.onShow();
  f.page.openMenu();
  f.page.openProfile();
  assert.deepEqual(f.routes, ['/pages/profile/index']);
  assert.equal(f.page.data.menuOpen, true);
  assert.equal(f.bar.menuOpen, true);
  f.page.onHide();
  assert.equal(f.page.data.menuOpen, true);
  assert.equal(f.bar.menuOpen, true);
  await f.page.onShow();
  assert.equal(f.page.data.menuOpen, false);
  assert.equal(f.page.data.menuInstant, true);
  assert.equal(f.bar.menuOpen, false);
  assert.equal(f.bar.menuInstant, true);
  assert.equal(f.page.data.menuItems[0].key, 'profile');
  f.page.openMenu();
  assert.equal(f.page.data.menuInstant, false);
  assert.equal(f.bar.menuInstant, false);
  f.page.selectMenuItem({ currentTarget: { dataset: { key: 'profile' } } });
  assert.deepEqual(f.routes, ['/pages/profile/index', '/pages/profile/index']);
  assert.equal(f.page.data.menuOpen, true);
  assert.equal(f.bar.menuOpen, true);
});

test('认证页覆盖首页期间可预先恢复菜单与底栏，保留头像且不额外联网或跳页', async () => {
  const f = fixture({ cachedUser: user }); await f.page.onShow();
  f.page.onHomeAvatarLoad({ currentTarget: { dataset: { source: user.avatarFileID } } });
  f.page.openMenu();
  f.page.selectMenuItem({ currentTarget: { dataset: { key: 'certification' } } });
  f.page.onHide(); assert.equal(f.page.data.menuOpen, true);
  const reads = f.feedRequests.length;
  f.page.prepareMenuReturn();
  assert.equal(f.page._visible, false);
  assert.equal(f.page.data.menuOpen, false); assert.equal(f.page.data.menuInstant, true);
  assert.equal(f.bar.menuOpen, false); assert.equal(f.bar.menuInstant, true);
  assert.equal(f.page.data.homeAvatarReady, true);
  assert.equal(f.page.data.homeAvatarSource, user.avatarFileID);
  assert.equal(f.feedRequests.length, reads);
  assert.deepEqual(f.routes, ['/pages/certification/index']);
});

test('菜单跳转期间阻止重复跳转和收起；跳转失败保留菜单并允许重试', async () => {
  const f = fixture();
  await f.page.onShow();
  f.page.openMenu();
  f.page.openProfile();
  f.page.openProfile();
  f.page.selectMenuItem({ currentTarget: { dataset: { key: 'certification' } } });
  f.page.closeMenu();
  f.page.logout();
  assert.equal(f.routes.length, 1);
  assert.equal(f.page.data.menuOpen, true);
  assert.equal(f.bar.menuOpen, true);
  assert.equal(f.modals.length, 0);
  f.navigation[0].fail();
  assert.equal(f.toasts.at(-1), '个人主页打开失败，请重试');
  assert.equal(f.page.data.menuOpen, true);
  f.page.selectMenuItem({ currentTarget: { dataset: { key: 'certification' } } });
  assert.deepEqual(f.routes, ['/pages/profile/index', '/pages/certification/index']);
  f.navigation[1].fail();
  assert.equal(f.toasts.at(-1), '认证页面打开失败，请重试');
  f.page.closeMenu();
  assert.equal(f.page.data.menuOpen, false);
});

test('未登录点击首页头像弹登录，失败可重试，成功后留在首页且再次点击才展开菜单', async () => {
  let attempts = 0;
  const f = fixture({ restore: () => null, login: () => {
    if (++attempts === 1) throw new Error('连接失败');
    return user;
  } });
  await f.page.onShow();
  assert.equal(f.page.data.loginSheetOpen, false);
  f.page.openMenu();
  assert.equal(f.page.data.loginSheetOpen, true);
  assert.equal(f.page.data.menuOpen, false);
  assert.equal(f.bar.authBlocked, true);
  f.page.selectTab({ currentTarget: { dataset: { key: 'campus' } } });
  assert.equal(f.page.data.activeTab, 'square');
  await f.page.login();
  assert.equal(f.page.data.error, '连接失败');
  assert.equal(f.page.data.loginSheetOpen, true);
  await f.page.login();
  assert.equal(f.page.data.user._id, user._id);
  assert.equal(f.page.data.loginSheetOpen, false);
  assert.equal(f.page.data.menuOpen, false);
  assert.deepEqual(f.routes, []);
  assert.equal(f.bar.authBlocked, false);
  f.page.openMenu();
  assert.equal(f.page.data.menuOpen, true);
});

test('首页取消登录不跳转，保持首页可浏览；迟到的登录响应不会重新显示账号或菜单', async () => {
  let resolve;
  const f = fixture({ restore: () => null, login: () => new Promise(done => { resolve = done; }) });
  await f.page.onShow();
  f.page.openMenu();
  const pending = f.page.login();
  await f.page.login();
  assert.equal(f.requests.filter(value => value === 'login').length, 1);
  f.page.cancelLogin();
  assert.equal(f.page.data.loginSheetOpen, false);
  assert.equal(f.bar.authBlocked, false);
  resolve(user);
  await pending;
  assert.equal(f.page.data.user, null);
  assert.equal(f.page.data.menuOpen, false);
  assert.deepEqual(f.routes, []);
  assert.deepEqual(f.requests, ['restore', 'login', 'logout']);
  assert.equal(f.toasts.length, 0);
});

test('头像点击等待会话恢复后再决定弹登录；离开首页后不弹迟到面板', async () => {
  let resolve;
  const f = fixture({ restore: () => new Promise(done => { resolve = done; }) });
  const pending = f.page.onShow();
  f.page.openMenu();
  assert.equal(f.page.data.authChecking, true);
  assert.equal(f.bar.authBlocked, true);
  resolve(null);
  await pending;
  assert.equal(f.page.data.loginSheetOpen, true);
  const g = fixture({ restore: () => new Promise(done => { resolve = done; }) });
  const waiting = g.page.onShow();
  g.page.openMenu(); g.page.onHide(); resolve(null);
  await waiting;
  assert.equal(g.page.data.loginSheetOpen, false);
  assert.equal(g.bar.authBlocked, false);
});

test('底栏最右入口为搜索，个人主页保留为独立页面，登录面板及菜单头像使用共享模板', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.equal(config.tabBar.list.at(-1).pagePath, 'pages/search/index');
  assert.ok(!config.tabBar.list.some(tab => tab.pagePath === 'pages/profile/index'));
  assert.ok(config.pages.includes('pages/profile/index'));
  assert.ok(config.pages.includes('pages/search/index'));
  const profile = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.wxml'), 'utf8');
  assert.doesNotMatch(profile, /has-tab-bar/);
  assert.match(profile, /bindtap="backToHome"/);
});

test('首页菜单退出登录需确认，重复点击只确认一次，取消保留，确认后清空头像和ID', async () => {
  const f = fixture();
  await f.page.onShow();
  f.page.openMenu();
  f.page.logout(); f.page.logout();
  assert.equal(f.modals.length, 1);
  f.modals[0].success({ confirm: false }); f.modals[0].complete();
  assert.equal(f.page.data.user._id, user._id);
  assert.equal(f.page.data.menuOpen, true);
  f.page.logout();
  const frames = [];
  const setData = f.page.setData.bind(f.page);
  f.page.setData = value => {
    setData(value);
    frames.push({ menuOpen: f.page.data.menuOpen, user: f.page.data.user });
  };
  f.modals[1].success({ confirm: true }); f.modals[1].complete();
  assert.deepEqual(f.requests, ['restore', 'logout']);
  assert.equal(f.page.data.user, null);
  assert.equal(f.page.data.menuOpen, false);
  assert.equal(f.page.data.confirmingLogout, false);
  assert.equal(f.page.data.accountHint, '未登录');
  assert.equal(f.bar.menuOpen, false);
  assert.ok(frames.every(frame => frame.menuOpen || frame.user === null), '收起菜单展示首页时不能仍携带旧账号头像');
  f.page.openMenu();
  assert.equal(f.page.data.menuOpen, false);
  assert.equal(f.page.data.loginSheetOpen, true);
});

test('离开页面或切换账号后，迟到的退出确认不会影响账号', async () => {
  for (const action of ['hide', 'unload', 'switch']) {
    const f = fixture();
    await f.page.onShow();
    f.page.openMenu(); f.page.logout();
    if (action === 'hide') f.page.onHide();
    if (action === 'unload') f.page.onUnload();
    if (action === 'switch') f.page.applyUser({ ...user, _id: 'bob' });
    f.modals[0].success({ confirm: true }); f.modals[0].complete();
    assert.deepEqual(f.requests, ['restore']);
    assert.ok(f.page.data.user);
  }
});

test('离开首页后的迟到恢复不覆盖新页面，首次头像加载过程中打开菜单不会突然关闭', async () => {
  let resolve;
  const f = fixture({ restore: () => new Promise(done => { resolve = done; }) });
  const pending = f.page.onShow();
  f.page.openMenu();
  resolve(user);
  await pending;
  assert.equal(f.page.data.menuOpen, true);
  assert.equal(f.page.data.user._id, user._id);
  let finish;
  const g = fixture({ restore: () => new Promise(done => { finish = done; }) });
  const waiting = g.page.onShow();
  g.page.onHide();
  finish(user);
  await waiting;
  assert.equal(g.page.data.user, null);
  assert.equal(g.bar.menuOpen, false);
});

test('首页读取失败不会展示旧账号，重新进入后可恢复真实资料', async () => {
  let fail = false;
  const f = fixture({ restore: () => { if (fail) throw new Error('连接失败'); return user; } });
  await f.page.onShow();
  f.page.onHide(); fail = true;
  await f.page.onShow();
  assert.equal(f.page.data.user, null);
  assert.equal(f.page.data.accountHint, '账号信息暂不可用');
  assert.equal(f.page.data.loading, false);
  f.page.onHide(); fail = false;
  await f.page.onShow();
  assert.equal(f.page.data.user._id, user._id);
  assert.equal(f.page.data.error, '');
});

test('首页Cui起伏等待真实刷新，不清空已有动态，重复下拉合并请求，成功后收起', async () => {
  let finish;
  const old = { _id: 'old', content: '已有动态', author: { nickname: '同学' } };
  const f = fixture({ cachedFeed: { items: [old], hasMore: false, nextOffset: 1 }, list: () => new Promise(resolve => { finish = resolve; }) });
  f.page.onLoad();
  const refreshing = f.page.refreshFeed();
  assert.equal(f.page.data.pullRefreshing, true); assert.equal(f.page.data.posts[0].content, old.content);
  assert.equal(f.feedRequests[0].force, true);
  assert.equal(f.page.refreshFeed(), refreshing); assert.equal(f.feedRequests.length, 1);
  finish({ items: [{ ...old, content: '最新动态' }], hasMore: false, nextOffset: 1 });
  await refreshing;
  assert.equal(f.page.data.posts[0].content, '最新动态'); assert.equal(f.page.data.pullRefreshing, false);
  assert.equal(f.page._pullRefresh, null);
});

test('已有首屏请求时Cui起伏等待同一请求；失败保留内容并收起，离开后不干扰新刷新', async () => {
  let fail;
  const f = fixture({ list: () => new Promise((resolve, reject) => { fail = reject; }) });
  f.page.data.posts = [{ _id: 'old', content: '已有内容', author: {} }];
  const existing = f.page.loadFeed(false);
  const refreshing = f.page.refreshFeed();
  assert.equal(f.feedRequests.length, 1); assert.equal(f.page.data.pullRefreshing, true);
  fail(new Error('网络失败')); await existing; await refreshing;
  assert.equal(f.page.data.posts[0].content, '已有内容'); assert.equal(f.page.data.feedError, '网络失败');
  assert.equal(f.page.data.pullRefreshing, false);
  let finish;
  const g = fixture({ list: () => new Promise(resolve => { finish = resolve; }) });
  const stale = g.page.refreshFeed(); g.page.onHide();
  assert.equal(g.page.data.pullRefreshing, false);
  finish({ items: [], hasMore: false, nextOffset: 0 }); await stale;
  assert.equal(g.page.data.pullRefreshing, false);
});

test('分页中的下拉在分页结束后刷新首屏；菜单、登录面板和占位板块不触发刷新', async () => {
  let finish;
  const f = fixture({ list: args => args.offset ? new Promise(resolve => { finish = resolve; }) : { items: [], hasMore: false, nextOffset: 0 } });
  f.page.data.feedOffset = 20;
  const more = f.page.loadFeed(false, true), refreshing = f.page.refreshFeed();
  assert.equal(f.feedRequests.length, 1);
  finish({ items: [], hasMore: false, nextOffset: 20 }); await more; await refreshing;
  assert.equal(f.feedRequests.length, 2); assert.equal(f.feedRequests[1].force, true); assert.equal(f.feedRequests[1].offset, 0);
  for (const state of [{ menuOpen: true }, { loginSheetOpen: true }, { activeTab: 'following' }, { commentPostId: 'open' }]) {
    const g = fixture(); Object.assign(g.page.data, state); await g.page.refreshFeed();
    assert.equal(g.page.data.pullRefreshing, false); assert.equal(g.feedRequests.length, 0);
  }
});

test('内容区触底继续分页，刷新或弹层期间不并发触发分页', async () => {
  const f = fixture();
  f.page.data.feedHasMore = true; f.page.data.feedOffset = 20;
  await f.page.loadMoreFeed();
  assert.equal(f.feedRequests[0].offset, 20);
  for (const state of [{ menuOpen: true }, { loginSheetOpen: true }, { pullRefreshing: true }, { commentPostId: 'open' }]) {
    const g = fixture(); Object.assign(g.page.data, { feedHasMore: true, feedOffset: 20 }, state);
    await g.page.loadMoreFeed(); assert.equal(g.feedRequests.length, 0);
  }
});

test('原生相册、拍照及预览往返保留评论组件；普通离开仍关闭面板', async () => {
  const f = fixture({ cachedUser: user }); f.page.onLoad(); await f.page.onShow();
  let mediaActive = true;
  f.page.selectComponent = selector => selector === '#active-comments' ? { isNativeMediaActive: () => mediaActive } : null;
  f.page.openComments({ detail: { id: 'post' } }); f.page.onHide();
  assert.equal(f.page.data.commentPostId, 'post');
  mediaActive = false; await f.page.onShow(); assert.equal(f.page.data.commentPostId, 'post'); assert.equal(f.bar.commentsOpen, true);
  f.page.onHide(); assert.equal(f.page.data.commentPostId, '');
});

test('评论面板打开时隐藏底栏，关闭、离开及重新进入首页后恢复底栏', () => {
  const f = fixture();
  f.page.openComments({ detail: { id: 'post' } });
  assert.equal(f.page.data.commentPostId, 'post'); assert.equal(f.bar.commentsOpen, true);
  f.page.syncNavigation(); assert.equal(f.bar.commentsOpen, true);
  f.page.closeComments(); assert.equal(f.bar.commentsOpen, false);
  f.page.openComments({ detail: { id: 'post' } }); f.page.onHide();
  assert.equal(f.page.data.commentPostId, ''); assert.equal(f.bar.commentsOpen, false);
  f.page.syncNavigation(); assert.equal(f.bar.commentsOpen, false);
});

test('旧分享参数不再插入指定动态，首页正常显示广场列表', () => {
  const normal = { _id: 'normal', content: '正常广场动态', author: { nickname: '同学' } };
  const f = fixture({ cachedFeed: { items: [normal], hasMore: false, nextOffset: 1 } });
  f.page.onLoad({ postId: 'p_' + 'a'.repeat(40) });
  assert.equal(f.page.data.posts.length, 1); assert.equal(f.page.data.posts[0]._id, normal._id);
  assert.equal(f.page.loadSharedPost, undefined); assert.equal(f.page.onShareAppMessage, undefined);
});

test('首页发布在原位打开面板，不跳转路由；取消后恢复操作并保留原列表', () => {
  const normal = { _id: 'normal', content: '原列表内容', author: { nickname: '同学' } };
  const f = fixture({ cachedUser: user, cachedFeed: { items: [normal], hasMore: false, nextOffset: 1 } });
  f.page.onLoad(); f.page.openComposer();
  assert.equal(f.page.data.composerOpen, true); assert.equal(f.routes.length, 0);
  assert.equal(f.bar.composerOpen, true);
  assert.equal(f.page.interactionBlocked(), true);
  f.page.openMenu(); assert.equal(f.page.data.menuOpen, false);
  f.page.openComposer(); assert.equal(f.routes.length, 0);
  f.page.closeComposer({ detail: { published: false } });
  assert.equal(f.page.data.composerOpen, false); assert.equal(f.page.interactionBlocked(), false);
  assert.equal(f.bar.composerOpen, false);
  assert.equal(f.page.data.posts[0]._id, normal._id); assert.equal(f.feedRequests.length, 0);
});

test('首页发布面板保留后台草稿时释放底栏标记，返回后恢复遮挡状态', async () => {
  const f = fixture({ cachedUser: user }); f.page.onLoad(); f.page.openComposer();
  assert.equal(f.bar.composerOpen, true);
  f.page.onHide(); assert.equal(f.bar.composerOpen, false);
  assert.equal(f.page.data.composerOpen, true);
  await f.page.onShow(); assert.equal(f.bar.composerOpen, true);
  f.page.closeComposer({ detail: { published: false } }); assert.equal(f.bar.composerOpen, false);
});

test('发布时账号失效关闭面板，同时清理底栏发布遮挡标记', () => {
  const f = fixture({ cachedUser: user }); f.page.onLoad(); f.page.openComposer();
  assert.equal(f.bar.composerOpen, true);
  f.page.applyUser(null);
  assert.equal(f.page.data.composerOpen, false); assert.equal(f.bar.composerOpen, false);
});


test('侧栏获赞先展示缓存，后台更新只写统计；失败及切换账号不显示假零或旧账号数据', async () => {
  let finish, fail = false;
  const options = { cachedUser: user, cachedOwnStats: { receivedLikes: 27 }, getOwnStats: () => fail ? Promise.reject(new Error('offline')) : new Promise(resolve => { finish = resolve; }) };
  const f = fixture(options); f.page.onLoad();
  assert.equal(f.page.data.menuLikeCount, 27);
  f.page.openMenu(); const rows = f.page.data.posts, avatar = f.page.data.homeAvatarSource;
  finish({ receivedLikes: 35 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.page.data.menuLikeCount, 35); assert.equal(f.page.data.posts, rows); assert.equal(f.page.data.homeAvatarSource, avatar);
  options.cachedOwnStats = { receivedLikes: 35 }; fail = true;
  f.page.closeMenu(); f.page.openMenu(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.page.data.menuLikeCount, 35);
  fail = false; f.page.closeMenu(); f.page.openMenu();
  options.cachedUser = { ...user, _id: 'bob' }; options.cachedOwnStats = null; options.sessionVersion = 1;
  f.page.applyUser(options.cachedUser); finish({ receivedLikes: 999 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.page.data.menuLikeCount, '—');
});
