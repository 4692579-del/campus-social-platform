const userService = require('../../services/user');
const { describeUser } = require('../../utils/user-role');
const { menuItems, utilityMenuItems, accountMenuRoutes } = require('../../utils/account-menu');
const square = require('../../services/square');
const { postPreview } = require('../../utils/post-view');
const postActions = require('../../utils/post-actions');
const homeRefresh = require('../../utils/home-refresh');
const { readTabLayout, patchState } = require('../../utils/tab-page-layout');
const homeScrollChrome = require('../../utils/home-scroll-chrome');
const postRemovalMotion = require('../../utils/post-removal-motion');
const { CLOSE_DURATION, popoverLayout } = require('../../utils/post-popover');
const DEFAULT_AVATAR = '/images/avatar.png';
const CUI_WELCOME_POST_ID = 'p_1efff1a54dbe48e2e8e6ceb309fc2f56bde1a7e6';
const TAB_INDICATOR_OVERHANG = 8; // rpx on each side of the label
const HOME_TABS = [
  { key: 'square', label: '动态广场' },
  { key: 'campus', label: '校园圈' },
  { key: 'following', label: '关注' },
];
const FEED_FIELDS = {
  square: { posts: 'posts', loading: 'feedLoading', error: 'feedError', more: 'feedHasMore', position: 'feedOffset', appending: 'feedMoreLoading' },
  following: { posts: 'followingPosts', loading: 'followingLoading', error: 'followingError', more: 'followingHasMore', position: 'followingCursor', appending: 'followingMoreLoading' },
};

Page({
  ...accountMenuRoutes(wx),
  ...postActions,
  ...homeRefresh,
  ...homeScrollChrome.methods,
  ...postRemovalMotion,
  data: {
    followByAccount: {}, followKnown: false, profileFollowing: false, followBusy: false, followError: '',
    ...homeScrollChrome.data,
    user: null, identity: describeUser(null), avatarFailed: false,
    homeAvatarSource: DEFAULT_AVATAR, homeAvatarReady: true,
    loading: false, error: '', accountHint: '未登录', menuOpen: false, confirmingLogout: false, composerOpen: false,
    authChecking: false, loginSheetOpen: false, menuInstant: false,
    navTop: 28, navButtonHeight: 32, navHeight: 72, membershipOpen: false,
    brandRefreshPhase: 'idle', nativeRefreshing: false, refreshThreshold: 72,
    brandBouncing: false, topTargets: { square: '', campus: '', following: '' },
    menuLikeCount: '—', followerCount: '—', followingCount: '—', menuItems, utilityMenuItems,
    activeTab: 'square', activeTabIndex: 0, authorMenu: null, followPreviews: {}, defaultFollowPreview: { followed: false }, followingPreview: { followed: true, phase: 'followed' }, unfollowTarget: null, unfollowClosing: false, unfollowBusy: false, commentPostId: '',
    authorMenuExpanded: false, postRemoval: null, tabIndicatorLeft: 22.5, tabIndicatorWidth: 72, tabIndicatorDirection: '',
    posts: [], cuiWelcomePostId: CUI_WELCOME_POST_ID, feedLoading: false, feedError: '', feedHasMore: false, feedOffset: 0, feedMoreLoading: false, pullRefreshing: false, skeletons: [1, 2, 3],
    followingPosts: [], followingLoading: false, followingError: '', followingHasMore: false, followingCursor: '', followingMoreLoading: false,
    tabs: HOME_TABS,
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
    this._openingAuthor = false;
    this.resetHomeChrome(this._visible === false);
    this._openingPost = false;
    this._visible = true;
    this.startPostUpdates();
    this._viewVersion = (this._viewVersion || 0) + 1;
    this._menuNavigating = false;
    // 返回时直接呈现首页，离开时保留的菜单不再播放收起动画。
    patchState(this, { menuInstant: true });
    // 先同步当前账号及头像，再露出首页，避免显示上一账号的图片。
    const account = this.refreshUser(false);
    patchState(this, { menuOpen: false });
    if (square.consumePublication()) this.setHomeTab('square');
    this.syncNavigation();
    if (!this._tabAnchors) this.measureHomeTabs();
    if (this.isPostFeed()) this.loadFeed(false);
    return account;
  },
  onHide() {
    this.closeMembership();
    this.settleFollowAnimations();
    this.closeUnfollow(true);
    this.stopBrandBounce();
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (bar) patchState(bar, { composerOpen: false });
    this.stopPostUpdates();
    this._tabMeasureVersion = (this._tabMeasureVersion || 0) + 1;
    this.closeAuthorMenu();
    if (this.data.commentPostId && !this.commentsUsingNativeMedia()) this.closeComments();
    this.stopHomeRefresh();
    this._visible = false;
    this.finishPostRemoval();
    this._refreshing = false;
    this._feedRequests = {};
    this._viewVersion = (this._viewVersion || 0) + 1;
    this._logoutVersion = (this._logoutVersion || 0) + 1;
    if (!this._menuNavigating) this.closeMenu();
    this._openAfterRestore = false;
    patchState(this, { loading: false, confirmingLogout: false, authChecking: false, loginSheetOpen: false,
      feedLoading: false, feedMoreLoading: false, followingLoading: false, followingMoreLoading: false });
    this.setAuthBlocked(false);
  },
  onUnload() {
    this.closeMembership();
    this.resetFollowAnimations();
    this.stopBrandBounce();
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (bar) bar.setData({ composerOpen: false });
    this.stopPostUpdates();
    this._tabMeasureVersion = (this._tabMeasureVersion || 0) + 1;
    this.closeAuthorMenu();
    this.closeComments();
    this.stopHomeRefresh();
    this._unloaded = true;
    this.finishPostRemoval();
    this._visible = false;
    this._viewVersion = (this._viewVersion || 0) + 1;
    this.setMenuTabBarOpen(false);
    this.setAuthBlocked(false);
  },
  onReady() { this.syncNavigation(); this.measureHomeTabs(); },
  openComments(event) { this.closeAuthorMenu(); this.revealHomeChrome(); this.stopHomeRefresh(); postActions.openComments.call(this, event); },
  backToFeedTop() {
    if (this._unloaded || this._visible === false || this.interactionBlocked() || this.data.menuOpen || this.data.commentPostId || this.data.brandRefreshPhase !== 'idle') return;
    this.revealHomeChrome();
    const tab = this.data.activeTab, key = `topTargets.${tab}`;
    const sequence = this._brandScrollSequence = (this._brandScrollSequence || 0) + 1;
    if (!this.data.brandBouncing) {
      this.setData({ brandBouncing: true });
      this._brandBounceTimer = setTimeout(() => this.finishBrandBounce(), 400);
    }
    // 清除再设置原生滚动锚点，手动下滑后再次点击也可回顶，不重建动态或图片。
    this.setData({ [key]: '' }, () => {
      const scroll = () => {
        if (this._unloaded || this._visible === false || sequence !== this._brandScrollSequence || this.data.activeTab !== tab ||
          this.interactionBlocked() || this.data.menuOpen || this.data.commentPostId) return;
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
    this.finishPostRemoval();
    this.closeAuthorMenu();
    this.closePostPopover(true);
    this._homeWidth = event.size.windowWidth || this._homeWidth || 375;
    this.configureHomeChrome();
    this.resetHomeChrome();
    this._tabAnchors = null;
    this.setData(this.tabIndicatorState(this.data.activeTab));
    this.measureHomeTabs();
  },
  tabIndicatorState(key) {
    const index = HOME_TABS.findIndex(tab => tab.key === key), scale = (this._homeWidth || 375) / 750;
    const measured = this._tabAnchors && this._tabAnchors[index];
    const labelWidth = measured ? measured.width : HOME_TABS[index].label.length * 32 * scale;
    const groupWidth = ((this._homeWidth || 375) - 48 * scale) / HOME_TABS.length;
    const center = measured ? measured.center : groupWidth * (index + .5);
    const width = labelWidth + 2 * TAB_INDICATOR_OVERHANG * scale;
    return { activeTabIndex: index, tabIndicatorLeft: center - width / 2, tabIndicatorWidth: width };
  },
  setHomeTab(key) {
    if (key === this.data.activeTab) return;
    this.finishPostRemoval();
    const indicator = this.tabIndicatorState(key);
    this.setData({ activeTab: key, ...indicator,
      tabIndicatorDirection: indicator.activeTabIndex > this.data.activeTabIndex ? 'right' : 'left' });
  },
  measureHomeTabs() {
    const version = this._tabMeasureVersion = (this._tabMeasureVersion || 0) + 1;
    const measure = () => {
      if (this._unloaded || this._visible === false || version !== this._tabMeasureVersion) return;
      const query = typeof this.createSelectorQuery === 'function' ? this.createSelectorQuery() :
        typeof wx.createSelectorQuery === 'function' ? wx.createSelectorQuery().in(this) : null;
      if (!query) return;
      query.select('.home-tabs').boundingClientRect();
      query.selectAll('.home-tab-text').boundingClientRect();
      query.exec(result => {
        if (this._unloaded || this._visible === false || version !== this._tabMeasureVersion) return;
        const [tabs, labels] = result || [];
        if (!tabs || !labels || labels.length !== HOME_TABS.length || labels.some(label => !label || !label.width)) return;
        this._tabAnchors = labels.map(label => ({ center: label.left + label.width / 2 - tabs.left, width: label.width }));
        const state = this.tabIndicatorState(this.data.activeTab);
        const changed = Object.fromEntries(Object.entries(state).filter(([key, value]) => this.data[key] !== value));
        if (Object.keys(changed).length) this.setData(changed);
      });
    };
    if (typeof wx.nextTick === 'function') wx.nextTick(measure);
    else measure();
  },
  syncNavigation(preparingReturn = false) {
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (!bar || this._unloaded || (this._visible === false && !preparingReturn)) return;
    const values = {
      menuOpen: this.data.menuOpen, menuInstant: this.data.menuInstant, authBlocked: this.interactionBlocked(),
      commentsOpen: Boolean(this.data.commentPostId), composerOpen: Boolean(this.data.composerOpen),
    };
    const compact = Boolean(this.data.chromeCompact && !values.menuOpen && !values.commentsOpen && !values.authBlocked);
    if (typeof bar.syncFromPage === 'function' && !preparingReturn) bar.syncFromPage(0, { ...values, compact });
    else if (typeof bar.syncFromPage === 'function') patchState(bar, { ...values, compact });
    else patchState(bar, bar._switching ? values : { ...values, selected: 0, compact });
  },
  setMenuTabBarOpen(open) {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) patchState(tabBar, { menuOpen: open, menuInstant: this.data.menuInstant });
  },
  interactionBlocked() { return Boolean(this.data.authChecking || this.data.loginSheetOpen || this.data.composerOpen || this.data.unfollowTarget || this.data.membershipOpen); },
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
    const followOwner = this.followSessionKey();
    const feedOwnerChanged = this._feedOwner !== followOwner || previousId !== (user && user._id);
    this._feedOwner = followOwner;
    if (this._followPreviewOwner && this._followPreviewOwner !== followOwner) this.resetFollowAnimations();
    this._followPreviewOwner = followOwner;
    if (feedOwnerChanged) { this.finishPostRemoval(); this.closeAuthorMenu(); this.closePostPopover(true); }
    const accountChanged = Boolean(previousId && previousId !== (user && user._id));
    const avatarChanged = previousId !== (user && user._id) ||
      (this.data.user && this.data.user.avatarFileID || '') !== (user && user.avatarFileID || '');
    const avatarSource = user && user.avatarFileID || DEFAULT_AVATAR;
    if (previousId !== (user && user._id)) this.stopHomeRefresh();
    if (accountChanged) { this.closeComments(); this._followAction = null; }
    patchState(this, { user, identity: describeUser(user), error,
      ...(avatarChanged ? { homeAvatarSource: avatarSource, homeAvatarReady: avatarSource === DEFAULT_AVATAR, avatarFailed: false } : {}),
      ...(accountChanged ? { menuOpen: false, composerOpen: false } : {}),
      ...(feedOwnerChanged ? { followingPosts: [], followingLoading: false, followingError: '', followingHasMore: false, followingCursor: '', followingMoreLoading: false } : {}),
      authChecking: false, loginSheetOpen: user ? false : this.data.loginSheetOpen,
      accountHint: error ? '账号信息暂不可用' : '未登录', menuLikeCount: user ? (square.cachedOwnStats() || {}).receivedLikes ?? '—' : '—', followerCount: user && square.cachedFollowProfile ? square.cachedFollowProfile(user.accountId)?.followerCount ?? '—' : '—', followingCount: user && square.cachedFollowProfile ? square.cachedFollowProfile(user.accountId)?.followingCount ?? '—' : '—', ...(accountChanged ? { followByAccount: {}, unfollowBusy: false } : {}) });
    this.refreshFollowPresentation();
    if (accountChanged) this.setMenuTabBarOpen(false);
    this.setAuthBlocked(this.interactionBlocked());
    if (feedOwnerChanged && this._visible === true) {
      this._feedRequests = {};
      patchState(this, { feedLoading: false, feedMoreLoading: false });
      this.setData({ posts: this.data.posts.map(post => ({ ...post, liked: false, reposted: false })) });
      if (this.isPostFeed()) this.loadFeed(false);
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
    this.closeAuthorMenu();
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
  prepareMenuReturn() {
    if (this._unloaded) return;
    // 在子页面仍覆盖首页时恢复底层画面，不在返回动画中收起菜单。
    this._menuNavigating = false;
    this.setData({ menuOpen: false, menuInstant: true });
    const cached = userService.getCachedUser();
    if (cached !== this.data.user) this.applyUser(cached);
    this.syncNavigation(true);
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
    if (this._unloaded || this._visible === false || this.data.menuOpen || this.data.commentPostId || this.interactionBlocked()) return;
    const key = event.currentTarget.dataset.key;
    if (key === this.data.activeTab || !HOME_TABS.some(tab => tab.key === key)) return;
    this.closeAuthorMenu();
    this.resetHomeChrome();
    this.stopHomeRefresh();
    this.setHomeTab(key);
    if (this.isPostFeed()) return this.loadFeed(false);
  },
  isPostFeed() { return Boolean(FEED_FIELDS[this.data.activeTab]); },
  canRefreshFeed() {
    return !this._postRemoval && (this.data.activeTab === 'square' || (this.data.activeTab === 'following' && Boolean(userService.getCachedUser())));
  },
  activeFeedPosts() { return this.data[FEED_FIELDS[this.data.activeTab]?.posts] || []; },
  onFollowingChanged(event) {
    if (this._feedRequests) delete this._feedRequests.following;
    const cached = square.cachedFollowingFeed();
    if (cached) this.showFeed(cached, 'following');
    patchState(this, { followingMoreLoading: false });
    if (this.data.activeTab === 'following' && !event.pending) this.loadFeed(true);
  },
  closeAuthorMenu() {
    this._authorMenuTicket = (this._authorMenuTicket || 0) + 1;
    this._authorMenuSession = null;
    clearTimeout(this._authorMenuTimer);
    this._authorMenuTimer = null;
    if (!this._unloaded && this.data.authorMenu) this.setData({ authorMenu: null, authorMenuExpanded: false });
  },
  dismissAuthorMenu(afterClose) {
    const session = this._authorMenuSession;
    if (!session || !this.data.authorMenu) return;
    const ticket = ++this._authorMenuTicket;
    this._authorMenuSession = null;
    clearTimeout(this._authorMenuTimer);
    this.setData({ authorMenuExpanded: false }, () => {
      if (ticket !== this._authorMenuTicket) return;
      this._authorMenuTimer = setTimeout(() => {
        if (ticket !== this._authorMenuTicket) return;
        this.closeAuthorMenu();
        const user = userService.getCachedUser();
        if (typeof afterClose === 'function' && !this._unloaded && this._visible !== false && !this.interactionBlocked() &&
            session.version === userService.getSessionVersion() && session.account === (user && user._id)) afterClose();
      }, CLOSE_DURATION);
    });
  },
  openAuthorMenu(event) {
    if (this._unloaded || this._visible === false || this.interactionBlocked() || this.data.menuOpen || this.data.commentPostId || !this.isPostFeed()) return;
    const tab = this.data.activeTab, id = event.detail.id, post = this.activeFeedPosts().find(row => row._id === id);
    if (!post || !/^p_[a-f0-9]{40}$/.test(id)) return;
    const viewer = userService.getCachedUser();
    if (viewer && (viewer.accountId && post.author && post.author.accountId ? viewer.accountId === post.author.accountId : post.isOwn)) { this.closeAuthorMenu(); return; }
    if (this.data.authorMenu?.id === id && this._authorMenuSession) { this.dismissAuthorMenu(); return; }
    this.closeAuthorMenu();
    this.stopHomeRefresh();
    const ticket = this._authorMenuTicket, version = userService.getSessionVersion();
    const user = userService.getCachedUser(), account = user && user._id;
    const card = typeof this.selectComponent === 'function' && this.selectComponent((tab === 'following' ? '#home-following-post-' : '#home-post-') + id);
    if (!card || typeof card.getAvatarRect !== 'function') return;
    card.getAvatarRect(rect => {
      const currentUser = userService.getCachedUser();
      if (this._unloaded || this._visible === false || ticket !== this._authorMenuTicket || version !== userService.getSessionVersion() ||
          account !== (currentUser && currentUser._id) || this.interactionBlocked() || this.data.menuOpen || this.data.commentPostId || this.data.activeTab !== tab || !this.activeFeedPosts().some(row => row._id === id)) return;
      if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom)) return;
      const isOwn = Boolean(currentUser && (currentUser.accountId && post.author && post.author.accountId ? currentUser.accountId === post.author.accountId : post.isOwn));
      if (isOwn) return;
      const layout = popoverLayout(wx, rect, 2, { windowWidth: this._homeWidth, safeTop: this.data.chromeSafeTop, origin: 'avatar' });
      this._authorMenuSession = { version, account };
      const state = square.cachedFollowState?.(post.author.accountId);
      this.setData({ authorMenu: { ...layout, id, isOwn, following: state ? state.following : tab === 'following' }, authorMenuExpanded: true });
      this.hydrateFollowAuthors([post]);
    });
  },
  async selectAuthorAction(event) {
    const menu = this.data.authorMenu, session = this._authorMenuSession, action = event.currentTarget.dataset.action;
    if (!menu || !session) return;
    const user = userService.getCachedUser();
    const post = this.activeFeedPosts().find(row => row._id === menu.id);
    if (this._unloaded || this._visible === false || this.interactionBlocked() ||
        session.version !== userService.getSessionVersion() || session.account !== (user && user._id) ||
        !post || !['follow', 'profile'].includes(action) || menu.isOwn) { this.closeAuthorMenu(); return; }
    if (action === 'profile') { this.dismissAuthorMenu(() => this.viewAuthorProfile({ detail: { author: post.author } })); return; }
    if (!user) { this.dismissAuthorMenu(() => this.openMenu()); return; }
    const state = square.cachedFollowState(post.author.accountId);
    if (state ? state.following : menu.following) {
      this.dismissAuthorMenu(() => {
        this._unfollowSession = this.followSessionKey();
        this.setData({ unfollowTarget: { key: this.followAuthorKey(post), accountId: post.author.accountId, id: post._id, nickname: post.author.nickname || '该用户', avatar: post.author.avatarFileID || '' }, unfollowClosing: false });
        this.syncNavigation();
      });
      return;
    }
    this.dismissAuthorMenu();
    const request = this.persistFollowIntent(post.author.accountId, true);
    this.playFollowAnimation(post);
    return request;
  },
  followSessionKey() { const user = userService.getCachedUser(); return `${user ? user._id : 'guest'}:${userService.getSessionVersion()}`; },
  postRemovalTarget(id) {
    if (this.data.activeTab === 'square' && this.data.posts.some(post => post._id === id)) return 'home';
  },
  restorePostRemovalFeed() {
    const cached = square.cachedFeed();
    if (cached) this.showFeed(cached);
  },
  followAuthorKey(post) { return post.author && post.author.accountId ? 'account:' + post.author.accountId : 'post:' + post._id; },
  refreshFollowPreviews() {
    if (this._unloaded) return;
    const patch = {};
    for (const post of [...this.data.posts, ...this.data.followingPosts]) {
      const record = this._followPreviewState && this._followPreviewState.get(this.followAuthorKey(post));
      const state = square.cachedFollowState && square.cachedFollowState(post.author && post.author.accountId);
      if (record && state && !state.following) { if (record.timer) clearTimeout(record.timer); this._followPreviewState.delete(this.followAuthorKey(post)); }
      const next = { followed: Boolean(state && state.following), phase: state && state.following ? record ? record.phase : 'followed' : 'idle' };
      const old = this.data.followPreviews[post._id];
      if ((!old && state) || old && (old.followed !== next.followed || old.phase !== next.phase)) patch[`followPreviews.${post._id}`] = next;
    }
    if (Object.keys(patch).length) this.setData(patch);
  },
  playFollowAnimation(post) {
    const owner = this.followSessionKey();
    if (this._followPreviewOwner && this._followPreviewOwner !== owner) this.resetFollowAnimations();
    this._followPreviewOwner = owner;
    const key = this.followAuthorKey(post), states = this._followPreviewState || (this._followPreviewState = new Map());
    if (this._unloaded || this._visible === false) return;
    if (states.get(key)?.timer) clearTimeout(states.get(key).timer);
    const record = { phase: 'following', timer: null }; states.set(key, record);
    this.refreshFollowPreviews();
    // CSS完成加号/勾及圆钮两阶段动画；只在云端确认后播放并在结束后落定动画状态，不逐帧写页面。
    record.timer = setTimeout(() => {
      if (this._unloaded || this._visible === false || owner !== this.followSessionKey() || this._followPreviewState !== states || states.get(key) !== record) return;
      record.timer = null; record.phase = 'followed'; this.refreshFollowPreviews();
    }, 1250);
  },
  settleFollowAnimations() {
    if (!this._followPreviewState) return;
    for (const record of this._followPreviewState.values()) { if (record.timer) clearTimeout(record.timer); record.timer = null; record.phase = 'followed'; }
    this.refreshFollowPreviews();
  },
  resetFollowAnimations() {
    if (this._followPreviewState) for (const record of this._followPreviewState.values()) if (record.timer) clearTimeout(record.timer);
    this._followPreviewState = new Map(); this._followPreviewOwner = null;
    this.closeUnfollow(true);
    if (!this._unloaded && Object.keys(this.data.followPreviews).length) this.setData({ followPreviews: {} });
  },
  closeUnfollow(immediate = false) {
    const ticket = this._unfollowCloseVersion = (this._unfollowCloseVersion || 0) + 1;
    if (this._unfollowCloseTimer) { clearTimeout(this._unfollowCloseTimer); this._unfollowCloseTimer = null; }
    if (!this.data.unfollowTarget || this._unloaded) return;
    const target = this.data.unfollowTarget;
    const finish = () => {
      if (this._unloaded || ticket !== this._unfollowCloseVersion || this.data.unfollowTarget !== target) return;
      this._unfollowCloseTimer = null;
      this._unfollowSession = null;
      this.setData({ unfollowTarget: null, unfollowClosing: false }); this.syncNavigation();
    };
    if (immediate) { finish(); return; }
    this.setData({ unfollowClosing: true }); this._unfollowCloseTimer = setTimeout(finish, 200);
  },
  cancelUnfollow() { if (!this.data.unfollowClosing) this.closeUnfollow(); },
  confirmUnfollow() {
    const target = this.data.unfollowTarget, owner = this.followSessionKey();
    if (!target || this.data.unfollowClosing || this._unloaded || this._visible === false) return;
    if (this._unfollowSession !== owner) { this.resetFollowAnimations(); return; }
    const request = this.persistFollowIntent(target.accountId, false);
    const record = this._followPreviewState && this._followPreviewState.get(target.key);
    if (record?.timer) clearTimeout(record.timer);
    if (this._followPreviewState) this._followPreviewState.delete(target.key);
    this.refreshFollowPreviews(); this.closeUnfollow();
    return request;
  },
  showFeed(result, tab = 'square') {
    if (tab === 'square' && this._postRemoval) {
      this._postRemoval.feedUpdated = true;
      return;
    }
    const fields = FEED_FIELDS[tab];
    const visible = square.visiblePosts?.(result.items) || result.items;
    const current = this.data[fields.posts];
    const values = {};
    if (visible.length < current.length || current.some((post, index) => post._id !== visible[index]._id)) {
      // 刷新、删除或重新排序时重新对齐列表。
      values[fields.posts] = visible.map(postPreview);
    } else {
      visible.forEach((row, index) => {
        const next = postPreview(row), previous = current[index], path = `${fields.posts}[${index}]`;
        if (!previous || Object.keys(previous).some(key => !Object.prototype.hasOwnProperty.call(next, key))) {
          values[path] = next;
          return;
        }
        for (const [key, value] of Object.entries(next)) {
          const old = previous[key];
          if (old === value) continue;
          if (value && typeof value === 'object' && JSON.stringify(old) === JSON.stringify(value)) continue;
          values[`${path}.${key}`] = value;
        }
      });
    }
    const position = tab === 'following' ? result.nextCursor : result.nextOffset;
    if (this.data[fields.more] !== result.hasMore) values[fields.more] = result.hasMore;
    if (this.data[fields.position] !== position) values[fields.position] = position;
    if (Object.keys(values).length) this.setData(values);
    this.refreshFollowPreviews();
    this.hydrateFollowAuthors(visible);
  },
  loadFeed(force = false, append = false) {
    const tab = this.data.activeTab, fields = FEED_FIELDS[tab];
    if (!fields || this._unloaded || this._visible === false) return;
    const following = tab === 'following';
    if (following && !userService.getCachedUser()) return;
    const requests = this._feedRequests || (this._feedRequests = {});
    if (requests[tab]) {
      const pending = requests[tab];
      if (force && pending.append) {
        const version = this._viewVersion || 0, session = this.followSessionKey();
        return pending.promise.then(() => {
          if (this.currentView(version) && this.data.activeTab === tab && session === this.followSessionKey()) return this.loadFeed(true);
        });
      }
      return pending.promise;
    }
    const request = { append };
    requests[tab] = request;
    const version = this._viewVersion || 0, session = this.followSessionKey();
    const ownsRequest = () => this.currentView(version) && this._feedRequests?.[tab] === request;
    const current = () => ownsRequest() && session === this.followSessionKey();
    const cached = following ? square.cachedFollowingFeed() : square.cachedFeed();
    if (cached) this.showFeed(cached, tab);
    patchState(this, { [fields.loading]: !this.data[fields.posts].length && !cached, [fields.appending]: append, [fields.error]: '' });
    request.promise = (async () => {
      try {
        const position = this.data[fields.position];
        const result = following ? await square.listFollowing({ force, cursor: append ? position : '' }) : await square.list({ force, offset: append ? position : 0 });
        if (current()) this.showFeed(result, tab);
      } catch (error) {
        if (current() && !['SESSION_CHANGED', 'BLOCK_CHANGED'].includes(error.code)) this.setData({ [fields.error]: error.message || '动态读取失败，请稍后重试' });
      } finally {
        if (current()) patchState(this, { [fields.loading]: false, [fields.appending]: false });
        else if (ownsRequest()) this.applyUser(userService.getCachedUser());
        if (requests[tab] === request) delete requests[tab];
      }
    })();
    return request.promise;
  },
  retryFeed() { return this.loadFeed(true); },
  loadMoreFeed(event) {
    const tab = this.data.activeTab, source = event?.currentTarget?.dataset?.feed, fields = FEED_FIELDS[tab];
    if (fields && (!source || source === tab) && !this._postRemoval && !this.data.menuOpen && !this.data.authorMenu && !this.data.commentPostId && !this.interactionBlocked() && !this.data.pullRefreshing && this.data[fields.more]) return this.loadFeed(false, true);
  },
  openComposer(event) {
    if (this.interactionBlocked() || this.data.menuOpen || this.data.commentPostId) return;
    this.revealHomeChrome();
    if (!this.data.user) { this.openMenu(); return; }
    this.closeAuthorMenu();
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
      this.setHomeTab('square');
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
