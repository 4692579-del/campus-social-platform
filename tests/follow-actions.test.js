const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadPostActions, applyPageData } = require('./helpers/post-actions-fixture');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  let viewer = {_id:'alice',accountId:'12345678'},session=0,following=false,version=0;
  const target='87654321',calls=[],toasts=[],requests=[],paints=[];
  const row={_id:'p_'+'a'.repeat(40),content:'动态',images:[],author:{accountId:target,nickname:'对方',avatarFileID:'avatar'}};
  const users={getCachedUser:()=>viewer,getSessionVersion:()=>session,logout(){viewer=null;session++;}};
  const profile=id=>({accountId:id,followingCount:id===target?0:Number(following),followerCount:id===target?Number(following):0,version,...(id===target?{following,relationVersion:version}:{})});
  const ok=square=>({result:{success:true,square}});
  const wx={showToast:args=>toasts.push(args.title),showModal:()=>{throw new Error('取关不能再使用原生确认框');},cloud:{callFunction:({data})=>{
    if(data.action==='getSquareFollowProfile')return Promise.resolve(ok({profile:profile(data.accountId)}));
    if(data.action==='getSquareFollowStates')return Promise.resolve(ok({items:data.accountIds.map(accountId=>({accountId,following:accountId===target&&following,version}))}));
    if(data.action!=='setSquareFollow')throw new Error('unexpected '+data.action);
    calls.push({id:data.accountId,value:data.following});
    return new Promise((resolve,reject)=>requests.push(error=>{
      if(error){reject(error);return;}
      if(following!==data.following)version++;following=data.following;
      resolve(ok({state:{accountId:target,following,version},profile:profile(target),viewer:profile(viewer.accountId)}));
    }));
  }}};
  const context={module:{exports:{}},wx,require:name=>name==='./user'?users:require('../miniprogram/utils/'+name.split('/').pop())};
  vm.runInNewContext(fs.readFileSync('miniprogram/services/square.js','utf8'),context);const square=context.module.exports;
  await Promise.all([square.getFollowProfile(target),square.getFollowProfile(viewer.accountId)]);
  const page={...loadPostActions(users,square,wx),_visible:true,interactionBlocked(){return Boolean(this.data.unfollowTarget);},
    data:{isVisitor:true,profileAccountId:target,profileUser:{accountId:target,nickname:'对方',avatarFileID:'avatar'},user:viewer,profileFollowing:false,followKnown:true,followBusy:false,followError:'',followingCount:0,followerCount:0,followByAccount:{},unfollowTarget:null,unfollowClosing:false,unfollowBusy:false,posts:[row]},
    setData(patch){if(Object.hasOwn(patch,'profileFollowing'))paints.push(patch.profileFollowing);applyPageData(this.data,patch);}};
  page.startPostUpdates();
  return {page,calls,toasts,square,paints,row,resolve(error){assert.ok(requests.length,'缺少待保存的关注请求');requests.shift()(error);},switchUser(){viewer={_id:'bob',accountId:'23456789'};session++;page.data.user=viewer;page.data.profileFollowing=false;page.closeUnfollowPrompt(true);square.cachedFollowState(target);}};
}
async function followedFixture() { const f=await fixture(),add=f.page.toggleProfileFollow();f.resolve();await add;return f; }

test('主页点击立即切换及更新统计，不等待查询或保存；重复点击已关注只打开取关确认',async()=>{
  const f=await fixture(),pending=f.page.toggleProfileFollow();
  assert.equal(f.page.data.profileFollowing,true);assert.equal(f.page.data.followerCount,1);assert.equal(f.page.data.followBusy,false);assert.equal(f.calls.length,1);
  f.page.openProfileMessage();assert.deepEqual(f.toasts,['私信功能暂未开放']);
  const prompt=f.page.toggleProfileFollow();assert.ok(f.page.data.unfollowTarget);assert.equal(f.calls.length,1);
  f.page.cancelUnfollowPrompt();await prompt;f.page.closeUnfollowPrompt(true);f.resolve();await pending;
  assert.equal(f.page.data.profileFollowing,true);assert.equal(f.page.data.followerCount,1);
});

test('关注失败回退共享按钮和统计，切账号后的迟到失败不污染新会话',async()=>{
  const f=await fixture(),pending=f.page.toggleProfileFollow();assert.equal(f.page.data.profileFollowing,true);
  f.resolve(new Error('网络异常'));await pending;assert.equal(f.page.data.profileFollowing,false);assert.equal(f.page.data.followerCount,0);assert.equal(f.toasts.length,1);
  const late=f.page.toggleProfileFollow();f.switchUser();f.resolve();await late;assert.equal(f.page.data.profileFollowing,false);
});

test('确认取关立即恢复按钮并退出弹窗；后台失败回退关系及统计，不重开旧弹窗',async()=>{
  const f=await followedFixture(),prompt=f.page.toggleProfileFollow();assert.ok(f.page.data.unfollowTarget);
  const saving=f.page.confirmUnfollowPrompt();assert.equal(f.page.data.profileFollowing,false);assert.equal(f.page.data.followerCount,0);assert.equal(f.page.data.unfollowClosing,true);
  await prompt;f.page.closeUnfollowPrompt(true);assert.equal(f.page.data.unfollowTarget,null);
  f.resolve(new Error('取关保存异常'));await saving;assert.equal(f.page.data.profileFollowing,true);assert.equal(f.page.data.followerCount,1);assert.equal(f.page.data.unfollowTarget,null);assert.equal(f.toasts.length,1);
});

test('详情关注和取关同样立即响应，取消确认不发请求',async()=>{
  const f=await fixture();f.page.data.isVisitor=false;
  const first=f.page.followPostAuthor({detail:{id:f.row._id}});assert.equal(f.page.data.followByAccount['87654321'].following,true);f.resolve();await first;
  const cancel=f.page.followPostAuthor({detail:{id:f.row._id}});assert.equal(f.page.data.unfollowTarget.nickname,'对方');f.page.cancelUnfollowPrompt();await cancel;f.page.closeUnfollowPrompt(true);assert.equal(f.calls.length,1);
  const prompt=f.page.followPostAuthor({detail:{id:f.row._id}}),saving=f.page.confirmUnfollowPrompt();assert.equal(f.page.data.followByAccount['87654321'].following,false);assert.equal(f.page.data.unfollowClosing,true);
  await prompt;f.resolve();await saving;f.page.closeUnfollowPrompt(true);
});

test('保存途中反向取关保持最新界面，旧成功不短暂变回已关注，串行保存最终意图',async()=>{
  const f=await fixture(),first=f.page.toggleProfileFollow(),prompt=f.page.toggleProfileFollow(),inverse=f.page.confirmUnfollowPrompt();
  assert.equal(f.page.data.profileFollowing,false);const start=f.paints.length;await prompt;f.page.closeUnfollowPrompt(true);
  assert.equal(f.calls.length,1);f.resolve();await tick();assert.equal(f.calls.length,2);assert.equal(f.calls[1].value,false);assert.equal(f.page.data.profileFollowing,false);
  f.resolve();await Promise.all([first,inverse]);assert.ok(f.paints.slice(start).every(value=>!value));assert.equal(f.page.data.followerCount,0);
});

test('更早失败已被反向意图替代时仍保存最新选择；离页和换账号取消未确认操作',async()=>{
  const f=await fixture(),first=f.page.toggleProfileFollow(),prompt=f.page.toggleProfileFollow(),inverse=f.page.confirmUnfollowPrompt();await prompt;f.page.closeUnfollowPrompt(true);
  f.resolve(new Error('旧请求失败'));await tick();assert.equal(f.calls.length,2);f.resolve();await Promise.all([first,inverse]);assert.equal(f.page.data.profileFollowing,false);assert.equal(f.toasts.length,0);
  const g=await followedFixture(),cancel=g.page.toggleProfileFollow();g.page._visible=false;g.page.stopPostUpdates();await cancel;g.page.confirmUnfollowPrompt();assert.equal(g.calls.length,1);
  const h=await followedFixture(),old=h.page.toggleProfileFollow();h.switchUser();await old;h.page.confirmUnfollowPrompt();assert.equal(h.calls.length,1);
});

test('本人及失效主页不触发关注；后台统计失败仍保留真实缓存',async()=>{
  const f=await fixture();f.page.data.isVisitor=false;await f.page.toggleProfileFollow();f.page.data.isVisitor=true;f.page.data.profileUnavailable=true;await f.page.toggleProfileFollow();assert.equal(f.calls.length,0);
  f.page.data.profileUnavailable=false;f.square.getFollowProfile=()=>Promise.reject(new Error('offline'));f.square.cachedFollowProfile=()=>({followerCount:12,followingCount:4});f.square.cachedFollowState=()=>({following:true});
  const read=f.page.refreshFollowPresentation();assert.equal(f.page.data.profileFollowing,true);assert.equal(f.page.data.followerCount,12);await read;assert.equal(f.page.data.followerCount,12);
});
