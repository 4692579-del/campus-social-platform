const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/certification-fixture');
const { edgeId } = require('../cloudfunctions/userService/square-follows');
const id = n => 'p_' + n.toString(16).padStart(40, '0');
const send = (f, action, data = {}, identity = f.alice) => f.handle({ action, ...data }, identity);

test('普通未认证账号真实关注，重复及并发提交幂等，双向关注统计独立，取关不出现负数', async () => {
  const f = fixture(), alice = await f.login(), bob = await f.login(f.bob);
  const follow = following => send(f, 'setSquareFollow', { accountId: bob.accountId, following, followerId: bob._id });
  const values = await Promise.all([follow(true), follow(true), follow(true)]);
  assert.ok(values.every(value => value.success)); assert.equal(f.follows.size, 1);
  assert.equal(f.users.get(alice._id).followingCount, 1); assert.equal(f.users.get(bob._id).followerCount, 1);
  assert.equal(values[2].square.state.version, 1);
  const opposite = await send(f, 'setSquareFollow', { accountId: alice.accountId, following: true }, f.bob);
  assert.equal(opposite.success, true); assert.equal(f.users.get(alice._id).followerCount, 1); assert.equal(f.follows.size, 2);
  await follow(false); await follow(false);
  assert.equal(f.users.get(alice._id).followingCount, 0); assert.equal(f.users.get(bob._id).followerCount, 0);
  assert.equal(f.users.get(bob._id).followingCount, 1); assert.equal(f.follows.get(edgeId(alice._id, bob.accountId)).version, 2);
  const profile = (await send(f, 'getSquareFollowProfile', { accountId: bob.accountId })).square.profile;
  assert.equal(profile.following, false); assert.equal(profile.followingCount, 1); assert.equal(profile.followerCount, 0);
  assert.ok(!JSON.stringify(profile).includes(bob._id));
});

test('关注拒绝自己、伪造身份、禁用目标和未登录；写入失败整笔回滚', async () => {
  const f = fixture({ failCollection: 'user_follows' }), alice = await f.login(), bob = await f.login(f.bob);
  assert.equal((await send(f, 'setSquareFollow', { accountId: alice.accountId, following: true })).code, 'FOLLOW_SELF');
  assert.equal((await send(f, 'setSquareFollow', { accountId: bob.accountId, following: 'true' })).code, 'INVALID_FOLLOW');
  assert.equal((await send(f, 'setSquareFollow', { accountId: bob.accountId, following: true }, { openid: 'unknown', env: 'test' })).code, 'NOT_REGISTERED');
  assert.equal((await send(f, 'setSquareFollow', { accountId: bob.accountId, following: true })).success, false);
  assert.equal(f.follows.size, 0); assert.equal(f.users.get(alice._id).followingCount, undefined);
  f.users.get(bob._id).status = 'disabled';
  assert.equal((await send(f, 'setSquareFollow', { accountId: bob.accountId, following: true })).code, 'PROFILE_NOT_FOUND');
});

test('关注事务重新校验双方身份；事务内串行读取兼容真实云端', async () => {
  const f = fixture(), alice = await f.login(), bob = await f.login(f.bob); f.hooks.serialTransactionReads = true;
  f.hooks.beforeTransaction = tables => { tables.get('users').get(bob._id).status = 'disabled'; };
  assert.equal((await send(f, 'setSquareFollow', { accountId: bob.accountId, following: true })).code, 'PROFILE_NOT_FOUND');
  assert.equal(f.follows.size, 0); f.hooks.beforeTransaction = null; f.users.get(bob._id).status = 'active';
  assert.equal((await send(f, 'setSquareFollow', { accountId: bob.accountId, following: true })).success, true);
  assert.equal(f.users.get(alice._id).followingCount, 1);
});

test('批量关系只返回当前浏览者自己的状态；退出后的读取不能绕过登录', async () => {
  const f = fixture(); await f.login(); const bob = await f.login(f.bob);
  await send(f, 'setSquareFollow', { accountId: bob.accountId, following: true });
  const read = who => send(f, 'getSquareFollowStates', { accountIds: [bob.accountId], followerId: 'spoof' }, who);
  assert.equal((await read(f.alice)).square.items[0].following, true);
  assert.equal((await read(f.bob)).square.items[0].following, false);
  assert.equal((await read({ openid: 'unknown', env: 'test' })).code, 'NOT_REGISTERED');
  assert.equal((await send(f, 'getSquareFollowStates', { accountIds: Array(51).fill(bob.accountId) })).code, 'INVALID_FOLLOW');
});

test('关注时间线只含已关注的公开广场动态和引用，游标分页不受新帖插入影响', async () => {
  const f = fixture(), alice = await f.login(), bob = await f.login(f.bob);
  for (let n = 1; n <= 48; n++) f.squarePosts.set(id(n), { _id: id(n), authorId: n % 2 ? alice._id : bob._id, scope: 'square', status: 'published',
    content: String(n), sortKey: String(n).padStart(16, '0') + '_' + id(n), createdAt: '2026-11-21T00:00:00Z', images: [], ...(n === 48 ? { quotePostId: id(1) } : {}) });
  f.squarePosts.set(id(90), { _id: id(90), authorId: bob._id, scope: 'campus', status: 'published', content: '私有板块', sortKey: '99' });
  f.squarePosts.set(id(91), { _id: id(91), authorId: bob._id, scope: 'square', status: 'deleted', content: '已删除', sortKey: '99' });
  assert.equal((await send(f, 'listSquareFollowing')).square.items.length, 0);
  await send(f, 'setSquareFollow', { accountId: bob.accountId, following: true });
  const first = (await send(f, 'listSquareFollowing')).square;
  assert.equal(first.items.length, 20); assert.equal(first.hasMore, true); assert.equal(first.items[0]._id, id(48));
  assert.ok(first.items.every(row => row.author.accountId === bob.accountId && !row.isOwn && !row.imageSources));
  f.squarePosts.set(id(99), { ...f.squarePosts.get(id(2)), _id: id(99), sortKey: '9999999999999999_' + id(99) });
  const second = (await send(f, 'listSquareFollowing', { cursor: first.nextCursor })).square;
  assert.equal(second.items.length, 4); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map(row => row._id)).size, 24);
  await send(f, 'setSquareFollow', { accountId: bob.accountId, following: false });
  assert.equal((await send(f, 'listSquareFollowing')).square.items.length, 0);
});

test('稀疏关注时间线返回可继续的真实游标，不误报结束；禁用作者不展示', async () => {
  const f = fixture(), alice = await f.login(), bob = await f.login(f.bob);
  for (let n = 1; n <= 405; n++) f.squarePosts.set(id(n), { _id:id(n), authorId:n === 1 ? bob._id : alice._id, scope:'square',status:'published',content:'内容',sortKey:String(n).padStart(16,'0')+'_'+id(n) });
  await send(f, 'setSquareFollow', { accountId:bob.accountId,following:true });
  const first = (await send(f, 'listSquareFollowing')).square;
  assert.equal(first.items.length,0); assert.equal(first.hasMore,true); assert.ok(first.nextCursor);
  const second = (await send(f, 'listSquareFollowing', {cursor:first.nextCursor})).square;
  assert.equal(second.items.length,1); assert.equal(second.hasMore,false);
  f.users.get(bob._id).status='disabled'; assert.equal((await send(f,'listSquareFollowing',{cursor:first.nextCursor})).square.items.length,0);
});
