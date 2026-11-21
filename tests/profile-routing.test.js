const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPostActions } = require('./helpers/post-actions-fixture');

const alice = '12345678', bob = '87654321', carol = '23456789';
const author = accountId => ({ detail: { author: { accountId, nickname: '同名用户' } } });
function fixture() {
  let viewer = { _id: 'alice', accountId: alice }, version = 1;
  const stack = [], calls = [], seeds = [], toasts = [];
  const users = { getCachedUser: () => viewer, getSessionVersion: () => version, seedPublicProfile: value => seeds.push(value) };
  const actions = loadPostActions(users, {}, {
    navigateTo: args => calls.push({ type: 'push', ...args }),
    navigateBack: args => calls.push({ type: 'back', ...args }),
    showToast: args => toasts.push(args.title),
  }, () => stack);
  const page = (route, data = {}) => ({ ...actions, route, data, _visible: true, interactionBlocked: () => false });
  const profile = (id, route = 'pages/profile/index') => page(route, { isVisitor: id !== alice, profileAccountId: id === alice ? '' : id,
    profileUser: { accountId: id }, user: viewer, selectedContent: 'replies', ownPosts: [{ _id: 'post', images: ['unchanged-photo'] }] });
  return { stack, calls, seeds, toasts, page, profile, switchUser() { viewer = { _id: 'bob', accountId: bob }; version++; } };
}

test('当前用户主页的动态、回复、引用作者入口都不重复入栈，不依赖route字段', () => {
  const f = fixture(), home = f.page('pages/home/index'), profile = f.profile(bob, undefined);
  delete profile.route; f.stack.push(home, profile); const data = profile.data, images = data.ownPosts[0].images;
  for (const selectedContent of ['posts', 'replies', 'reposts']) {
    profile.data.selectedContent = selectedContent;
    for (let n = 0; n < 5; n++) profile.viewAuthorProfile(author(bob));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.seeds.length, 0);
  assert.equal(f.stack.length, 2); assert.equal(profile.data, data); assert.equal(profile.data.ownPosts[0].images, images);
  assert.equal(Boolean(profile._openingAuthor), false);
});

test('主页到动态详情再点同一作者，返回已有主页而不是继续套娃', () => {
  const f = fixture(), profile = f.profile(bob), detail = f.page('pages/square-detail/index');
  f.stack.push(f.page('pages/home/index'), profile, detail);
  detail.viewAuthorProfile(author(bob)); detail.viewAuthorProfile(author(bob));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].type, 'back'); assert.equal(f.calls[0].delta, 1);
  assert.equal(f.seeds.length, 0); assert.equal(profile.data.selectedContent, 'replies');
});

test('不同作者相互跳转形成循环时回到最近的已有实例，跨过中间详情页', () => {
  const f = fixture(), a = f.profile(bob), b = f.profile(carol), detail = f.page('pages/square-detail/index');
  f.stack.push(f.page('pages/home/index'), a, detail, b);
  b.viewAuthorProfile(author(bob)); assert.equal(f.calls[0].type, 'back'); assert.equal(f.calls[0].delta, 2);
  f.stack.splice(2); a._openingAuthor = false;
  a.viewAuthorProfile(author(carol)); assert.equal(f.calls[1].type, 'push'); assert.equal(f.calls[1].url, '/pages/profile/index?accountId=' + carol);
});

test('本人主页也复用；昵称相同不合并，切账号后不误复用旧本人的资料', () => {
  const f = fixture(), own = f.profile(alice), other = f.profile(carol);
  f.stack.push(f.page('pages/home/index'), own, other);
  other.viewAuthorProfile(author(alice)); assert.equal(f.calls[0].type, 'back'); assert.equal(f.calls[0].delta, 1);
  other._openingAuthor = false; f.switchUser();
  other.viewAuthorProfile(author(alice)); assert.equal(f.calls[1].type, 'push'); assert.equal(f.calls[1].url, '/pages/profile/index?accountId=' + alice);
});

test('没有既有主页时保持正常跳转，返回失败可重试，旧失败回调不解锁新跳转', () => {
  const f = fixture(), profile = f.profile(bob), detail = f.page('pages/square-detail/index');
  f.stack.push(profile, detail); detail.viewAuthorProfile(author(bob)); const first = f.calls[0];
  first.fail(); assert.equal(detail._openingAuthor, false); assert.equal(f.toasts.length, 1);
  detail.viewAuthorProfile(author(bob)); assert.equal(f.calls[1].type, 'back');
  first.fail(); assert.equal(detail._openingAuthor, true); assert.equal(f.toasts.length, 1);
  f.calls[1].fail(); detail.viewAuthorProfile(author(carol)); assert.equal(f.calls[2].type, 'push');
});

test('旧运行时route别名和前导斜杠可识别，无普通ID的AI入口仍不创建主页', () => {
  const f = fixture(), profile = f.profile(bob, '/pages/profile/index?accountId=' + bob), detail = f.page('pages/square-detail/index');
  f.stack.push(profile, detail); detail.viewAuthorProfile(author(bob)); assert.equal(f.calls[0].type, 'back');
  detail._openingAuthor = false; detail.viewAuthorProfile(author('system-ai')); assert.equal(f.calls.length, 1); assert.equal(f.toasts.length, 1);
  const legacy = f.page(undefined, { isVisitor: true, profileAccountId: bob }); legacy.__route__ = 'pages/profile/index';
  legacy.viewAuthorProfile(author(bob)); assert.equal(f.calls.length, 1);
});
