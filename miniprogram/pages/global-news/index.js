const users = require('../../services/user');
const square = require('../../services/square');
const gate = require('../../utils/login-gate');
const postActions = require('../../utils/post-actions');
const homeRefresh = require('../../utils/home-refresh');
const { nav, postView } = require('../../utils/post-view');
const { THRESHOLD } = require('../../utils/cui-refresh-drawing');

Page({
  ...gate,
  ...postActions,
  ...homeRefresh,
  data: {
    navTop: 28, navButtonHeight: 32, navHeight: 72, language: 'en', user: null,
    posts: [], feedError: '', feedWarning: '', feedLoading: true, feedMoreLoading: false, feedHasMore: false,
    skeletons: [1, 2, 3], commentPostId: '', loginSheetOpen: false, loginLoading: false, loginError: '',
    brandRefreshPhase: 'idle', nativeRefreshing: false, pullRefreshing: false, refreshThreshold: THRESHOLD,
  },
  onLoad(options = {}) {
    nav(this);
    if (options.language === 'zh') this.setData({ language: 'zh' });
    this.syncViewer();
  },
  onShow() {
    this._visible = true;
    this._openingPost = false;
    const changed = this.syncViewer();
    this._stopPostUpdates = square.subscribePost(post => {
      if (!this._visible || this._sessionVersion !== users.getSessionVersion() || post.contentType !== 'news') return;
      const index = this.data.posts.findIndex(item => item._id === post._id);
      if (index >= 0) {
        const patch = {};
        for (const field of ['title', 'content', 'liked', 'likeCount', 'replyCount']) {
          if (this.data.posts[index][field] !== post[field]) patch[`posts[${index}].${field}`] = post[field];
        }
        if (JSON.stringify(this.data.posts[index].images) !== JSON.stringify(post.images)) patch[`posts[${index}].images`] = post.images;
        if (Object.keys(patch).length) this.setData(patch);
      }
    });
    if (changed || !this._loaded) return this.loadFeed();
    const cached = square.cachedNews(this.data.language);
    if (cached) this.showNews(cached);
  },
  onHide() {
    this._visible = false;
    this._authVersion = (this._authVersion || 0) + 1;
    this._newsRequest = null;
    this.stopPostUpdates();
    this.stopHomeRefresh();
    this.setData({ feedMoreLoading: false, loginLoading: false, loginSheetOpen: false,
      ...(this.commentsUsingNativeMedia() ? {} : { commentPostId: '' }) });
  },
  onUnload() { this.onHide(); this._unloaded = true; },
  onResize() { this.closePostPopover(true); nav(this); },
  syncViewer() {
    const version = users.getSessionVersion();
    if (version === this._sessionVersion) return false;
    this.closePostPopover(true);
    this._sessionVersion = version;
    this._newsRequest = null;
    this._failedAppend = false;
    this._loaded = false;
    this.stopHomeRefresh();
    const cached = square.cachedNews(this.data.language);
    this.setData({ user: users.getCachedUser(), posts: [], feedLoading: !cached, feedError: '', feedWarning: '',
      feedHasMore: false, feedMoreLoading: false, commentPostId: '' });
    if (cached) this.showNews(cached);
    return true;
  },
  showNews(result) {
    this._page = result;
    this.setData({ posts: result.items.map(postView), feedHasMore: result.hasMore, feedLoading: false,
      feedWarning: result.stale ? result.warning || '更新暂不可用，显示上次获取的新闻' : '', feedError: '' });
  },
  loadFeed(force = false, append = false) {
    if (this._unloaded || this._visible === false) return;
    if (this._newsRequest) {
      if (force && this._newsRequest.append) {
        const version = users.getSessionVersion();
        return this._newsRequest.promise.then(() => {
          if (this._visible && !this._unloaded && version === users.getSessionVersion()) return this.loadFeed(true);
        });
      }
      return this._newsRequest.promise;
    }
    const ticket = this._newsRequest = { append }, language = this.data.language, version = users.getSessionVersion();
    const current = () => this._newsRequest === ticket && this._visible !== false && !this._unloaded && version === users.getSessionVersion();
    this.setData({ feedLoading: !this.data.posts.length && !append, feedMoreLoading: append, feedError: '' });
    ticket.promise = square.listNews({ language, force, ...(append ? { offset: this._page.nextOffset, anchor: this._page.anchor } : {}) })
      .then(result => { if (current() && result) { this._loaded = true; this.showNews(result); } })
      .catch(error => {
        if (current()) {
          this._failedAppend = append && error.code !== 'NEWS_INVALID_PAGE';
          this.setData({ feedError: error.message || '新闻暂时无法读取，请重试' });
        }
      })
      .finally(() => {
        if (this._newsRequest !== ticket) return;
        this._newsRequest = null;
        if (this._visible === false || this._unloaded) return;
        if (version !== users.getSessionVersion()) { this.syncViewer(); this.loadFeed(); }
        else this.setData({ feedLoading: false, feedMoreLoading: false });
      });
    return ticket.promise;
  },
  retryFeed() { return this._failedAppend && this.data.feedHasMore ? this.loadFeed(false, true) : this.loadFeed(true); },
  loadMoreFeed() {
    if (this.data.feedHasMore && !this.data.pullRefreshing && !this.data.feedError && !this.interactionBlocked()) return this.loadFeed(false, true);
  },
  canRefreshFeed() { return true; },
  stopBrandBounce() {},
  interactionBlocked() { return Boolean(this.data.commentPostId || this.data.loginSheetOpen || this.data.loginLoading); },
  openComments(event) { this.stopHomeRefresh(); postActions.openComments.call(this, event); },
  requestLogin() { this.stopHomeRefresh(); gate.requestLogin.call(this); },
  onLoggedIn() { this.syncViewer(); return this.loadFeed(true); },
  cancelLogin() { gate.cancelLogin.call(this); this.syncViewer(); return this.loadFeed(); },
  applyUser() { this.syncViewer(); return this.loadFeed(); },
  back() { wx.navigateBack(); },
});
