const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/certification-fixture');
const id = n => 'p_' + n.toString(16).padStart(40, '0');
const search = (f, value, who = f.alice) => f.handle({ action: 'searchSquareContent', kind: 'square', keyword: '校园', ...value }, who);
function post(owner, n, content = '校园生活', extra = {}) { return { _id:id(n), authorId:owner._id, scope:'square',status:'published',content,sortKey:String(n).padStart(16,'0')+'_'+id(n),images:[],...extra }; }

test('搜索真实广场正文，作者条件使用公开ID，引用不匹配被引用者正文，排除其他板块与已删除内容',async()=>{
  const f=fixture(),alice=await f.login(),bob=await f.login(f.bob);
  for(const row of [post(alice,1),post(bob,2),post(bob,3,'其他',{quotePostId:id(1)}),post(bob,4,'校园',{scope:'campus'}),post(bob,5,'校园',{status:'deleted'})])f.squarePosts.set(row._id,row);
  const all=(await search(f,{})).square;assert.deepEqual(all.items.map(row=>row._id),[id(2),id(1)]);
  const own=(await search(f,{accountId:bob.accountId,authorId:alice._id})).square;assert.deepEqual(own.items.map(row=>row._id),[id(2)]);assert.ok(own.items.every(row=>row.author.accountId===bob.accountId&&!row.imageSources));
  const guest=await search(f,{}, {openid:'unregistered',env:'test'});assert.equal(guest.success,true);
  assert.equal((await search(f,{accountId:bob.accountId},{openid:'unregistered',env:'test'})).code,'NOT_REGISTERED');
});

test('关键词按普通文本精确包含处理，不把点星号、括号或竖线当成正则表达式',async()=>{
  const f=fixture(),user=await f.login();for(const [n,text] of [[1,'包含 .* 特殊字符'],[2,'包含 [你好]'],[3,'A|B'],[4,'普通文本'],[5,'deepSeek Flash']])f.squarePosts.set(id(n),post(user,n,text));
  assert.deepEqual((await search(f,{keyword:'.*'})).square.items.map(row=>row._id),[id(1)]);
  assert.deepEqual((await search(f,{keyword:'['})).square.items.map(row=>row._id),[id(2)]);
  assert.deepEqual((await search(f,{keyword:'A|B'})).square.items.map(row=>row._id),[id(3)]);
  assert.deepEqual((await search(f,{keyword:'DEEPSEEK'})).square.items.map(row=>row._id),[id(5)]);
});

test('只带ID可搜索目标账号及其全部广场帖子，用户关键词搜索昵称或ID并去重，公开结果无敏感资料',async()=>{
  const f=fixture(),alice=await f.login(),bob=await f.login(f.bob);Object.assign(f.users.get(bob._id),{nickname:'校园同学',bio:'公开简介',realName:'private-name',schoolId:'private-school',birthDate:'private-date'});
  f.squarePosts.set(id(1),post(bob,1,'无关键字正文'));
  const person=(await search(f,{kind:'users',keyword:'',accountId:bob.accountId})).square;assert.equal(person.items.length,1);assert.equal(person.items[0].accountId,bob.accountId);
  assert.deepEqual(Object.keys(person.items[0]).sort(),['accountId','nickname','avatarFileID','bio','isVerified'].sort());assert.ok(!JSON.stringify(person).includes('private-'));
  assert.equal((await search(f,{kind:'users',keyword:'校园同学'})).square.items.length,1);
  assert.equal((await search(f,{kind:'users',keyword:'@'+bob.accountId})).square.items[0].accountId,bob.accountId);
  assert.equal((await search(f,{kind:'users',keyword:'正文关键词',accountId:bob.accountId})).square.items[0].accountId,bob.accountId);
  assert.equal((await search(f,{keyword:'',accountId:bob.accountId})).square.items.length,1);
  assert.equal((await search(f,{kind:'users'},{openid:'unknown',env:'test'})).code,'NOT_REGISTERED');
  assert.equal(f.users.get(alice._id).accountId,alice.accountId);
});

test('搜索游标按真实时间倒序分页，插入新动态不跳过旧内容，作者失效与非法请求真实拒绝',async()=>{
  const f=fixture(),user=await f.login();for(let n=1;n<=25;n++)f.squarePosts.set(id(n),post(user,n));
  const first=(await search(f,{})).square;assert.equal(first.items.length,20);assert.equal(first.hasMore,true);f.squarePosts.set(id(100),post(user,100));
  const next=(await search(f,{cursor:first.nextCursor})).square;assert.equal(next.items.length,5);assert.equal(new Set([...first.items,...next.items].map(row=>row._id)).size,25);
  assert.equal((await search(f,{keyword:''})).code,'INVALID_SEARCH');assert.equal((await search(f,{keyword:'a'.repeat(101)})).code,'INVALID_SEARCH');
  assert.equal((await search(f,{kind:'campus'})).code,'SEARCH_SCOPE_UNAVAILABLE');assert.equal((await search(f,{accountId:'bad'})).code,'INVALID_SEARCH');
  f.users.get(user._id).status='disabled';const bob=await f.login(f.bob);assert.equal((await search(f,{accountId:user.accountId},f.bob)).code,'PROFILE_NOT_FOUND');
  assert.equal((await search(f,{kind:'users',keyword:'校园'},f.bob)).square.items.some(row=>row.accountId===user.accountId),false);assert.ok(bob.accountId);
});

test('昵称和ID同时命中的用户跨页去重，返回稳定的真实分页结果',async()=>{
  const f=fixture({randomAccountId:()=> '87654321'}),viewer=await f.login();
  for(let n=0;n<26;n++){
    const _id='u_'+n.toString(16).padStart(32,'0');
    f.users.set(_id,{...f.users.get(viewer._id),_id,accountId:String(12340000+n),nickname:'1234测试用户'});
  }
  const first=(await search(f,{kind:'users',keyword:'1234'})).square;
  assert.equal(first.items.length,20);assert.equal(first.hasMore,true);
  const next=(await search(f,{kind:'users',keyword:'1234',cursor:first.nextCursor})).square;
  assert.equal(next.items.length,6);assert.equal(next.hasMore,false);
  assert.equal(new Set([...first.items,...next.items].map(row=>row.accountId)).size,26);
});
