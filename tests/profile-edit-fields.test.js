const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture } = require('./helpers/certification-fixture');

test('保存简介、生日与封面为同一个资料更新，不改变认证，并兼容旧版昵称头像保存', async () => {
  const f = fixture();
  const user = await f.login();
  Object.assign(f.users.get(user._id), { role: 'student', certificationStatus: 'approved', schoolId: 'school' });
  const cover = `cloud://test.bucket/avatars/${user._id}/cover-edit-test.png`;
  const result = await f.handle({ action: 'updateProfile', profile: {
    nickname: '新的昵称', avatarFileID: '', bio: '  喜欢校园生活\r\n记录日常 🌻  ', birthDate: '2004-02-29', coverFileID: cover,
  } }, f.alice);
  assert.equal(result.success, true);
  assert.equal(result.user.bio, '喜欢校园生活\n记录日常 🌻');
  assert.equal(result.user.birthDate, '2004-02-29');
  assert.equal(result.user.coverFileID, cover);
  assert.equal(result.user.role, 'student');
  assert.equal(result.user.certificationStatus, 'approved');
  await f.handle({ action: 'updateProfile', profile: { nickname: '旧客户端', avatarFileID: '' } }, f.alice);
  const restored = await f.login();
  assert.equal(restored.bio, result.user.bio);
  assert.equal(restored.birthDate, result.user.birthDate);
  assert.equal(restored.coverFileID, cover);
  await f.handle({ action: 'updateProfile', profile: { nickname: '清空简介生日', avatarFileID: '', bio: '', birthDate: '' } }, f.alice);
  assert.equal((await f.login()).birthDate, '');
  assert.equal((await f.login()).bio, '');
});

test('简介与日期服务端验证失败时，昵称等资料也不会部分保存', async () => {
  const f = fixture();
  const user = await f.login();
  for (const bio of [null, '字'.repeat(161), '简介\u0000异常']) {
    const result = await f.handle({ action: 'updateProfile', profile: { nickname: '不可写入', avatarFileID: '', bio } }, f.alice);
    assert.equal(result.code, 'INVALID_BIO');
  }
  for (const birthDate of [null, '2023-02-29', '2000-13-01', '1899-12-31', '2999-01-01', '2004-2-9']) {
    const result = await f.handle({ action: 'updateProfile', profile: { nickname: '不可写入', avatarFileID: '', birthDate } }, f.alice);
    assert.equal(result.code, 'INVALID_BIRTH_DATE');
  }
  assert.equal(f.users.get(user._id).nickname, user.nickname);
  assert.equal((await f.handle({ action: 'updateProfile', profile: { nickname: '🌻', avatarFileID: '', bio: '🌻'.repeat(160) } }, f.alice)).success, true);
});

test('编辑页封面不能引用别人的文件；未知字段不能修改角色或认证', async () => {
  const f = fixture();
  const user = await f.login();
  const other = await f.login(f.bob);
  for (const extra of [
    { coverFileID: `cloud://test.bucket/avatars/${other._id}/cover-other.png` },
    { role: 'admin' }, { certificationStatus: 'approved' }, { location: '假位置' },
  ]) {
    const result = await f.handle({ action: 'updateProfile', profile: { nickname: '不可写入', avatarFileID: '', bio: '简介', ...extra } }, f.alice);
    assert.equal(result.success, false);
  }
  assert.equal(f.users.get(user._id).nickname, user.nickname);
  assert.equal(f.users.get(user._id).role, 'user');
});

function editFixture(options = {}) {
  let definition;
  const user = { _id: 'alice', nickname: '旧昵称', avatarFileID: '', coverFileID: '', bio: '旧简介', birthDate: '2000-01-01' };
  const uploads = [], saves = [], navigation = [], toasts = [];
  const service = {
    getCachedUser: () => options.cachedUser || null,
    restore: async () => options.restore ? options.restore() : ({ ...user }),
    updateProfile: async profile => {
      saves.push(profile);
      if (options.updateProfile) return options.updateProfile(profile);
      return { ...user, ...profile };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/edit-profile/index.js'), 'utf8'), {
    Page: value => { definition = value; }, require: () => service,
    console: { error() {} },
    wx: {
      getWindowInfo: () => ({ statusBarHeight: 44 }), getMenuButtonBoundingClientRect: () => ({ top: 52, height: 32 }),
      chooseMedia: args => options.cancel ? args.fail({ errMsg: 'chooseMedia:fail cancel' }) : args.success({ tempFiles: [{ tempFilePath: '/temp/cover.png' }] }),
      getImageInfo: args => args.success({ type: 'png', width: 1000 }),
      compressImage: args => args.success({ tempFilePath: '/temp/cover-small.png' }),
      getFileSystemManager: () => ({ getFileInfo: args => args.success({ size: 1024 }) }),
      cloud: { uploadFile: async args => { uploads.push(args); return { fileID: 'cloud://test.bucket/' + args.cloudPath }; } },
      showToast: args => toasts.push(args.title), navigateBack: () => navigation.push('back'), switchTab: () => navigation.push('profile'),
    },
  });
  const page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values); } };
  return { page, user, uploads, saves, navigation, toasts };
}

test('编辑页直接使用会话资料，不等待网络且不覆盖正在输入的草稿', async () => {
  const f = editFixture({ cachedUser: { _id: 'alice', nickname: '内存昵称', avatarFileID: '', bio: '内存简介' },
    restore: () => { throw new Error('不应额外请求'); } });
  const pending = f.page.onLoad();
  assert.equal(f.page.data.loading, false);
  assert.equal(f.page.data.nickname, '内存昵称');
  f.page.onBioChange({ detail: { value: '正在编辑' } });
  await pending;
  assert.equal(f.page.data.bio, '正在编辑');
  assert.equal(f.page.data.dirty, true);
});

test('编辑页预填真实资料，取消只退出，不上传、不保存封面或文本', async () => {
  const f = editFixture();
  await f.page.onLoad();
  assert.equal(f.page.data.bio, '旧简介');
  assert.equal(f.page.data.birthDate, '2000-01-01');
  assert.equal(f.page.data.dirty, false);
  f.page.onBioChange({ detail: { value: '新简介' } });
  assert.equal(f.page.data.dirty, true);
  await f.page.chooseCover();
  f.page.cancel();
  assert.equal(f.uploads.length, 0);
  assert.equal(f.saves.length, 0);
  assert.deepEqual(f.navigation, ['back']);
});

test('完成时一次保存最终昵称、简介、生日和新图片；生日可清空，位置只提示', async () => {
  const f = editFixture();
  await f.page.onLoad();
  f.page.onChooseAvatar({ detail: { avatarUrl: '/temp/avatar.png' } });
  await f.page.chooseCover();
  f.page.onBirthDateChange({ detail: { value: '2001-03-04' } });
  await f.page.save({ detail: { value: { nickname: '最终昵称', bio: ' 最终简介\n第二行 ' } } });
  assert.equal(f.uploads.length, 2);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].bio, '最终简介\n第二行');
  assert.equal(f.saves[0].birthDate, '2001-03-04');
  assert.match(f.saves[0].coverFileID, /\/avatars\/alice\/cover-/);
  assert.deepEqual(f.navigation, ['back']);
  f.page.clearBirthDate();
  assert.equal(f.page.data.birthDate, '');
  f.page.showLocationNotice();
  assert.equal(f.toasts.at(-1), '位置功能暂未开放');
});

test('简介或生日无效时不上传图片；取消相册不会显示错误', async () => {
  const f = editFixture({ cancel: true });
  await f.page.onLoad();
  await f.page.chooseCover();
  assert.equal(f.page.data.error, '');
  await f.page.save({ detail: { value: { nickname: '昵称', bio: '字'.repeat(161) } } });
  assert.match(f.page.data.error, /160/);
  f.page.onBirthDateChange({ detail: { value: '2023-02-29' } });
  await f.page.save({ detail: { value: { nickname: '昵称', bio: '' } } });
  assert.match(f.page.data.error, /出生日期/);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.saves.length, 0);
});

test('服务失败重试不重复上传封面和头像，成功前不返回', async () => {
  let attempts = 0;
  const f = editFixture({ updateProfile: async profile => { if (++attempts === 1) throw new Error('超时'); return profile; } });
  await f.page.onLoad();
  f.page.onChooseAvatar({ detail: { avatarUrl: '/temp/avatar.png' } });
  await f.page.chooseCover();
  const event = { detail: { value: { nickname: '昵称', bio: '简介' } } };
  await f.page.save(event);
  assert.deepEqual(f.navigation, []);
  assert.equal(f.page.data.saving, false);
  await f.page.save(event);
  assert.equal(f.uploads.length, 2);
  assert.deepEqual(f.navigation, ['back']);
});

test('离开编辑页后，迟到保存结果不再提示成功或跳转其他页面', async () => {
  let resolve;
  const f = editFixture({ updateProfile: () => new Promise(done => { resolve = done; }) });
  await f.page.onLoad();
  const saving = f.page.save({ detail: { value: { nickname: '昵称', bio: '简介' } } });
  f.page.onUnload(); resolve({}); await saving;
  assert.deepEqual(f.navigation, []);
  assert.deepEqual(f.toasts, []);
});
