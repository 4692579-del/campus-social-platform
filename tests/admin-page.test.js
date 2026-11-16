const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describeUser } = require('../miniprogram/utils/user-role');

function pageFixture(service) {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/admin/index.js'), 'utf8'), {
    Page: page => { definition = page; }, require: () => service,
    wx: { stopPullDownRefresh() {}, switchTab() {} },
  });
  return { ...definition, data: { ...definition.data }, setData(value) { Object.assign(this.data, value); } };
}

test('身份文字区分三种角色，旧版无 role 的返回值不显示管理入口', () => {
  assert.equal(describeUser({ role: 'user', certificationStatus: 'unverified' }).roleText, '普通用户');
  assert.equal(describeUser({ role: 'student', certificationStatus: 'approved' }).roleText, '学生用户');
  assert.equal(describeUser({ role: 'admin' }).isAdmin, true);
  assert.equal(describeUser({ role: 'admin' }).certificationText, '管理员不参与学生认证');
  assert.equal(describeUser({}).isAdmin, false);
  assert.equal(describeUser({}).roleText, '身份待同步');
});

test('直接打开管理页时，伪造的客户端 admin 缓存无法绕过云端拒绝', async () => {
  let requests = 0;
  const page = pageFixture({
    restore: async () => ({ role: 'admin' }),
    getAdminDashboard: async () => { requests++; throw new Error('仅管理员可以访问管理工作台'); },
  });
  page.data.dashboard = { operator: { role: 'admin', nickname: '旧缓存' } };
  await page.loadDashboard();
  assert.equal(requests, 1);
  assert.equal(page.data.dashboard, null);
  assert.match(page.data.error, /仅管理员/);
  assert.equal(page.data.loading, false);
});

test('未登录直接访问管理页显示登录提示，不建立账号', async () => {
  const page = pageFixture({ restore: async () => null, getAdminDashboard: () => { throw new Error('should not call'); } });
  await page.loadDashboard();
  assert.equal(page.data.dashboard, null);
  assert.match(page.data.error, /请先/);
});

test('管理员访问成功；重新进入时仍重新验证，服务不可用不保留旧工作台', async () => {
  let unavailable = false;
  const page = pageFixture({
    restore: async () => ({ role: 'admin' }),
    getAdminDashboard: async () => {
      if (unavailable) throw new Error('连接失败');
      return { operator: { role: 'admin', nickname: '管理员' } };
    },
  });
  await page.loadDashboard();
  assert.equal(page.data.dashboard.operator.nickname, '管理员');
  unavailable = true;
  await page.loadDashboard();
  assert.equal(page.data.dashboard, null);
  assert.equal(page.data.error, '连接失败');
});
