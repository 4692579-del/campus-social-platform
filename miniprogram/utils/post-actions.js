const users = require('../services/user');
const square = require('../services/square');
const { postPreview, token } = require('./post-view');

const reasons = [
  { key: 'spam', label: '垃圾广告' }, { key: 'illegal', label: '违法违规' },
  { key: 'sexual', label: '色情低俗' }, { key: 'abuse', label: '辱骂骚扰' }, { key: 'other', label: '其他问题' },
];
const popup = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
function snapshot() { const user = users.getCachedUser(); return { id: user && user._id, version: users.getSessionVersion() }; }
function current(page, account, visible = true) {
  const user = users.getCachedUser();
  return !page._unloaded && (!visible || page._visible !== false) && user && user._id === account.id && users.getSessionVersion() === account.version;
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
    if (page._sharedPostId === id) { page._sharedPostId = ''; page._sharedPost = null; }
  }
  page.setData(values);
  if (removed) syncCommentsTabBar(page);
}

module.exports = {
  openComments(event) {
    if (this._unloaded || this._visible === false || this.data.menuOpen || this.data.postsMenuOpen || this.interactionBlocked && this.interactionBlocked()) return;
    if (event.detail.id) { this.setData({ commentPostId: event.detail.id }); syncCommentsTabBar(this); }
  },
  closeComments() { if (this.data.commentPostId) this.setData({ commentPostId: '' }); syncCommentsTabBar(this); },
  commentLogin() { if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard(); this.closeComments(); login(this); },
  commentChanged(event) { sync(this, event.detail.id); },
  prepareShare() { login(this); },
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
  buildPostShare(options, fallbackId) {
    const id = options && options.target && options.target.dataset.id || fallbackId;
    const post = id && find(this, id);
    if (post && users.getCachedUser()) {
      const account = snapshot();
      // 此事件确认的是发起分享，不代表已送达；不使用已废弃的分享成功回调。
      square.recordShare(id, token()).then(() => {
        if (current(this, account, false)) sync(this, id);
      }).catch(error => {
        if (current(this, account)) wx.showToast({ title: error.message || '分享计数暂未更新', icon: 'none' });
      });
    }
    return id ? { title: post ? post.content.slice(0, 40) : '萃 · 动态广场', path: `/pages/home/index?postId=${encodeURIComponent(id)}` } :
      { title: '萃 · 动态广场', path: '/pages/home/index' };
  },
};
