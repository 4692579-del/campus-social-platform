// 小程序只通过云函数访问 users，不直接读写用户集合。
const SESSION_KEY = 'campus.session.v1';
let pendingLogin = null;
let pendingRestore = null;
let sessionVersion = 0;

async function request(action, extra, resultKey = 'user') {
  let response;
  try {
    response = await wx.cloud.callFunction({ name: 'userService', data: { action, ...extra } });
  } catch (error) {
    console.error('用户服务调用失败', error);
    throw new Error('连接失败，请稍后重试');
  }
  const result = response.result;
  if (!result || !result.success) {
    if (result && ['ACCOUNT_DISABLED', 'NOT_REGISTERED', 'UNAUTHENTICATED', 'INVALID_ROLE'].includes(result.code)) logout();
    const error = new Error((result && result.message) || '服务暂时不可用，请稍后重试');
    error.code = (result && result.code) || 'SERVICE_ERROR';
    throw error;
  }
  return result[resultKey];
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

// 这只是服务入口，访问权限必须由云函数检查，不能由客户端决定。
function getAdminDashboard() {
  return request('getAdminDashboard', {}, 'dashboard');
}

async function certificationRequest(action, application) {
  const version = sessionVersion;
  const result = await request(action, application ? { application } : {}, 'certification');
  if (version !== sessionVersion) throw new Error('登录状态已变更，请重新登录');
  if (!result || !result.user) throw new Error('认证信息读取失败，请重试');
  remember(result.user);
  return result;
}

function getCertification() { return certificationRequest('getCertification'); }
function submitCertification(application) { return certificationRequest('submitCertification', application); }

async function reviewRequest(action, data) {
  if (!wx.getStorageSync(SESSION_KEY)) {
    const error = new Error('请先到“我的”页面登录');
    error.code = 'UNAUTHENTICATED';
    throw error;
  }
  const version = sessionVersion;
  const result = await request(action, data, 'reviewResult');
  if (version !== sessionVersion) {
    const error = new Error('登录状态已变更，请重新登录');
    error.code = 'UNAUTHENTICATED';
    throw error;
  }
  if (!result) throw new Error('审核信息读取失败，请重试');
  return result;
}
function listCertifications(status, offset = 0) { return reviewRequest('listCertifications', { status, offset }); }
function getCertificationDetail(applicationId) { return reviewRequest('getCertificationDetail', { applicationId }); }
function getCertificationProof(applicationId, revision) { return reviewRequest('getCertificationProof', { applicationId, revision }); }
function reviewCertification(applicationId, revision, review) {
  return reviewRequest('reviewCertification', { applicationId, revision, review });
}

module.exports = { login, restore, updateProfile, logout, getAdminDashboard, getCertification, submitCertification,
  listCertifications, getCertificationDetail, getCertificationProof, reviewCertification };
