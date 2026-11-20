const userService = require('../../services/user');
const { describeUser } = require('../../utils/user-role');
const { menuItems, utilityMenuItems } = require('../../utils/account-menu');
const square = require('../../services/square');
const { postPreview } = require('../../utils/post-view');
const postActions = require('../../utils/post-actions');
const homeRefresh = require('../../utils/home-refresh');
const { readTabLayout, patchState } = require('../../utils/tab-page-layout');
const tabPageMotion = require('../../utils/tab-page-motion');
const homeScrollChrome = require('../../utils/home-scroll-chrome');
const DEFAULT_AVATAR = '/images/avatar.png';

Page({
  ...postActions,
  ...homeRefresh,
  ...tabPageMotion.methods,
  ...homeScrollChrome.methods,
  data: {
    ...tabPageMotion.data,
    ...homeScrollChrome.data,
    user: null, identity: describeUser(null), avatarFailed: false,
    homeAvatarSource: DEFAULT_AVATAR, homeAvatarReady: true,
    loading: false, error: '', accountHint: '未登录', menuOpen: false, confirmingLogout: false, composerOpen: false,
    authChecking: false, loginSheetOpen: false, menuInstant: false,
    navTop: 28, navButtonHeight: 32, navHeight: 72,
    brandRefreshPhase: 'idle', nativeRefreshing: false, refreshThreshold: 72,
    brandBouncing: false, squareTopTarget: '', campusTopTarget: '',
    menuLikeCount: '—', followerCount: 0, followingCount: 0, menuItems, utilityMenuItems,
    activeTab: 'square', tabMenuKey: '', tabFilters: { square: 'square', campus: 'campus' }, commentPostId: '',
    tabIndicatorLeft: 43.75, tabIndicatorWidth: 85,
    posts: [], feedLoading: false, feedError: '', feedHasMore: false, feedOffset: 0, feedMoreLoading: false, pullRefreshing: false, skeletons: [1, 2, 3],
    tabs: [
      { key: 'square', label: '动态广场', options: [{ key: 'square', label: '推荐' }, { key: 'following', label: '关注' }] },
      { key: 'campus', label: '校园圈', options: [{ key: 'campus', label: '推荐' }, { key: 'following', label: '关注' }] },
    ],
  },
  onLoad() {
    const { windowWidth, ...layout } = readTabLayout(wx);
    this._homeWidth = windowWidth;
    patchState(this, layout);
    this.configureHomeChrome();
    this.setData(this.tabIndicatorState(this.data.activeTab));
    const cached = userService.getCachedUser();
    if (cached) this.applyUser(cached);
    const feed = square.cachedFeed();
    if (feed) this.showFeed(feed);
  },
  onShow() {
    this.showTabMotion('/pages/home/index');
    this.resetHomeChrome();
    this._openingPost = false;
    this._visible = true;
    this.startPostUpdates();
    this._viewVersion = (this._viewVersion || 0) + 1;
    this._menuNavigating = false;
    // 返回时直接呈现首页，离开时保留的菜单不再播放收起动画。
    patchState(this, { menuInstant: true, tabMenuKey: '' });
    // 先同步当前账号及头像，再露出首页，避免显示上一账号的图片。
    const account = this.refreshUser(false);
    patchState(this, { menuOpen: false });
    if (square.consumePublication()) this.setData({ activeTab: 'square', ...this.tabIndicatorState('square'), tabFilters: { ...this.data.tabFilters, square: 'square' } });
    this.syncNavigation();
    if (!this._tabAnchors) this.measureHomeTabs();
    if (this.isSquareFeed()) this.loadFeed(false);
    return account;
  },
  onHide() {
    this.hideTabMotion();
    this.stopBrandBounce();
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (bar) patchState(bar, { composerOpen: false });
    this.stopPostUpdates();
    this._tabMeasureVersion = (this._tabMeasureVersion || 0) + 1;
    this.closeTabMenu();
    if (this.data.commentPostId && !this.commentsUsingNativeMedia()) this.closeComments();
    this.stopHomeRefresh();
    this._visible = false;
    this._refreshing = false;
    this._feedBusy = false;
    this._feedPromise = null;
    this._viewVersion = (this._viewVersion || 0) + 1;
    this._logoutVersion = (this._logoutVersion || 0) + 1;
    if (!this._menuNavigating) this.closeMenu();
    this._openAfterRestore = false;
    patchState(this, { loading: false, confirmingLogout: false, authChecking: false, loginSheetOpen: false });
    this.setAuthBlocked(false);
  },
  onUnload() {
    this.hideTabMotion();
    this.stopBrandBounce();
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (bar) bar.setData({ composerOpen: false });
    this.stopPostUpdates();
    this._tabMeasureVersion = (this._tabMeasureVersion || 0) + 1;
    this.closeTabMenu();
    this.closeComments();
    this.stopHomeRefresh();
    this._unloaded = true;
    this._visible = false;
    this._viewVersion = (this._viewVersion || 0) + 1;
    this.setMenuTabBarOpen(false);
    this.setAuthBlocked(false);
  },
  onReady() { this.syncNavigation(); this.measureHomeTabs(); },
  openComments(event) { this.revealHomeChrome(); this.stopHomeRefresh(); postActions.openComments.call(this, event); },
  backToFeedTop() {
    if (this._unloaded || this._visible === false || this.interactionBlocked() || this.data.menuOpen || this.data.tabMenuKey || this.data.commentPostId || this.data.brandRefreshPhase !== 'idle') return;
    this.revealHomeChrome();
    const tab = this.data.activeTab, key = tab === 'campus' ? 'campusTopTarget' : 'squareTopTarget';
    const sequence = this._brandScrollSequence = (this._brandScrollSequence || 0) + 1;
    if (!this.data.brandBouncing) {
      this.setData({ brandBouncing: true });
      this._brandBounceTimer = setTimeout(() => this.finishBrandBounce(), 400);
    }
    // 清除再设置原生滚动锚点，手动下滑后再次点击也可回顶，不重建动态或图片。
    this.setData({ [key]: '' }, () => {
      const scroll = () => {
        if (this._unloaded || this._visible === false || sequence !== this._brandScrollSequence || this.data.activeTab !== tab ||
          this.interactionBlocked() || this.data.menuOpen || this.data.tabMenuKey || this.data.commentPostId) return;
        this.setData({ [key]: `home-${tab}-top` });
      };
      if (typeof wx.nextTick === 'function') wx.nextTick(scroll); else scroll();
    });
  },
  finishBrandBounce() {
    if (this._brandBounceTimer) { clearTimeout(this._brandBounceTimer); this._brandBounceTimer = null; }
    if (!this._unloaded && this.data.brandBouncing) this.setData({ brandBouncing: false });
  },
  stopBrandBounce() {
    this._brandScrollSequence = (this._brandScrollSequence || 0) + 1;
    this.finishBrandBounce();
  },
  onResize(event) {
    this._homeWidth = event.size.windowWidth || this._homeWidth || 375;
    this.configureHomeChrome();
    this.resetHomeChrome();
    this._tabAnchors = null;
    this.setData(this.tabIndicatorState(this.data.activeTab));
    this.measureHomeTabs();
  },
  tabIndicatorState(key) {
    const index = key === 'campus' ? 1 : 0, scale = (this._homeWidth || 375) / 750;
    const measured = this._tabAnchors && this._tabAnchors[index];
    const labelWidth = (index ? 132 : 164) * scale;
    const groupWidth = ((this._homeWidth || 375) - 48 * scale) / 2;
    const left = measured ? measured.left : groupWidth * (index + .5) - labelWidth / 2;
    return { tabIndicatorLeft: left - 6 * scale, tabIndicatorWidth: (measured ? measured.width : labelWidth) + 6 * scale };
  },
  measureHomeTabs() {
    const version = this._tabMeasureVersion = (this._tabMeasureVersion || 0) + 1;
    const measure = () => {
      if (this._unloaded || this._visible === false || version !== this._tabMeasureVersion) return;
      const query = typeof this.createSelectorQuery === 'function' ? this.createSelectorQuery() :
        typeof wx.createSelectorQuery === 'function' ? wx.createSelectorQuery().in(this) : null;
      if (!query) return;
      query.select('.home-tabs').boundingClientRect();
      query.selectAll('.home-tab-label').boundingClientRect();
      query.exec(result => {
        if (this._unloaded || this._visible === false || version !== this._tabMeasureVersion) return;
        const [tabs, labels] = result || [];
        if (!tabs || !labels || labels.length !== 2 || labels.some(label => !label || !label.width)) return;
        this._tabAnchors = labels.map(label => ({ left: label.left - tabs.left, width: label.width }));
        const state = this.tabIndicatorState(this.data.activeTab);
        const changed = Object.fromEntries(Object.entries(state).filter(([key, value]) => this.data[key] !== value));
        if (Object.keys(changed).length) this.setData(changed);
      });
    };
    if (typeof wx.nextTick === 'function') wx.nextTick(measure);
    else measure();
  },
  syncNavigation() {
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (bar) patchState(bar, {
      ...(!bar._switching ? { selected: 0, compact: Boolean(this.data.chromeCompact && !this.data.menuOpen && !this.data.commentPostId && !this.interactionBlocked()) } : {}),
      menuOpen: this.data.menuOpen, menuInstant: this.data.menuInstant, authBlocked: this.interactionBlocked(),
      commentsOpen: Boolean(this.data.commentPostId), composerOpen: Boolean(this.data.composerOpen),
    });
  },
  setMenuTabBarOpen(open) {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) patchState(tabBar, { menuOpen: open, menuInstant: this.data.menuInstant });
  },
  interactionBlocked() { return Boolean(this.data.authChecking || this.data.loginSheetOpen || this.data.composerOpen); },
  setAuthBlocked(blocked) {
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (bar) patchState(bar, { authBlocked: Boolean(blocked), composerOpen: Boolean(this.data.composerOpen && this._visible !== false && !this._unloaded) });
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
    patchState(this, { loading: !cached, error: '', accountHint: cached ? '' : '正在读取账号…' });
    try {
      const user = await userService.restore({ force: force !== false });
      if (this.currentView(version)) this.applyUser(user);
    } catch (error) {
      if (this.currentView(version) && (!cached || !userService.getCachedUser())) this.applyUser(null, error.message || '账号信息读取失败');
    } finally {
      if (this.currentView(version)) {
        this._refreshing = false;
        patchState(this, { loading: false });
        if (this._openAfterRestore) { this._openAfterRestore = false; this.openMenu(); }
      }
    }
  },
  applyUser(user, error = '') {
    const previousId = this.data.user && this.data.user._id;
    const accountChanged = Boolean(previousId && previousId !== (user && user._id));
    const avatarChanged = previousId !== (user && user._id) ||
      (this.data.user && this.data.user.avatarFileID || '') !== (user && user.avatarFileID || '');
    const avatarSource = user && user.avatarFileID || DEFAULT_AVATAR;
    if (previousId !== (user && user._id)) this.stopHomeRefresh();
    if (accountChanged) this.closeComments();
    patchState(this, { user, identity: describeUser(user), error,
      ...(avatarChanged ? { homeAvatarSource: avatarSource, homeAvatarReady: avatarSource === DEFAULT_AVATAR, avatarFailed: false } : {}),
      ...(accountChanged ? { menuOpen: false, composerOpen: false } : {}),
      authChecking: false, loginSheetOpen: user ? false : this.data.loginSheetOpen,
      accountHint: error ? '账号信息暂不可用' : '未登录', menuLikeCount: user ? (square.cachedOwnStats() || {}).receivedLikes ?? '—' : '—', followerCount: 0, followingCount: 0 });
    if (accountChanged) this.setMenuTabBarOpen(false);
    this.setAuthBlocked(this.interactionBlocked());
    if (previousId !== (user && user._id) && this._visible === true) {
      this._feedEpoch = (this._feedEpoch || 0) + 1;
      this._feedBusy = false;
      this.setData({ posts: this.data.posts.map(post => ({ ...post, liked: false, reposted: false })) });
      if (this.isSquareFeed()) this.loadFeed(false);
    }
  },
  onHomeAvatarLoad(event) {
    if (event && event.currentTarget && event.currentTarget.dataset.source !== this.data.homeAvatarSource) return;
    if (!this.data.homeAvatarReady) this.setData({ homeAvatarReady: true });
  },
  onAvatarError(event) {
    if (event && event.currentTarget && event.currentTarget.dataset.source !== this.data.homeAvatarSource) return;
    if (this.data.homeAvatarSource !== DEFAULT_AVATAR) this.setData({ avatarFailed: true, homeAvatarSource: DEFAULT_AVATAR, homeAvatarReady: true });
  },
  openMenu() {
    if (this._unloaded || this._visible === false || this.data.menuOpen || this.data.composerOpen) return;
    this.revealHomeChrome();
    if (this.data.loginSheetOpen) return;
    this.closeTabMenu();
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
    this.stopHomeRefresh();
    this.setData({ menuOpen: true, menuInstant: false });
    this.setMenuTabBarOpen(true);
    this.refreshMenuStats();
  },
  refreshMenuStats() {
    const user = userService.getCachedUser(), version = userService.getSessionVersion();
    if (!user) return;
    const cached = square.cachedOwnStats();
    if (cached) this.setData({ menuLikeCount: cached.receivedLikes });
    square.getOwnStats().then(stats => {
      if (this._unloaded || this._visible === false || userService.getSessionVersion() !== version ||
          !this.data.user || this.data.user._id !== user._id) return;
      if (this.data.menuLikeCount !== stats.receivedLikes) this.setData({ menuLikeCount: stats.receivedLikes });
    }).catch(() => { /* 保留真实缓存；首次失败显示破折号，不伪造零获赞。 */ });
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
  prepareMenuReturn() {
    if (this._unloaded) return;
    // 在子页面仍覆盖首页时恢复底层画面，不在返回动画中收起菜单。
    this._menuNavigating = false;
    this.setData({ menuOpen: false, menuInstant: true, tabMenuKey: '' });
    const cached = userService.getCachedUser();
    if (cached !== this.data.user) this.applyUser(cached);
    this.syncNavigation();
  },
  selectMenuItem(event) {
    if (this._menuNavigating || this.interactionBlocked() || this.data.loading || this.data.confirmingLogout) return;
    const item = [...this.data.menuItems, ...this.data.utilityMenuItems].find(entry => entry.key === event.currentTarget.dataset.key);
    if (!item) return;
    if (item.key === 'xiaocui') { this.navigateFromMenu('/pages/xiaocui-about/index', '小萃AI页面打开失败，请重试'); return; }
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
    if (this.data.menuOpen || this.data.commentPostId || this.interactionBlocked()) return;
    const key = event.currentTarget.dataset.key;
    if (this.data.tabs.some(tab => tab.key === key)) {
      if (this.data.activeTab === key) { this.toggleTabMenu(event); return; }
      this.resetHomeChrome();
      this.stopHomeRefresh();
      this.setData({ activeTab: key, ...this.tabIndicatorState(key), tabMenuKey: '' });
      if (this.isSquareFeed()) this.loadFeed(false);
    }
  },
  isSquareFeed() { return this.data.activeTab === 'square' && this.data.tabFilters.square === 'square'; },
  toggleTabMenu(event) {
    if (this.data.menuOpen || this.data.commentPostId || this.interactionBlocked()) return;
    this.revealHomeChrome();
    const key = event.currentTarget.dataset.key;
    if (!this.data.tabs.some(tab => tab.key === key)) return;
    const switched = this.data.activeTab !== key;
    this.stopHomeRefresh();
    this.setData({ activeTab: key, ...this.tabIndicatorState(key), tabMenuKey: this.data.tabMenuKey === key ? '' : key });
    if (switched && this.isSquareFeed()) this.loadFeed(false);
  },
  closeTabMenu() { if (this.data.tabMenuKey) this.setData({ tabMenuKey: '' }); },
  selectTabFilter(event) {
    if (this.data.menuOpen || this.data.commentPostId || this.interactionBlocked()) return;
    const { key, filter } = event.currentTarget.dataset;
    const tab = this.data.tabs.find(item => item.key === key);
    if (this.data.tabMenuKey !== key || !tab || !tab.options.some(item => item.key === filter)) return;
    this.stopHomeRefresh();
    this.setData({ activeTab: key, ...this.tabIndicatorState(key), tabMenuKey: '', tabFilters: { ...this.data.tabFilters, [key]: filter } });
    if (this.isSquareFeed()) this.loadFeed(false);
  },
  showFeed(result) {
    const items = result.items.map(postPreview);
    const values = {};
    // 返回时缓存和后台结果常相同，不重复替换整组图文组件。
    if (JSON.stringify(items) !== JSON.stringify(this.data.posts)) values.posts = items;
    if (this.data.feedHasMore !== result.hasMore) values.feedHasMore = result.hasMore;
    if (this.data.feedOffset !== result.nextOffset) values.feedOffset = result.nextOffset;
    if (Object.keys(values).length) this.setData(values);
  },
  loadFeed(force = false, append = false) {
    if (this._feedBusy) return this._feedPromise;
    this._feedBusy = true;
    const version = this._viewVersion || 0, epoch = this._feedEpoch || 0;
    const cached = square.cachedFeed();
    if (cached) this.showFeed(cached);
    patchState(this, { feedLoading: !this.data.posts.length && !cached, feedMoreLoading: append, feedError: '' });
    this._feedAppend = append;
    const request = (async () => {
      try {
        const result = await square.list({ force, offset: append ? this.data.feedOffset : 0 });
        if (this.currentView(version) && epoch === (this._feedEpoch || 0)) this.showFeed(result);
      } catch (error) {
        if (this.currentView(version) && epoch === (this._feedEpoch || 0) && error.code !== 'SESSION_CHANGED') this.setData({ feedError: error.message || '动态读取失败，请稍后重试' });
      } finally {
        if (this.currentView(version) && epoch === (this._feedEpoch || 0)) {
          this._feedBusy = false; this._feedPromise = null; patchState(this, { feedLoading: false, feedMoreLoading: false });
        }
      }
    })();
    this._feedPromise = request;
    return request;
  },
  retryFeed() { return this.loadFeed(true); },
  loadMoreFeed() { if (!this.data.menuOpen && !this.data.tabMenuKey && !this.data.commentPostId && !this.interactionBlocked() && !this.data.pullRefreshing && this.isSquareFeed() && this.data.feedHasMore) return this.loadFeed(false, true); },
  openComposer(event) {
    if (this.interactionBlocked() || this.data.menuOpen || this.data.commentPostId) return;
    this.revealHomeChrome();
    if (!this.data.user) { this.openMenu(); return; }
    this.closeTabMenu();
    this.stopHomeRefresh();
    this.setData({ composerOpen: true, composerQuote: event && event.quotePost || null, composerQuoteOwnerId: this.data.user._id });
    this.syncNavigation();
  },
  closeComposer(event) {
    this.setData({ composerOpen: false, composerQuote: null, composerQuoteOwnerId: '' });
    const user = userService.getCachedUser();
    if ((user && user._id) !== (this.data.user && this.data.user._id)) this.applyUser(user);
    if (event.detail.published) {
      square.consumePublication();
      this.setData({ activeTab: 'square', ...this.tabIndicatorState('square'), tabFilters: { ...this.data.tabFilters, square: 'square' } });
      const cached = square.cachedFeed();
      if (cached) this.showFeed(cached);
      this.loadFeed(false);
    }
    this.syncNavigation();
  },
  openCampusCertification() {
    if (!this.data.user) { this.openMenu(); return; }
    wx.navigateTo({ url: '/pages/certification/index' });
  },
});
