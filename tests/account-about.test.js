const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture } = require('./helpers/certification-fixture');
const { describeUser } = require('../miniprogram/utils/user-role');

const profile = nickname => ({ nickname, avatarFileID: '' });
const accountInfo = (f, identity = f.alice, extra = {}) => f.handle({ action: 'getAccountInfo', ...extra }, identity);
const rename = (f, nickname) => f.handle({ action: 'updateProfile', profile: profile(nickname) }, f.alice);

test('公开账号信息仅返回指定账号的公开学校、日期和改名摘要，不返回本人私有资料或敏感字段',async()=>{
  const f=fixture();await f.login();const bob=await f.login(f.bob);
  await f.handle({action:'updateProfile',profile:profile('Bob改名')},f.bob);
  Object.assign(f.users.get(bob._id),{role:'student',certificationStatus:'approved',schoolId:'private-school-id',schoolName:'公开认证学校',realName:'private-name',studentNumber:'private-number',birthDate:'2001-01-01',certificationProof:'private-proof'});
  const read=who=>f.handle({action:'getSquarePublicAccountInfo',accountId:bob.accountId,userId:'forged',openid:'bob'},who);
  const result=await read(f.alice);assert.equal(result.success,true);const about=result.square.accountInfo;
  assert.deepEqual(Object.keys(about.user).sort(),['accountId','nickname','avatarFileID','createdAt','isVerified','schoolName'].sort());
  assert.equal(about.user.accountId,bob.accountId);assert.equal(about.user.schoolName,'公开认证学校');assert.equal(about.user.isVerified,true);assert.equal(about.nicknameHistory.changeCount,1);
  assert.ok(!JSON.stringify(about).includes('private-'));assert.equal((await read({openid:'unknown',env:'test'})).code,'NOT_REGISTERED');
  f.users.get(bob._id).status='disabled';assert.equal((await read(f.alice)).code,'PROFILE_NOT_FOUND');
});

test('公开读取不初始化他人的老账号历史，也不展示未通过认证的旧学校',async()=>{
  const f=fixture();await f.login();const bob=await f.login(f.bob),record=f.users.get(bob._id);
  for(const key of ['nicknameChangeCount','nicknameTrackingStartedAt','nicknameHistoryComplete','nicknameLastChangedAt'])delete record[key];
  record.schoolName='不应公开的旧学校';const before=JSON.stringify(record);
  const about=(await f.handle({action:'getSquarePublicAccountInfo',accountId:bob.accountId},f.alice)).square.accountInfo;
  assert.equal(about.user.schoolName,'');assert.equal(about.user.isVerified,false);assert.equal(about.nicknameHistory.changeCount,null);assert.equal(about.nicknameHistory.lastChangedAt,null);assert.equal(JSON.stringify(record),before);
});

test('新账号从零开始，改名与最后修改时间真实持久化，重登录不重置', async () => {
  const clock = { serverTime: '2026-11-17T06:00:00.000Z' };
  const f = fixture(clock);
  const user = await f.login();
  const initial = (await accountInfo(f)).accountInfo;
  assert.equal(initial.nicknameHistory.changeCount, 0);
  assert.equal(initial.nicknameHistory.lastChangedAt, null);
  assert.equal(initial.nicknameHistory.historyComplete, true);
  clock.serverTime = '2026-11-17T07:23:45.000Z';
  assert.equal((await rename(f, '第一次改名')).success, true);
  let info = (await accountInfo(f)).accountInfo;
  assert.equal(info.nicknameHistory.changeCount, 1);
  assert.equal(info.nicknameHistory.lastChangedAt, clock.serverTime);
  assert.equal(info.user.createdAt, user.createdAt);
  clock.serverTime = '2026-11-18T01:02:03.000Z';
  await rename(f, '第二次改名');
  await f.login();
  info = (await accountInfo(f)).accountInfo;
  assert.equal(info.nicknameHistory.changeCount, 2);
  assert.equal(info.nicknameHistory.lastChangedAt, clock.serverTime);
  assert.equal(info.nicknameHistory.trackingStartedAt, user.createdAt);
  assert.equal(info.user.openid, undefined);
});

test('相同昵称、空白规范化、只编辑简介头像生日封面，不增加改名次数或改名时间', async () => {
  const f = fixture();
  const user = await f.login();
  await rename(f, '小罗');
  const before = (await accountInfo(f)).accountInfo.nicknameHistory;
  const result = await f.handle({ action: 'updateProfile', profile: {
    nickname: '  小罗  ', avatarFileID: `cloud://test.bucket/avatars/${user._id}/avatar.png`,
    bio: '新简介', birthDate: '2000-02-29', coverFileID: `cloud://test.bucket/avatars/${user._id}/cover-new.png`,
  } }, f.alice);
  assert.equal(result.success, true);
  assert.deepEqual((await accountInfo(f)).accountInfo.nicknameHistory, before);
});

test('并发保存同一个昵称只记一次；不同昵称逐次记录，计数不会丢失', async () => {
  const f = fixture();
  await f.login();
  assert.ok((await Promise.all(Array.from({ length: 8 }, () => rename(f, '相同昵称')))).every(r => r.success));
  assert.equal((await accountInfo(f)).accountInfo.nicknameHistory.changeCount, 1);
  assert.ok((await Promise.all(['甲', '乙', '丙'].map(name => rename(f, name)))).every(r => r.success));
  assert.equal((await accountInfo(f)).accountInfo.nicknameHistory.changeCount, 4);
});

test('老账号不推测历史，首次查看与首次改名并发也只初始化一次', async () => {
  const f = fixture();
  const user = await f.login();
  const record = f.users.get(user._id);
  for (const key of ['nicknameChangeCount', 'nicknameLastChangedAt', 'nicknameTrackingStartedAt', 'nicknameHistoryComplete']) delete record[key];
  record.updatedAt = '2020-01-01T00:00:00.000Z';
  await Promise.all([accountInfo(f), rename(f, '新名字'), accountInfo(f)]);
  const history = (await accountInfo(f)).accountInfo.nicknameHistory;
  assert.equal(history.changeCount, 1);
  assert.equal(history.historyComplete, false);
  assert.equal(history.trackingStartedAt, '2026-11-14T10:00:00.000Z');
  assert.equal(history.lastChangedAt, '2026-11-14T10:00:00.000Z');
});

test('写入失败会同时回滚昵称和统计；事务内重新确认封禁状态', async () => {
  const f = fixture({ failUserUpdate: true });
  const user = await f.login();
  assert.equal((await rename(f, '不应保存')).success, false);
  assert.equal(f.users.get(user._id).nickname, user.nickname);
  assert.equal(f.users.get(user._id).nicknameChangeCount, 0);
  assert.equal(f.users.get(user._id).nicknameLastChangedAt, null);
  const g = fixture();
  const other = await g.login();
  g.hooks.beforeTransaction = tables => { tables.get('users').get(other._id).status = 'banned'; };
  assert.equal((await rename(g, '封禁后不可改名')).code, 'ACCOUNT_DISABLED');
  assert.equal(g.users.get(other._id).nickname, other.nickname);
});

test('账号信息仅按可信身份读取，禁止伪造统计字段，未注册或禁用不能访问', async () => {
  const f = fixture();
  assert.equal((await accountInfo(f, {})).code, 'UNAUTHENTICATED');
  assert.equal((await accountInfo(f)).code, 'NOT_REGISTERED');
  const alice = await f.login(), bob = await f.login(f.bob);
  await rename(f, 'Alice');
  const info = (await accountInfo(f, f.bob, { userId: alice._id, openid: 'alice' })).accountInfo;
  assert.equal(info.user._id, bob._id);
  assert.equal(info.nicknameHistory.changeCount, 0);
  for (const key of ['nicknameChangeCount', 'nicknameLastChangedAt', 'nicknameHistoryComplete', 'nicknameTrackingStartedAt']) {
    assert.equal((await f.handle({ action: 'updateProfile', profile: { ...profile('伪造'), [key]: 999 } }, f.alice)).code, 'INVALID_PROFILE');
  }
  f.users.get(alice._id).status = 'banned';
  assert.equal((await accountInfo(f)).code, 'ACCOUNT_DISABLED');
});

function pageFixture(result, options = {}) {
  let definition;
  const routes = [];
  const copies = [], toasts = [];
  const calls=[];
  const service = { getCachedUser: () => options.cachedUser || null, getSessionVersion:()=>options.sessionVersion||0,
    getCachedAccountInfo: () => options.cachedInfo || null, getAccountInfo: async () => {calls.push({own:true});return typeof result === 'function' ? result() : result;},
    getCachedPublicAccountInfo:()=>options.publicInfo||null,getCachedPublicProfile:()=>options.publicProfile||null,
    getPublicAccountInfo:async(accountId,args)=>{calls.push({accountId,...args});return typeof result==='function'?result():result;},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/account-about/index.js'), 'utf8'), {
    require: () => service, Page: page => { definition = page; },
    wx: { getWindowInfo: () => ({ statusBarHeight: 44 }), getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32 }),
      setClipboardData: args => {
        copies.push(args);
        if (options.holdCopy) return;
        if (options.failCopy) args.fail();
        else args.success();
        args.complete();
      },
      showToast: args => toasts.push(args.title),
      navigateBack: () => routes.push('back'), switchTab: value => routes.push(value.url) },
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  return { page, routes, copies, toasts, calls };
}
const info = { user: { _id: 'alice', accountId: '12345678', nickname: '真实昵称', avatarFileID: 'real-avatar', role: 'user',
  certificationStatus: 'unverified', schoolId: '', schoolName: '不应展示的旧学校', createdAt: '2026-11-16T16:00:00.000Z' },
nicknameHistory: { changeCount: 2, lastChangedAt: '2026-11-17T03:04:05.000Z', trackingStartedAt: '2026-11-17T01:00:00.000Z', historyComplete: false } };

const publicInfo={user:{accountId:'87654321',nickname:'对方昵称',avatarFileID:'public-avatar',createdAt:'2026-11-16T16:00:00.000Z',isVerified:true,schoolName:'公开学校'},nicknameHistory:{changeCount:3,lastChangedAt:'2026-11-17T03:04:05.000Z',historyComplete:true}};

test('访客关于此账号优先预填公开缓存并读取目标信息，能复制目标ID，不混用本人账号接口',async()=>{
  let finish;const f=pageFixture(()=>new Promise(resolve=>{finish=resolve;}),{cachedUser:info.user,cachedInfo:info,publicProfile:publicInfo.user});
  f.page.onLoad({accountId:publicInfo.user.accountId});assert.equal(f.page.data.user.nickname,'对方昵称');assert.equal(f.page.data.changeCount,null);
  const pending=f.page.onShow();assert.equal(f.page.data.loading,false);assert.equal(f.calls[0].accountId,'87654321');assert.ok(!f.calls.some(call=>call.own));
  finish(publicInfo);await pending;assert.equal(f.page.data.schoolText,'公开学校');assert.equal(f.page.data.changeCount,3);assert.equal(f.page.data.joinedText,'2026年11月17日');
  f.page.copyAccountId();assert.equal(f.copies[0].data,'87654321');
});

test('公开账号页刷新失败保留缓存，账号失效清空，未记录的历史不编造为0',async()=>{
  const f=pageFixture(()=>Promise.reject(new Error('offline')),{cachedUser:info.user,publicInfo});f.page.onLoad({accountId:'87654321'});await f.page.onShow();assert.equal(f.page.data.changeCount,3);assert.equal(f.page.data.error,'offline');
  const gone=pageFixture(()=>Promise.reject(Object.assign(new Error('不存在'),{code:'PROFILE_NOT_FOUND'})),{cachedUser:info.user,publicInfo});gone.page.onLoad({accountId:'87654321'});await gone.page.onShow();assert.equal(gone.page.data.user,null);
  const legacy=pageFixture({...publicInfo,nicknameHistory:{changeCount:null,lastChangedAt:null}},{cachedUser:info.user});legacy.page.onLoad({accountId:'87654321'});await legacy.page.onShow();assert.equal(legacy.page.data.changeCount,null);assert.equal(legacy.page.data.lastChangedText,'暂无用户名更改记录');
});

test('公开账号页离开和切账号忽略迟到信息，未登录及非法目标不会读取本人的资料',async()=>{
  let finish;const options={cachedUser:info.user,publicInfo};const f=pageFixture(()=>new Promise(resolve=>{finish=resolve;}),options);f.page.onLoad({accountId:'87654321'});const pending=f.page.onShow();options.cachedUser={...info.user,_id:'new-viewer'};options.sessionVersion=1;finish(publicInfo);await pending;assert.equal(f.page.data.user,null);
  let late;const hidden=pageFixture(()=>new Promise(resolve=>{late=resolve;}),{cachedUser:info.user});hidden.page.onLoad({accountId:'87654321'});const load=hidden.page.onShow();hidden.page.onHide();late(publicInfo);await load;assert.equal(hidden.page.data.user,null);
  const guest=pageFixture(publicInfo);guest.page.onLoad({accountId:'87654321'});await guest.page.onShow();assert.equal(guest.calls.length,0);assert.equal(guest.page.data.user,null);
  const invalid=pageFixture(publicInfo,{cachedUser:info.user});invalid.page.onLoad({accountId:'bad'});await invalid.page.onShow();assert.equal(invalid.calls.length,0);assert.equal(invalid.page.data.user,null);
});

test('关于账号直接展示已有资料，未知改名记录不编造，后台完成后补全真实统计', async () => {
  let resolve;
  const f = pageFixture(() => new Promise(done => { resolve = done; }), { cachedUser: info.user });
  f.page.onLoad();
  const pending = f.page.onShow();
  assert.equal(f.page.data.user.nickname, info.user.nickname);
  assert.equal(f.page.data.loading, false);
  assert.equal(f.page.data.changeCount, null);
  resolve(info);
  await pending;
  assert.equal(f.page.data.changeCount, 2);
  f.page.onHide();
  assert.equal(f.page.data.user.nickname, info.user.nickname);
});

test('ID复制由用户点击触发，只复制本账号8位ID且成功后显示指定提示', async () => {
  const f = pageFixture(info);
  await f.page.onShow();
  assert.equal(f.copies.length, 0);
  f.page.copyAccountId();
  assert.equal(f.copies[0].data, '12345678');
  assert.deepEqual(f.toasts, ['已复制ID账号']);
  const failed = pageFixture(info, { failCopy: true });
  await failed.page.onShow();
  failed.page.copyAccountId();
  assert.deepEqual(failed.toasts, ['复制失败，请重试']);
});

test('未分配或未登录不复制，连续点击不重复调用，离开页面忽略迟到的复制提示', async () => {
  const f = pageFixture(info, { holdCopy: true });
  f.page.copyAccountId();
  assert.equal(f.copies.length, 0);
  await f.page.onShow();
  f.page.data.user = { ...info.user, accountId: '' };
  f.page.copyAccountId();
  assert.equal(f.copies.length, 0);
  f.page.data.user = { ...info.user };
  f.page.copyAccountId(); f.page.copyAccountId();
  assert.equal(f.copies.length, 1);
  f.page.onHide();
  f.copies[0].success(); f.copies[0].complete();
  assert.deepEqual(f.toasts, []);
});

test('账号页展示真实资料与北京时间，未认证不展示旧学校', async () => {
  const { page, routes } = pageFixture(info);
  page.onLoad();
  await page.onShow();
  assert.equal(page.data.navHeight, 92);
  assert.equal(page.data.user.avatarFileID, 'real-avatar');
  assert.equal(page.data.schoolText, '未认证');
  assert.equal(page.data.joinedText, '2026年11月17日');
  assert.equal(page.data.changeCount, 2);
  assert.equal(page.data.lastChangedText, '2026年11月17日 11:04:05');
  page.back();
  assert.deepEqual(routes, ['back']);
});

test('只有真实通过认证的学生展示认证学校和已认证状态，缺失时间不编造', async () => {
  const result = structuredClone(info);
  Object.assign(result.user, { role: 'student', certificationStatus: 'approved', schoolId: 'school-real', schoolName: '闽南科技学院' });
  result.nicknameHistory = { ...result.nicknameHistory, historyComplete: true, changeCount: 0, lastChangedAt: null };
  const { page } = pageFixture(result);
  await page.onShow();
  assert.equal(page.data.isVerified, true);
  assert.equal(page.data.schoolText, '闽南科技学院');
  assert.equal(page.data.lastChangedText, '尚无更改记录');
  result.user.createdAt = null;
  result.user.certificationStatus = 'pending';
  await page.onShow();
  assert.equal(page.data.isVerified, false);
  assert.equal(page.data.schoolText, '未认证');
  assert.equal(page.data.joinedText, '暂无加入日期记录');
});

test('离开页面清除旧账号资料并忽略迟到响应；重新进入或失败不显示旧数据', async () => {
  let resolve;
  const { page } = pageFixture(() => new Promise(done => { resolve = done; }));
  const pending = page.onShow();
  page.onHide();
  resolve(info);
  await pending;
  assert.equal(page.data.user, null);
  const failed = pageFixture(async () => { throw new Error('请重新登录'); }).page;
  await failed.onShow();
  assert.equal(failed.data.error, '请重新登录');
  assert.equal(failed.data.user, null);
  assert.equal(failed.data.loading, false);
});

test('主页加入日期可进入账号页，学校名称已移出主页且新页面已注册', () => {
  let definition;
  const routes = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.js'), 'utf8'), {
    Page: value => { definition = value; }, require: name => name.includes('user-role') ? { describeUser } : name.includes('account-menu') ? require('../miniprogram/utils/account-menu') : {},
    wx: { navigateTo: value => routes.push(value.url) },
  });
  const page = { ...definition, data: { user: null } };
  page.openAccountAbout();
  assert.equal(routes.length, 0);
  page.data.user = info.user;
  page.openAccountAbout();
  assert.deepEqual(routes, ['/pages/account-about/index']);
  const markup = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.wxml'), 'utf8');
  assert.match(markup, /class="joined-row" bindtap="openAccountAbout"/);
  assert.doesNotMatch(markup, /user\.schoolName/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8')).pages.includes('pages/account-about/index'));
});
