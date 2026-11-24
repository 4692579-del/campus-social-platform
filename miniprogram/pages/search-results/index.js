const users = require('../../services/user');
const square = require('../../services/square');
const postActions = require('../../utils/post-actions');
const gate = require('../../utils/login-gate');
const { nav, postPreview } = require('../../utils/post-view');
const queryTools = require('../../utils/search-query');
const kinds = ['square', 'campus', 'users'];

Page({
  ...gate, ...postActions,
  data: {
    keyword: '', accountId: '', user: null, tabIndex: 0,
    tabs: [{ key: 'square', label: '动态广场' }, { key: 'campus', label: '校园圈' }, { key: 'users', label: '用户' }],
    navTop: 28, navButtonHeight: 32, navHeight: 72, indicatorStyle: 'left:calc(16.6667% - 67rpx);width:134rpx;',
    posts: [], userRows: [], squareLoading: false, usersLoading: false, squareMoreLoading: false, usersMoreLoading: false,
    squareError: '', usersError: '', squareCursor: '', usersCursor: '', squareHasMore: false, usersHasMore: false,
    queryReady: false, queryError: '', needsLogin: false, loginSheetOpen: false, loginLoading: false, loginError: '',
    commentPostId: '', composerOpen: false, unfollowTarget: null, unfollowClosing: false, unfollowBusy: false,
  },
  onLoad(options) {
    nav(this); this._session = this.sessionKey(); this.setData({ user: users.getCachedUser() });
    try { this.applyQuery(queryTools.fromOptions(options)); }
    catch (error) { this.setData({ queryError: '搜索条件不正确，请重新输入' }); }
  },
  onShow() {
    this._visible = true; this._openingAuthor = false; this._openingPost = false; this._returning = false;
    this.syncViewer(); this.startPostUpdates(); this.loadActive();
  },
  onHide() {
    this._visible = false; this._requests = {}; this._viewVersion = (this._viewVersion || 0) + 1;
    this._authVersion = (this._authVersion || 0) + 1; this.stopPostUpdates();
    if (!this.commentsUsingNativeMedia()) this.closeComments();
    this.setData({ squareLoading: false, usersLoading: false, squareMoreLoading: false, usersMoreLoading: false, loginSheetOpen: false, loginLoading: false });
  },
  onUnload() { this._unloaded = true; this._visible = false; this._requests = {}; this.stopPostUpdates(); },
  onResize() { nav(this); },
  sessionKey() { return `${users.getCachedUser()?._id || 'guest'}:${users.getSessionVersion()}`; },
  syncViewer() {
    const key = this.sessionKey();
    if (key !== this._session) {
      this._session = key; this._requests = {}; this._viewVersion = (this._viewVersion || 0) + 1;
      this.closeComments(); this.closeUnfollowPrompt(true);
      this.setData({ user: users.getCachedUser(), posts: [], userRows: [], composerOpen: false, needsLogin: false });
    } else this.setData({ user: users.getCachedUser() });
    const visible = square.visiblePosts?.(this.data.posts);
    if (visible && (visible.length !== this.data.posts.length || visible.some((row, index) => row !== this.data.posts[index]))) this.setData({ posts: visible });
    this.prefillResults();
  },
  // 搜索页没有个人统计展示，不额外请求当前账号的关注总数。
  refreshFollowPresentation() {},
  interactionBlocked() { return Boolean(this.data.loginSheetOpen || this.data.loginLoading || this.data.composerOpen || this.data.unfollowTarget); },
  onInput(event) { this.setData({ keyword: event.detail.value }); },
  removeAuthor() {
    this.setData({ accountId: '' });
    if (this.data.keyword.trim()) this.search();
    else { this._query = null; this._queryVersion = (this._queryVersion || 0) + 1; this._requests = {}; this.setData({ queryReady: false, posts: [], userRows: [], queryError: '', squareError: '', usersError: '', squareLoading: false, usersLoading: false, squareMoreLoading: false, usersMoreLoading: false, squareHasMore: false, usersHasMore: false, squareCursor: '', usersCursor: '', needsLogin: false }); }
  },
  search() {
    if (this.interactionBlocked()) return;
    try {
      const value = queryTools.normalize(this.data);
      if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
      const same = this._query && JSON.stringify(this._query) === JSON.stringify(value);
      if (!same) this.applyQuery(value, this.data.tabIndex); this.loadActive(true);
    } catch (error) { wx.showToast({ title: error.message, icon: 'none' }); }
  },
  applyQuery(value, preferredTab) {
    this._query = value; this._queryVersion = (this._queryVersion || 0) + 1; this._requests = {};
    this.setData({ ...value, queryReady: true, queryError: '', tabIndex: !value.keyword && value.accountId ? 2 : Number.isInteger(preferredTab) ? preferredTab : 0,
      posts: [], userRows: [], squareError: '', usersError: '', squareCursor: '', usersCursor: '', squareHasMore: false, usersHasMore: false,
      squareLoading: false, usersLoading: false, squareMoreLoading: false, usersMoreLoading: false, needsLogin: false });
    this.updateIndicator(); this.prefillResults();
  },
  updateIndicator() {
    const width = this.data.tabIndex === 2 ? 70 : 134;
    this.setData({ indicatorStyle: `left:calc(${(this.data.tabIndex + .5) * 100 / 3}% - ${width / 2}rpx);width:${width}rpx;` });
  },
  selectTab(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !kinds[index] || this.interactionBlocked() || this.data.commentPostId || index === this.data.tabIndex) return;
    this.setData({ tabIndex: index }); this.updateIndicator(); this.loadActive();
  },
  prefillResults() {
    if (!this._query) return;
    for (const kind of ['square', 'users']) {
      const cached = square.cachedSearch({ ...this._query, kind });
      if (cached) this.showResults(kind, cached);
    }
  },
  showResults(kind, result) {
    const key = kind === 'square' ? 'posts' : 'userRows', rows = kind === 'square' ? result.items.map(postPreview) : result.items, patch = {};
    if (JSON.stringify(rows) !== JSON.stringify(this.data[key])) patch[key] = rows;
    if (this.data[kind + 'HasMore'] !== result.hasMore) patch[kind + 'HasMore'] = result.hasMore;
    if (this.data[kind + 'Cursor'] !== result.nextCursor) patch[kind + 'Cursor'] = result.nextCursor;
    if (Object.keys(patch).length) this.setData(patch);
  },
  loadActive(force = false) { const kind = kinds[this.data.tabIndex]; if (kind !== 'campus') return this.loadResults(kind, false, force); },
  loadResults(kind, append = false, force = false) {
    if (!this._query || this._unloaded || this._visible === false || !['square', 'users'].includes(kind)) return Promise.resolve();
    if ((kind === 'users' || this._query.accountId) && !users.getCachedUser()) {
      this.setData({ [kind + 'Error']: '登录后查看搜索结果', needsLogin: true }); return Promise.resolve();
    }
    const requests = this._requests || (this._requests = {});
    if (requests[kind]) return requests[kind].promise;
    const query = this._query, request = { queryVersion: this._queryVersion, session: this.sessionKey(), view: this._viewVersion || 0 }; requests[kind] = request;
    const current = () => !this._unloaded && this._visible !== false && this._requests === requests && requests[kind] === request && this._queryVersion === request.queryVersion && this.sessionKey() === request.session && (this._viewVersion || 0) === request.view;
    const cached = square.cachedSearch({ ...query, kind }); if (cached) this.showResults(kind, cached);
    const rows = kind === 'square' ? this.data.posts : this.data.userRows;
    this.setData({ [kind + 'Loading']: !rows.length, [kind + 'MoreLoading']: append, [kind + 'Error']: '', needsLogin: false });
    request.promise = square.searchContent({ ...query, kind, force, cursor: append ? this.data[kind + 'Cursor'] : '' }).then(result => { if (current()) this.showResults(kind, result); })
      .catch(error => {
        if (current() && error.code !== 'SESSION_CHANGED') this.setData({ [kind + 'Error']: error.message || '搜索失败，请重试', needsLogin: !users.getCachedUser() });
        else if (!this._unloaded && this._visible !== false && this._requests === requests && this._queryVersion === request.queryVersion && this.sessionKey() !== request.session) {
          this.syncViewer(); this.setData({ squareLoading: false, usersLoading: false, squareMoreLoading: false, usersMoreLoading: false }); this.loadActive(true);
        }
      })
      .finally(() => { if (current()) { requests[kind] = null; this.setData({ [kind + 'Loading']: false, [kind + 'MoreLoading']: false }); } });
    return request.promise;
  },
  loadMore(event) { const kind = event.currentTarget.dataset.kind; if (this.data[kind + 'HasMore']) return this.loadResults(kind, true); },
  retry() { return this.loadActive(true); },
  openUser(event) {
    const user = this.data.userRows.find(row => row.accountId === event.currentTarget.dataset.id);
    if (user) this.viewAuthorProfile({ detail: { author: { ...user, verified: user.isVerified } } });
  },
  onLoggedIn() { this.syncViewer(); return this.loadActive(true); },
  applyUser() { this.syncViewer(); },
  closeComposer(event) {
    this.setData({ composerOpen: false, composerQuote: null, composerQuoteOwnerId: '' });
    if (event.detail.published) { square.consumePublication(); this.loadActive(true); }
  },
  back() {
    if (this._returning) return; this._returning = true;
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/search/index', fail: () => { this._returning = false; } }) });
  },
});
