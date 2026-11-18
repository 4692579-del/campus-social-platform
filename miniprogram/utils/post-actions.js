const users = require('../services/user');
const square = require('../services/square');
const { postPreview } = require('./post-view');

const reasons = [
  { key: 'spam', label: '垃圾广告' }, { key: 'illegal', label: '违法违规' },
  { key: 'sexual', label: '色情低俗' }, { key: 'abuse', label: '辱骂骚扰' }, { key: 'other', label: '其他问题' },
];
const popup = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
function snapshot() { const user = users.getCachedUser(); return { id: user && user._id, version: users.getSessionVersion() }; }
function current(page, account) {
  const user = users.getCachedUser();
  return !page._unloaded && page._visible !== false && user && user._id === account.id && users.getSessionVersion() === account.version;
}
function find(page, id) {
  return square.cachedPost(id) || [...(page.data.posts || []), ...(page.data.ownPosts || [])].find(post => post._id === id);
}
function login(page) {
  if (users.getCachedUser()) return true;
  if (typeof page.requestLogin === 'function') page.requestLogin();
  else { page.applyUser(null); if (typeof page.openMenu === 'function') page.openMenu(); }
  return false;
}
function syncCommentsTabBar(page) {
  const bar = typeof page.getTabBar === 'function' && page.getTabBar();
  if (bar) bar.setData({ commentsOpen: Boolean(page.data.commentPostId) });
}
function sync(page, id, removed = false) {
  const latest = removed ? null : square.cachedPost(id), values = {};
  for (const key of ['posts', 'ownPosts']) if (Array.isArray(page.data[key])) {
    const found = page.data[key].some(post => post._id === id);
    values[key] = removed ? page.data[key].filter(post => post._id !== id) : page.data[key].map(post => post._id === id && latest ? postPreview(latest) : post);
    if (removed && found) {
      const offset = key === 'posts' ? 'feedOffset' : 'postsOffset';
      values[offset] = Math.max(0, (page.data[offset] || 0) - 1);
    }
  }
  if (removed) {
    if (page.data.commentPostId === id) values.commentPostId = '';
  }
  page.setData(values);
  if (removed) syncCommentsTabBar(page);
  if (removed && typeof page.updatePostCount === 'function') page.updatePostCount();
}
function paintLike(page, id, post) {
  if (!post) return;
  const values = {}, liked = Boolean(post.liked), count = Math.max(0, Number(post.likeCount) || 0);
  for (const key of ['posts', 'ownPosts']) if (Array.isArray(page.data[key])) {
    const index = page.data[key].findIndex(row => row._id === id);
    if (index < 0) continue;
    const row = page.data[key][index];
    if (Boolean(row.liked) !== liked) values[`${key}[${index}].liked`] = liked;
    if ((Number(row.likeCount) || 0) !== count) values[`${key}[${index}].likeCount`] = count;
  }
  if (Object.keys(values).length) page.setData(values);
}

module.exports = {
  openPost(event) {
    if (this._openingPost || this._unloaded || this._visible === false || this.data.menuOpen || this.data.postsMenuOpen || this.interactionBlocked && this.interactionBlocked()) return;
    const id = event.detail.id;
    if (!/^p_[a-f0-9]{40}$/.test(id || '')) return;
    this._openingPost = true;
    wx.navigateTo({ url: `/pages/square-detail/index?id=${encodeURIComponent(id)}`, fail: () => {
      this._openingPost = false;
      if (!this._unloaded && this._visible !== false) wx.showToast({ title: '动态打开失败，请重试', icon: 'none' });
    } });
  },
  startPostUpdates() {
    this.stopPostUpdates();
    if (typeof square.subscribePost !== 'function') return;
    this._stopPostUpdates = square.subscribePost(post => {
      if (current(this, snapshot()) && this.data.user && this.data.user._id === users.getCachedUser()._id) paintLike(this, post._id, post);
    });
  },
  stopPostUpdates() { if (this._stopPostUpdates) this._stopPostUpdates(); this._stopPostUpdates = null; },
  async reactPost(event) {
    if (this._unloaded || this._visible === false || this.data.menuOpen || this.data.postsMenuOpen || this.interactionBlocked && this.interactionBlocked()) return;
    const { id, kind } = event.detail;
    if (kind !== 'like' || !login(this)) return;
    const account = snapshot();
    if (!this.data.user || this.data.user._id !== account.id) return;
    const post = [...(this.data.posts || []), ...(this.data.ownPosts || [])].find(row => row._id === id);
    if (!post) return;
    this._likeClicks = this._likeClicks || new Map();
    let operation = this._likeClicks.get(id);
    if (!operation || operation.account.id !== account.id || operation.account.version !== account.version) {
      operation = { account, original: { ...post }, sequence: 0 };
      this._likeClicks.set(id, operation);
    }
    const sequence = ++operation.sequence, active = !Boolean(post.liked), sourcePost = { ...post };
    paintLike(this, id, { liked: active, likeCount: Math.max(0, (Number(post.likeCount) || 0) + (active ? 1 : -1)) });
    const latest = () => this._likeClicks.get(id) === operation && operation.sequence === sequence;
    try {
      const confirmed = await square.react(id, 'like', active, sourcePost);
      if (latest() && current(this, account)) paintLike(this, id, square.cachedPost(id) || confirmed);
    } catch (error) {
      if (!latest() || error.code === 'SESSION_CHANGED') return;
      if (current(this, account)) {
        paintLike(this, id, square.cachedPost(id) || operation.original);
        wx.showToast({ title: error.message || '点赞保存失败，请重试', icon: 'none' });
      } else if (!this._unloaded && this._visible !== false && !users.getCachedUser() && this.data.user && this.data.user._id === account.id) {
        paintLike(this, id, operation.original);
        this.applyUser(null);
        wx.showToast({ title: error.message || '请重新登录', icon: 'none' });
      }
    } finally { if (latest()) this._likeClicks.delete(id); }
  },
  openComments(event) {
    if (this._unloaded || this._visible === false || this.data.menuOpen || this.data.postsMenuOpen || this.interactionBlocked && this.interactionBlocked()) return;
    if (event.detail.id) { this.setData({ commentPostId: event.detail.id }); syncCommentsTabBar(this); }
  },
  closeComments() { if (this.data.commentPostId) this.setData({ commentPostId: '' }); syncCommentsTabBar(this); },
  commentLogin() { if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard(); this.closeComments(); login(this); },
  commentChanged(event) { sync(this, event.detail.id); },
  async managePost(event) {
    if (this._postMenuBusy || this._unloaded || this._visible === false || !login(this)) return;
    const id = event.detail.id, post = find(this, id), user = users.getCachedUser();
    if (!post) return;
    const own = user.accountId && post.author && post.author.accountId ? post.author.accountId === user.accountId :
      post.isOwn === true && this.data.user && this.data.user._id === user._id;
    const account = snapshot();
    this._postMenuBusy = true;
    try {
      const choice = await popup('showActionSheet', { itemList: [own ? '删除动态' : '举报动态'], itemColor: own ? '#d84a4a' : '#171b20' });
      if (!current(this, account) || choice.tapIndex !== 0) return;
      if (own) {
        const confirm = await popup('showModal', { title: '删除动态', content: '确定删除这条动态吗？删除后将不再展示。', confirmText: '删除', confirmColor: '#d84a4a' });
        if (!confirm.confirm || !current(this, account)) return;
        await square.deletePost(id);
        if (!current(this, account)) return;
        sync(this, id, true);
        wx.showToast({ title: '动态已删除' });
      } else {
        const selection = await popup('showActionSheet', { itemList: reasons.map(reason => reason.label) });
        if (!current(this, account) || !reasons[selection.tapIndex]) return;
        const reason = reasons[selection.tapIndex];
        const confirm = await popup('showModal', { title: '举报动态', content: `举报原因：${reason.label}。提交后将交由管理员处理。`, confirmText: '提交举报', confirmColor: '#4775fa' });
        if (!confirm.confirm || !current(this, account)) return;
        const result = await square.reportPost(id, reason.key);
        if (current(this, account)) wx.showToast({ title: result.alreadyReported ? '你已举报过这条动态' : '举报已提交', icon: 'none' });
      }
    } catch (error) {
      if (current(this, account) && !/cancel/.test(error.errMsg || '')) wx.showToast({ title: error.message || '操作失败，请重试', icon: 'none' });
    } finally { this._postMenuBusy = false; }
  },
};
