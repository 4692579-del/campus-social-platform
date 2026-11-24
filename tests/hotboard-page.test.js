const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const queryTools=require('../miniprogram/utils/search-query');
const { loadPostActions } = require('./helpers/post-actions-fixture');
const flush=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};
const makeBoard=(type='weibo',count=20)=>({type,updateTime:'2026-11-21T16:24:00.000Z',fetchedAt:100000000,expiresAt:100300000,stale:false,list:Array.from({length:count},(_,index)=>({rank:index+11,title:`仅用于自动测试的词条${index}`}))});
function clientFixture(read){
  const calls=[];let now=100000000;const context={module:{exports:{}},Date:class extends Date{static now(){return now;}},wx:{cloud:{callFunction:async value=>{calls.push(value);return read(value,calls.length);}}}};
  vm.runInNewContext(fs.readFileSync('miniprogram/services/hotboard.js','utf8'),context);
  return {client:context.module.exports,calls,advance:ms=>{now+=ms;}};
}
test('客户端仅调用自有云函数，合并平台请求和短时缓存，保留后台过期与真实失败状态',async()=>{
  const f=clientFixture(async()=>({result:{success:true,board:makeBoard()}}));
  await Promise.all([f.client.load('weibo'),f.client.load('weibo')]);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].name,'hotboard');assert.deepEqual(Object.keys(f.calls[0].data),['type']);
  await f.client.load('weibo');assert.equal(f.calls.length,1);f.advance(60001);await f.client.load('weibo');assert.equal(f.calls.length,2);
  await Promise.all([f.client.load('weibo', { force: true }), f.client.load('weibo', { force: true })]);
  assert.equal(f.calls.length,3);
  const bad=clientFixture(async()=>({result:{success:false,code:'HOTBOARD_AUTH_FAILED',message:'热榜服务鉴权失败'}}));
  await assert.rejects(bad.client.load('weibo'),error=>error.code==='HOTBOARD_AUTH_FAILED');assert.equal(bad.client.cached('weibo'),null);
  assert.equal(f.client.updateText('2026-11-21T16:24:00.000Z'),'11-22 00:24');
});
function pageFixture(read, api = {}, pendingIndex = () => null, account = {}){
  let definition;const cache=new Map(),calls=[],routes=[],options=[];
  const hot={cached:type=>cache.get(type)||null,updateText:()=> '11-22 00:24',load:async (type, loadOptions)=>{calls.push(type);options.push(loadOptions);const result=read?await read(type):makeBoard(type);cache.set(type,result);return result;}};
  const base={data:{},onLoad(){},onShow(){this._visible=true;},onHide(){this._visible=false;},onUnload(){this._visible=false;this._unloaded=true;}};
  const { refresh = require('../miniprogram/pages/search/refresh') } = account;
  const users = { getCachedUser: () => null, restore: async () => null, searchSessionKey: () => 'viewer:0',
    getSessionVersion: () => 0, consumeSearchEntry: () => null, getPublicProfile: async () => null, ...account.users };
  const square = { getFollowStates: async () => [], ...account.square };
  const wx = { hideKeyboard() {}, navigateTo: value => routes.push(value.url), showToast() {}, ...api };
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/search/index.js','utf8'),{
    Page:value=>{definition=value;},require:name=>name === './refresh' ? refresh : name.includes('utils/account-menu') ? require('../miniprogram/utils/account-menu') : name.includes('utils/tab-page-layout') ? require('../miniprogram/utils/tab-page-layout') : name.includes('utils/post-actions') ? loadPostActions(users, square, wx) : name.includes('services/square') ? square : name.includes('services/hotboard')?hot:name.includes('services/user')?users:name.includes('tab-selection')?{pendingIndex}:name.includes('search-query')?queryTools:()=>base,
    wx,
  });
  const page={...definition,data:structuredClone(definition.data),setData(value, done){Object.assign(this.data,value);done?.();}};page.onLoad();
  const openHotboard = () => page.selectBoardTab({currentTarget:{dataset:{index:2}}});
  return {page,cache,calls,routes,openHotboard,options};
}

test('搜索先显示页面，首次渲染后才挂载榜单和发起请求，返回时保留原内容', async () => {
  const ticks = [];
  const f = pageFixture(undefined, { nextTick: callback => ticks.push(callback) });
  f.page.onShow();
  assert.equal(f.page._visible, true);
  assert.equal(f.page.data.boardsMounted, false);
  assert.deepEqual(f.calls, []);
  f.page.onReady();
  assert.equal(f.page.data.boardsMounted, true);
  assert.deepEqual(f.calls, ['toutiao']);
  await flush();
  f.page.onHide(); f.page.onShow();
  assert.ok(f.page.data.cuiHotRows.length);
  assert.equal(f.calls.length, 1);
  f.page.onHide();
  ticks.pop()();
  assert.equal(f.calls.length, 1);
});

test('Cui热榜宣传片和词条之间展示固定账号，新登录会话可直接关注并从头像进入主页', async () => {
  const ids = ['10000001', '19090448', '58732480', '45214114'];
  const profiles = new Map(), following = new Set(), writes = [];
  let user = null, version = 0;
  const f = pageFixture(undefined, {}, () => null, {
    users: {
      getCachedUser: () => user, restore: async () => user,
      getSessionVersion: () => version, searchSessionKey: () => `${user?._id || 'guest'}:${version}`,
      getCachedPublicProfile: id => profiles.get(id),
      getPublicProfile: async id => profiles.set(id, { accountId: id, nickname: `测试账号 ${id}` }).get(id),
    },
    square: {
      cachedFollowState: id => ({ following: following.has(id) }),
      setFollow: async (id, value) => { writes.push([id, value]); following.add(id); },
    },
  });
  f.page.onShow();
  assert.equal(f.page.data.recommendations.length, 0);
  user = { _id: 'new-user', accountId: '12345678' }; version++;
  f.page.applyMenuUser(user);
  await flush();
  assert.deepEqual(Array.from(f.page.data.recommendations, row => row.accountId), ids);
  const event = accountId => ({ currentTarget: { dataset: { accountId } } });
  await f.page.followRecommendation(event(ids[0]));
  await f.page.followRecommendation(event(ids[0]));
  assert.deepEqual(writes, [[ids[0], true]]);
  assert.equal(f.page.data.recommendations[0].following, true);
  f.page.openRecommendation(event(ids[1]));
  assert.deepEqual(f.routes, ['/pages/profile/index?accountId=19090448']);
  const markup = fs.readFileSync('miniprogram/pages/search/index.wxml', 'utf8');
  const recommendations = markup.indexOf('class="cui-recommendations"');
  const hotboard = markup.indexOf('class="cui-hotboard"');
  const section = markup.slice(recommendations, hotboard);
  assert.ok(markup.indexOf('class="cui-promo-frame"') < recommendations);
  assert.ok(recommendations < hotboard);
  assert.doesNotMatch(markup, /榜单更新于|hot-updated/);
  assert.match(section, /scroll-x/);
  assert.doesNotMatch(section, /dismiss|x\.svg/);
});

test('探索标签的全球热点横幅位于榜单前，探索按钮只导航一次到独立新闻页', async () => {
  const f = pageFixture();
  f.page.onShow();
  f.page.exploreHotList();
  assert.equal(f.routes.length, 0);
  f.openHotboard();
  await flush();
  const rows = f.page.data.hotRows;
  const requests = f.calls.length;
  f.page.exploreHotList();
  f.page.exploreHotList();
  assert.deepEqual(f.routes, ['/pages/global-news/index']);
  assert.equal(f.page.data.hotRows, rows);
  assert.equal(f.calls.length, requests);
  const markup = fs.readFileSync('miniprogram/pages/search/index.wxml', 'utf8');
  assert.match(markup, /class="global-trends-banner [^"]+"[\s\S]*?全球热点[\s\S]*?最受欢迎的动态[\s\S]*?catchtap="exploreHotList"[\s\S]*?wx:for="{{hotRows}}"/);
});

test('搜索下拉刷新只重新查询当前榜单，保留已有词条并在字标回蓝后收起缺口', async () => {
  let now = 0, complete, deferred = false;
  const timers = new Map();
  const context = {
    module: { exports: {} }, Date: { now: () => now },
    require: name => require('../miniprogram/utils/' + name.split('/').at(-1)),
    setTimeout(fn, delay) { timers.set(fn, { fn, delay }); return fn; },
    clearTimeout(fn) { timers.delete(fn); },
  };
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/search/refresh.js', 'utf8'), context);
  const runTimer = delay => {
    const timer = [...timers.values()].find(timer => timer.delay === delay);
    assert.ok(timer);
    timers.delete(timer.fn);
    now += delay;
    timer.fn();
  };
  const f = pageFixture(type => deferred ? new Promise(resolve => { complete = resolve; }) : makeBoard(type, 30),
    {}, () => null, { refresh: context.module.exports });
  const frames = [];
  f.page.selectComponent = () => ({ setState: state => frames.push(state) });
  f.page.onShow(); f.openHotboard(); await flush();
  f.page.showMoreHotwords();
  const previous = f.page.data.hotRows;
  frames.length = 0;
  f.page.beginSearchPull();
  f.page.pullSearch({ detail: { dy: 18 } });
  assert.equal(f.page.data.searchRefreshVisible, true);
  assert.equal(frames.at(-1).phase, 'pulling');
  assert.equal(frames.at(-1).progress, 0.25);
  f.page.pullSearch({ detail: { dy: 36 } });
  assert.equal(frames.at(-1).progress, 0.5);
  assert.deepEqual(f.calls, ['toutiao', 'weibo']);
  f.page.pullSearch({ detail: { dy: 66 } });
  assert.equal(f.page.data.searchRefreshVisible, true);
  f.page.releaseSearchPull();
  assert.equal(f.page.data.searchRefreshPhase, 'returning');
  assert.equal(f.page.data.searchRefreshVisible, true);
  assert.equal(frames.at(-1).progress, 66 / 72);
  const returnFrame = frames.at(-1);
  f.page.cancelSearchPull();
  assert.equal(frames.at(-1), returnFrame);
  f.page.pullSearch({ detail: { dy: 70 } });
  assert.equal(frames.at(-1), returnFrame);
  runTimer(returnFrame.duration);
  f.page.onSearchBrandReady();
  assert.equal(f.page.data.searchRefreshPhase, 'idle');
  assert.equal(f.page.data.searchRefreshVisible, false);
  assert.deepEqual(frames.map(frame => frame.phase), ['pulling', 'pulling', 'pulling', 'returning']);
  assert.deepEqual(f.calls, ['toutiao', 'weibo']);

  f.page.beginSearchPull();
  f.page.pullSearch({ detail: { dy: 72 } });
  f.page.releaseSearchPull();
  runTimer(300);
  assert.equal(f.page.data.searchRefreshPhase, 'returning');
  runTimer(frames.at(-1).duration);
  assert.equal(f.page.data.searchRefreshVisible, false);

  deferred = true;
  f.page.beginSearchPull();
  f.page.pullSearch({ detail: { dy: 72 } });
  assert.equal(f.page.data.searchRefreshVisible, true);
  f.page.deferSearchPullCancel();
  const refresh = f.page.refreshSearch();
  assert.equal(f.page.refreshSearch(), refresh);
  assert.equal(f.options.at(-1).force, true);
  assert.deepEqual(f.calls, ['toutiao', 'weibo', 'weibo']);
  assert.equal(f.page.data.hotRows, previous);
  assert.equal(f.page.data.searchRefreshing, true);
  now += 980;
  complete(makeBoard('weibo', 31));
  await refresh;
  assert.equal(f.page.data.searchRefreshPhase, 'loading');
  runTimer(820);
  assert.equal(f.page.data.searchRefreshPhase, 'refill');
  assert.equal(f.page.data.hotRows.length, 20);
  runTimer(600);
  assert.equal(f.page.data.searchRefreshing, false);
  assert.equal(f.page.data.searchRefreshVisible, false);
  assert.equal(frames.at(-1).phase, 'refill');
  f.page.pullSearch({ detail: { dy: 72 } });
  assert.equal(f.page.refreshSearch(), undefined);
  assert.equal(f.page.data.searchRefreshVisible, false);

  f.page.beginSearchPull();
  f.page.pullSearch({ detail: { dy: 72 } });
  const late = f.page.refreshSearch();
  f.page.onHide();
  complete(makeBoard());
  await late;
  assert.equal(f.page.data.searchRefreshPhase, 'idle');
  assert.equal(f.page.data.searchRefreshVisible, false);
  assert.equal(timers.size, 0);

  const markup = fs.readFileSync('miniprogram/pages/search/index.wxml', 'utf8');
  const logo = markup.indexOf('id="search-cui"');
  const scroll = markup.indexOf('<scroll-view class="search-discovery"');
  assert.ok(logo >= 0 && logo < scroll);
  assert.match(markup, /wx:if="{{searchRefreshVisible}}" class="search-refresh-anchor"/);
  assert.match(markup, /refresher-background="transparent"/);
});
test('热榜完整展示原排名，预填和平台切换复用缓存',async()=>{
  const f=pageFixture();f.cache.set('weibo',makeBoard('weibo',8));f.page.onShow();
  assert.deepEqual([...f.page.data.boardTabs],['Cui热榜','校园热榜','探索']);
  assert.equal(f.page.data.boardIndex,0);assert.deepEqual(f.calls,['toutiao']);
  f.page.selectBoardTab({currentTarget:{dataset:{index:1}}});
  assert.equal(f.page.canPullSearch(), false);
  assert.deepEqual(f.calls,['toutiao']);
  f.openHotboard();assert.equal(f.page.data.hotRows[0].rank,11);
  assert.equal(f.page.canPullSearch(), true);
  assert.equal(f.page.data.hotRows.length,8);assert.equal(f.page.data.hotHasMore,false);
  await flush();assert.equal(f.page.data.hotRows.length,10);assert.equal(f.page.data.hotHasMore,true);
  await f.page.selectHotPlatform({currentTarget:{dataset:{type:'baidu'}}});assert.equal(f.page.data.hotType,'baidu');
  await f.page.selectHotPlatform({currentTarget:{dataset:{type:'weibo'}}});assert.equal(f.page.data.hotRows[0].rank,11);
});

test('搜索侧栏打开荟萃计划时隐藏底栏，页面隐藏后清除遮挡', () => {
  const f = pageFixture();
  const bar = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
  f.page.getTabBar = () => bar;
  f.page.onShow();
  f.page.setData({ menuOpen: true });
  f.page.selectMenuItem({ currentTarget: { dataset: { key: 'membership' } } });
  assert.equal(f.page.data.membershipOpen, true);
  assert.equal(bar.data.authBlocked, true);
  assert.match(fs.readFileSync('miniprogram/pages/search/index.wxml', 'utf8'), /<membership-sheet[^>]*top="{{navHeight}}"/);
  f.page.onHide();
  assert.equal(f.page.data.membershipOpen, false);
  assert.equal(bar.data.authBlocked, false);
});

test('搜索页的侧栏使用已登录头像和统计，菜单跳转保留展开画面，返回后恢复搜索状态', async () => {
  let user = { _id: 'viewer', accountId: '12345678', avatarFileID: 'avatar' };
  const f = pageFixture(undefined, {}, () => null, {
    users: { getCachedUser: () => user, restore: async () => user },
    square: {
      cachedOwnStats: () => ({ receivedLikes: 6 }), getOwnStats: async () => ({ receivedLikes: 8 }),
      cachedFollowProfile: () => ({ followerCount: 4, followingCount: 2 }),
      getFollowProfile: async () => ({ followerCount: 5, followingCount: 2 }),
    },
  });
  const bar = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
  f.page.getTabBar = () => bar;
  f.page.onShow();
  assert.equal(f.page.data.avatarSource, 'avatar');
  f.openHotboard();
  await f.page.selectHotPlatform({ currentTarget: { dataset: { type: 'baidu' } } });
  f.page.setData({ chromeCompact: true });
  for (const [key, route] of [['profile', '/pages/profile/index'], ['certification', '/pages/certification/index'], ['xiaocui', '/pages/xiaocui-about/index']]) {
    f.page.openMenu();
    assert.equal(f.page.data.menuOpen, true);
    assert.equal(bar.data.menuOpen, true);
    await flush();
    assert.equal(f.page.data.menuLikeCount, 8);
    assert.equal(f.page.data.followerCount, 5);
    f.page.selectMenuItem({ currentTarget: { dataset: { key } } });
    assert.equal(f.routes.at(-1), route);
    f.page.onHide();
    assert.equal(f.page.data.menuOpen, true);
    user = { ...user, avatarFileID: 'updated-avatar' };
    f.page.prepareMenuReturn();
    assert.equal(bar.data.menuOpen, false);
    assert.equal(f.page.data.avatarSource, 'updated-avatar');
    f.page.onShow();
    assert.equal(f.page.data.boardIndex, 2);
    assert.equal(f.page.data.hotType, 'baidu');
    assert.equal(f.page.data.chromeCompact, true);
  }
});
test('初始显示10条，显示更多每次追加10条真实缓存词条，保留原排名和平台进度',async()=>{
  const f=pageFixture(async type=>makeBoard(type,35));f.page.onShow();f.openHotboard();await flush();
  assert.equal(f.page.data.hotRows.length,10);assert.equal(f.page.data.hotHasMore,true);
  for(const count of [20,30,35]){f.page.showMoreHotwords();assert.equal(f.page.data.hotRows.length,count);assert.equal(f.page.data.hotRows[0].rank,11);}
  assert.deepEqual(f.calls,['toutiao','weibo']);assert.equal(f.page.data.hotHasMore,false);f.page.showMoreHotwords();assert.equal(f.page.data.hotRows.length,35);
  await f.page.selectHotPlatform({currentTarget:{dataset:{type:'baidu'}}});assert.equal(f.page.data.hotRows.length,10);
  await f.page.selectHotPlatform({currentTarget:{dataset:{type:'weibo'}}});assert.equal(f.page.data.hotRows.length,35);
});
test('慢响应不会覆盖新平台或隐藏页面，失败保留旧词条且没有缓存时不伪造空榜',async()=>{
  const waiting=[];const f=pageFixture(type=>type === 'toutiao' ? makeBoard(type) : new Promise((resolve,reject)=>waiting.push({type,resolve,reject})));
  f.page.onShow();f.openHotboard();f.page.selectHotPlatform({currentTarget:{dataset:{type:'zhihu'}}});
  waiting[1].resolve(makeBoard('zhihu'));await flush();waiting[0].resolve(makeBoard());await flush();
  assert.equal(f.page.data.hotType,'zhihu');assert.ok(f.page.data.hotRows.every(row=>row.title));
  const before=f.page.data.hotRows;const pending=f.page.loadHotboard();waiting[2].reject(new Error('网络失败'));await pending;
  assert.equal(f.page.data.hotRows,before);assert.equal(f.page.data.hotError,'网络失败');
  f.page.loadHotboard();f.page.onHide();waiting[3].resolve({...makeBoard('zhihu'),list:[]});await flush();assert.equal(f.page.data.hotRows,before);
  const empty=pageFixture(async()=>{throw new Error('云函数未配置');});empty.page.onShow();empty.openHotboard();await flush();assert.equal(empty.page.data.hotRows.length,0);assert.equal(empty.page.data.hotError,'云函数未配置');
});
test('热搜点击进入现有站内动态搜索并移除作者限定，不打开上游外链',async()=>{
  const f=pageFixture();f.page.onShow();f.page.togglePlatformMenu();await flush();f.page.data.accountId='12345678';
  assert.equal(f.page.data.boardIndex,2);assert.equal(f.page.data.platformMenuOpen,true);
  f.page.searchHotword({currentTarget:{dataset:{rank:11}}});assert.equal(f.routes.length,1);
  const query=queryTools.fromOptions({query:f.routes[0].split('?query=')[1]});assert.equal(query.accountId,'');assert.equal(query.keyword,'仅用于自动测试的词条0');
});

test('Cui 热榜在宣传片下读取今日头条缓存和真实排名，点击使用站内搜索',async()=>{
  const f=pageFixture(async type=>makeBoard(type,24));
  f.cache.set('toutiao',makeBoard('toutiao',12));
  f.page.onShow();
  assert.equal(f.page.data.cuiHotRows.length,10);
  await flush();
  assert.equal(f.page.data.cuiHotRows.length,10);
  assert.equal(f.page.data.cuiHotHasMore,true);
  assert.equal(f.page.data.hotRows.length,0);
  f.page.showMoreCuiHotwords();
  assert.equal(f.page.data.cuiHotRows.length,20);
  f.page.showMoreCuiHotwords();
  assert.equal(f.page.data.cuiHotRows.length,24);
  assert.deepEqual(f.calls,['toutiao']);
  f.page.searchHotword({currentTarget:{dataset:{rank:12}}});
  assert.equal(queryTools.fromOptions({query:f.routes[0].split('?query=')[1]}).keyword,'仅用于自动测试的词条1');
  const markup=fs.readFileSync('miniprogram/pages/search/index.wxml','utf8');
  assert.ok(markup.indexOf('class="cui-hotboard"') > markup.indexOf('id="cui-promo"'));
  assert.doesNotMatch(markup,/今日头条热搜/);
});

test('从底栏进入搜索时显示并播放宣传片，切走时暂停并复用播放地址', async () => {
  const playback = [];
  let loads = 0, pending = null;
  const f = pageFixture(undefined, {
    cloud: { async getTempFileURL() {
      loads++;
      return { fileList: [{ status: 0, tempFileURL: 'https://example.test/promo.mp4' }] };
    } },
    createVideoContext: id => ({ play() { playback.push(['play', id]); }, pause() { playback.push(['pause', id]); } }),
  }, () => pending);
  f.page.onShow();
  await flush();
  assert.equal(f.page.data.cuiPromoSrc, 'https://example.test/promo.mp4');
  assert.equal(f.page.data.cuiPromoMuted, true);
  f.page.toggleCuiPromoSound();
  assert.equal(f.page.data.cuiPromoMuted, false);
  f.page.toggleCuiPromoSound();
  assert.equal(f.page.data.cuiPromoMuted, true);
  f.page.toggleCuiPromoSound();
  assert.equal(f.routes.length, 0);
  f.openHotboard();
  f.page.onHide();
  pending = 3;
  f.page.onShow();
  assert.equal(f.page.data.boardIndex, 0);
  assert.equal(f.page.data.cuiPromoMuted, true);
  assert.equal(loads, 1);
  assert.deepEqual(playback.at(-1), ['play', 'cui-promo']);
  f.page.onHide();
  assert.deepEqual(playback.at(-1), ['pause', 'cui-promo']);

  const markup = fs.readFileSync('miniprogram/pages/search/index.wxml', 'utf8');
  const promo = markup.match(/<view class="cui-promo-frame">\s*<block wx:if="{{cuiPromoSrc}}">([\s\S]*?)<\/block>/)[1];
  const video = promo.match(/<video\b[\s\S]*?\/>/)[0];
  assert.match(video, /autoplay="{{searchActive && boardIndex === 0 && !menuOpen && !loginSheetOpen && !authChecking}}"/);
  assert.match(video, /loop="{{true}}"/);
  assert.match(video, /muted="{{cuiPromoMuted}}"/);
  for (const attribute of ['controls', 'show-play-btn', 'show-center-play-btn', 'show-fullscreen-btn', 'play-gesture', 'enable-progress-gesture']) {
    assert.ok(video.includes(`${attribute}="{{false}}"`));
  }
  assert.doesNotMatch(promo, /<cover-(view|image)\b/);
  assert.match(promo, /\/>\s*<view class="cui-promo-link" catchtap="openCuiPromoPost"/);
  assert.match(promo, /<text class="cui-promo-credit">由「Cui · 萃」官方推荐<\/text>/);
  assert.match(promo, /<\/view>\s*<view class="cui-promo-sound" catchtap="toggleCuiPromoSound"/);
  f.page.onShow();
  f.page.openCuiPromoPost();
  f.page.openCuiPromoPost();
  assert.deepEqual(f.routes, ['/pages/square-detail/index?id=p_1efff1a54dbe48e2e8e6ceb309fc2f56bde1a7e6']);
});
