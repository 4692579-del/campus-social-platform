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
    Page:value=>{definition=value;},require:name=>name.includes('services/user')?{searchSessionKey:()=>key,consumeSearchEntry:()=>{const value=entry;entry=null;return value;}}:name.includes('tab-selection')?{pendingIndex:()=>pending}:name.includes('search-query')?queryTools:()=>({data:{},onLoad(){},onShow(){this._visible=true;}}),
    wx:{navigateTo:args=>routes.push(args),showToast:args=>toasts.push(args.title),hideKeyboard(){}},
  });
  const page={...definition,data:structuredClone(definition.data),setData(patch){applyPageData(this.data,patch);}};
  return {page,routes,toasts,globalEntry(){pending=3;},switchUser(){key='bob:1';}};
}

test('个人主页入口带账号胶囊，空关键词可提交；返回结果页保留草稿，普通底栏入口移除胶囊',()=>{
  const f=entryFixture();f.page.onLoad();f.page.onShow();assert.equal(f.page.data.accountId,target);f.page.search();
  assert.deepEqual(queryTools.fromOptions({query:f.routes[0].url.split('?query=')[1]}),{keyword:'',accountId:target});
  f.page.onInput({detail:{value:'文案'}});f.page.onShow();assert.equal(f.page.data.keyword,'文案');assert.equal(f.page.data.accountId,target);
  f.page.onShow();assert.equal(f.page.data.keyword,'文案');assert.equal(f.page.data.accountId,target,'切后台返回仍保留作者与草稿');
  f.globalEntry();f.page.onShow();assert.equal(f.page.data.accountId,'');assert.equal(f.page.data.keyword,'文案');
  f.switchUser();f.page.onShow();assert.equal(f.page.data.keyword,'');assert.equal(f.page.data.accountId,'');
});

test('移除胶囊即恢复普通搜索，无关键词和无胶囊时不创建空结果页',()=>{
  const f=entryFixture();f.page.onLoad();f.page.onShow();f.page.removeAuthor();f.page.search();assert.equal(f.routes.length,0);assert.equal(f.toasts.length,1);
  f.page.onInput({detail:{value:'关键字'}});f.page.search();assert.equal(queryTools.fromOptions({query:f.routes[0].url.split('?query=')[1]}).accountId,'');
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
