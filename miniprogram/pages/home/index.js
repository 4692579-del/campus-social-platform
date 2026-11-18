const userService = require('../../services/user');
const { describeUser } = require('../../utils/user-role');
const { menuItems, utilityMenuItems } = require('../../utils/account-menu');
const square = require('../../services/square');
const { postPreview } = require('../../utils/post-view');
const postActions = require('../../utils/post-actions');

Page({
  ...postActions,
  data: {
    user: null, identity: describeUser(null), avatarFailed: false,
    loading: false, error: '', accountHint: '未登录', menuOpen: false, confirmingLogout: false,
    authChecking: false, loginSheetOpen: false, menuInstant: false,
    navTop: 28, navButtonHeight: 32, navHeight: 72,
    followerCount: 0, followingCount: 0, menuItems, utilityMenuItems,
    activeTab: 'square', commentPostId: '',
    posts: [], feedLoading: false, feedError: '', feedHasMore: false, feedOffset: 0, feedMoreLoading: false, pullRefreshing: false, skeletons: [1, 2, 3],
    tabs: [
      { key: 'square', label: '动态广场' },
      { key: 'following', label: '关注' },
      { key: 'campus', label: '校园圈' },
    ],
  },
  onLoad(options = {}) {
    this._sharedPostId = /^p_[a-f0-9]{40}$/.test(options.postId || '') ? options.postId : '';
    try {
      const info = wx.getWindowInfo();
      const capsule = wx.getMenuButtonBoundingClientRect();
      const status = info.statusBarHeight || 0;
      const valid = capsule && capsule.height > 0 && capsule.top >= status;
      const navTop = valid ? capsule.top : status + 8;
      const navButtonHeight = valid ? capsule.height : 32;
      this.setData({ navTop, navButtonHeight, navHeight: navTop + navButtonHeight + 8 });
    } catch (error) { /* 旧客户端使用默认的顶部留白。 */ }
    const cached = userService.getCachedUser();
    if (cached) this.applyUser(cached);
    const feed = square.cachedFeed();
    if (feed) this.showFeed(feed);
    else if (this._sharedPostId && square.cachedPost(this._sharedPostId)) this.showFeed({ items: [], hasMore: true, nextOffset: 0 });
  },
  onShow() {
    this._visible = true;
    this._viewVersion = (this._viewVersion || 0) + 1;
    this._menuNavigating = false;
    // 返回时直接呈现首页，离开时保留的菜单不再播放收起动画。
    this.setData({ menuOpen: false, menuInstant: true });
    if (square.consumePublication()) this.setData({ activeTab: 'square' });
    this.syncNavigation();
    this._openingComposer = false;
    const account = this.refreshUser(false);
    if (this.data.activeTab === 'square') this.loadFeed(false);
    if (this._sharedPostId) this.loadSharedPost();
    return account;
  },
  onHide() {
    this.closeComments();
    this.stopHomeRefresh();
    this._visible = false;
    this._refreshing = false;
    this._feedBusy = false;
    this._feedPromise = null;
    this._sharedRequest = null;
    this._viewVersion = (this._viewVersion || 0) + 1;
    this._logoutVersion = (this._logoutVersion || 0) + 1;
    if (!this._menuNavigating) this.closeMenu();
    this._openAfterRestore = false;
    this.setData({ loading: false, confirmingLogout: false, authChecking: false, loginSheetOpen: false });
    this.setAuthBlocked(false);
  },
  onUnload() {
    this.closeComments();
    this.stopHomeRefresh();
    this._unloaded = true;
    this._visible = false;
    this._viewVersion = (this._viewVersion || 0) + 1;
    this.setMenuTabBarOpen(false);
    this.setAuthBlocked(false);
  },
  onReady() { this.syncNavigation(); },
  syncNavigation() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 0, menuOpen: this.data.menuOpen, menuInstant: this.data.menuInstant, authBlocked: this.interactionBlocked(), commentsOpen: Boolean(this.data.commentPostId) });
  },
  setMenuTabBarOpen(open) {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) tabBar.setData({ menuOpen: open, menuInstant: this.data.menuInstant });
  },
  interactionBlocked() { return Boolean(this.data.authChecking || this.data.loginSheetOpen); },
  setAuthBlocked(blocked) {
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (bar) bar.setData({ authBlocked: Boolean(blocked) });
  },
  currentView(version) {
    return !this._unloaded && this._visible !== false && version === (this._viewVersion || 0);
  },
  async refreshUser(force = true) {
    if (this._refreshing || this.data.loading) return;
    this._refreshing = true;
    const version = this._viewVersion || 0;
    const cached = userService.getCachedUser();
    if (cached) this.applyUser(cached);
    else if (this.data.user) this.applyUser(null);
    this.setData({ loading: !cached, error: '', accountHint: cached ? '' : '正在读取账号…' });
    try {
      const user = await userService.restore({ force: force !== false });
      if (this.currentView(version)) this.applyUser(user);
    } catch (error) {
      if (this.currentView(version) && (!cached || !userService.getCachedUser())) this.applyUser(null, error.message || '账号信息读取失败');
    } finally {
      if (this.currentView(version)) {
        this._refreshing = false;
        this.setData({ loading: false });
        if (this._openAfterRestore) { this._openAfterRestore = false; this.openMenu(); }
      }
    }
  },
  applyUser(user, error = '') {
    const previousId = this.data.user && this.data.user._id;
    const accountChanged = Boolean(previousId && previousId !== (user && user._id));
    if (accountChanged) { this.closeComments(); this._sharedPost = null; this._sharedRequest = null; }
    this.setData({ user, identity: describeUser(user), avatarFailed: false, error,
      ...(accountChanged ? { menuOpen: false } : {}),
      authChecking: false, loginSheetOpen: user ? false : this.data.loginSheetOpen,
      accountHint: error ? '账号信息暂不可用' : '未登录', followerCount: 0, followingCount: 0 });
    if (accountChanged) this.setMenuTabBarOpen(false);
    this.setAuthBlocked(this.interactionBlocked());
    if (previousId !== (user && user._id) && this._visible === true) {
      this._feedEpoch = (this._feedEpoch || 0) + 1;
      this._feedBusy = false;
      this.setData({ posts: this.data.posts.map(post => ({ ...post, liked: false, reposted: false })) });
      if (this.data.activeTab === 'square') this.loadFeed(false);
      if (this._sharedPostId) this.loadSharedPost();
    }
  },
  onAvatarError() { this.setData({ avatarFailed: true }); },
  openMenu() {
    if (this._unloaded || this._visible === false || this.data.menuOpen) return;
    if (this.data.loginSheetOpen) return;
    if (this.data.loading) {
      this._openAfterRestore = true;
      this.setData({ authChecking: true });
      this.setAuthBlocked(true);
      return;
    }
    this.setData({ authChecking: false });
    if (!this.data.user) {
      this.setData({ loginSheetOpen: true });
      this.setAuthBlocked(true);
      return;
    }
    this.setAuthBlocked(false);
    this.setData({ menuOpen: true, menuInstant: false });
    this.setMenuTabBarOpen(true);
  },
  closeMenu() {
    if (!this.data.menuOpen || this._menuNavigating) return;
    this.setData({ menuOpen: false });
    this.setMenuTabBarOpen(false);
  },
  stopMenuEvent() {},
  async login() {
    if (!this.data.loginSheetOpen || this.data.loading) return;
    const version = this._viewVersion || 0;
    this.setData({ loading: true, error: '' });
    try {
      const user = await userService.login();
      if (!this.currentView(version)) return;
      if (!user || !user._id) throw new Error('登录信息读取失败，请重试');
      this.applyUser(user);
      this.setData({ loading: false });
      wx.showToast({ title: '登录成功' });
    } catch (error) {
      if (this.currentView(version)) this.setData({ loginSheetOpen: true, error: error.message || '登录失败，请重试' });
    } finally {
      if (this.currentView(version)) this.setData({ loading: false });
    }
  },
  cancelLogin() {
    if (!this.data.loginSheetOpen) return;
    userService.logout();
    this._viewVersion = (this._viewVersion || 0) + 1;
    this._openAfterRestore = false;
    this.setData({ loading: false, loginSheetOpen: false, authChecking: false, error: '' });
    this.setAuthBlocked(false);
  },
  openProfile() {
    if (this.interactionBlocked() || this.data.loading || this.data.confirmingLogout) return;
    if (!this.data.user) { this.openMenu(); return; }
    this.navigateFromMenu('/pages/profile/index', '个人主页打开失败，请重试');
  },
  navigateFromMenu(url, failureMessage) {
    if (this._menuNavigating || this._unloaded || this._visible === false) return;
    this._menuNavigating = true;
    // 保留当前展开画面，直到新页面覆盖它；不要在 onHide 中提前收起。
    wx.navigateTo({ url, fail: () => {
      this._menuNavigating = false;
      if (!this._unloaded && this._visible !== false) wx.showToast({ title: failureMessage, icon: 'none' });
    } });
  },
  selectMenuItem(event) {
    if (this._menuNavigating || this.interactionBlocked() || this.data.loading || this.data.confirmingLogout) return;
    const item = [...this.data.menuItems, ...this.data.utilityMenuItems].find(entry => entry.key === event.currentTarget.dataset.key);
    if (!item) return;
    if (item.key === 'profile') { this.openProfile(); return; }
    if (item.key === 'certification') {
      if (!this.data.user) {
        this.closeMenu();
        this.openMenu();
        return;
      }
      if (this.data.identity.isAdmin) { wx.showToast({ title: '管理员账号无需学生认证', icon: 'none' }); return; }
      this.navigateFromMenu('/pages/certification/index', '认证页面打开失败，请重试');
      return;
    }
    wx.showToast({ title: `${item.label}功能将在后续开放`, icon: 'none' });
  },
  logout() {
    if (this._menuNavigating || !this.data.user || this._unloaded || this._visible === false || this.data.loading || this.data.confirmingLogout) return;
    const userId = this.data.user._id;
    const version = this._logoutVersion = (this._logoutVersion || 0) + 1;
    this.setData({ confirmingLogout: true });
    wx.showModal({
      title: '退出登录', content: '退出后会保留你的账号和已保存的资料。',
      success: result => {
        if (!result.confirm || this._unloaded || this._visible === false || version !== this._logoutVersion ||
            !this.data.user || this.data.user._id !== userId) return;
        userService.logout();
        this.applyUser(null);
        wx.showToast({ title: '已退出登录' });
      },
      fail: () => {
        if (!this._unloaded && this._visible !== false && version === this._logoutVersion) wx.showToast({ title: '暂时无法确认，请重试', icon: 'none' });
      },
      complete: () => {
        if (!this._unloaded && version === this._logoutVersion) this.setData({ confirmingLogout: false });
      },
    });
  },
  selectTab(event) {
    if (this.data.menuOpen || this.interactionBlocked()) return;
    const key = event.currentTarget.dataset.key;
    if (this.data.tabs.some(tab => tab.key === key)) {
      this.stopHomeRefresh();
      this.setData({ activeTab: key });
      if (key === 'square') this.loadFeed(false);
    }
  },
  showFeed(result) {
    const items = result.items.map(postPreview);
    const shared = this._sharedPostId && (square.cachedPost(this._sharedPostId) || this._sharedPost);
    if (shared) {
      const preview = postPreview(shared);
      const index = items.findIndex(post => post._id === shared._id);
      if (index < 0) items.unshift(preview);
      else items[index] = preview;
    }
    this.setData({ posts: items, feedHasMore: result.hasMore, feedOffset: result.nextOffset });
  },
  async loadSharedPost() {
    if (!this._sharedPostId || this._sharedRequest) return;
    const request = { id: this._sharedPostId, version: this._viewVersion || 0 };
    this._sharedRequest = request;
    const current = () => this._sharedRequest === request && this.currentView(request.version);
    let retry = false;
    try {
      const post = await square.detail(request.id);
      if (current()) {
        this._sharedPost = post;
        this.showFeed({ items: this.data.posts, hasMore: this.data.feedHasMore, nextOffset: this.data.feedOffset });
      }
    } catch (error) {
      if (current() && error.code === 'SESSION_CHANGED') retry = true;
      else if (current()) {
        this._sharedPost = null; this._sharedPostId = '';
        this.setData({ posts: this.data.posts.filter(post => post._id !== request.id) });
        wx.showToast({ title: error.message || '分享的动态暂不可见', icon: 'none' });
      }
    } finally {
      if (this._sharedRequest === request) {
        this._sharedRequest = null;
        if (retry && this.currentView(request.version)) this.loadSharedPost();
      }
    }
  },
  loadFeed(force = false, append = false) {
    if (this._feedBusy) return this._feedPromise;
    this._feedBusy = true;
    const version = this._viewVersion || 0, epoch = this._feedEpoch || 0;
    const cached = square.cachedFeed();
    if (cached) this.showFeed(cached);
    this.setData({ feedLoading: !this.data.posts.length && !cached, feedMoreLoading: append, feedError: '' });
    this._feedAppend = append;
    const request = (async () => {
      try {
        const result = await square.list({ force, offset: append ? this.data.feedOffset : 0 });
        if (this.currentView(version) && epoch === (this._feedEpoch || 0)) this.showFeed(result);
      } catch (error) {
        if (this.currentView(version) && epoch === (this._feedEpoch || 0) && error.code !== 'SESSION_CHANGED') this.setData({ feedError: error.message || '动态读取失败，请稍后重试' });
      } finally {
        if (this.currentView(version) && epoch === (this._feedEpoch || 0)) {
          this._feedBusy = false; this._feedPromise = null; this.setData({ feedLoading: false, feedMoreLoading: false });
        }
      }
    })();
    this._feedPromise = request;
    return request;
  },
  retryFeed() { return this.loadFeed(true); },
  refreshFeed() {
    if (this.data.pullRefreshing) return this._pullRefreshPromise;
    if (this.data.menuOpen || this.data.commentPostId || this.interactionBlocked() || this.data.activeTab !== 'square') return;
    const refresh = {};
    this._pullRefresh = refresh;
    this.setData({ pullRefreshing: true });
    const wasAppending = this._feedBusy && this._feedAppend;
    const request = (async () => {
      try {
        // 首屏正在联网时复用该请求；分页时先等待完成，再刷新最新动态。
        if (wasAppending) await this._feedPromise;
        if (this._pullRefresh === refresh) await this.loadFeed(true);
      } finally {
        if (this._pullRefresh === refresh) this.stopHomeRefresh();
      }
    })();
    this._pullRefreshPromise = request;
    return request;
  },
  stopHomeRefresh() {
    this._pullRefresh = null;
    this._pullRefreshPromise = null;
    if (this.data.pullRefreshing) this.setData({ pullRefreshing: false });
  },
  loadMoreFeed() { if (!this.data.menuOpen && !this.data.commentPostId && !this.interactionBlocked() && !this.data.pullRefreshing && this.data.activeTab === 'square' && this.data.feedHasMore) return this.loadFeed(false, true); },
  openComposer() {
    if (this.interactionBlocked() || this.data.menuOpen || this._openingComposer) return;
    if (!this.data.user) { this.openMenu(); return; }
    this._openingComposer = true;
    wx.navigateTo({ url: '/pages/square-compose/index', fail: () => {
      this._openingComposer = false; wx.showToast({ title: '发布页面打开失败，请重试', icon: 'none' });
    } });
  },
  async reactPost(event) {
    if (this.interactionBlocked() || this.data.menuOpen) return;
    if (!this.data.user) { this.openMenu(); return; }
    const { id, kind } = event.detail;
    const post = this.data.posts.find(item => item._id === id);
    this._reactions = this._reactions || new Set();
    if (!post || this._reactions.has(id)) return;
    this._reactions.add(id);
    try {
      const latest = await square.react(id, kind, !(kind === 'like' ? post.liked : post.reposted));
      if (!this._unloaded && this._visible !== false) this.setData({ posts: this.data.posts.map(item => item._id === id ? postPreview(latest) : item) });
    } catch (error) {
      if (!this._unloaded && this._visible !== false) {
        wx.showToast({ title: error.message, icon: 'none' });
        if (!userService.getCachedUser()) { this.applyUser(null); this.openMenu(); }
      }
    } finally { this._reactions.delete(id); }
  },
  openCampusCertification() {
    if (!this.data.user) { this.openMenu(); return; }
    wx.navigateTo({ url: '/pages/certification/index' });
  },
  onShareAppMessage(options) {
    return this.buildPostShare(options);
  },
});
