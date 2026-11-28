const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const queryTools = require('../miniprogram/utils/search-query');
const {loadPostActions,applyPageData} = require('./helpers/post-actions-fixture');
const viewer = {_id:'alice',accountId:'12345678',role:'user'};
const target = '87654321';
const row = text => ({_id:'p_'+(text==='new'?'b':'a').repeat(40),content:text,images:['cloud://public/photo'],author:{accountId:target,nickname:'同学'},createdAt:'2026-11-21T00:00:00Z'});

test('搜索参数按JSON传递，包含百分号、中文和符号时不被重复解码或改变',()=>{
  const query={keyword:'校园 100% %E4 & + # 😀',accountId:target},url=queryTools.resultUrl(query),raw=url.split('?query=')[1];
  assert.deepEqual(queryTools.fromOptions({query:raw}),query);assert.deepEqual(queryTools.fromOptions({query:decodeURIComponent(raw)}),query);
  assert.throws(()=>queryTools.normalize({keyword:''}));assert.throws(()=>queryTools.normalize({keyword:'a'.repeat(101)}));
});

function entryFixture() {
  let definition,entry={accountId:target},key='alice:0',pending=null;
  const routes=[],toasts=[];
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/search/index.js','utf8'),{
    Page:value=>{definition=value;},require: name => name.includes('utils/post-actions') ? require('../miniprogram/utils/post-actions') : name.includes('label-indicator') ? require('../miniprogram/utils/label-indicator') : name === './refresh' ? require('../miniprogram/pages/search/refresh') : name.includes('utils/account-menu') ? require('../miniprogram/utils/account-menu') : name.includes('utils/tab-page-layout') ? require('../miniprogram/utils/tab-page-layout') : name.includes('services/square') ? {} : name.includes('services/hotboard')?{cached:()=>null,load:async()=>{throw new Error('此测试不联网');}}:name.includes('services/user')?{getCachedUser:()=>null,restore:async()=>null,searchSessionKey:()=>key,consumeSearchEntry:()=>{const value=entry;entry=null;return value;}}:name.includes('tab-selection')?{pendingIndex:()=>pending}:name.includes('search-query')?queryTools:()=>({data:{},onLoad(){},onShow(){this._visible=true;}}),
    wx:{navigateTo:args=>routes.push(args),showToast:args=>toasts.push(args.title),hideKeyboard(){}},
  });
  const page={...definition,data:structuredClone(definition.data),setData(patch){applyPageData(this.data,patch);}};
  return {page,routes,toasts,globalEntry(){pending=3;},switchUser(){key='bob:1';}};
}

test('个人主页带公开 ID 进入副搜索页，普通搜索入口不携带上一位作者',()=>{
  const f=entryFixture();
  f.page.onLoad();f.page.onShow();
  assert.equal(f.routes[0].url,'/pages/search-entry/index?accountId='+target);
  f.page.tapSearchEntry();assert.equal(f.routes.length,1);
  f.page.onShow();f.page.tapSearchEntry();
  assert.equal(f.routes[1].url,'/pages/search-entry/index');
});

function searchEntryFixture() {
  let definition, user = viewer, version = 0;
  let storageFailure = false;
  const routes = [], toasts = [], storage = new Map();
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => {
      if (storageFailure) throw new Error('storage unavailable');
      storage.set(key, value);
    },
    hideKeyboard() {}, navigateTo: args => routes.push(args), navigateBack: args => routes.push({back:args}),
    showToast: args => toasts.push(args.title),
  };
  const users = { getCachedUser: () => user, searchSessionKey: () => `${user?._id || 'guest'}:${version}` };
  const history = { module: { exports: {} }, wx, require: () => queryTools };
  vm.runInNewContext(fs.readFileSync('miniprogram/services/search-history.js', 'utf8'), history);
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/search-entry/index.js', 'utf8'), {
    wx, setTimeout, clearTimeout, Page: value => { definition = value; },
    require: name => name.endsWith('services/user') ? users : name.endsWith('search-history') ? history.module.exports :
      require('../miniprogram/utils/' + name.split('/').pop()),
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(values, callback) {
    Object.assign(this.data, values);
    callback?.();
  } };
  page.onLoad({ accountId: target }); page.onShow();
  return {page, routes, toasts, storage, switchUser(value) { user=value; version++; },
    failStorage(value) { storageFailure = value; }};
}

test('副搜索成功后返回时清空关键词和作者胶囊并保留记录，失败可重试',()=>{
  const f=searchEntryFixture();
  assert.equal(f.page.data.accountId,target);
  f.page.onInput({detail:{value:'校园'}});
  f.page.onHide(); f.page.onShow();
  assert.equal(f.page.data.keyword,'校园');
  assert.equal(f.page.data.accountId,target);
  f.page.search(); f.routes[0].fail();
  assert.equal(f.storage.size,0);
  assert.equal(f.page.data.keyword,'校园');
  assert.equal(f.page.data.accountId,target);
  f.page.search(); f.page.onHide(); f.routes[1].success(); f.page.onShow();
  assert.deepEqual(queryTools.fromOptions({query:f.routes[1].url.split('?query=')[1]}),{keyword:'校园',accountId:target});
  assert.equal(f.page.data.keyword,'');
  assert.equal(f.page.data.accountId,'');
  assert.equal(f.page.data.records[0].keyword,'校园');
  assert.equal(f.page.data.records[0].accountId,target);
  f.page.searchRecord({currentTarget:{dataset:{id:f.page.data.records[0].id}}});
  f.page.onHide(); f.routes[2].success(); f.page.onShow();
  assert.equal(f.page.data.records.length,1);
  f.page.cancel();
  assert.ok(f.routes[3].back);
});

test('副搜索页移除胶囊恢复普通搜索，切换登录账号时隔离历史和迟到记录',()=>{
  const f=searchEntryFixture();f.page.removeAuthor();f.page.search();assert.equal(f.routes.length,0);assert.equal(f.toasts.length,1);
  f.page.onInput({detail:{value:'关键字'}});f.page.search();assert.equal(queryTools.fromOptions({query:f.routes[0].url.split('?query=')[1]}).accountId,'');
  f.page.onHide(); f.switchUser({_id:'bob'}); f.routes[0].success(); f.page.onShow();
  assert.equal(f.page.data.keyword,'');assert.equal(f.page.data.records.length,0);assert.equal(f.storage.size,0);
});

test('删除只写入当前账号并只移除目标搜索记录，存储失败保留记录', () => {
  const f = searchEntryFixture();
  const key = 'campus.search-entry-history.v1:alice';
  const otherKey = 'campus.search-entry-history.v1:bob';
  const targetRecord = { keyword: '校园', accountId: target };
  const keptRecord = { keyword: '校园', accountId: '' };
  f.storage.set(key, [targetRecord, keptRecord]);
  f.storage.set(otherKey, [targetRecord]);
  f.page.onShow();
  const { id } = f.page.data.records[0];

  f.failStorage(true);
  f.page.deleteHistoryRecord({ id });
  assert.equal(f.page.data.records.length, 2);
  assert.equal(f.page.data.removingId, '');
  assert.equal(f.toasts.length, 1);

  f.failStorage(false);
  f.page.deleteHistoryRecord({ id });
  assert.equal(f.page.data.removingId, id);
  assert.equal(f.page.data.records.length, 2);
  assert.deepEqual(structuredClone(f.storage.get(key)), [keptRecord]);
  assert.deepEqual(f.storage.get(otherKey), [targetRecord]);
  f.page.onHide(); f.page.onShow();
  assert.equal(f.page.data.records.length, 1);
  assert.equal(f.page.data.records[0].accountId, '');
  assert.equal(f.page.data.removingId, '');
});

test('搜索记录区分纵向滚动和横向拖动，滑开后才可删除，右滑收回', () => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/search-entry/history-swipe.wxs', 'utf8'), { module });
  const swipe = module.exports;
  const styles = {}, state = {}, calls = [];
  const owner = {
    getState: () => state,
    callMethod: (name, args) => calls.push([name, args]),
    selectComponent: selector => ({ addClass() {}, removeClass() {}, setStyle: style => { styles[selector] = style; } }),
  };
  const event = (x, y, time = 0, id = 'first', index = 0) => ({ touches: [{ clientX: x, clientY: y }],
    timeStamp: time, currentTarget: { dataset: { id, index } } });
  swipe.sync({ width: 375 }, null, owner);
  swipe.start(event(100, 20), owner);
  swipe.move(event(97, 50), owner);
  swipe.end(event(97, 50, 100), owner);
  swipe.tap(event(97, 50), owner);
  assert.equal(Object.keys(styles).length, 0);
  assert.equal(calls.length, 0);

  swipe.start(event(100, 20), owner);
  swipe.move(event(85, 22), owner);
  assert.equal(styles['.history-card-0'].transform, 'translate3d(-15px,0,0)');
  swipe.end(event(85, 22, 100), owner);
  assert.equal(styles['.history-card-0'].transform, 'translate3d(-44px,0,0)');
  swipe.remove(event(85, 22), owner);
  assert.equal(calls.length, 0);
  swipe.start(event(85, 22), owner);
  swipe.end(event(85, 22), owner);
  swipe.remove(event(85, 22), owner);
  assert.equal(calls[0][0], 'deleteHistoryRecord');
  assert.equal(calls[0][1].id, 'first');

  swipe.start(event(80, 20), owner);
  swipe.move(event(112, 21), owner);
  swipe.end(event(112, 21, 100), owner);
  assert.equal(styles['.history-card-0'].transform, 'translate3d(0px,0,0)');
  swipe.start(event(100, 20), owner);
  swipe.tap(event(100, 20), owner);
  assert.equal(calls[1][0], 'searchRecord');
});

function resultsFixture(options={}) {
  let definition,user=options.guest?null:viewer,version=0;
  const cache=new Map(),calls=[],routes=[],toasts=[];
  const users={getCachedUser:()=>user,getSessionVersion:()=>version,seedPublicProfile(){}};
  const square={cachedSearch:q=>cache.get(JSON.stringify([q.keyword,q.accountId,q.kind])),
    searchContent:async q=>{calls.push(q);const value=options.read?await options.read(q):{...q,items:q.kind==='users'?[{accountId:target,nickname:'同学',isVerified:false}]:[row(q.keyword)],hasMore:false,nextCursor:''};cache.set(JSON.stringify([q.keyword,q.accountId,q.kind]),value);return value;},
    cachedPost:()=>null,subscribePost:()=>()=>{},subscribeFollow:()=>()=>{},subscribeAI:()=>()=>{},consumePublication(){},cachedFollowProfile:()=>null,cachedFollowState:()=>null};
  const wx={navigateTo:args=>routes.push(args.url),navigateBack:()=>routes.push('back'),switchTab:args=>routes.push(args.url),showToast:args=>toasts.push(args.title),hideKeyboard(){}};
  const actions=loadPostActions(users,square,wx);
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/search-results/index.js','utf8'),{
    Page:value=>{definition=value;},wx,
    require:name=>name.includes('services/user')?users:name.includes('services/square')?square:name.includes('post-actions')?actions:name.includes('login-gate')?{requestLogin(){this.setData({loginSheetOpen:true});}}:name.includes('search-query')?queryTools:{postPreview:require('../miniprogram/utils/post-view').postPreview,nav(){}},
  });
  const page={...definition,route:'pages/search-results/index',data:structuredClone(definition.data),setData(patch){applyPageData(this.data,patch);},selectComponent:()=>options.nativeMedia?{isNativeMediaActive:()=>true}:null};
  const query=options.query||{keyword:'校园',accountId:''};page.onLoad({query:encodeURIComponent(JSON.stringify(query))});
  return {page,calls,routes,toasts,cache,square,switchUser(value){user=value;version++;},query};
}

test('只带账号默认用户栏，有关键词默认动态栏，三个标签切换保留卡片和图片节点数据',async()=>{
  const only=resultsFixture({query:{keyword:'',accountId:target}});only.page.onShow();await new Promise(resolve=>setImmediate(resolve));assert.equal(only.page.data.tabIndex,2);assert.equal(only.calls[0].kind,'users');assert.equal(only.page.data.userRows[0].accountId,target);
  const f=resultsFixture();f.page.onShow();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls[0].kind,'square');const posts=f.page.data.posts,images=posts[0].images;
  f.page.selectTab({currentTarget:{dataset:{index:1}}});assert.equal(f.calls.length,1);assert.equal(f.page.data.posts,posts);
  f.page.selectTab({currentTarget:{dataset:{index:2}}});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.page.data.userRows.length,1);assert.equal(f.page.data.posts,posts);
  f.page.selectTab({currentTarget:{dataset:{index:0}}});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.page.data.posts,posts);assert.equal(f.page.data.posts[0].images,images);
});

test('新关键词与移除作者条件替换查询，旧查询迟到不能覆盖；清空条件不继续分页',async()=>{
  const waiting=[];const f=resultsFixture({query:{keyword:'old',accountId:target},read:q=>new Promise(resolve=>waiting.push({q,resolve}))});f.page.onShow();
  f.page.onInput({detail:{value:'new'}});f.page.removeAuthor();assert.equal(waiting.length,2);assert.equal(waiting[1].q.accountId,'');
  waiting[1].resolve({...waiting[1].q,items:[row('new')],hasMore:true,nextCursor:'cursor'});await new Promise(resolve=>setImmediate(resolve));
  waiting[0].resolve({...waiting[0].q,items:[row('old')],hasMore:false,nextCursor:''});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.page.data.posts[0].content,'new');
  f.page.onInput({detail:{value:''}});f.page.removeAuthor();assert.equal(f.page.data.queryReady,false);assert.equal(f.page.data.squareHasMore,false);await f.page.loadMore({currentTarget:{dataset:{kind:'square'}}});assert.equal(waiting.length,2);
});

test('用户搜索结果可进入真实主页，匿名用户切到用户栏提示登录；隐藏保留选图中的评论节点',async()=>{
  const f=resultsFixture({query:{keyword:'',accountId:target}});f.page.onShow();await new Promise(resolve=>setImmediate(resolve));f.page.openUser({currentTarget:{dataset:{id:target}}});assert.equal(f.routes[0],'/pages/profile/index?accountId='+target);
  const guest=resultsFixture({guest:true});guest.page.onShow();await new Promise(resolve=>setImmediate(resolve));guest.page.selectTab({currentTarget:{dataset:{index:2}}});assert.equal(guest.page.data.needsLogin,true);assert.equal(guest.calls.length,1);
  const native=resultsFixture({nativeMedia:true});native.page.onShow();await new Promise(resolve=>setImmediate(resolve));native.page.data.commentPostId='post';const posts=native.page.data.posts;native.page.onHide();assert.equal(native.page.data.commentPostId,'post');assert.equal(native.page.data.posts,posts);
});
