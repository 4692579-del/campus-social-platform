const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function clientFixture(callFunction) {
  const storage = new Map();
  const app = { globalData: { currentUser: null } };
  const requests = [];
  const context = {
    module: { exports: {} }, console,
    getApp: () => app,
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
      cloud: { callFunction: args => { requests.push(args); return callFunction(args); } },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/services/user.js'), 'utf8'), context);
  return { service: context.module.exports, storage, app, requests };
}

test('未登录时恢复不会调用云端或创建用户', async () => {
  const f = clientFixture(() => { throw new Error('should not call'); });
  assert.equal(await f.service.restore(), null);
  assert.equal(f.requests.length, 0);
});

test('重复点击登录只发一次请求；恢复会重新向云端读取', async () => {
  const f = clientFixture(async () => ({ result: { success: true, user: { _id: 'alice', nickname: '同学' } } }));
  const first = f.service.login();
  const second = f.service.login();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.app.globalData.currentUser._id, 'alice');
  await f.service.restore();
  assert.equal(f.requests[1].data.action, 'getProfile');
  assert.deepEqual([...f.storage.values()], [true]);
});

test('云端返回业务失败时不会留下登录状态', async () => {
  const f = clientFixture(async () => ({ result: { success: false, message: '测试失败' } }));
  await assert.rejects(f.service.login(), /测试失败/);
  assert.equal(f.storage.size, 0);
  assert.equal(f.app.globalData.currentUser, null);
});

test('退出后迟到的登录响应不能重新登录账号', async () => {
  let resolve;
  const f = clientFixture(() => new Promise(done => { resolve = done; }));
  const pending = f.service.login();
  f.service.logout();
  resolve({ result: { success: true, user: { _id: 'alice' } } });
  await assert.rejects(pending, /登录已取消/);
  assert.equal(f.storage.size, 0);
  assert.equal(f.app.globalData.currentUser, null);
});

function editFixture({ failSave = false, failUpload = false } = {}) {
  const uploads = [];
  const saves = [];
  const toasts = [];
  const navigation = [];
  let page;
  const service = {
    async restore() { return { _id: 'alice', nickname: '旧昵称', avatarFileID: '' }; },
    async updateProfile(profile) {
      saves.push(profile);
      if (failSave) throw new Error('服务暂不可用');
      return profile;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/edit-profile/index.js'), 'utf8'), {
    Page: definition => { page = definition; }, require: () => service,
    console: { error() {} }, Date, Math,
    wx: {
      cloud: { uploadFile: async args => {
        uploads.push(args);
        if (failUpload) throw new Error('上传失败');
        return { fileID: 'cloud://campus-test.bucket/' + args.cloudPath };
      } },
      showToast: value => toasts.push(value.title),
      navigateBack: () => navigation.push('back'),
      switchTab: () => navigation.push('profile'),
    },
  });
  const instance = { ...page, data: { ...page.data }, setData(value) { Object.assign(this.data, value); } };
  return { page: instance, uploads, saves, toasts, navigation, allowSave() { failSave = false; }, allowUpload() { failUpload = false; } };
}

test('新头像先上传再保存，使用表单最终昵称，成功才返回', async () => {
  const f = editFixture();
  await f.page.loadProfile();
  f.page.onChooseAvatar({ detail: { avatarUrl: '/tmp/photo.png' } });
  await f.page.save({ detail: { value: { nickname: ' 新昵称 ' } } });
  assert.match(f.uploads[0].cloudPath, /^avatars\/alice\/.+\.png$/);
  assert.equal(f.saves[0].nickname, '新昵称');
  assert.match(f.saves[0].avatarFileID, /^cloud:\/\//);
  assert.deepEqual(f.toasts, ['资料已保存']);
  assert.deepEqual(f.navigation, ['back']);
});

test('保存失败不提示成功或返回，重试复用已上传头像', async () => {
  const f = editFixture({ failSave: true });
  await f.page.loadProfile();
  f.page.onChooseAvatar({ detail: { avatarUrl: '/tmp/photo.jpg' } });
  await f.page.save({ detail: { value: { nickname: '新昵称' } } });
  assert.equal(f.page.data.error, '服务暂不可用');
  assert.equal(f.page.data.saving, false);
  assert.deepEqual(f.toasts, []);
  assert.deepEqual(f.navigation, []);
  f.allowSave();
  await f.page.save({ detail: { value: { nickname: '新昵称' } } });
  assert.equal(f.uploads.length, 1);
  assert.deepEqual(f.toasts, ['资料已保存']);
});

test('头像上传失败不写入临时路径、不提交资料，可以重试', async () => {
  const f = editFixture({ failUpload: true });
  await f.page.loadProfile();
  f.page.onChooseAvatar({ detail: { avatarUrl: '/tmp/photo.jpg' } });
  await f.page.save({ detail: { value: { nickname: '新昵称' } } });
  assert.equal(f.uploads.length, 1);
  assert.equal(f.saves.length, 0);
  assert.equal(f.page.data.error, '上传失败');
  assert.deepEqual(f.toasts, []);
  assert.equal(f.page.data.saving, false);
  f.allowUpload();
  await f.page.save({ detail: { value: { nickname: '新昵称' } } });
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.toasts, ['资料已保存']);
});

test('空白昵称不上传头像或提交资料', async () => {
  const f = editFixture();
  await f.page.loadProfile();
  await f.page.save({ detail: { value: { nickname: '   ' } } });
  assert.equal(f.uploads.length, 0);
  assert.equal(f.saves.length, 0);
  assert.match(f.page.data.error, /昵称/);
});
