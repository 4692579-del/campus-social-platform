const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/certification-fixture');
const { loadPostActions } = require('./helpers/post-actions-fixture');
const id = n => 'p_' + n.toString(16).padStart(40, '0');
const pin = (f, target, pinned = true, identity = f.alice) => f.handle({ action: 'setSquareProfilePin', postId: target, pinned }, identity);
async function seeded(count = 25, options) {
  const f = fixture(options), user = await f.login(); await f.login(f.bob);
  for (let n = 1; n <= count; n++) f.squarePosts.set(id(n), { _id: id(n), authorId: user._id, scope: 'square', status: 'published',
    content: String(n), sortKey: String(n).padStart(5, '0'), createdAt: `2026-11-${String(n).padStart(2, '0')}T00:00:00Z` });
  return { f, user };
}

test('旧动态置顶跨分页不漏帖不重复；首页维持自然时间顺序且无置顶状态', async () => {
  const { f } = await seeded();
  assert.equal((await pin(f, id(1))).success, true);
  const read = offset => f.handle({ action: 'listSquarePosts', mine: true, postType: 'posts', offset }, f.alice);
  const first = (await read(0)).square;
  assert.equal(first.pinnedPostId, id(1)); assert.equal(first.items[0]._id, id(1));
  assert.equal(first.nextOffset, 20); assert.equal(first.items.length, 21); assert.equal(first.total, 25);
  const next = (await read(first.nextOffset)).square;
  assert.equal(next.hasMore, false); assert.equal(next.nextOffset, 25);
  assert.equal(new Set([...first.items, ...next.items].map(row => row._id)).size, 25);
  const home = (await f.handle({ action: 'listSquarePosts' }, f.alice)).square;
  assert.equal(home.items[0]._id, id(25)); assert.equal(home.pinnedPostId, undefined);
  assert.equal((await pin(f, id(1), false)).square.pinnedPostId, '');
  assert.equal((await read(0)).square.items[0]._id, id(25));
});

test('并发仅一条置顶，重复请求幂等；取消旧目标不能撤销新目标', async () => {
  const { f, user } = await seeded(3);
  const results = await Promise.all([pin(f, id(1)), pin(f, id(2))]);
  assert.equal(results.filter(row => row.success).length, 1);
  assert.equal(results.find(row => !row.success).code, 'PIN_EXISTS');
  const chosen = f.users.get(user._id).squarePinnedPostId;
  const version = f.users.get(user._id).squarePinVersion;
  await pin(f, chosen); assert.equal(f.users.get(user._id).squarePinVersion, version);
  await pin(f, chosen, false); await pin(f, id(3));
  assert.equal((await pin(f, chosen, false)).code, 'PIN_CHANGED');
  assert.equal(f.users.get(user._id).squarePinnedPostId, id(3));
});

test('本人/普通动态/有效账号校验，删除置顶原子清理，失败不伪保存', async () => {
  const { f, user } = await seeded(3);
  assert.equal((await pin(f, id(1), true, f.bob)).code, 'FORBIDDEN');
  f.squarePosts.get(id(2)).quotePostId = id(1);
  assert.equal((await pin(f, id(2))).code, 'INVALID_POST');
  assert.equal((await pin(f, id(3), 'yes')).code, 'INVALID_POST');
  await pin(f, id(1));
  const removed = await f.handle({ action: 'deleteSquarePost', postId: id(1) }, f.alice);
  assert.equal(removed.success, true); assert.equal(f.users.get(user._id).squarePinnedPostId, '');
  assert.equal((await pin(f, id(1))).code, 'POST_NOT_FOUND');
  assert.equal((await pin(f, id(3))).success, true);
  f.users.get(user._id).status = 'disabled';
  assert.equal((await pin(f, id(3), false)).code, 'ACCOUNT_DISABLED');
  const failing = await seeded(1, { failUserUpdate: true });
  assert.equal((await pin(failing.f, id(1))).success, false);
  assert.equal(failing.f.users.get(failing.user._id).squarePinnedPostId, undefined);
});

function menuFixture({ pinnedPostId = '', route = 'pages/profile/index', selectedContent = 'posts', own = true } = {}) {
  const sheets = [], writes = [], messages = [];
  let account = { _id: 'self', accountId: '12345678' }, version = 0;
  const row = { _id: id(1), content: '动态', isOwn: own, author: { accountId: own ? '12345678' : '87654321' } };
  const users = { getCachedUser: () => account, getSessionVersion: () => version };
  const square = { cachedPost: () => row, cachedProfilePin: () => ({ pinnedPostId }),
    async setProfilePin(target, active) { writes.push({ target, active }); pinnedPostId = active ? target : ''; },
    cachedOwnFeed: () => ({ items: [row], pinnedPostId }),
  };
  const methods = loadPostActions(users, square, { showActionSheet: args => sheets.push(args), showToast: args => messages.push(args.title) });
  const page = { ...methods, route, data: { user: account, ownPosts: [row], postScope: 'square', selectedContent, pinnedPostId },
    showOwnPosts(result) { this.data.pinnedPostId = result.pinnedPostId; } };
  return { page, sheets, writes, messages, switchUser() { account = { _id: 'other' }; version++; } };
}
const moreEvent = { detail: { id: id(1), profilePosts: true } };
test('置顶菜单仅限本人主页动态；其他已置顶、首页、引用标签及他人都没有入口', async () => {
  for (const args of [{ pinnedPostId: id(2) }, { route: 'pages/home/index' }, { selectedContent: 'reposts' }, { own: false }]) {
    const f = menuFixture(args), pending = f.page.managePost(moreEvent);
    assert.equal(f.sheets[0].itemList.length, 1); f.sheets[0].fail({ errMsg: 'cancel' }); await pending;
  }
  const f = menuFixture(), pending = f.page.managePost(moreEvent);
  assert.equal(f.sheets[0].itemList[1], '置顶'); f.sheets[0].success({ tapIndex: 1 }); await pending;
  assert.deepEqual(f.writes, [{ target: id(1), active: true }]); assert.equal(f.page.data.pinnedPostId, id(1));
  const unpinning = f.page.managePost(moreEvent);
  assert.equal(f.sheets[1].itemList[1], '取消置顶'); f.sheets[1].success({ tapIndex: 1 }); await unpinning;
  assert.equal(f.page.data.pinnedPostId, '');
  const late = menuFixture(), waiting = late.page.managePost(moreEvent);
  late.switchUser(); late.sheets[0].success({ tapIndex: 1 }); await waiting;
  assert.equal(late.writes.length, 0); assert.equal(late.messages.length, 0);
});
