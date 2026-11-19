// 小程序只通过云函数访问 users，不直接读写用户集合。
const SESSION_KEY = 'campus.session.v1';
let pendingLogin = null;
let pendingRestore = null;
let sessionVersion = 0;
const CACHE_MAX_AGE = 60 * 1000;
let profileCheckedAt = 0;
let accountInfoCache = null;
let certificationCache = null;
let pendingAccountInfo = null;
let pendingCertification = null;
let dataVersion = 0;
let aiUsageCache = null, pendingAIUsage = null, aiUsageRevision = 0;

function getCachedAIUsage() {
  const user = getCachedUser();
  return user && aiUsageCache && aiUsageCache.owner === user._id && Date.parse(aiUsageCache.value.resetsAt) > Date.now() ? aiUsageCache.value : null;
}
function invalidateAIUsage() {
  aiUsageRevision++;
  if (aiUsageCache) aiUsageCache.time = 0;
  pendingAIUsage = null;
}
async function getAIUsage({ force = false } = {}) {
  const user = getCachedUser();
  if (!user) throw Object.assign(new Error('登录后可查看使用额度'), { code: 'UNAUTHENTICATED' });
  const cached = getCachedAIUsage();
  if (!force && cached && Date.now() - aiUsageCache.time < 15000) return cached;
  if (pendingAIUsage) return pendingAIUsage;
  const version = sessionVersion, revision = aiUsageRevision, owner = user._id;
  const promise = request('getAIUsage', {}, 'aiUsage').then(value => {
    if (version !== sessionVersion || !getCachedUser() || getCachedUser()._id !== owner) throw new Error('登录状态已变更，请重新登录');
    if (revision !== aiUsageRevision) return getAIUsage({ force: false });
    if (!value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100 || !Number.isFinite(Date.parse(value.resetsAt))) throw new Error('额度信息读取失败，请重试');
    aiUsageCache = { owner, value, time: Date.now() };
    return value;
  }).finally(() => { if (pendingAIUsage === promise) pendingAIUsage = null; });
  pendingAIUsage = promise;
  return promise;
}

// 只在本次运行内复用云端返回的数据，不把本地缓存当作操作权限。
function getCachedUser() {
  return wx.getStorageSync(SESSION_KEY) ? getApp().globalData.currentUser || null : null;
}
function getCachedAccountInfo() {
  const user = getCachedUser();
  return user && accountInfoCache && accountInfoCache.value.user._id === user._id
    ? { ...accountInfoCache.value, user } : null;
}
function getCachedCertification() {
  const user = getCachedUser();
  return user && certificationCache && certificationCache.value.user._id === user._id
    ? { ...certificationCache.value, user } : null;
}
function fresh(time) { return Date.now() - time < CACHE_MAX_AGE; }

async function request(action, extra, resultKey = 'user') {
  const version = sessionVersion;
  let response;
  try {
    response = await wx.cloud.callFunction({ name: 'userService', data: { action, ...extra } });
  } catch (error) {
    console.error('用户服务调用失败', error);
    throw new Error('连接失败，请稍后重试');
  }
  const result = response.result;
  if (!result || !result.success) {
    if (version === sessionVersion && result && ['ACCOUNT_DISABLED', 'NOT_REGISTERED', 'UNAUTHENTICATED', 'INVALID_ROLE'].includes(result.code)) logout();
    const error = new Error((result && result.message) || '服务暂时不可用，请稍后重试');
    error.code = (result && result.code) || 'SERVICE_ERROR';
    throw error;
  }
  return result[resultKey];
}

function remember(user) {
  if ((getApp().globalData.currentUser || {})._id !== (user || {})._id) { aiUsageCache = null; invalidateAIUsage(); }
  if (JSON.stringify(getApp().globalData.currentUser) !== JSON.stringify(user)) {
    dataVersion += 1;
    accountInfoCache = null;
    certificationCache = null;
  }
  profileCheckedAt = user ? Date.now() : 0;
  getApp().globalData.currentUser = user;
  if (user) wx.setStorageSync(SESSION_KEY, true);
  else wx.removeStorageSync(SESSION_KEY);
  return user;
}

function login() {
  if (pendingLogin) return pendingLogin;
  const version = sessionVersion;
  const promise = request('login').then(user => {
    if (version !== sessionVersion) throw new Error('登录已取消，请重试');
    dataVersion += 1;
    return remember(user);
  }).finally(() => { if (pendingLogin === promise) pendingLogin = null; });
  pendingLogin = promise;
  return pendingLogin;
}

function restore({ force = true } = {}) {
  if (!wx.getStorageSync(SESSION_KEY)) return Promise.resolve(null);
  const cached = getCachedUser();
  if (!force && cached && fresh(profileCheckedAt)) return Promise.resolve(cached);
  if (pendingRestore) return pendingRestore;
  const version = sessionVersion;
  const revision = dataVersion;
  const promise = request('getProfile').then(user => {
    if (version !== sessionVersion) return null;
    if (revision !== dataVersion) return getCachedUser();
    return remember(user);
  }).finally(() => { if (pendingRestore === promise) pendingRestore = null; });
  pendingRestore = promise;
  return pendingRestore;
}

async function updateProfile(profile) {
  const version = sessionVersion;
  const user = await request('updateProfile', { profile });
  if (version !== sessionVersion) throw new Error('登录状态已变更，请重新登录');
  dataVersion += 1;
  return remember(user);
}

function logout() {
  sessionVersion += 1;
  dataVersion += 1;
  pendingLogin = null;
  pendingRestore = null;
  pendingAccountInfo = null;
  pendingCertification = null;
  aiUsageCache = null;
  invalidateAIUsage();
  remember(null);
}

async function updateCover(coverFileID) {
  if (!wx.getStorageSync(SESSION_KEY)) {
    const error = new Error('请先登录后设置封面');
    error.code = 'UNAUTHENTICATED';
    throw error;
  }
  const version = sessionVersion;
  const user = await request('updateCover', { coverFileID });
  if (version !== sessionVersion) throw new Error('登录状态已变更，请重新登录');
  dataVersion += 1;
  return remember(user);
}

// 这只是服务入口，访问权限必须由云函数检查，不能由客户端决定。
function getAdminDashboard() {
  return request('getAdminDashboard', {}, 'dashboard');
}

async function getAccountInfo({ force = true } = {}) {
  if (!wx.getStorageSync(SESSION_KEY)) {
    const error = new Error('请先到“我的”页面登录');
    error.code = 'UNAUTHENTICATED';
    throw error;
  }
  const cached = getCachedAccountInfo();
  if (!force && cached && fresh(accountInfoCache.time)) return cached;
  if (pendingAccountInfo) return pendingAccountInfo;
  const version = sessionVersion;
  const revision = dataVersion;
  const promise = request('getAccountInfo', {}, 'accountInfo').then(info => {
    if (version !== sessionVersion) throw new Error('登录状态已变更，请重新登录');
    if (!info || !info.user || !info.nicknameHistory) throw new Error('账号信息读取失败，请重试');
    if (revision !== dataVersion) throw new Error('账号资料已更新，请重新读取');
    remember(info.user);
    accountInfoCache = { value: info, time: Date.now() };
    return info;
  }).finally(() => { if (pendingAccountInfo === promise) pendingAccountInfo = null; });
  pendingAccountInfo = promise;
  return promise;
}

async function findUserByAccountId(accountId) {
  if (!wx.getStorageSync(SESSION_KEY)) throw new Error('请先登录');
  const version = sessionVersion;
  const result = await request('findUserByAccountId', { accountId }, 'searchResult');
  if (version !== sessionVersion) throw new Error('登录状态已变更，请重新登录');
  return result;
}

async function certificationRequest(action, application) {
  const version = sessionVersion;
  const revision = dataVersion;
  const result = await request(action, application ? { application } : {}, 'certification');
  if (version !== sessionVersion) throw new Error('登录状态已变更，请重新登录');
  if (!result || !result.user) throw new Error('认证信息读取失败，请重试');
  if (action === 'getCertification' && revision !== dataVersion) throw new Error('认证资料已更新，请重新读取');
  if (action !== 'getCertification') dataVersion += 1;
  remember(result.user);
  certificationCache = { value: result, time: Date.now() };
  return result;
}

function getCertification({ force = true } = {}) {
  const cached = getCachedCertification();
  if (!force && cached && fresh(certificationCache.time)) return Promise.resolve(cached);
  if (pendingCertification) return pendingCertification;
  const promise = certificationRequest('getCertification').finally(() => {
    if (pendingCertification === promise) pendingCertification = null;
  });
  pendingCertification = promise;
  return promise;
}
function submitCertification(application) { return certificationRequest('submitCertification', application); }
function withdrawCertification(applicationId, revision, status) {
  if (!wx.getStorageSync(SESSION_KEY)) {
    const error = new Error('请先到“我的”页面登录');
    error.code = 'UNAUTHENTICATED';
    return Promise.reject(error);
  }
  return certificationRequest('withdrawCertification', { applicationId, revision, status });
}

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

module.exports = { login, restore, getSessionVersion: () => sessionVersion, getCachedUser, getCachedAIUsage, getAIUsage, invalidateAIUsage, getCachedAccountInfo, getCachedCertification, updateProfile, updateCover, logout, getAccountInfo, findUserByAccountId, getAdminDashboard, getCertification, submitCertification, withdrawCertification,
  listCertifications, getCertificationDetail, getCertificationProof, reviewCertification };
