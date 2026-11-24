const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { postView } = require('../miniprogram/utils/post-view');

const user = { _id: 'alice', nickname: '普通同学', role: 'user', certificationStatus: 'unverified', avatarFileID: '' };
const post = (extra = {}) => ({ _id: 'p_' + 'a'.repeat(40), content: '来自广场的一条文字动态',
  author: { nickname: '普通同学', avatarFileID: '', accountId: '12345678', verified: false },
  createdAt: '2026-11-17T06:00:00Z', likeCount: 0, replyCount: 0, repostCount: 0, liked: false, reposted: false, ...extra });

test('视频发布回包丢失时只查询本人发布状态，未写入则保留明确的超时提示', async () => {
  const requestId = 'post-video-client-00001';
  const media = [{ type: 'video', fileID: 'cloud://test.bucket/square-uploads/alice/clip.video' }];
  let committed = false;
  const published = post({ media: [{ type: 'video', fileID: 'cloud://test.bucket/square-media/alice/post/clip.mp4' }] });
  const f = client(data => {
    if (data.action === 'publishSquarePost') throw { errCode: -504002, errMsg: 'cloud function timeout, internal trace' };
    assert.equal(data.action, 'getSquarePublication'); assert.equal(data.requestId, requestId);
    return { result: { success: true, square: { post: committed ? published : null } } };
  });
  await assert.rejects(f.service.publish('', requestId, [], 'none', '', media), error => {
    assert.equal(error.code, 'VIDEO_PUBLICATION_UNCONFIRMED');
    assert.match(error.message, /超时.*-504002/); assert.doesNotMatch(error.message, /internal trace/);
    return true;
  });
  assert.deepEqual(f.calls.map(row => row.action), ['publishSquarePost', 'getSquarePublication']);
  committed = true;
  assert.equal((await f.service.publish('', requestId, [], 'none', '', media))._id, published._id);
});

test('搜索缓存按关键词、作者及类型隔离，合并读取和分页，返回缓存同步真实互动字段',async()=>{
  const ok=square=>({result:{success:true,square}}),one=post(),two=post({_id:'p_'+'b'.repeat(40)});
  const f=client(data=>data.action==='setSquareReaction'?ok({post:{...one,liked:true,likeCount:1}}):ok({keyword:data.keyword,accountId:data.accountId,kind:data.kind,items:data.kind==='users'?[{accountId:'87654321',nickname:'同学'}]:data.cursor?[two]:[one],hasMore:!data.cursor&&data.kind==='square',nextCursor:!data.cursor&&data.kind==='square'?'cursor':''}));
  const q={keyword:'校园',accountId:'',kind:'square'},first=f.service.searchContent(q),same=f.service.searchContent(q);assert.equal(first,same);await first;await f.service.searchContent(q);assert.equal(f.calls.length,1);
  await f.service.searchContent({...q,cursor:'cursor'});assert.equal(f.service.cachedSearch(q).items.length,2);
  await f.service.searchContent({...q,kind:'users'});await f.service.searchContent({...q,accountId:'87654321'});assert.equal(f.calls.length,4);
  await f.service.react(one._id,'like',true,one);assert.equal(f.service.cachedSearch(q).items[0].liked,true);assert.equal(f.service.cachedSearch({...q,kind:'users'}).items[0].nickname,'同学');
});

test('迟到搜索不能覆盖当前点赞或恢复删除内容，换账号清理搜索缓存',async()=>{
  let finish,delay=false;const ok=square=>({result:{success:true,square}}),p=post();
  const f=client(data=>{
    if(data.action==='setSquareReaction')return ok({post:{...p,liked:true,likeCount:1}});
    if(data.action==='deleteSquarePost')return ok({deletedId:p._id});
    const value=ok({keyword:data.keyword,accountId:data.accountId,kind:data.kind,items:[p],hasMore:false,nextCursor:''});return delay?new Promise(resolve=>{finish=()=>resolve(value);}):value;
  });
  const q={keyword:'校园',accountId:'',kind:'square'};await f.service.searchContent(q);delay=true;const pending=f.service.searchContent({...q,force:true});await f.service.react(p._id,'like',true,p);finish();await pending;assert.equal(f.service.cachedSearch(q).items[0].liked,true);
  const deleted=f.service.searchContent({...q,force:true});await f.service.deletePost(p._id);finish();await assert.rejects(deleted,error=>error.code==='SEARCH_CHANGED');assert.equal(f.service.cachedSearch(q).items.length,0);
  const late=f.service.searchContent({...q,force:true});f.login({...user,_id:'bob'});finish();await assert.rejects(late,error=>error.code==='SESSION_CHANGED');assert.equal(f.service.cachedSearch(q),null);
});

test('确认拉黑立刻过滤会话缓存，旧请求不能带回内容，公开 ID 搜索和其他账号不受影响', async () => {
  const viewer = { ...user, accountId: '12345678' }, target = '87654321';
  const hidden = post({ author: { accountId: target } });
  const quote = post({ _id: 'p_' + 'b'.repeat(40), quote: hidden });
  const ok = square => ({ result: { success: true, square } });
  let delay = false, finish;
  const f = client(data => {
    if (data.action === 'setSquareBlock') return ok({ blocked: true,
      state: { accountId: target, following: false, version: 2 },
      profile: { accountId: target, following: false, relationVersion: 2, followingCount: 0, followerCount: 0, version: 2 },
      viewer: { accountId: viewer.accountId, followingCount: 0, followerCount: 0, version: 2 } });
    if (data.action === 'searchSquareContent') return ok({ ...data, items: [{ accountId: target }], hasMore: false, nextCursor: '' });
    const page = ok({ items: [hidden, quote], hasMore: false, nextOffset: 2 });
    return delay ? new Promise(resolve => { finish = () => resolve(page); }) : page;
  });
  f.login(viewer);
  await f.service.list();
  delay = true;
  const stale = f.service.list({ force: true });
  await f.service.setBlock(target, true);
  assert.equal(f.service.cachedFeed().items.length, 1);
  assert.equal(f.service.cachedFeed().items[0].quote.unavailable, true);
  assert.equal(f.service.cachedPost(hidden._id), null);
  assert.equal(f.service.cachedPublicContent(target, 'posts'), null);
  finish(); await assert.rejects(stale, error => error.code === 'BLOCK_CHANGED');
  assert.equal((await f.service.searchContent({ keyword: target, kind: 'users' })).items[0].accountId, target);
  f.login({ ...viewer, _id: 'other' }); delay = false;
  assert.equal(f.service.isBlocked(target), false);
  assert.equal((await f.service.list()).items.length, 2);
});

test('真实关注同目标串行合并，旧关系与统计读取不能覆盖新版本，失败不伪造成功', async () => {
  const viewer = { ...user, accountId: '12345678' }, target = '87654321'; let releaseRead, releaseWrite, following = false, version = 0, delay = true;
  const ok = square => ({ result: { success: true, square } });
  const f = client(data => {
    if (data.action === 'getSquareFollowStates') return new Promise(resolve => { releaseRead = () => resolve(ok({ items: [{accountId:target,following:false,version:0}] })); });
    if (data.action === 'setSquareFollow') {
      const response = () => { following=data.following; version++; return ok({state:{accountId:target,following,version},viewer:{accountId:viewer.accountId,followingCount:Number(following),followerCount:0,version},profile:{accountId:target,followingCount:0,followerCount:Number(following),version,following,relationVersion:version}}); };
      return delay ? new Promise(resolve => {releaseWrite=()=>resolve(response());}) : response();
    }
  });
  f.login(viewer); const stale = f.service.getFollowStates([target]);
  const first = f.service.setFollow(target,true), duplicate = f.service.setFollow(target,true);
  assert.equal(first,duplicate); assert.equal(f.service.cachedFollowState(target).following,true); assert.equal(f.service.cachedFollowState(target).pending,true);
  const inverse = f.service.setFollow(target,false); delay=false; releaseWrite(); await first; await inverse;
  assert.equal(f.calls.filter(row=>row.action==='setSquareFollow').length,2);
  assert.equal(f.service.cachedFollowState(target).following,false); assert.equal(f.service.cachedFollowState(target).version,2);
  releaseRead(); await stale; assert.equal(f.service.cachedFollowState(target).version,2);
  assert.equal(f.service.cachedFollowProfile(viewer.accountId).followingCount,0);
});

test('关注动态独立缓存、取关移除目标，迟到列表及换账号后的写入不能恢复旧关系', async () => {
  const viewer={...user,accountId:'12345678'},target='87654321'; let lateList,lateWrite,delay=false;
  const row=post({author:{accountId:target,nickname:'对方'}}),ok=square=>({result:{success:true,square}});
  const f=client(data=>{
    if(data.action==='listSquareFollowing') return delay ? new Promise(resolve=>{lateList=()=>resolve(ok({items:[row],hasMore:false,nextCursor:''}));}) : ok({items:[row],hasMore:false,nextCursor:''});
    if(data.action==='listSquarePosts') return ok({items:[],hasMore:false,nextOffset:0});
    if(data.following) return new Promise(resolve=>{lateWrite=()=>resolve(ok({state:{accountId:target,following:true,version:3},viewer:{accountId:viewer.accountId,followingCount:1,followerCount:0,version:3},profile:{accountId:target,followingCount:0,followerCount:1,version:3,following:true,relationVersion:3}}));});
    return ok({state:{accountId:target,following:false,version:2},viewer:{accountId:viewer.accountId,followingCount:0,followerCount:0,version:2},profile:{accountId:target,followingCount:0,followerCount:0,version:2,following:false,relationVersion:2}});
  });
  f.login(viewer); await f.service.list(); await f.service.listFollowing();
  assert.equal(f.service.cachedFeed().items.length,0); assert.equal(f.service.cachedFollowingFeed().items.length,1);
  delay=true;const stale=f.service.listFollowing({force:true});await f.service.setFollow(target,false);
  assert.equal(f.service.cachedFollowingFeed().items.length,0);lateList();await assert.rejects(stale,error=>error.code==='FOLLOW_CHANGED');
  const write=f.service.setFollow(target,true); f.login({...viewer,_id:'bob',accountId:'23456789'});lateWrite();await assert.rejects(write,error=>error.code==='SESSION_CHANGED');
  assert.equal(f.service.cachedFollowState(target),null);assert.equal(f.service.cachedFollowingFeed(),null);
});

test('关注失败保持未知状态，重复读取合并，失败不清除正常登录会话', async()=>{
  const f=client(()=>({result:{success:false,code:'PROFILE_NOT_FOUND',message:'不可查看'}}));f.login({...user,accountId:'12345678'});
  await assert.rejects(f.service.setFollow('87654321',true),/不可查看/);
  assert.equal(f.service.cachedFollowState('87654321'),null);assert.ok(f.users.getCachedUser());
});

test('乐观取关立即同步状态、统计及关注流；后台失败完整回退，途中读取不重复查询或覆盖',async()=>{
  const viewer={...user,accountId:'12345678'},target='87654321',row=post({author:{accountId:target}}),ok=square=>({result:{success:true,square}});let fail;
  const f=client(data=>{
    if(data.action==='getSquareFollowProfile')return ok({profile:{accountId:data.accountId,followingCount:data.accountId===target?0:1,followerCount:data.accountId===target?1:0,version:5,...(data.accountId===target?{following:true,relationVersion:5}:{})}});
    if(data.action==='listSquareFollowing')return ok({items:[row],hasMore:false,nextCursor:''});
    if(data.action==='setSquareFollow')return new Promise((resolve,reject)=>{fail=()=>reject(new Error('offline'));});
    throw new Error('点击期间不应先读取关注状态');
  });
  f.login(viewer);await Promise.all([f.service.getFollowProfile(target),f.service.getFollowProfile(viewer.accountId)]);await f.service.listFollowing();
  const events=[];f.service.subscribeFollow(event=>events.push(event));const pending=f.service.setFollow(target,false);
  assert.equal(f.service.cachedFollowState(target).following,false);assert.equal(f.service.cachedFollowProfile(target).followerCount,0);assert.equal(f.service.cachedFollowProfile(viewer.accountId).followingCount,0);assert.equal(f.service.cachedFollowingFeed().items.length,0);
  const calls=f.calls.length;await f.service.getFollowStates([target],{force:true});await f.service.getFollowProfile(target,{force:true});assert.equal(f.calls.length,calls);
  fail();await assert.rejects(pending);assert.equal(f.service.cachedFollowState(target).following,true);assert.equal(f.service.cachedFollowProfile(target).followerCount,1);assert.equal(f.service.cachedFollowingFeed().items.length,1);assert.equal(events.at(-1).rollback,true);
});

test('不同目标的乐观计数合并但保存串行，一条失败只回退对应目标',async()=>{
  const viewer={...user,accountId:'12345678'},a='87654321',b='23456789',ok=square=>({result:{success:true,square}});let resolveA,rejectB;
  const f=client(data=>{
    if(data.action==='getSquareFollowProfile')return ok({profile:{accountId:data.accountId,followingCount:0,followerCount:0,version:0,...(data.accountId!==viewer.accountId?{following:false,relationVersion:0}:{})}});
    if(data.accountId===a)return new Promise(resolve=>{resolveA=()=>resolve(ok({state:{accountId:a,following:true,version:1},profile:{accountId:a,followingCount:0,followerCount:1,following:true,relationVersion:1,version:1},viewer:{accountId:viewer.accountId,followingCount:1,followerCount:0,version:1}}));});
    return new Promise((resolve,reject)=>{rejectB=()=>reject(new Error('offline'));});
  });
  f.login(viewer);await Promise.all([f.service.getFollowProfile(viewer.accountId),f.service.getFollowProfile(a),f.service.getFollowProfile(b)]);
  const first=f.service.setFollow(a,true),second=f.service.setFollow(b,true);assert.equal(f.service.cachedFollowProfile(viewer.accountId).followingCount,2);assert.equal(f.calls.filter(item=>item.action==='setSquareFollow').length,1);
  resolveA();await first;assert.equal(f.service.cachedFollowProfile(viewer.accountId).followingCount,2);assert.equal(f.calls.filter(item=>item.action==='setSquareFollow').length,2);
  rejectB();await assert.rejects(second);assert.equal(f.service.cachedFollowState(a).following,true);assert.equal(f.service.cachedFollowState(b).following,false);assert.equal(f.service.cachedFollowProfile(viewer.accountId).followingCount,1);
});

test('同目标连续关注取关再关注合并为最后一次选择，不保存已经过时的中间意图',async()=>{
  const viewer={...user,accountId:'12345678'},target='87654321',ok=square=>({result:{success:true,square}});let finish;
  const f=client(data=>new Promise(resolve=>{finish=()=>resolve(ok({state:{accountId:target,following:true,version:1},profile:{accountId:target,followingCount:0,followerCount:1,following:true,relationVersion:1,version:1},viewer:{accountId:viewer.accountId,followingCount:1,followerCount:0,version:1}}));}));
  f.login(viewer);const first=f.service.setFollow(target,true);f.service.setFollow(target,false);const last=f.service.setFollow(target,true);
  assert.equal(f.service.cachedFollowState(target).following,true);assert.equal(first,last);assert.equal(f.calls.length,1);finish();await last;assert.equal(f.service.cachedFollowState(target).following,true);assert.equal(f.calls.length,1);
});

test('访客内容按目标及分类隔离缓存，迟到列表不覆盖点赞，切账号不恢复旧主页', async () => {
  const targetId = '87654321', otherId = '23456789'; let finish, delay = false;
  const ok = square => ({ result: { success: true, square } });
  const f = client(data => {
    if (data.action === 'setSquareReaction') return ok({ post: post({ liked: true, likeCount: 1 }) });
    const result = ok({ profileAccountId: data.profileAccountId, postType: data.postType, items: [post()], hasMore: false, nextOffset: 1, pinnedPostId: '' });
    return delay ? new Promise(resolve => { finish = () => resolve(result); }) : result;
  });
  await f.service.listPublicContent(targetId, 'posts'); await f.service.listPublicContent(otherId, 'quotes');
  assert.equal(f.service.cachedOwnFeed('posts'), null); assert.equal(f.service.cachedFeed(), null);
  assert.equal(f.service.cachedPublicContent(targetId, 'quotes'), null); assert.equal(f.service.cachedPublicContent(otherId, 'posts'), null);
  delay = true; const late = f.service.listPublicContent(targetId, 'posts', { force: true });
  await f.service.react(post()._id, 'like', true, post()); finish(); await late;
  assert.equal(f.service.cachedPublicContent(targetId, 'posts').items[0].liked, true);
  const old = f.service.listPublicContent(targetId, 'posts', { force: true }); f.login({ ...user, _id: 'bob' }); finish();
  await assert.rejects(old, error => error.code === 'SESSION_CHANGED'); assert.equal(f.service.cachedPublicContent(targetId, 'posts'), null);
});

test('已知目标不可查看后，迟到内容不会恢复公开缓存或从旧动态重建', async () => {
  const targetId = '87654321'; let finish;
  const incoming = post({ author: { nickname: '对方', accountId: targetId } });
  const f = client(data => data.action === 'listSquarePosts' && data.profileAccountId ? new Promise(resolve => { finish = resolve; }) :
    { result: { success: true, square: { items: [incoming], hasMore: false, nextOffset: 1 } } });
  await f.service.list(); assert.equal(f.service.cachedPublicContent(targetId, 'posts').items[0]._id, incoming._id);
  const read = f.service.listPublicContent(targetId, 'posts', { force: true }); f.service.clearPublicAccount(targetId);
  finish({ result: { success: true, square: { profileAccountId: targetId, postType: 'posts', items: [incoming], hasMore: false, nextOffset: 1 } } });
  await assert.rejects(read, error => error.code === 'PROFILE_CHANGED'); assert.equal(f.service.cachedPublicContent(targetId, 'posts'), null);
});

test('分层回复缓存不混入一级列表，迟到读取不会覆盖刚发出的回复和个人折叠状态', async () => {
  const root = { _id: 'r_' + 'a'.repeat(40), content: '一级评论', author: post().author, replyCount: 0 };
  const child = { _id: 'c_' + 'b'.repeat(40), rootId: root._id, content: '新回复', author: post().author, folded: false };
  let delay = false, finishRoots, finishChildren;
  const f = client(data => {
    if (data.action === 'listSquareReplies') return delay ? new Promise(resolve => { finishRoots = resolve; }) : { result: { success: true, square: { items: [root], hasMore: false, nextOffset: 1 } } };
    if (data.action === 'listSquareReplyChildren') return delay ? new Promise(resolve => { finishChildren = resolve; }) : { result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } };
    if (data.action === 'publishSquareReply') return { result: { success: true, square: { post: post(), reply: child, root: { ...root, replyCount: 1 } } } };
    return { result: { success: true, square: { reply: { ...child, folded: true } } } };
  });
  const id = post()._id;
  await f.service.listReplies(id); await f.service.listChildren(id, root._id);
  delay = true;
  const rootsRead = f.service.listReplies(id, { force: true }), childrenRead = f.service.listChildren(id, root._id, { force: true });
  await f.service.reply(id, '新回复', 'child-request-00001', root._id);
  assert.equal(f.calls.at(-1).post.replyToId, root._id);
  await f.service.commentState(id, child._id, 'fold', true);
  finishRoots({ result: { success: true, square: { items: [root], hasMore: false, nextOffset: 1 } } });
  finishChildren({ result: { success: true, square: { items: [child], hasMore: false, nextOffset: 1 } } });
  await rootsRead; await childrenRead;
  assert.equal(f.service.cachedReplies(id).items.length, 1); assert.equal(f.service.cachedReplies(id).items[0].replyCount, 1);
  assert.equal(f.service.cachedChildren(id, root._id).items[0].folded, true);
  f.users.logout(); assert.equal(f.service.cachedChildren(id, root._id), null); assert.equal(f.service.cachedReplies(id), null);
});
function client(handler, clock = Date) {
  let current = { ...user }, version = 0;
  const calls = [];
  const users = { getCachedUser: () => current, getSessionVersion: () => version, logout: () => { current = null; version++; } };
  const context = { Date: clock, module: { exports: {} }, require: name => name.includes('comment-order') ? require('../miniprogram/utils/comment-order') : name.includes('comment-state') ? require('../miniprogram/utils/comment-state') : users,
    wx: { cloud: { callFunction: async args => { calls.push(args.data); return handler(args.data); } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/services/square.js'), 'utf8'), context);
  return { service: context.module.exports, users, calls, login(value = user) { current = { ...value }; version++; } };
}

test('新闻详情补充的正文和多图回填列表，后续旧回包不能覆盖', async () => {
  const short = post({ _id: 'n_' + 'a'.repeat(40), contentType: 'news', content: '旧摘要', bodyMissing: true,
    newsUrlKey: 'example.com/news', images: ['https://example.com/cover.jpg'] });
  const full = { ...short, content: '第一段\n\n第二段', bodyMissing: false, detailReady: true,
    images: ['https://example.com/inside.jpg', ...short.images] };
  const f = client(({ action }) => ({ result: { success: true, square: action === 'getSquarePost' ?
    { post: full } : { items: [short], anchor: 1, nextOffset: 10 } } }));
  await f.service.listNews();
  await f.service.detail(short._id);
  assert.equal(f.service.cachedNews().items[0].content, full.content);
  assert.deepEqual([...f.service.cachedNews().items[0].images], full.images);
  const refreshed = await f.service.listNews({ force: true });
  assert.equal(refreshed.items[0].content, full.content);
  assert.deepEqual([...refreshed.items[0].images], full.images);
});

test('新闻译文按原文版本和登录会话复用，合并同版本请求，忽略换账号后的迟到结果', async () => {
  const id = 'n_' + 'c'.repeat(40), firstVersion = '1'.repeat(40), updatedVersion = '2'.repeat(40);
  let finish;
  const f = client(({ postId, version }) => new Promise(resolve => {
    assert.equal(postId, id);
    finish = () => resolve({ result: { success: true, square: { translation: { version, title: '标题', content: '正文' } } } });
  }));
  const first = f.service.translateNews(id, firstVersion);
  assert.equal(f.service.translateNews(id, firstVersion), first);
  finish(); const result = await first;
  assert.equal(await f.service.translateNews(id, firstVersion), result);
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.cachedNewsTranslation(id, updatedVersion), null);
  const late = f.service.translateNews(id, updatedVersion);
  f.login({ ...user, _id: 'bob' });
  finish(); await assert.rejects(late, error => error.code === 'SESSION_CHANGED');
  assert.equal(f.service.cachedNewsTranslation(id, firstVersion), null);
  assert.equal(f.service.cachedNewsTranslation(id, updatedVersion), null);
});

test('置顶保存后仅重排个人普通动态缓存，迟到列表不回退，取消后恢复时间顺序', async () => {
  const older = post({ createdAt: '2026-11-01T00:00:00Z' }), newer = post({ _id: 'p_' + 'b'.repeat(40), createdAt: '2026-11-20T00:00:00Z' });
  const ok = square => ({ result: { success: true, square } });
  let finish, delay = false, version = 0;
  const listing = () => ok({ mine: true, postType: 'posts', pinnedPostId: '', pinVersion: version, items: [newer, older], nextOffset: 2, hasMore: false });
  const f = client(data => {
    if (data.action === 'setSquareProfilePin') return ok({ post: older, pinnedPostId: data.pinned ? older._id : '', pinVersion: ++version });
    if (data.mine) return delay ? new Promise(resolve => { const result = listing(); finish = () => resolve(result); }) : listing();
    return ok({ items: [newer, older], hasMore: false, nextOffset: 2 });
  });
  await f.service.list(); await f.service.list({ mine: true, postType: 'posts' });
  delay = true; const late = f.service.list({ mine: true, postType: 'posts', force: true });
  await f.service.setProfilePin(older._id, true);
  assert.equal(f.service.cachedOwnFeed('posts').items[0]._id, older._id);
  assert.equal(f.service.cachedFeed().items[0]._id, newer._id);
  finish(); await assert.rejects(late, error => error.code === 'PIN_CHANGED');
  assert.equal(f.service.cachedOwnFeed('posts').pinnedPostId, older._id);
  await f.service.setProfilePin(older._id, false);
  assert.equal(f.service.cachedOwnFeed('posts').items[0]._id, newer._id);
  assert.equal(f.service.cachedOwnFeed('posts').nextOffset, 2);
});

test('置顶失败、卸载账号及迟到写入不伪造成功或污染新账号', async () => {
  let finish;
  const f = client(data => data.action === 'setSquareProfilePin' ? new Promise(resolve => { finish = resolve; }) :
    { result: { success: true, square: { mine: true, postType: 'posts', pinnedPostId: '', pinVersion: 0, items: [post()], hasMore: false, nextOffset: 1 } } });
  await f.service.list({ mine: true, postType: 'posts' });
  const failed = f.service.setProfilePin(post()._id, true);
  await assert.rejects(f.service.setProfilePin(post()._id, true), /正在更新置顶/);
  finish({ result: { success: false, code: 'PIN_EXISTS', message: '先取消置顶' } });
  await assert.rejects(failed, error => error.code === 'PIN_EXISTS');
  assert.equal(f.service.cachedOwnFeed('posts').pinnedPostId, '');
  const late = f.service.setProfilePin(post()._id, true);
  f.login({ ...user, _id: 'bob' });
  finish({ result: { success: true, square: { post: post(), pinnedPostId: post()._id, pinVersion: 1 } } });
  await assert.rejects(late, error => error.code === 'SESSION_CHANGED');
  assert.equal(f.service.cachedProfilePin(), null); assert.equal(f.service.cachedOwnFeed('posts'), null);
});

const commentRow = (extra = {}) => ({ _id: 'r_' + 'a'.repeat(40), content: '评论', author: post().author, likeCount: 0, liked: false, folded: false, ...extra });
test('并发引用响应乱序不能回退数量，删除后的新版本可以正确减少数量', async () => {
  const source = post(); let finishFirst;
  const quoted = n => post({ _id: 'p_' + String(n).repeat(40), quotePostId: source._id, quote: { _id: source._id, content: source.content } });
  const f = client(data => {
    if (data.action === 'publishSquarePost') {
      const result = { result: { success: true, square: { post: quoted(data.post.requestId === 'first' ? 'b' : 'c'),
        quotedPost: { ...source, quoteCount: data.post.requestId === 'first' ? 1 : 2, quoteVersion: data.post.requestId === 'first' ? 1 : 2 } } } };
      return data.post.requestId === 'first' ? new Promise(resolve => { finishFirst = () => resolve(result); }) : result;
    }
    if (data.action === 'deleteSquarePost') return { result: { success: true, square: { deletedId: data.postId, quotedPost: { ...source, quoteCount: 1, quoteVersion: 3 } } } };
    return { result: { success: true, square: { items: [{ ...source, quoteCount: 2, quoteVersion: 2 }], hasMore: false, nextOffset: 1 } } };
  });
  const first = f.service.publish('引用一', 'first', [], 'none', source._id);
  await f.service.publish('引用二', 'second', [], 'none', source._id);
  finishFirst(); await first; assert.equal(f.service.cachedPost(source._id).quoteCount, 2);
  await f.service.deletePost(quoted('b')._id); assert.equal(f.service.cachedPost(source._id).quoteCount, 1);
  await f.service.list({ force: true }); assert.equal(f.service.cachedPost(source._id).quoteCount, 1);
});
test('引用发布只提交ID且同步真实数量；原帖删除及迟到列表不能恢复引用正文', async () => {
  const source = post(), quoted = post({ _id: 'p_' + 'b'.repeat(40), content: '', quotePostId: source._id, quote: { _id: source._id, content: source.content, images: [], author: source.author } });
  const f = client(data => ({ result: { success: true, square: data.action === 'publishSquarePost'
    ? { post: quoted, quotedPost: { ...source, quoteCount: 1 } }
    : data.action === 'deleteSquarePost' ? { deletedId: data.postId }
    : { items: [quoted], hasMore: false, nextOffset: 1 } } }));
  await f.service.publish('', 'quote-client-0000001', [], 'none', source._id);
  assert.equal(f.calls[0].post.quotePostId, source._id); assert.equal(f.calls[0].post.quote, undefined);
  assert.equal(f.service.cachedPost(source._id).quoteCount, 1);
  await f.service.deletePost(source._id);
  assert.equal(f.service.cachedPost(quoted._id).quote.unavailable, true);
  assert.equal(f.service.cachedPost(quoted._id).quote.content, undefined);
  await f.service.list({ force: true });
  assert.equal(f.service.cachedFeed().items[0].quote.unavailable, true);
});
const historyRow = (n = 1, extra = {}) => { const row = commentRow({ _id: 'r_' + n.toString(16).padStart(40, '0'), sortKey: String(n).padStart(16, '0') + '_r_' + n.toString(16).padStart(40, '0'), ...extra });
  return { _id: row._id, postId: post()._id, sortKey: row.sortKey, reply: row, context: { _id: post()._id, content: '上文', author: post().author, imageCount: 0 }, contextKind: 'post' }; };
test('历史定位向前分页独立读取窗口，不将首屏缓存拼到不连续的目标窗口', async () => {
  const root = commentRow(), first = commentRow({ _id: 'c_' + 'b'.repeat(40), rootId: root._id });
  const later = { ...first, _id: 'c_' + 'c'.repeat(40) };
  const f = client(data => ({ result: { success: true, square: { items: data.offset ? [later] : [first], hasMore: true, nextOffset: data.offset + 20 } } }));
  await f.service.listChildren(post()._id, root._id);
  const result = await f.service.replyWindow(post()._id, root._id, { offset: 60 });
  assert.equal(result.items.length, 1); assert.equal(result.items[0]._id, later._id);
  assert.equal(f.service.cachedChildren(post()._id, root._id).items.length, 1);
  assert.equal(f.service.cachedChildren(post()._id, root._id).items[0]._id, first._id);
});
test('历史上文折叠只生成展示投影，不覆盖评论本身的缓存和真实心碎状态', async () => {
  const rootId = 'r_' + 'f'.repeat(40), original = commentRow({ _id: 'c_' + 'b'.repeat(40), rootId, ancestorIds: [rootId], content: '原回复', images: ['photo'] });
  const item = { _id: original._id, postId: post()._id, sortKey: 'key', context: { folded: true },
    reply: { ...original, content: '', images: [], hiddenByAncestor: true, folded: true } };
  const f = client(data => ({ result: { success: true, square: data.action === 'listSquareOwnReplies'
    ? { items: [item], hasMore: false, nextCursor: 'key' } : { items: [original], hasMore: false, nextOffset: 1 } } }));
  await f.service.listChildren(post()._id, rootId); await f.service.listOwnReplies();
  assert.equal(f.service.cachedOwnReplies().items[0].reply.folded, true);
  assert.equal(f.service.cachedComment(original._id).folded, false);
  assert.equal(f.service.cachedChildren(post()._id, rootId).items[0].content, '原回复');
  assert.equal(f.service.cachedChildren(post()._id, rootId).items[0].images[0], 'photo');
});
test('本人回复缓存合并分页、合并请求、删除立即同步、退出清空并拒绝迟到读取', async () => {
  let finish, delayed = false;
  const first = historyRow(2), second = historyRow(1);
  const f = client(data => {
    if (data.action === 'deleteSquareReply') return { result: { success: true, square: { deletedId: first._id, post: post() } } };
    if (delayed) return new Promise(resolve => { finish = resolve; });
    return { result: { success: true, square: { items: data.cursor ? [second] : [first], hasMore: !data.cursor, nextCursor: data.cursor ? second.sortKey : first.sortKey } } };
  });
  const a = f.service.listOwnReplies(), b = f.service.listOwnReplies(); assert.equal(a, b);
  await a; await f.service.listOwnReplies(); assert.equal(f.calls.length, 1);
  await f.service.listOwnReplies({ cursor: first.sortKey }); assert.equal(f.service.cachedOwnReplies().items.length, 2);
  await f.service.deleteReply(post()._id, first._id);
  assert.deepEqual(Array.from(f.service.cachedOwnReplies().items, row => row._id), [second._id]);
  delayed = true; const old = f.service.listOwnReplies({ force: true });
  f.users.logout(); assert.equal(f.service.cachedOwnReplies(), null);
  finish({ result: { success: true, square: { items: [first], hasMore: false, nextCursor: first.sortKey } } });
  await assert.rejects(old, error => error.code === 'SESSION_CHANGED'); assert.equal(f.service.cachedOwnReplies(), null);
});
test('历史读取不能恢复刚删除的评论，服务更新错误明确提示部署', async () => {
  let finish; const row = historyRow();
  const f = client(data => data.action === 'deleteSquareReply' ? { result: { success: true, square: { deletedId: row._id, post: post() } } } : new Promise(resolve => { finish = resolve; }));
  const old = f.service.listOwnReplies(); await f.service.deleteReply(post()._id, row._id);
  finish({ result: { success: true, square: { items: [row], hasMore: false, nextCursor: row.sortKey } } });
  await assert.rejects(old, error => error.code === 'HISTORY_CHANGED'); assert.equal(f.service.cachedOwnReplies(), null);
  const unavailable = client(() => ({ result: { success: false, code: 'INVALID_ACTION' } }));
  await assert.rejects(unavailable.service.listOwnReplies(), /重新部署 userService/);
});
test('图文优化按图片顺序和正文合并，图片变化不复用旧请求，空文案带图可以生成', async () => {
  const pending = [], f = client(() => new Promise(resolve => pending.push(resolve)));
  const images = ['cloud://test.bucket/square-uploads/alice/one.jpg', 'cloud://test.bucket/square-uploads/alice/two.jpg'];
  const first = f.service.optimizeContent('', images);
  assert.equal(f.service.optimizeContent('', [...images]), first);
  const swapped = f.service.optimizeContent('', [...images].reverse());
  assert.notEqual(swapped, first); assert.equal(f.calls.length, 2);
  assert.deepEqual(Array.from(f.calls[0].images), images); assert.equal(f.calls[0].content, '');
  images.pop(); assert.equal(f.calls[0].images.length, 2);
  for (const resolve of pending) resolve({ result: { success: true, square: { content: '按图片撰写的文案' } } });
  assert.equal(await first, '按图片撰写的文案'); await swapped; assert.equal(f.service.cachedFeed(), null);
  for (const bad of [[], ['https://example.com/x.jpg'], ['cloud://same', 'cloud://same']])
    assert.throws(() => f.service.optimizeContent('', bad));
});
test('评论图片按原顺序提交并缓存展示，不写相册缓存，四图及外链被客户端拒绝', async () => {
  const images = [0,1,2].map(i => `cloud://test.bucket/square-uploads/alice/${i}.jpg`);
  const published = [0,1,2].map(i => `cloud://test.bucket/square-media/alice/comment/${i}.jpg`);
  const f = client(() => ({ result: { success: true, square: { post: post({ replyCount: 1 }), reply: commentRow({ content: '', images: published }) } } }));
  const result = await f.service.reply(post()._id, '', 'client-images-reply01', undefined, false, images);
  assert.deepEqual(Array.from(f.calls[0].post.images), images); assert.equal(f.calls[0].post.content, '');
  assert.deepEqual(Array.from(result.reply.images), published);
  assert.deepEqual(Array.from(f.service.cachedReplies(post()._id).items[0].images), published);
  assert.equal(f.service.cachedAlbum(), null);
  for (const files of [[...images, 'cloud://fourth'], ['https://example.com/x.jpg'], [images[0], images[0]]])
    await assert.rejects(f.service.reply(post()._id, '', 'client-images-bad01', undefined, false, files), error => error.code === 'INVALID_IMAGES');
});

test('正文优化只发送正文并合并重复请求，不污染动态缓存，换账号后的迟到结果被拒绝', async () => {
  let finish;
  const f = client(() => new Promise(resolve => { finish = resolve; }));
  const first = f.service.optimizeContent('待优化正文');
  assert.equal(f.service.optimizeContent('待优化正文'), first);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'optimizeSquareContent');
  assert.equal(f.calls[0].content, '待优化正文'); assert.equal(f.calls[0].post, undefined);
  finish({ result: { success: true, square: { content: '😊'.repeat(180) } } });
  const result = await first;
  assert.equal(Array.from(result).length, 150); assert.equal(f.service.cachedFeed(), null);
  const late = f.service.optimizeContent('下一段正文');
  f.login({ ...user, _id: 'bob' }); finish({ result: { success: true, square: { content: '旧账号内容' } } });
  await assert.rejects(late, error => error.code === 'SESSION_CHANGED');
});
test('评论删除清理分层缓存并调整分页，迟到的列表、点赞和AI不得恢复已删除整组', async () => {
  const root = commentRow({ isOwn: true, replyCount: 1 }), child = commentRow({ _id: 'c_' + 'b'.repeat(40), rootId: root._id });
  let delayed = false, finishList, finishState, finishAI, removed = false;
  const f = client(data => {
    const ok = square => ({ result: { success: true, square } });
    if (data.action === 'listSquareReplies') return delayed && !removed ? new Promise(resolve => { finishList = resolve; }) : ok({ items: removed ? [] : [root], nextOffset: removed ? 0 : 1, hasMore: false });
    if (data.action === 'listSquareReplyChildren') return ok({ items: [child], nextOffset: 1, hasMore: false });
    if (data.action === 'setSquareCommentState') return new Promise(resolve => { finishState = resolve; });
    if (data.action === 'processSquareAIReply') return new Promise(resolve => { finishAI = resolve; });
    if (data.action === 'deleteSquareReply') { removed = true; return ok({ deletedId: root._id, rootId: '', post: post({ replyCount: 0 }) }); }
    return ok({ post: post({ replyCount: 2 }) });
  });
  const id = post()._id;
  await f.service.listReplies(id); await f.service.listChildren(id, root._id);
  const events = []; f.service.subscribeComment(row => events.push(row));
  delayed = true;
  const reading = f.service.listReplies(id, { force: true });
  const reacting = f.service.commentState(id, child._id, 'like', true, child);
  const ai = f.service.processAIReply(id, root._id);
  await f.service.deleteReply(id, root._id);
  finishState({ result: { success: true, square: { reply: { ...child, liked: true, likeCount: 1 } } } });
  finishList({ result: { success: true, square: { items: [root], nextOffset: 1, hasMore: false } } });
  finishAI({ result: { success: true, square: { target: root, root, reply: child, post: post({ replyCount: 2 }) } } });
  await assert.rejects(reacting); await assert.rejects(ai); await reading;
  assert.equal(f.service.cachedReplies(id).items.length, 0); assert.equal(f.service.cachedReplies(id).nextOffset, 0);
  assert.equal(f.service.cachedChildren(id, root._id), null); assert.equal(f.service.cachedComment(child._id), null);
  assert.equal(f.service.cachedPost(id).replyCount, 0);
  assert.equal(events.at(-1).status, 'deleted');
});

test('删除楼中回复同步根计数；删除失败或换账号后的结果不能清理缓存，举报使用独立接口', async () => {
  const root = commentRow({ replyCount: 1 }), child = commentRow({ _id: 'c_' + 'b'.repeat(40), rootId: root._id });
  for (const mode of ['success', 'failure', 'switch']) {
    let finish;
    const f = client(data => {
      const ok = square => ({ result: { success: true, square } });
      if (data.action === 'listSquareReplies') return ok({ items: [root], nextOffset: 1, hasMore: false });
      if (data.action === 'listSquareReplyChildren') return ok({ items: [child], nextOffset: 1, hasMore: false });
      if (data.action === 'deleteSquareReply') return new Promise(resolve => { finish = resolve; });
      return ok({ reportId: 'saved-report' });
    });
    await f.service.listReplies(post()._id); await f.service.listChildren(post()._id, root._id);
    const operation = f.service.deleteReply(post()._id, child._id);
    if (mode === 'switch') f.login({ ...user, _id: 'bob' });
    finish(mode === 'failure' ? { result: { success: false, message: '删除失败' } } : { result: { success: true, square: {
      deletedId: child._id, rootId: root._id, root: { ...root, replyCount: 0 }, post: post({ replyCount: 1 }) } } });
    if (mode !== 'success') await assert.rejects(operation); else await operation;
    if (mode === 'switch') assert.equal(f.service.cachedReplies(post()._id), null);
    else {
      assert.equal(f.service.cachedChildren(post()._id, root._id).items.length, mode === 'success' ? 0 : 1);
      assert.equal(f.service.cachedReplies(post()._id).items[0].replyCount, mode === 'success' ? 0 : 1);
    }
    await f.service.reportReply(post()._id, root._id, 'abuse');
    assert.equal(f.calls.at(-1).action, 'reportSquareReply'); assert.equal(f.calls.at(-1).replyId, root._id);
  }
});
test('AI请求合并、回复同步缓存；切换账号或删除动态后的迟到AI响应不能恢复旧内容', async () => {
  for (const operation of ['finish', 'logout', 'delete']) {
    let finish;
    const root = commentRow({ aiStatus: 'queued', aiCanManage: true, replyCount: 0 });
    const bot = { ...commentRow(), _id: 'c_' + 'b'.repeat(40), rootId: root._id, author: { nickname: '小萃小萃', isAI: true } };
    const f = client(data => data.action === 'processSquareAIReply' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ result: { success: true, square:
      data.action === 'deleteSquarePost' ? { deletedId: post()._id } : { post: post({ replyCount: 1 }), reply: root } } }));
    await f.service.reply(post()._id, '@小萃 怎么看', 'client-ai-comment001', undefined, true);
    assert.equal(f.calls.at(-1).post.askAI, true);
    const events = []; f.service.subscribeAI(result => events.push(result));
    const running = f.service.processAIReply(post()._id, root._id);
    assert.equal(f.service.processAIReply(post()._id, root._id), running);
    if (operation === 'logout') f.users.logout();
    if (operation === 'delete') await f.service.deletePost(post()._id);
    finish({ result: { success: true, square: { status: 'done', created: true, target: { ...root, aiStatus: 'done', replyCount: 1 },
      root: { ...root, aiStatus: 'done', replyCount: 1 }, reply: bot, post: post({ replyCount: 2 }) } } });
    if (operation === 'finish') {
      await running; assert.equal(events.length, 1); assert.equal(f.service.cachedPost(post()._id).replyCount, 2);
      assert.equal(f.service.cachedChildren(post()._id, root._id).items[0].author.isAI, true);
    } else { await assert.rejects(running); assert.equal(events.length, 0); assert.equal(f.service.cachedPost(post()._id), null); }
  }
});
const commentResponse = row => ({ result: { success: true, square: { reply: row } } });
test('评论点赞和取消立即更新缓存，串行合并快速点击，迟到确认不反弹，失败回退已确认状态', async () => {
  const writes = [];
  const f = client(data => new Promise(resolve => writes.push({ data, resolve })));
  const row = commentRow(), notices = [], stop = f.service.subscribeComment(value => notices.push({ ...value }));
  const liking = f.service.commentState(post()._id, row._id, 'like', true, row);
  assert.equal(f.service.cachedComment(row._id).liked, true); assert.equal(f.service.cachedComment(row._id).likeCount, 1);
  const cancelling = f.service.commentState(post()._id, row._id, 'like', false);
  assert.equal(liking, cancelling); assert.equal(writes.length, 1); assert.equal(f.service.cachedComment(row._id).liked, false);
  writes[0].resolve(commentResponse(commentRow({ liked: true, likeCount: 1 })));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(writes.length, 2); assert.equal(writes[1].data.active, false); assert.equal(f.service.cachedComment(row._id).liked, false);
  assert.equal(notices.slice(1).some(value => value.liked), false);
  writes[1].resolve({ result: { success: false, code: 'NETWORK_ERROR', message: '保存失败' } });
  await assert.rejects(liking, /保存失败/);
  assert.equal(f.service.cachedComment(row._id).liked, true); assert.equal(f.service.cachedComment(row._id).likeCount, 1);
  stop();
});

test('心碎后立即点赞恢复显示，两种状态共用队列，确认前的后台读取不能覆盖即时选择', async () => {
  const writes = []; let finishRead;
  const row = commentRow();
  const f = client(data => data.action === 'listSquareReplies' ? new Promise(resolve => { finishRead = resolve; }) : new Promise(resolve => writes.push({ data, resolve })));
  const fold = f.service.commentState(post()._id, row._id, 'fold', true, row);
  assert.equal(f.service.cachedComment(row._id).folded, true);
  const like = f.service.commentState(post()._id, row._id, 'like', true);
  assert.equal(fold, like); assert.equal(f.service.cachedComment(row._id).folded, false); assert.equal(f.service.cachedComment(row._id).liked, true);
  const reading = f.service.listReplies(post()._id);
  finishRead({ result: { success: true, square: { items: [row], nextOffset: 1, hasMore: false } } }); await reading;
  assert.equal(f.service.cachedReplies(post()._id).items[0].liked, true);
  writes[0].resolve(commentResponse(commentRow({ folded: true })));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(writes[1].data.kind, 'like'); assert.equal(writes[1].data.active, true);
  writes[1].resolve(commentResponse(commentRow({ liked: true, likeCount: 1, folded: false }))); await like;
  assert.equal(f.service.cachedComment(row._id).likeCount, 1); assert.equal(f.service.cachedReplies(post()._id).items[0].folded, false);
});

test('评论保存中换账号或删除动态，不让迟到状态恢复旧账号或已删除内容', async () => {
  let finish;
  const f = client(() => new Promise(resolve => { finish = resolve; }));
  const row = commentRow(), pending = f.service.commentState(post()._id, row._id, 'fold', true, row);
  f.login({ ...user, _id: 'bob' }); finish(commentResponse(commentRow({ folded: true })));
  await assert.rejects(pending, error => error.code === 'SESSION_CHANGED'); assert.equal(f.service.cachedComment(row._id), null);
  let complete;
  const removed = client(data => data.action === 'deleteSquarePost' ? { result: { success: true, square: { deletedId: post()._id } } } : new Promise(resolve => { complete = resolve; }));
  const writing = removed.service.commentState(post()._id, row._id, 'like', true, row);
  await removed.service.deletePost(post()._id); complete(commentResponse(commentRow({ liked: true, likeCount: 1 })));
  await assert.rejects(writing, error => error.code === 'POST_NOT_FOUND'); assert.equal(removed.service.cachedComment(row._id), null);
});

test('仅预取前两个未折叠回复组，点击展开复用在途请求与新鲜缓存', async () => {
  const finishes = [];
  const f = client(() => new Promise(resolve => finishes.push(resolve)));
  const rows = [commentRow({ folded: true, replyCount: 5 }), ...[1, 2, 3].map(i => commentRow({ _id: 'root' + i, replyCount: 2 }))];
  f.service.warmReplyChildren(post()._id, rows); assert.equal(f.calls.length, 2);
  const expanding = f.service.listChildren(post()._id, 'root1'); assert.equal(f.calls.length, 2);
  for (const finish of finishes) finish({ result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } });
  await expanding; await f.service.listChildren(post()._id, 'root1'); assert.equal(f.calls.length, 2);
});

test('发布图片后立即同步列表、详情和相册；删除动态移除其所有图片，退出清理相册缓存', async () => {
  const images = ['cloud://test.bucket/square-media/alice/a.jpg', 'cloud://test.bucket/square-media/alice/b.jpg'];
  const f = client(data => ({ result: { success: true, square: data.action === 'publishSquarePost' ? { post: post({ images, isOwn: true }) } :
    data.action === 'deleteSquarePost' ? { deletedId: post()._id } : { items: [], hasMore: false, nextOffset: 0 } } }));
  await f.service.album(); await f.service.publish('图文', 'images-request-00001', ['cloud://test.bucket/square-uploads/alice/a.jpg']);
  assert.equal(f.calls.at(-1).post.images.length, 1);
  assert.equal(f.service.cachedOwnFeed().items[0].images.length, 2);
  assert.equal(f.service.cachedPost(post()._id).images.length, 2);
  assert.equal(f.service.cachedAlbum().items.length, 2); assert.equal(f.service.cachedAlbum().nextOffset, 1);
  await f.service.deletePost(post()._id);
  assert.equal(f.service.cachedAlbum().items.length, 0); assert.equal(f.service.cachedAlbum().nextOffset, 0);
  f.users.logout(); assert.equal(f.service.cachedAlbum(), null);
});

test('迟到相册读取不能覆盖刚发图片，也不能污染切换后的账号', async () => {
  let finish;
  const imagePost = post({ images: ['cloud://test.bucket/square-media/alice/a.jpg'] });
  const f = client(data => data.action === 'listSquareAlbum' ? new Promise(resolve => { finish = resolve; }) : { result: { success: true, square: { post: imagePost } } });
  const pending = f.service.album();
  await f.service.publish('图', 'images-request-00001', ['cloud://test.bucket/square-uploads/alice/a.jpg']);
  finish({ result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } });
  await pending; assert.equal(f.service.cachedAlbum().items.length, 1);
  const late = f.service.album({ force: true }); f.login({ ...user, _id: 'bob' });
  finish({ result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } });
  await assert.rejects(late, error => error.code === 'SESSION_CHANGED'); assert.equal(f.service.cachedAlbum(), null);
});

test('客户端拒绝转发操作，不发送云请求或伪造操作成功', async () => {
  const f = client(() => { throw new Error('不得调用云端'); });
  await assert.rejects(f.service.react(post()._id, 'repost', true), error => error.code === 'INVALID_POST');
  assert.equal(f.calls.length, 0);
});

const likeResponse = (liked, extra = {}) => ({ result: { success: true, square: { post: post({ liked, likeCount: liked ? 1 : 0, ...extra }) } } });
const settleLikes = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('点赞立即同步两个列表，快速取消即时复原并串行保存最后选择，旧响应不反弹', async () => {
  const writes = [];
  const f = client(data => data.action === 'setSquareReaction' ? new Promise(resolve => writes.push({ data, resolve })) :
    { result: { success: true, square: { mine: true, items: [post()], hasMore: false, nextOffset: 1 } } });
  await f.service.list(); await f.service.list({ mine: true });
  const notifications = [], stop = f.service.subscribePost(row => notifications.push([row.liked, row.likeCount]));
  const liking = f.service.react(post()._id, 'like', true);
  assert.equal(f.service.cachedFeed().items[0].liked, true);
  assert.equal(f.service.cachedOwnFeed().items[0].likeCount, 1);
  const cancelling = f.service.react(post()._id, 'like', false);
  assert.equal(liking, cancelling); assert.equal(writes.length, 1);
  assert.equal(f.service.cachedFeed().items[0].liked, false);
  assert.equal(f.service.cachedFeed().items[0].likeCount, 0);
  writes[0].resolve(likeResponse(true)); await settleLikes();
  assert.equal(writes.length, 2); assert.equal(writes[1].data.active, false);
  assert.equal(f.service.cachedPost(post()._id).liked, false);
  writes[1].resolve(likeResponse(false)); await cancelling;
  assert.equal(f.service.cachedOwnFeed().items[0].liked, false);
  assert.equal(f.service.cachedPost(post()._id).likeCount, 0);
  stop(); assert.ok(notifications.length >= 3);
});

test('多次切换合并为最新目标；保存失败恢复已确认状态，并允许再次操作', async () => {
  const writes = [];
  const f = client(data => data.action === 'setSquareReaction' ? new Promise((resolve, reject) => writes.push({ data, resolve, reject })) :
    { result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } });
  await f.service.list();
  const pending = f.service.react(post()._id, 'like', true);
  f.service.react(post()._id, 'like', false); f.service.react(post()._id, 'like', true);
  assert.equal(writes.length, 1); assert.equal(f.service.cachedPost(post()._id).likeCount, 1);
  writes[0].resolve(likeResponse(true)); await pending;
  assert.equal(writes.length, 1);
  const cancelling = f.service.react(post()._id, 'like', false);
  assert.equal(f.service.cachedPost(post()._id).likeCount, 0);
  const rejection = assert.rejects(cancelling, /连接/);
  writes[1].reject(new Error('offline')); await rejection;
  assert.equal(f.service.cachedPost(post()._id).liked, true);
  assert.equal(f.service.cachedFeed().items[0].likeCount, 1);
  const retry = f.service.react(post()._id, 'like', false);
  writes[2].resolve(likeResponse(false)); await retry;
  assert.equal(f.service.cachedFeed().items[0].likeCount, 0);
});

test('后台刷新不覆盖等待保存的爱心，点赞响应不覆盖同时增加的评论数量', async () => {
  let finishLike;
  const f = client(data => data.action === 'setSquareReaction' ? new Promise(resolve => { finishLike = resolve; }) :
    { result: { success: true, square: data.action === 'publishSquareReply'
      ? { post: post({ replyCount: 1 }), reply: { _id: 'reply', content: '并行评论' } }
      : { items: [post()], hasMore: false, nextOffset: 1 } } });
  await f.service.list(); const pending = f.service.react(post()._id, 'like', true);
  await f.service.list({ force: true });
  assert.equal(f.service.cachedFeed().items[0].liked, true);
  assert.equal(f.service.cachedFeed().items[0].likeCount, 1);
  await f.service.reply(post()._id, '并行评论', 'parallel-reply-000001');
  finishLike(likeResponse(true)); await pending;
  assert.equal(f.service.cachedPost(post()._id).replyCount, 1);
  assert.equal(f.service.cachedPost(post()._id).likeCount, 1);
});

test('服务返回未确认的目标状态时停止保存并回退，不无限重试', async () => {
  const f = client(data => data.action === 'setSquareReaction' ? likeResponse(false) :
    { result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } });
  await f.service.list();
  await assert.rejects(f.service.react(post()._id, 'like', true), /状态未确认/);
  assert.equal(f.calls.filter(call => call.action === 'setSquareReaction').length, 1);
  assert.equal(f.service.cachedPost(post()._id).liked, false);
  assert.equal(f.service.cachedFeed().items[0].likeCount, 0);
});

test('点赞响应在切换账号或删除动态后到达，不能恢复旧状态或被删除的卡片', async () => {
  let finish;
  const f = client(data => data.action === 'setSquareReaction' ? new Promise(resolve => { finish = resolve; }) :
    { result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } });
  await f.service.list(); const pending = f.service.react(post()._id, 'like', true);
  f.users.logout(); f.login({ ...user, _id: 'bob' });
  const rejection = assert.rejects(pending, error => error.code === 'SESSION_CHANGED');
  finish(likeResponse(true)); await rejection;
  assert.equal(f.service.cachedPost(post()._id), null);
  let finishDeleted;
  const g = client(data => data.action === 'setSquareReaction' ? new Promise(resolve => { finishDeleted = resolve; }) :
    { result: { success: true, square: data.action === 'deleteSquarePost' ? { deletedId: post()._id } : { items: [post()], hasMore: false, nextOffset: 1 } } });
  await g.service.list(); const writing = g.service.react(post()._id, 'like', true);
  await g.service.deletePost(post()._id);
  const deleted = assert.rejects(writing, error => error.code === 'POST_NOT_FOUND');
  finishDeleted(likeResponse(true)); await deleted;
  assert.equal(g.service.cachedPost(post()._id), null); assert.equal(g.service.cachedFeed().items.length, 0);
});

test('个人动态真实总数跨分页保留，发布与删除同步更新总数，重复删除不再扣减', async () => {
  const addedId = 'p_' + 'c'.repeat(40);
  const f = client(data => ({ result: { success: true, square:
    data.action === 'publishSquarePost' ? { post: post({ _id: addedId, isOwn: true }) } :
    data.action === 'deleteSquarePost' ? { deletedId: addedId } :
    { mine: true, items: [post()], hasMore: true, nextOffset: data.offset ? 40 : 20, ...(data.offset ? {} : { total: 45 }) } } }));
  await f.service.list({ mine: true }); await f.service.list({ mine: true, offset: 20 });
  assert.equal(f.service.cachedOwnFeed().total, 45);
  await f.service.publish('新增动态', 'total-post-request-001'); assert.equal(f.service.cachedOwnFeed().total, 46);
  await f.service.deletePost(addedId); assert.equal(f.service.cachedOwnFeed().total, 45);
  await f.service.deletePost(addedId); assert.equal(f.service.cachedOwnFeed().total, 45);
});

test('信息流、完整动态和回复在一分钟内复用；普通用户发布后立即更新预览并返回广场', async () => {
  const f = client(async data => ({ result: { success: true, square:
    data.action === 'listSquarePosts' ? { items: [post()], hasMore: false, nextOffset: 1 } :
      data.action === 'listSquareReplies' ? { items: [], hasMore: false, nextOffset: 0 } : { post: post({ _id: 'p_' + 'b'.repeat(40), content: data.post && data.post.content || '详情' }) } } }));
  await f.service.list(); await f.service.list();
  assert.equal(f.calls.length, 1);
  await f.service.detail(post()._id);
  assert.equal(f.calls.length, 1);
  await f.service.listReplies(post()._id); await f.service.listReplies(post()._id);
  assert.equal(f.calls.length, 2);
  await f.service.publish('未认证也能发布', 'post-request-00000001');
  assert.equal(f.calls.at(-1).post.scope, 'square');
  assert.equal(f.calls.at(-1).scope, undefined);
  assert.equal(f.service.cachedFeed().items[0].content, '未认证也能发布');
  assert.equal(f.service.consumePublication(), true);
  assert.equal(f.service.consumePublication(), false);
});

test('内容声明跟随真实发布响应同步广场、个人和详情缓存，显示文案不混入正文且旧动态不显示声明', async () => {
  const f = client(async data => ({ result: { success: true, square: { post: post({
    content: data.post.content, declaration: data.post.declaration || 'none', images: ['cloud://test.bucket/square-media/alice/a.jpg'],
  }) } } }));
  const row = await f.service.publish('真实图文', 'declaration-client001', ['cloud://test.bucket/square-uploads/alice/a.jpg'], 'ai');
  assert.equal(f.calls[0].post.declaration, 'ai');
  for (const value of [row, f.service.cachedFeed().items[0], f.service.cachedOwnFeed().items[0], f.service.cachedPost(row._id)]) {
    assert.equal(value.declaration, 'ai'); assert.equal(value.content, '真实图文');
    assert.equal(postView(value).declarationText, '内容由AI生成'); assert.equal(value.images.length, 1);
  }
  await f.service.publish('无需声明', 'declaration-none0001'); assert.equal(f.calls.at(-1).post.declaration, undefined);
  const { declarations } = require('../miniprogram/utils/content-declaration');
  for (const item of declarations) assert.equal(postView(post({ declaration: item.key })).declarationText, item.key === 'none' ? '' : item.label);
  assert.equal(postView(post()).declarationText, '');
  assert.equal(postView(post({ declaration: 'arbitrary', declarationText: '不能伪造展示' })).declarationText, '');
});

test('详情点赞和回复同步列表；迟到的旧详情不会覆盖刚成功的点赞', async () => {
  let finish;
  const f = client(data => data.action === 'getSquarePost' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ result: { success: true, square:
    data.action === 'listSquarePosts' ? { items: [post()], hasMore: false, nextOffset: 1 } :
      data.action === 'setSquareReaction' ? { post: post({ liked: true, likeCount: 1 }) } :
        { post: post({ liked: true, likeCount: 1, replyCount: 1 }), reply: { _id: 'reply', content: '你好' } } } }));
  await f.service.list();
  const pending = f.service.detail(post()._id, true);
  await f.service.react(post()._id, 'like', true);
  finish({ result: { success: true, square: { post: post() } } });
  assert.equal((await pending).likeCount, 1);
  assert.equal(f.service.cachedFeed().items[0].likeCount, 1);
  await f.service.reply(post()._id, '你好', 'reply-request-000001');
  assert.equal(f.service.cachedFeed().items[0].replyCount, 1);
});

test('长文预览已同步缓存全文，点击进入详情不再等待额外请求，点赞后预览仍保持截断', async () => {
  const content = '长'.repeat(700);
  const f = client(async data => ({ result: { success: true, square: data.action === 'listSquarePosts'
    ? { items: [post({ content: content.slice(0, 280), fullContent: content, truncated: true })], hasMore: false, nextOffset: 1 }
    : { post: post({ content, liked: true, likeCount: 1 }) } } }));
  await f.service.list();
  assert.equal(f.service.cachedPost(post()._id).content.length, 700);
  assert.equal((await f.service.detail(post()._id)).truncated, false);
  assert.equal(f.calls.length, 1);
  await f.service.react(post()._id, 'like', true);
  assert.equal(f.service.cachedFeed().items[0].content.length, 280);
  assert.equal(f.service.cachedFeed().items[0].truncated, true);
});

test('强制刷新可读取他人新点赞；会话退出清理互动状态，旧响应不能进入新账号缓存', async () => {
  let finish, latest = 0;
  const f = client(data => data.action === 'getSquarePost' ? new Promise(resolve => { finish = resolve; }) :
    Promise.resolve({ result: { success: true, square: data.action === 'setSquareReaction' ? { post: post({ liked: true, likeCount: 1 }) } :
      { items: [post({ likeCount: latest })], hasMore: false, nextOffset: 1 } } }));
  await f.service.list(); await f.service.react(post()._id, 'like', true);
  latest = 7;
  await f.service.list({ force: true });
  assert.equal(f.service.cachedFeed().items[0].likeCount, 7);
  const pending = f.service.detail(post()._id, true);
  f.users.logout(); f.login({ ...user, _id: 'bob' });
  finish({ result: { success: true, square: { post: post({ liked: true }) } } });
  await assert.rejects(pending, error => error.code === 'SESSION_CHANGED');
  assert.equal(f.service.cachedPost(post()._id), null);
  f.users.logout();
  await assert.rejects(f.service.publish('不能匿名发布', 'post-request-00000001'), error => error.code === 'UNAUTHENTICATED');
});

test('个人动态独立缓存和分页，发布、详情互动同步到个人动态；广场不会被本人列表替换', async () => {
  const own = post({ _id: 'p_' + 'b'.repeat(40) });
  const f = client(async data => ({ result: { success: true, square: data.action === 'listSquarePosts'
    ? { ...(data.mine ? { mine: true } : {}), items: data.mine ? [own] : [post(), own], hasMore: false, nextOffset: data.mine ? 1 : 2 }
    : { post: data.action === 'publishSquarePost' ? post({ _id: 'p_' + 'c'.repeat(40), content: data.post.content }) : { ...own, liked: true, likeCount: 1 } } } }));
  await f.service.list(); await f.service.list({ mine: true }); await f.service.list({ mine: true });
  assert.equal(f.calls.length, 2);
  assert.equal(f.service.cachedFeed().items.length, 2);
  assert.equal(f.service.cachedOwnFeed().items.length, 1);
  await f.service.react(own._id, 'like', true);
  assert.equal(f.service.cachedOwnFeed().items[0].likeCount, 1);
  await f.service.publish('新发布立即出现在个人主页', 'profile-client-00001');
  assert.equal(f.service.cachedOwnFeed().items[0].content, '新发布立即出现在个人主页');
  assert.equal(f.service.cachedOwnFeed().nextOffset, 2);
  f.users.logout(); assert.equal(f.service.cachedOwnFeed(), null);
});

test('旧版云函数未支持本人筛选时不把全部广场内容显示到个人主页', async () => {
  const f = client(async () => ({ result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } }));
  await assert.rejects(f.service.list({ mine: true }), /重新部署 userService/);
  assert.equal(f.service.cachedOwnFeed(), null);
});

test('本人列表的迟到响应不会覆盖刚发布的新动态，也不会进入另一账号缓存', async () => {
  let finish;
  const f = client(data => data.action === 'listSquarePosts' ? new Promise(resolve => { finish = resolve; }) :
    Promise.resolve({ result: { success: true, square: { post: post({ content: data.post.content }) } } }));
  const listing = f.service.list({ mine: true });
  await f.service.publish('先于列表返回发布成功', 'profile-race-00000001');
  finish({ result: { success: true, square: { mine: true, items: [], hasMore: false, nextOffset: 0 } } });
  assert.equal((await listing).items[0].content, '先于列表返回发布成功');
  const stale = f.service.list({ mine: true, force: true });
  f.users.logout(); f.login({ ...user, _id: 'bob' });
  finish({ result: { success: true, square: { mine: true, items: [post()], hasMore: false, nextOffset: 1 } } });
  await assert.rejects(stale, error => error.code === 'SESSION_CHANGED');
  assert.equal(f.service.cachedOwnFeed(), null);
});

test('删除同步清理广场、个人、详情与回复缓存，迟到响应不能让动态复活', async () => {
  let finishList, finishDetail, finishReplies, delayed = false, listCalls = 0;
  const f = client(data => {
    if (data.action === 'deleteSquarePost') return Promise.resolve({ result: { success: true, square: { deletedId: data.postId } } });
    if (delayed && data.action === 'listSquarePosts' && ++listCalls > 1) return Promise.resolve({ result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } });
    if (delayed) return new Promise(resolve => {
      if (data.action === 'listSquarePosts') finishList = resolve;
      if (data.action === 'getSquarePost') finishDetail = resolve;
      if (data.action === 'listSquareReplies') finishReplies = resolve;
    });
    return Promise.resolve({ result: { success: true, square: { ...(data.mine ? { mine: true } : {}), items: [post()], hasMore: false, nextOffset: 1 } } });
  });
  await f.service.list(); await f.service.list({ mine: true });
  delayed = true;
  const listing = f.service.list({ force: true }), detail = f.service.detail(post()._id, true), replies = f.service.listReplies(post()._id);
  await f.service.deletePost(post()._id);
  assert.equal(f.service.cachedFeed().items.length, 0); assert.equal(f.service.cachedOwnFeed().items.length, 0);
  assert.equal(f.service.cachedPost(post()._id), null); assert.equal(f.service.cachedReplies(post()._id), null);
  const detailRejected = assert.rejects(detail, error => error.code === 'POST_NOT_FOUND');
  const repliesRejected = assert.rejects(replies, error => error.code === 'POST_NOT_FOUND');
  finishList({ result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } });
  finishDetail({ result: { success: true, square: { post: post() } } });
  finishReplies({ result: { success: true, square: { items: [post()], hasMore: false, nextOffset: 1 } } });
  const afterDelete = await listing;
  assert.equal(afterDelete.items.length, 0); assert.equal(afterDelete.nextOffset, 0);
  await detailRejected; await repliesRejected;
  assert.equal(f.service.cachedPost(post()._id), null);
});

test('失败删除保留动态，账号切换后旧删除结果不能清理新账号缓存', async () => {
  let failed = true, finish;
  const f = client(data => {
    if (data.action === 'deleteSquarePost') return failed ? Promise.resolve({ result: { success: false, code: 'FORBIDDEN', message: '只能删除自己的动态' } }) : new Promise(resolve => { finish = resolve; });
    return Promise.resolve({ result: { success: true, square: { ...(data.mine ? { mine: true } : {}), items: [post()], hasMore: false, nextOffset: 1 } } });
  });
  await f.service.list(); await f.service.list({ mine: true });
  await assert.rejects(f.service.deletePost(post()._id), error => error.code === 'FORBIDDEN');
  assert.equal(f.service.cachedPost(post()._id)._id, post()._id);
  failed = false;
  const deleting = f.service.deletePost(post()._id);
  f.users.logout(); f.login({ ...user, _id: 'bob' }); await f.service.list();
  finish({ result: { success: true, square: { deletedId: post()._id } } });
  await assert.rejects(deleting, error => error.code === 'SESSION_CHANGED');
  assert.equal(f.service.cachedFeed().items.length, 1);
});

const { composerFixture: pageFixture } = require('./helpers/square-composer-fixture');

test('发布页普通用户直接输入，仅明确保存后恢复草稿，并限制150字', async () => {
  const f = pageFixture(); await f.attach();
  f.page.onInput({ detail: { value: '未认证同学的想法' } });
  assert.equal(f.page.data.canPublish, true);
  assert.equal(f.storage.size, 0); f.page.saveAndClose();
  assert.equal(f.storage.get('square.draft.alice').content, '未认证同学的想法');
  const reopened = pageFixture({ storage: f.storage }); await reopened.attach();
  assert.equal(reopened.page.data.content, '未认证同学的想法');
  reopened.page.onInput({ detail: { value: '😊'.repeat(151) } });
  assert.equal(reopened.page.data.count, 150);
  assert.equal(reopened.page.data.canPublish, true);
  assert.equal(reopened.page.data.limitHintVisible, true);
  await reopened.page.publish(); assert.equal(reopened.calls.length, 1);
  assert.equal(Array.from(reopened.calls[0].content).length, 150);
});

test('发布请求失败保留编辑内容和幂等标识，不自动保存草稿，成功才收起面板', async () => {
  let failed = true;
  const f = pageFixture({ publish: async () => { if (failed) throw new Error('暂时无法连接'); return post(); } });
  await f.attach(); f.page.onInput({ detail: { value: '失败后可以重试' } });
  await f.page.publish();
  assert.equal(f.page.data.error, '暂时无法连接'); assert.equal(f.events.length, 0);
  assert.equal(f.page.data.content, '失败后可以重试'); assert.equal(f.storage.size, 0);
  failed = false; await f.page.publish();
  assert.equal(f.calls[0].id, f.calls[1].id);
  f.flushClose(); assert.equal(f.events.at(-1).detail.published, true); assert.equal(f.storage.size, 0);
});

test('首次评论读取迟于发送返回时保留刚发布的评论', async () => {
  let finish;
  const f = client(data => data.action === 'listSquareReplies' ? new Promise(resolve => { finish = resolve; }) :
    Promise.resolve({ result: { success: true, square: { post: post({ replyCount: 1 }), reply: { _id: 'reply', content: '新评论' } } } }));
  const reading = f.service.listReplies(post()._id);
  await f.service.reply(post()._id, '新评论', 'reply-race-00000001');
  finish({ result: { success: true, square: { items: [], hasMore: false, nextOffset: 0 } } });
  assert.equal((await reading).items[0].content, '新评论');
  assert.match(postView(post()).exactTime, /2026年11月17日 14:00/);
});


test('评论服务在调用云端前拒绝51个码点和空内容，保留emoji按码点规则', async () => {
  let calls = 0;
  const f = client(() => { calls++; throw new Error('不得请求云端'); });
  for (const content of ['😊'.repeat(51), '字'.repeat(50) + ' ', '', '   ']) await assert.rejects(f.service.reply(post()._id, content, 'comment-limit-request1'), error => error.code === 'INVALID_POST');
  assert.equal(calls, 0);
});


test('主页视频缓存按目标隔离，合并分页并忽略删除与换账号前的旧回包', async () => {
  const accountId = '87654321', postId = post()._id;
  const row = { _id: `${postId}_0`, postId }, other = { _id: 'other_0', postId: 'p_' + 'b'.repeat(40) };
  const ok = square => ({ result: { success: true, square } });
  const completions = [];
  const f = client(data => {
    if (data.action === 'deleteSquarePost') return ok({ deletedId: data.postId });
    return new Promise(resolve => completions.push(value => resolve(ok({ ...value, profileAccountId: data.profileAccountId }))));
  });
  const first = f.service.listProfileVideos(accountId);
  assert.equal(f.service.listProfileVideos(accountId), first);
  completions.shift()({ items: [row], hasMore: true, nextCursor: 'page-2' }); await first;
  assert.equal(f.service.cachedProfileVideos(), null);
  const more = f.service.listProfileVideos(accountId, { cursor: 'page-2' });
  assert.equal(f.calls.at(-1).cursor, 'page-2');
  await f.service.deletePost(postId);
  completions.shift()({ items: [row, other], hasMore: false, nextCursor: '' });
  assert.deepEqual(Array.from((await more).items), [other]);
  const late = f.service.listProfileVideos(accountId, { force: true }); f.login({ _id: 'bob' });
  completions.shift()({ items: [row], hasMore: false, nextCursor: '' });
  await assert.rejects(late, { code: 'SESSION_CHANGED' });
  assert.equal(f.service.cachedProfileVideos(accountId), null);
});

test('获赞统计合并请求、复用会话缓存，删除及点赞确认后重新读取', async () => {
  let finish, likes = 38;
  const f = client(data => {
    if (data.action === 'getSquareOwnStats') return new Promise(resolve => { finish = () => resolve({ result: { success: true, square: { receivedLikes: likes } } }); });
    if (data.action === 'deleteSquarePost') return { result: { success: true, square: { deletedId: data.postId } } };
    return { result: { success: true, square: { post: post({ liked: data.active, likeCount: data.active ? 1 : 0 }) } } };
  });
  assert.equal(f.service.cachedOwnStats(), null);
  const first = f.service.getOwnStats(), same = f.service.getOwnStats();
  assert.equal(first, same); finish(); assert.equal((await first).receivedLikes, 38);
  assert.equal((await f.service.getOwnStats()).receivedLikes, 38); assert.equal(f.calls.length, 1);
  let invalidations = 0;
  const unsubscribe = f.service.subscribeOwnStats(() => { invalidations++; });
  await f.service.react(post()._id, 'like', true, post());
  assert.equal(invalidations, 1);
  const refreshed = f.service.getOwnStats(); likes = 39; finish(); assert.equal((await refreshed).receivedLikes, 39);
  await f.service.deletePost(post()._id);
  assert.equal(invalidations, 2);
  unsubscribe();
  const deleted = f.service.getOwnStats(); likes = 0; finish(); assert.equal((await deleted).receivedLikes, 0);
  const forced = f.service.getOwnStats({ force: true });
  assert.equal(forced, f.service.getOwnStats({ force: true }));
  likes = 3; finish(); assert.equal((await forced).receivedLikes, 3);
});

test('获赞迟到读取不能覆盖切换账号或删除后的数据，失败仍保留真实缓存', async () => {
  const pending = [], f = client(() => new Promise(resolve => pending.push(resolve)));
  const first = f.service.getOwnStats();
  pending.shift()({ result: { success: true, square: { receivedLikes: 27 } } }); await first;
  f.login({ ...user, _id: 'bob' });
  assert.equal(f.service.cachedOwnStats(), null);
  const old = f.service.getOwnStats(); f.login();
  pending.shift()({ result: { success: true, square: { receivedLikes: 99 } } });
  await assert.rejects(old, { code: 'SESSION_CHANGED' }); assert.equal(f.service.cachedOwnStats(), null);
  const read = f.service.getOwnStats(), removal = f.service.deletePost(post()._id);
  pending[1]({ result: { success: true, square: { deletedId: post()._id } } }); await removal;
  pending[0]({ result: { success: true, square: { receivedLikes: 999 } } });
  await assert.rejects(read, { code: 'STATS_CHANGED' }); assert.equal(f.service.cachedOwnStats(), null);
});


test('获赞缓存到期后台重查，失败和异常数值不覆盖已有真实统计', async () => {
  let now = 1000000, result = 5, fail = false;
  const f = client(() => {
    if (fail) throw new Error('offline');
    return { result: { success: true, square: { receivedLikes: result } } };
  }, { now: () => now });
  assert.equal((await f.service.getOwnStats()).receivedLikes, 5);
  now += 60001; fail = true;
  await assert.rejects(f.service.getOwnStats()); assert.equal(f.service.cachedOwnStats().receivedLikes, 5);
  fail = false; result = -1;
  await assert.rejects(f.service.getOwnStats()); assert.equal(f.service.cachedOwnStats().receivedLikes, 5);
  result = 6; assert.equal((await f.service.getOwnStats()).receivedLikes, 6);
});


test('动态和引用缓存独立分页，发布依最终关系归类，重复确认及删除不重复扣数', async () => {
  const normal = post({ isOwn: true }), sourceId = 'p_' + 'b'.repeat(40);
  const quote = post({ _id: 'p_' + 'c'.repeat(40), quotePostId: sourceId, isOwn: true });
  const plain = post({ _id: 'p_' + 'd'.repeat(40), isOwn: true });
  const newQuote = { ...quote, _id: 'p_' + 'e'.repeat(40) };
  const f = client(data => {
    let square;
    if (data.action === 'listSquarePosts') square = { mine: true, postType: data.postType, items: data.postType === 'quotes' ? [quote] : [normal], total: 1, allTotal: 2, hasMore: false, nextOffset: 1 };
    else if (data.action === 'publishSquarePost') square = { post: data.post.quotePostId ? newQuote : plain };
    else square = { deletedId: quote._id };
    return { result: { success: true, square } };
  });
  await Promise.all([f.service.list({ mine: true, postType: 'posts' }), f.service.list({ mine: true, postType: 'quotes' })]);
  assert.equal(f.calls.length, 2);
  await Promise.all([f.service.list({ mine: true, postType: 'posts' }), f.service.list({ mine: true, postType: 'quotes' })]);
  assert.equal(f.calls.length, 2);
  await f.service.publish('移除引用之后的文字', 'profile-plain-000001');
  await f.service.publish('移除引用之后的文字', 'profile-plain-000001');
  assert.deepEqual(Array.from(f.service.cachedOwnFeed('posts').items, row => row._id), [plain._id, normal._id]);
  assert.deepEqual(Array.from(f.service.cachedOwnFeed('quotes').items, row => row._id), [quote._id]);
  assert.equal(f.service.cachedOwnFeed('posts').total, 2); assert.equal(f.service.cachedOwnFeed('quotes').allTotal, 3);
  await f.service.publish('引用发布', 'profile-quote-000001', [], 'none', sourceId);
  await f.service.publish('引用发布', 'profile-quote-000001', [], 'none', sourceId);
  assert.deepEqual(Array.from(f.service.cachedOwnFeed('quotes').items, row => row._id), [newQuote._id, quote._id]);
  assert.equal(f.service.cachedOwnFeed('quotes').total, 2); assert.equal(f.service.cachedOwnFeed('posts').allTotal, 4);
  assert.equal(f.service.cachedOwnFeed('posts').items.length, 2);
  await f.service.deletePost(quote._id); await f.service.deletePost(quote._id);
  assert.equal(f.service.cachedOwnFeed('quotes').items.length, 1); assert.equal(f.service.cachedOwnFeed('quotes').total, 1);
  assert.equal(f.service.cachedOwnFeed('posts').total, 2); assert.equal(f.service.cachedOwnFeed('posts').allTotal, 3);
  f.users.logout(); assert.equal(f.service.cachedOwnFeed('quotes'), null); assert.equal(f.service.cachedOwnFeed('posts'), null);
});

test('分类查询拒绝旧云端混合响应，切账号后的迟到引用列表不能写入缓存', async () => {
  const old = client(() => ({ result: { success: true, square: { mine: true, items: [], hasMore: false, nextOffset: 0 } } }));
  await assert.rejects(old.service.list({ mine: true, postType: 'quotes' }), /重新部署 userService/);
  let finish;
  const f = client(() => new Promise(resolve => { finish = resolve; }));
  const listing = f.service.list({ mine: true, postType: 'quotes' });
  f.login({ ...user, _id: 'bob' });
  finish({ result: { success: true, square: { mine: true, postType: 'quotes', items: [post({ quotePostId: 'source' })], hasMore: false, nextOffset: 1 } } });
  await assert.rejects(listing, error => error.code === 'SESSION_CHANGED');
  assert.equal(f.service.cachedOwnFeed('quotes'), null);
});


test('发布与删除同步引用蓝色状态，迟到列表及旧引用版本不能反弹当前颜色', async () => {
  const source = post({ quoteCount: 0, quoteVersion: 0, quoted: false });
  const quote = post({ _id: 'p_' + 'f'.repeat(40), quotePostId: source._id, isOwn: true });
  let delayed = false, finish;
  const f = client(data => {
    const ok = square => ({ result: { success: true, square } });
    if (data.action === 'listSquarePosts') return delayed ? new Promise(resolve => { finish = resolve; }) : ok({ items: [source], hasMore: false, nextOffset: 1 });
    if (data.action === 'publishSquarePost') return ok({ post: quote, quotedPost: { ...source, quoted: true, quoteCount: 1, quoteVersion: 1 } });
    return ok({ deletedId: quote._id, quotedPost: { ...source, quoted: false, quoteCount: 0, quoteVersion: 2 } });
  });
  await f.service.list(); delayed = true;
  const staleRead = f.service.list({ force: true });
  await f.service.publish('引用', 'state-quote-publish-1', [], 'none', source._id);
  assert.equal(f.service.cachedPost(source._id).quoted, true);
  finish({ result: { success: true, square: { items: [source], hasMore: false, nextOffset: 1 } } }); await staleRead;
  assert.equal(f.service.cachedFeed().items.find(row => row._id === source._id).quoted, true);
  const secondRead = f.service.list({ force: true });
  await f.service.deletePost(quote._id); delayed = false;
  finish({ result: { success: true, square: { items: [{ ...source, quoted: true, quoteCount: 1, quoteVersion: 1 }], hasMore: false, nextOffset: 1 } } }); await secondRead;
  assert.equal(f.service.cachedPost(source._id).quoted, false);
  assert.equal(f.service.cachedFeed().items.find(row => row._id === source._id).quoteCount, 0);
});
