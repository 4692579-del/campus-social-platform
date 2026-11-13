// 小程序只通过云函数访问 users，不直接读写用户集合。
const SESSION_KEY = 'campus.session.v1';
let pendingLogin = null;
let pendingRestore = null;
let sessionVersion = 0;

async function request(action, extra) {
  let response;
  try {
    response = await wx.cloud.callFunction({ name: 'userService', data: { action, ...extra } });
  } catch (error) {
    console.error('用户服务调用失败', error);
    throw new Error('连接失败，请稍后重试');
  }
  const result = response.result;
  if (!result || !result.success) {
    if (result && result.code === 'ACCOUNT_DISABLED') logout();
    throw new Error((result && result.message) || '服务暂时不可用，请稍后重试');
  }
  return result.user;
}

function remember(user) {
  getApp().globalData.currentUser = user;
  if (user) wx.setStorageSync(SESSION_KEY, true);
  else wx.removeStorageSync(SESSION_KEY);
  return user;
}

function login() {
  if (pendingLogin) return pendingLogin;
  const version = sessionVersion;
  pendingLogin = request('login').then(user => {
    if (version !== sessionVersion) throw new Error('登录已取消，请重试');
    return remember(user);
  }).finally(() => { pendingLogin = null; });
  return pendingLogin;
}

function restore() {
  if (!wx.getStorageSync(SESSION_KEY)) return Promise.resolve(null);
  if (pendingRestore) return pendingRestore;
  const version = sessionVersion;
  // 本地仅保存“曾登录”标记；每次恢复都向云端确认，缓存不是权限凭证。
  pendingRestore = request('getProfile').then(user => {
    if (version !== sessionVersion) return null;
    return remember(user);
  }).finally(() => { pendingRestore = null; });
  return pendingRestore;
}

async function updateProfile(profile) {
  const version = sessionVersion;
  const user = await request('updateProfile', { profile });
  if (version !== sessionVersion) throw new Error('登录状态已变更，请重新登录');
  return remember(user);
}

function logout() {
  sessionVersion += 1;
  remember(null);
}

module.exports = { login, restore, updateProfile, logout };
