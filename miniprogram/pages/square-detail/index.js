const users = require('../../services/user');
const square = require('../../services/square');
const gate = require('../../utils/login-gate');
const postActions = require('../../utils/post-actions');
const { nav, postView } = require('../../utils/post-view');

Page({
  ...gate,
  ...postActions,
  data: {
    user: null, postId: '', posts: [], commentMounts: [], loading: false, error: '', unavailable: false,
    navTop: 28, navButtonHeight: 32, navHeight: 72,
    loginSheetOpen: false, loginLoading: false, loginError: '',
  },
  onLoad(options = {}) {
    nav(this);
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    this._returnPage = pages[pages.length - 2];
    if (!/^p_[a-f0-9]{40}$/.test(options.id || '')) {
      this.setData({ unavailable: true });
      return;
    }
    this.setData({ postId: options.id });
    this.syncViewer();
  },
  onShow() {
    this._visible = true;
    this.syncViewer();
    this.startPostUpdates();
    return this.loadPost();
  },
  onHide() {
    this._visible = false;
    this.stopPostUpdates();
    this._request = null;
    this._loadSequence = (this._loadSequence || 0) + 1;
    this._authVersion = (this._authVersion || 0) + 1;
    this.setData({ loading: false, loginSheetOpen: false, loginLoading: false });
  },
  onUnload() {
    this._unloaded = true;
    this._visible = false;
    this.stopPostUpdates();
    this.prepareReturn();
  },
  onResize() { nav(this); },
  syncViewer() {
    const version = users.getSessionVersion();
    const changed = this._sessionVersion !== version;
    if (changed) {
      this._sessionVersion = version;
      this._request = null;
      this._loadSequence = (this._loadSequence || 0) + 1;
      // 换账号才重建评论区，避免旧账号的私有折叠状态或草稿被继续展示。
      this.setData({ user: users.getCachedUser(), posts: [], commentMounts: [{ key: version }], error: '', loading: Boolean(this.data.postId) });
    } else this.setData({ user: users.getCachedUser() });
    const cached = this.data.postId && square.cachedPost(this.data.postId);
    if (cached) this.showPost(cached);
    return changed;
  },
  showPost(post) {
    this.setData({ posts: [postView({ ...post, content: post.fullContent || post.content })], unavailable: false, loading: false });
  },
  loadPost(force = false) {
    if (!this.data.postId || this._unloaded || this._visible === false) return Promise.resolve();
    if (this._request) return this._request;
    const sequence = this._loadSequence = (this._loadSequence || 0) + 1;
    const version = users.getSessionVersion();
    const current = () => !this._unloaded && this._visible !== false && sequence === this._loadSequence && version === users.getSessionVersion();
    this.setData({ loading: !this.data.posts.length, error: '' });
    const request = Promise.resolve().then(() => current() ? square.detail(this.data.postId, force) : null).then(post => {
      if (current()) this.showPost(post);
    }).catch(error => {
      if (!current()) {
        if (!this._unloaded && this._visible !== false && version !== users.getSessionVersion() && this.syncViewer()) this.loadPost();
        return;
      }
      if (error.code === 'POST_NOT_FOUND') this.setData({ posts: [], unavailable: true });
      else this.setData({ error: error.message || '动态读取失败，请重试' });
    }).finally(() => {
      if (current()) this.setData({ loading: false });
      if (this._request === request) this._request = null;
    });
    this._request = request;
    return request;
  },
  retry() { return this.loadPost(true); },
  interactionBlocked() { return this.data.loginSheetOpen || this.data.loginLoading; },
  requestLogin() { this.syncViewer(); gate.requestLogin.call(this); },
  onLoggedIn() { this.syncViewer(); return this.loadPost(); },
  cancelLogin() { gate.cancelLogin.call(this); this.syncViewer(); return this.loadPost(); },
  applyUser() { this.syncViewer(); return this.loadPost(); },
  commentLogin() { this.requestLogin(); },
  onCommentsClose() { if (this.syncViewer()) return this.loadPost(); },
  focusComments() {
    if (this.interactionBlocked()) return;
    const comments = this.selectComponent('#detail-comments');
    if (comments) comments.focusComposer();
  },
  prepareReturn() {
    if (this._returnPrepared) return;
    this._returnPrepared = true;
    if (this._returnPage && typeof this._returnPage.prepareMenuReturn === 'function') this._returnPage.prepareMenuReturn();
  },
  back() {
    if (this._returning) return;
    this._returning = true;
    this.prepareReturn();
    const leave = () => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index', fail: () => { this._returning = false; } }) });
    if (typeof wx.nextTick === 'function') wx.nextTick(leave);
    else leave();
  },
});
