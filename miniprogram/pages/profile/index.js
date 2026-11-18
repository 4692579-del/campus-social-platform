const userService = require('../../services/user');
const { describeUser } = require('../../utils/user-role');
const { menuItems, utilityMenuItems } = require('../../utils/account-menu');
const square = require('../../services/square');
const { postPreview } = require('../../utils/post-view');
const postActions = require('../../utils/post-actions');
const postImages = require('../../services/post-images');
const { navigationLayout, defaultGeometry, navigationState, pullState } = require('../../utils/profile-navigation');

function wxCall(name, options) {
  return new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
}

Page({
  ...postActions,
  data: {
    user: null, loading: false, error: '', identity: describeUser(null),
    coverBusy: false, coverRetry: false, coverFailed: false, coverFileID: '',
    joinedText: '', isVerified: false, certificationAction: '去认证',
    navTop: 28, navButtonHeight: 32, navHeight: 72, searchLeft: 68, navTitleInset: 116,
    coverHeight: 202, navCoverOffset: 0, navBlurOpacity: 0, navShadeOpacity: 0, navTitleOpacity: 0, postCountText: '帖子',
    coverArtHeight: 250, pullMax: 48, pullThreshold: 30,
    profilePullOffset: 0, pullRotation: 0, pullOpacity: 0, pullDragging: false, profileRefreshing: false,
    menuOpen: false, confirmingLogout: false, composerOpen: false,
    authChecking: true, loginSheetOpen: false,
    menuItems, utilityMenuItems,
    likeCount: 0, followingCount: 0, followerCount: 0, selectedContent: 'posts',
    contentTabs: [
      { key: 'posts', label: '动态', icon: 'posts', empty: '还没有发布动态' },
      { key: 'replies', label: '回复', icon: 'replies', iconSource: '/images/interface/message-square', iconExtension: 'svg', empty: '还没有回复' },
      { key: 'reposts', label: '转发', icon: 'reposts', empty: '还没有转发的动态' },
      { key: 'album', label: '相册', icon: 'album', iconSource: '/images/interface/album', iconExtension: 'svg', empty: '还没有上传照片' },
    ],
    emptyText: '还没有发布动态', commentPostId: '',
    postsMenuOpen: false, postScope: 'square', ownPosts: [], postsLoading: false, postsMoreLoading: false,
    postsError: '', postsHasMore: false, postsOffset: 0,
    albumImages: [], albumLoading: false, albumMoreLoading: false, albumHasMore: false, albumOffset: 0, albumError: '',
  },
  onLoad() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    this._homePage = pages.find(page => page.route === 'pages/home/index');
    this.updateNavigationLayout();
    const cached = userService.getCachedUser();
    if (cached) this.applyUser(cached);
  },
  onUnload() {
    this._visible = false;
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (bar) bar.setData({ composerOpen: false });
    this.stopPostUpdates();
    this.prepareHomeReturn();
    this._homePage = null;
    this.resetProfilePull();
    this.clearProfileScrollSync();
    this.clearNavigationFrame();
    this._navMeasurementVersion = (this._navMeasurementVersion || 0) + 1;
    this.closeComments();
    this.setMenuTabBarOpen(false);
    this.setAuthBlocked(false);
    this._visible = false;
    this._viewVersion = (this._viewVersion || 0) + 1;
    this._unloaded = true;
    this._accountVersion = (this._accountVersion || 0) + 1;
  },
  onHide() {
    this._albumRequest = null;
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (bar) bar.setData({ composerOpen: false });
    this.stopPostUpdates();
    this.resetProfilePull();
    this.clearProfileScrollSync();
    this.clearNavigationFrame();
    this._navMeasurementVersion = (this._navMeasurementVersion || 0) + 1;
    this.closeComments();
    this._visible = false;
    this._refreshing = false;
    this._viewVersion = (this._viewVersion || 0) + 1;
    this.closeMenu();
    this._logoutVersion = (this._logoutVersion || 0) + 1;
    this._postsRequest = null;
    this.setData({ confirmingLogout: false, loading: false, authChecking: false, loginSheetOpen: false, postsMenuOpen: false });
    this.setAuthBlocked(false);
  },
  onShow() {
    this._openingPost = false;
    this._visible = true;
    this.startPostUpdates();
    this._viewVersion = (this._viewVersion || 0) + 1;
    this.syncNavigation();
    this.updateNavigationScroll();
    this.measureProfileNavigation();
    this.scheduleProfileScrollSync();
    return this.refresh(false);
  },
  onReady() { this.syncNavigation(); this.measureProfileNavigation(); },
  onResize() { this.updateNavigationLayout(); this.measureProfileNavigation(); },
  updateNavigationLayout() {
    let info = {}, capsule;
    try { info = wx.getWindowInfo(); capsule = wx.getMenuButtonBoundingClientRect(); } catch (error) { /* 保守适配旧客户端。 */ }
    const layout = navigationLayout(info, capsule);
    this._navGeometry = defaultGeometry(layout, info.windowWidth || info.screenWidth || 375);
    this.setData(layout);
    this.updateNavigationScroll();
  },
  measureProfileNavigation() {
    const version = this._navMeasurementVersion = (this._navMeasurementVersion || 0) + 1;
    const measure = () => {
      if (this._unloaded || this._visible === false || version !== this._navMeasurementVersion) return;
      const query = typeof this.createSelectorQuery === 'function' ? this.createSelectorQuery() :
        typeof wx.createSelectorQuery === 'function' ? wx.createSelectorQuery().in(this) : null;
      if (!query) return;
      query.select('.profile-cover').boundingClientRect();
      query.select('.profile-heading').boundingClientRect();
      query.select('.profile-scroll').scrollOffset();
      query.select('.profile-white').boundingClientRect();
      query.exec(result => {
        if (this._unloaded || this._visible === false || version !== this._navMeasurementVersion) return;
        const [cover, heading, viewport, white] = result;
        if (!cover || !heading || !cover.height || !heading.height) return;
        const top = viewport ? viewport.scrollTop : this._profileScrollTop || 0;
        const overlap = (cover.height - this.data.navHeight) * 32 / 260;
        const offset = white ? white.top + top - (cover.height - overlap) : 0;
        this._navGeometry = { coverHeight: cover.height, headingTop: heading.top + top - offset, headingBottom: heading.bottom + top - offset };
        this.updateNavigationScroll();
      });
    };
    if (typeof wx.nextTick === 'function') wx.nextTick(measure);
    else measure();
  },
  onProfileScroll(event) {
    if (this._unloaded || this._visible === false) return;
    this._profileScrollRevision = (this._profileScrollRevision || 0) + 1;
    this._scrollStableReads = 0;
    this.setProfileScrollPosition(event.detail.scrollTop);
    this.scheduleProfileScrollSync();
  },
  setProfileScrollPosition(value) {
    const previous = this._profileScrollTop || 0;
    this._profileScrollTop = Math.max(0, Number(value) || 0);
    const gesture = this._pullGesture;
    if (gesture && gesture.active && this._profileScrollTop > 1) this.cancelProfilePull();
    // 回顶前的手指位移用于滚动，不能算入到顶后的下拉距离。
    if (gesture && !gesture.active && (previous > 1 || this._profileScrollTop > 1)) {
      gesture.y = gesture.lastY;
    }
    const elapsed = Date.now() - (this._navFrameAt || 0);
    // 回到顶部立即清掉叠加层，不等尾帧，避免回滚结束后仍留下一帧接缝。
    if (this._profileScrollTop <= 1 || elapsed >= 16 || typeof setTimeout !== 'function') { this.clearNavigationFrame(); this.updateNavigationScroll(); }
    else if (!this._navFrame) this._navFrame = setTimeout(() => { this._navFrame = null; this.updateNavigationScroll(); }, 16 - elapsed);
  },
  scheduleProfileScrollSync() {
    if (this._unloaded || this._visible === false || typeof setTimeout !== 'function') return;
    if (this._scrollSyncTimer) clearTimeout(this._scrollSyncTimer);
    // 惯性停止后读取容器真实位置，不能假定一定收到最后一次 scrollTop=0。
    this._scrollSyncTimer = setTimeout(() => { this._scrollSyncTimer = null; this.syncProfileScrollPosition(); }, 80);
  },
  clearProfileScrollSync() {
    if (this._scrollSyncTimer && typeof clearTimeout === 'function') clearTimeout(this._scrollSyncTimer);
    this._scrollSyncTimer = null;
    this._scrollRead = null;
    this._scrollStableReads = 0;
  },
  syncProfileScrollPosition() {
    if (this._scrollRead || this._unloaded || this._visible === false) return;
    const query = typeof this.createSelectorQuery === 'function' ? this.createSelectorQuery() :
      typeof wx.createSelectorQuery === 'function' ? wx.createSelectorQuery().in(this) : null;
    if (!query) return;
    const request = this._scrollRead = { revision: this._profileScrollRevision || 0 };
    query.select('.profile-scroll').scrollOffset();
    query.select('.profile-scroll').boundingClientRect();
    query.select('.profile-cover').boundingClientRect();
    query.exec(result => {
      if (this._scrollRead !== request) return;
      this._scrollRead = null;
      if (this._unloaded || this._visible === false || request.revision !== (this._profileScrollRevision || 0)) return;
      const [offset, viewport, cover] = result || [];
      // 封面未参与下拉位移，可用其实际坐标交叉校准原生容器的位置。
      const visualTop = viewport && cover && Number.isFinite(viewport.top) && Number.isFinite(cover.top) ? viewport.top - cover.top : null;
      const top = visualTop === null ? offset && offset.scrollTop : visualTop;
      if (!Number.isFinite(top)) return;
      this._scrollStableReads = Math.abs(Math.max(0, top) - (this._profileScrollTop || 0)) <= .5 ? (this._scrollStableReads || 0) + 1 : 0;
      this.setProfileScrollPosition(top);
      // 若原生惯性仍在继续但没有派发新事件，继续核对，直到顶部或位置稳定。
      if (top > 1 && this._scrollStableReads < 2) this.scheduleProfileScrollSync();
    });
  },
  onProfileScrollUpper() { this.syncProfileScrollPosition(); this.scheduleProfileScrollSync(); },
  clearNavigationFrame() {
    if (this._navFrame && typeof clearTimeout === 'function') clearTimeout(this._navFrame);
    this._navFrame = null;
  },
  updateNavigationScroll() {
    if (!this._navGeometry || this._unloaded || this._visible === false) return;
    this._navFrameAt = Date.now();
    const state = navigationState(this._profileScrollTop, this.data.navHeight, this._navGeometry);
    const changed = Object.fromEntries(Object.entries(state).filter(([key, value]) => this.data[key] !== value));
    if (Object.keys(changed).length) this.setData(changed);
  },
  startProfilePull(event) {
    this._pullGesture = null;
    if (this._unloaded || this._visible === false || this.interactionBlocked() || this.data.commentPostId || this.data.postsMenuOpen || this.data.profileRefreshing) return;
    const touch = event.touches && event.touches[0];
    if (touch && event.touches.length === 1) {
      this._pullGesture = { x: touch.clientX, y: touch.clientY, lastY: touch.clientY, active: false };
      this.syncProfileScrollPosition();
    }
  },
  moveProfilePull(event) {
    const gesture = this._pullGesture, touch = event.touches && event.touches[0];
    if (!gesture || !touch) return;
    if (event.touches.length !== 1) { this.cancelProfilePull(); return; }
    gesture.lastY = touch.clientY;
    const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
    if (!gesture.active) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) || dy < -8) { this._pullGesture = null; return; }
      if (dy < 8) return;
      if ((this._profileScrollTop || 0) > 1) {
        gesture.y = touch.clientY;
        if (!this._scrollSyncTimer) this.scheduleProfileScrollSync();
        return;
      }
      gesture.active = true;
      this.setData({ pullDragging: true });
    }
    this._pullDistance = dy;
    const elapsed = Date.now() - (this._pullFrameAt || 0);
    if (elapsed >= 16 || typeof setTimeout !== 'function') { this.clearPullFrame(); this.paintProfilePull(); }
    else if (!this._pullFrame) this._pullFrame = setTimeout(() => { this._pullFrame = null; this.paintProfilePull(); }, 16 - elapsed);
  },
  clearPullFrame() {
    if (this._pullFrame && typeof clearTimeout === 'function') clearTimeout(this._pullFrame);
    this._pullFrame = null;
  },
  paintProfilePull() {
    if (!this._pullGesture || !this._pullGesture.active || this._unloaded || this._visible === false) return;
    this._pullFrameAt = Date.now();
    const state = pullState(this._pullDistance, this.data.pullMax, this.data.pullThreshold);
    const changed = Object.fromEntries(Object.entries(state).filter(([key, value]) => this.data[key] !== value));
    if (Object.keys(changed).length) this.setData(changed);
  },
  finishProfilePull() {
    const active = this._pullGesture && this._pullGesture.active;
    this.clearPullFrame();
    this.scheduleProfileScrollSync();
    if (!active) { this._pullGesture = null; return; }
    const state = pullState(this._pullDistance, this.data.pullMax, this.data.pullThreshold);
    this._pullGesture = null;
    this.setData({ profilePullOffset: 0, pullDragging: false, pullOpacity: 0 });
    if (state.profilePullOffset >= this.data.pullThreshold) return this.refreshProfilePosts();
  },
  cancelProfilePull() {
    this._pullGesture = null; this.clearPullFrame();
    this.setData({ profilePullOffset: 0, pullDragging: false, pullOpacity: 0 });
    this.scheduleProfileScrollSync();
  },
  resetProfilePull() {
    this._profilePullRequest = null;
    this.cancelProfilePull();
    if (this.data.profileRefreshing) this.setData({ profileRefreshing: false });
  },
  async refreshProfilePosts() {
    if (this.data.profileRefreshing || this.interactionBlocked() || !this.data.user || this._unloaded || this._visible === false) return;
    const request = this._profilePullRequest = {};
    this.setData({ profileRefreshing: true });
    try { if (this.data.selectedContent === 'album') await this.loadAlbum(true); else await this.loadOwnPosts(true); }
    finally {
      if (this._profilePullRequest === request) { this._profilePullRequest = null; this.setData({ profileRefreshing: false }); }
    }
  },
  syncNavigation() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({
      selected: 4, menuOpen: this.data.menuOpen, authBlocked: this.interactionBlocked(), commentsOpen: Boolean(this.data.commentPostId), composerOpen: Boolean(this.data.composerOpen),
    });
  },
  setMenuTabBarOpen(open) {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) tabBar.setData({ menuOpen: open });
  },
  setAuthBlocked(blocked) {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) tabBar.setData({ authBlocked: Boolean(blocked), composerOpen: Boolean(this.data.composerOpen && this._visible !== false && !this._unloaded) });
  },
  interactionBlocked() { return Boolean(this.data.authChecking || this.data.loginSheetOpen || this.data.composerOpen); },
  currentView(version) {
    return !this._unloaded && this._visible !== false && version === (this._viewVersion || 0);
  },
  async refresh(force = true) {
    if (this._refreshing || this.data.loading || this.data.coverBusy) return;
    this._refreshing = true;
    const version = this._viewVersion || 0;
    const cached = userService.getCachedUser();
    if (cached) this.applyUser(cached);
    else if (this.data.user) this.applyUser(null);
    this.setData({ loading: !cached, authChecking: !cached, error: '', ...(!cached ? { loginSheetOpen: false } : {}) });
    this.setAuthBlocked(this.interactionBlocked());
    try {
      const user = await userService.restore({ force: force !== false });
      if (this.currentView(version)) this.applyUser(user);
    }
    catch (error) {
      if (this.currentView(version)) {
        if (!cached || !userService.getCachedUser()) this.applyUser(null);
        if (force !== false || !cached || !userService.getCachedUser()) this.setData({ error: error.message || '登录状态读取失败，请重试' });
      }
    }
    finally { if (this.currentView(version)) { this._refreshing = false; this.setData({ loading: false }); } }
  },
  applyUser(user) {
    if ((this.data.user && this.data.user._id) !== (user && user._id)) {
      this.resetProfilePull();
      this.closeComments();
      this.closeMenu();
      this._accountVersion = (this._accountVersion || 0) + 1;
      this._pendingCover = null;
      this._postsRequest = null;
      this._albumRequest = null;
      this.setData({ albumImages: [], albumLoading: false, albumMoreLoading: false, albumHasMore: false, albumOffset: 0, albumError: '' });
      this.setData({ ownPosts: [], postCountText: '帖子', postsError: '', postsHasMore: false, postsOffset: 0, postsLoading: false, postsMoreLoading: false, postsMenuOpen: false, composerOpen: false });
    }
    if (user && this._pendingCover && user.coverFileID === this._pendingCover.fileID) this._pendingCover = null;
    const isVerified = Boolean(user && user.role === 'student' && user.certificationStatus === 'approved' && user.schoolId);
    const raw = user && user.createdAt;
    const date = raw ? new Date(raw && typeof raw === 'object' && '$date' in raw ? raw.$date : raw) : null;
    const joinedText = date && !Number.isNaN(date.getTime()) ? `${date.getFullYear()}年${date.getMonth() + 1}月 加入` : '';
    this.setData({
      user, identity: describeUser(user), isVerified, joinedText, authChecking: false, loginSheetOpen: !user,
      coverFileID: user ? user.coverFileID || '' : '', coverFailed: false, coverRetry: Boolean(this._pendingCover),
      likeCount: 0, followingCount: 0, followerCount: 0,
      certificationAction: user && user.certificationStatus === 'pending' ? '查看审核' :
        user && user.certificationStatus === 'rejected' ? '重新认证' : '去认证',
    });
    this.setAuthBlocked(!user);
    this.measureProfileNavigation();
    if (user) {
      const cachedPosts = square.cachedOwnFeed();
      if (cachedPosts) this.showOwnPosts(cachedPosts);
      if (this._visible === true && this.data.selectedContent === 'posts' && this.data.postScope === 'square') this.loadOwnPosts();
      if (this._visible === true && this.data.selectedContent === 'album') this.loadAlbum();
    }
  },
  async login() {
    if (!this.data.loginSheetOpen || this.data.loading || this.data.coverBusy || this._leavingLogin) return;
    const version = this._viewVersion || 0;
    this.setData({ loading: true, error: '' });
    try {
      const user = await userService.login();
      if (!this.currentView(version)) return;
      if (!user || !user._id) throw new Error('登录信息读取失败，请重试');
      this.applyUser(user);
      wx.showToast({ title: '登录成功' });
    } catch (error) { if (this.currentView(version)) this.setData({ error: error.message || '登录失败，请重试', loginSheetOpen: true }); }
    finally { if (this.currentView(version)) this.setData({ loading: false }); }
  },
  cancelLogin() {
    if (!this.data.loginSheetOpen || this._leavingLogin) return;
    this._leavingLogin = true;
    // 撤销尚未完成的登录，迟到响应不能重新建立已取消的本地会话。
    userService.logout();
    this._viewVersion = (this._viewVersion || 0) + 1;
    this.setData({ loading: false, error: '' });
    wx.switchTab({
      url: '/pages/home/index',
      fail: () => {
        if (!this._unloaded && this._visible !== false) this.setData({ error: '返回首页失败，请重试' });
      },
      complete: () => { this._leavingLogin = false; },
    });
  },
  async chooseCover() {
    if (this.interactionBlocked() || this.data.coverBusy || this.data.loading) return;
    if (!this.data.user) { wx.showToast({ title: '请先登录后设置封面', icon: 'none' }); return; }
    const userId = this.data.user._id;
    const version = this._accountVersion;
    const current = () => !this._unloaded && this._accountVersion === version && this.data.user && this.data.user._id === userId;
    this.setData({ coverBusy: true, error: '' });
    try {
      let fileID = this._pendingCover && this._pendingCover.fileID;
      if (!fileID) {
        const chosen = await wxCall('chooseMedia', { count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['compressed'] });
        if (!current()) return;
        let path = chosen.tempFiles[0].tempFilePath;
        let info = await wxCall('getImageInfo', { src: path });
        if (!['jpg', 'jpeg', 'png', 'webp'].includes(info.type.toLowerCase())) throw new Error('请选择 JPG、PNG 或 WebP 封面图片');
        try {
          path = (await wxCall('compressImage', { src: path, quality: 80, compressedWidth: Math.min(info.width, 1600) })).tempFilePath;
          info = await wxCall('getImageInfo', { src: path });
        } catch (error) { /* 无法压缩时检查原图大小。 */ }
        const file = await new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath: path, success: resolve, fail: reject }));
        if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('封面图片读取失败，请重新选择');
        if (file.size > 5 * 1024 * 1024) throw new Error('封面不能超过 5MB，请裁剪或压缩后再试');
        if (!current()) return;
        const filename = `cover-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${info.type.toLowerCase()}`;
        fileID = (await wx.cloud.uploadFile({ cloudPath: `avatars/${userId}/${filename}`, filePath: path })).fileID;
        if (!current()) return;
        this._pendingCover = { fileID };
      }
      const user = await userService.updateCover(fileID);
      if (!current()) return;
      if (!user || user.coverFileID !== fileID) throw new Error('封面保存未确认，请重试');
      this._pendingCover = null;
      this.applyUser(user);
      wx.showToast({ title: '封面已更新' });
    } catch (error) {
      if (current() && !/cancel/.test(error.errMsg || '')) this.setData({
        error: error.code === 'INVALID_ACTION' ? '封面服务尚未更新，请先部署 userService 云函数' : error.message || '封面保存失败，请重试',
        coverRetry: Boolean(this._pendingCover),
      });
    } finally { if (!this._unloaded) this.setData({ coverBusy: false }); }
  },
  onCoverError() { this.setData({ coverFailed: true }); },
  openMenu() {
    if (this.interactionBlocked() || this._unloaded || this.data.menuOpen) return;
    this.setData({ menuOpen: true });
    this.setMenuTabBarOpen(true);
    this.setMenuNavigationColor(true);
  },
  closeMenu() {
    if (!this.data.menuOpen) return;
    this.setData({ menuOpen: false });
    this.setMenuTabBarOpen(false);
    this.setMenuNavigationColor(false);
  },
  setMenuNavigationColor(open) {
    if (typeof wx.setNavigationBarColor === 'function') wx.setNavigationBarColor({
      frontColor: open ? '#000000' : '#ffffff', backgroundColor: '#ffffff', fail() {},
    });
  },
  stopMenuEvent() {},
  prepareHomeReturn() {
    if (this._homeReturnPrepared) return true;
    const home = this._homePage;
    if (!home || typeof home.prepareMenuReturn !== 'function') return false;
    home.prepareMenuReturn();
    this._homeReturnPrepared = true;
    return true;
  },
  backToHome() {
    if (this._returningHome || this._unloaded) return;
    this._returningHome = true;
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const homeIndex = pages.findIndex(page => page.route === 'pages/home/index');
    if (homeIndex >= 0) this._homePage = pages[homeIndex];
    const prepared = this.prepareHomeReturn();
    const fallback = () => {
      if (this._unloaded) return;
      wx.switchTab({ url: '/pages/home/index', fail: () => {
        this._returningHome = false;
        if (!this._unloaded) wx.showToast({ title: '返回首页失败，请重试', icon: 'none' });
      } });
    };
    const navigate = () => {
      if (this._unloaded) return;
      const delta = pages.length - 1 - homeIndex;
      if (homeIndex >= 0 && delta > 0) wx.navigateBack({ delta, fail: fallback });
      else fallback();
    };
    // 先恢复被个人主页覆盖的首页及底栏，再执行一次原生返回过渡。
    if (prepared && typeof wx.nextTick === 'function') wx.nextTick(navigate);
    else navigate();
  },
  openSearch() { if (!this.interactionBlocked()) wx.switchTab({ url: '/pages/search/index' }); },
  selectMenuItem(event) {
    if (this.interactionBlocked()) return;
    const item = [...this.data.menuItems, ...this.data.utilityMenuItems].find(entry => entry.key === event.currentTarget.dataset.key);
    if (item && item.key === 'certification') {
      if (!this.data.user) { wx.showToast({ title: '请先登录后进行认证', icon: 'none' }); return; }
      if (this.data.identity.isAdmin) { wx.showToast({ title: '管理员账号无需学生认证', icon: 'none' }); return; }
      this.closeMenu();
      this.openCertification();
      return;
    }
    if (item) wx.showToast({ title: `${item.label}功能将在后续开放`, icon: 'none' });
  },
  selectContent(event) {
    if (this.interactionBlocked()) return;
    const tab = this.data.contentTabs.find(item => item.key === event.currentTarget.dataset.key);
    if (!tab) return;
    if (tab.key === 'posts' && this.data.selectedContent === 'posts') {
      this.setData({ postsMenuOpen: !this.data.postsMenuOpen });
      return;
    }
    this.setData({ selectedContent: tab.key, emptyText: tab.empty, postsMenuOpen: false });
    if (tab.key === 'posts' && this.data.postScope === 'square') this.loadOwnPosts();
    if (tab.key === 'album') return this.loadAlbum();
  },
  closePostsMenu() { this.setData({ postsMenuOpen: false }); },
  selectPostScope(event) {
    if (this.interactionBlocked()) return;
    const scope = event.currentTarget.dataset.scope;
    if (!['square', 'campus'].includes(scope)) return;
    this.setData({ postScope: scope, postsMenuOpen: false });
    if (scope === 'square') this.loadOwnPosts();
  },
  showOwnPosts(result) {
    this.setData({ ownPosts: result.items.map(postPreview), postsHasMore: result.hasMore, postsOffset: result.nextOffset });
    this.updatePostCount(result);
  },
  updatePostCount(result = square.cachedOwnFeed()) {
    if (!result) return;
    const total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total :
      !result.hasMore && result.nextOffset === result.items.length ? result.items.length : null;
    this.setData({ postCountText: total === null ? '帖子' : `${total} 条帖子` });
  },
  async loadOwnPosts(force = false, append = false) {
    if (!this.data.user || this.interactionBlocked()) return;
    if (this._postsRequest) return this._postsRequest.promise;
    const cached = square.cachedOwnFeed();
    if (cached) this.showOwnPosts(cached);
    const request = { version: this._viewVersion || 0, account: this.data.user._id };
    this._postsRequest = request;
    const current = () => this._postsRequest === request && this.currentView(request.version) &&
      this.data.user && this.data.user._id === request.account;
    this.setData({ postsLoading: !cached && !this.data.ownPosts.length, postsMoreLoading: append, postsError: '' });
    request.promise = (async () => {
      try {
        const result = await square.list({ mine: true, force, offset: append ? this.data.postsOffset : 0 });
        if (current()) this.showOwnPosts(result);
      } catch (error) {
        if (current() && error.code !== 'SESSION_CHANGED') this.setData({ postsError: error.message || '动态读取失败，请稍后重试' });
      } finally {
        if (current()) {
          this._postsRequest = null;
          this.setData({ postsLoading: false, postsMoreLoading: false });
        }
      }
    })();
    return request.promise;
  },
  retryOwnPosts() { return this.loadOwnPosts(true); },
  showAlbum(result) { this.setData({ albumImages: result.items, albumHasMore: result.hasMore, albumOffset: result.nextOffset }); },
  async loadAlbum(force = false, append = false) {
    if (!this.data.user || this.interactionBlocked() || this._unloaded || this._visible === false) return;
    if (this._albumRequest) return this._albumRequest.promise;
    const cached = square.cachedAlbum();
    if (cached) this.showAlbum(cached);
    const request = { version: this._viewVersion || 0, account: this.data.user._id };
    this._albumRequest = request;
    const current = () => this._albumRequest === request && this.currentView(request.version) && this.data.user && this.data.user._id === request.account;
    this.setData({ albumLoading: !this.data.albumImages.length, albumMoreLoading: append, albumError: '' });
    request.promise = (async () => {
      try {
        const result = await square.album({ force, offset: append ? this.data.albumOffset : 0 });
        if (current()) this.showAlbum(result);
      } catch (error) { if (current() && error.code !== 'SESSION_CHANGED') this.setData({ albumError: error.message || '相册读取失败，请重试' }); }
      finally { if (current()) { this._albumRequest = null; this.setData({ albumLoading: false, albumMoreLoading: false }); } }
    })();
    return request.promise;
  },
  retryAlbum() { return this.loadAlbum(true); },
  async previewAlbum(event) {
    const files = this.data.albumImages.map(image => image.fileID), current = files[Number(event.currentTarget.dataset.index)];
    if (!current || this._albumPreviewing || this.interactionBlocked()) return;
    this._albumPreviewing = true;
    try { await postImages.previewImages(files, current); }
    catch (error) { if (!this._unloaded && error.code !== 'SESSION_CHANGED') wx.showToast({ title: error.message || '图片预览失败', icon: 'none' }); }
    finally { this._albumPreviewing = false; }
  },
  loadMoreOwnPosts() {
    if (this.data.profileRefreshing || this.data.pullDragging || this.interactionBlocked() || this.data.commentPostId || this.data.postsMenuOpen) return;
    if (this.data.selectedContent === 'album') { if (this.data.albumHasMore) return this.loadAlbum(false, true); return; }
    if (this.data.selectedContent === 'posts' && this.data.postScope === 'square' && this.data.postsHasMore) return this.loadOwnPosts(false, true);
  },
  shareProfile() { if (!this.interactionBlocked()) wx.showToast({ title: '个人主页分享将在后续开放', icon: 'none' }); },
  publishPost() {
    if (this.interactionBlocked() || !this.data.user || this.data.commentPostId) return;
    this.resetProfilePull();
    this.setData({ composerOpen: true, postsMenuOpen: false });
    this.syncNavigation();
  },
  closeComposer(event) {
    this.setData({ composerOpen: false });
    const user = userService.getCachedUser();
    if ((user && user._id) !== (this.data.user && this.data.user._id)) this.applyUser(user);
    if (event.detail.published) {
      const cached = square.cachedOwnFeed();
      if (cached) this.showOwnPosts(cached);
      this.loadOwnPosts(false);
      const album = square.cachedAlbum();
      if (album) this.showAlbum(album);
      if (this.data.selectedContent === 'album') this.loadAlbum(false);
    }
    this.syncNavigation();
  },
  editProfile() { if (!this.interactionBlocked() && this.data.user) wx.navigateTo({ url: '/pages/edit-profile/index' }); },
  openAccountAbout() { if (!this.interactionBlocked() && this.data.user) wx.navigateTo({ url: '/pages/account-about/index' }); },
  openCertification() {
    if (!this.interactionBlocked() && this.data.user && !this.data.identity.isAdmin) wx.navigateTo({ url: '/pages/certification/index' });
  },
  openAdmin() {
    if (!this.interactionBlocked() && this.data.identity.isAdmin) wx.navigateTo({ url: '/pages/admin/index' });
  },
  logout() {
    if (this.interactionBlocked() || !this.data.user || this._unloaded || this.data.loading || this.data.coverBusy || this.data.confirmingLogout) return;
    const userId = this.data.user._id;
    const accountVersion = this._accountVersion;
    const version = this._logoutVersion = (this._logoutVersion || 0) + 1;
    this.setData({ confirmingLogout: true });
    wx.showModal({
      title: '退出登录', content: '退出后会保留你的账号和已保存的资料。',
      success: result => {
        if (!result.confirm || this._unloaded || version !== this._logoutVersion ||
            accountVersion !== this._accountVersion || !this.data.user || this.data.user._id !== userId) return;
        userService.logout();
        this.closeMenu();
        this.applyUser(null);
        this.setData({ error: '', selectedContent: 'posts', emptyText: '还没有发布动态' });
      },
      fail: () => {
        if (!this._unloaded && version === this._logoutVersion) wx.showToast({ title: '暂时无法确认，请重试', icon: 'none' });
      },
      complete: () => {
        if (!this._unloaded && version === this._logoutVersion) this.setData({ confirmingLogout: false });
      },
    });
  },
});
