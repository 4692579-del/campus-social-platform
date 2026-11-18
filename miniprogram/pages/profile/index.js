const userService = require('../../services/user');
const { describeUser } = require('../../utils/user-role');
const { menuItems, utilityMenuItems } = require('../../utils/account-menu');
const square = require('../../services/square');
const { postPreview } = require('../../utils/post-view');
const postActions = require('../../utils/post-actions');

function wxCall(name, options) {
  return new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
}

Page({
  ...postActions,
  data: {
    user: null, loading: false, error: '', identity: describeUser(null),
    coverBusy: false, coverRetry: false, coverFailed: false, coverFileID: '',
    joinedText: '', isVerified: false, certificationAction: '去认证',
    navTop: 28, navButtonHeight: 32, navHeight: 72, searchRight: 104,
    menuOpen: false, confirmingLogout: false,
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
  },
  onLoad() {
    try {
      const info = wx.getWindowInfo();
      const capsule = wx.getMenuButtonBoundingClientRect();
      const statusBarHeight = info.statusBarHeight || 0;
      const valid = capsule && capsule.height > 0 && capsule.top >= statusBarHeight;
      const navTop = valid ? capsule.top : statusBarHeight + 8;
      const navButtonHeight = valid ? capsule.height : 32;
      const windowWidth = info.windowWidth || info.screenWidth || 375;
      const capsuleLeft = valid && Number.isFinite(capsule.left) ? capsule.left : windowWidth - 96;
      const searchRight = Math.max(12, windowWidth - capsuleLeft + 8);
      this.setData({ navTop, navButtonHeight, navHeight: navTop + navButtonHeight + 8, searchRight });
    } catch (error) { /* 使用保守的顶部留白，兼容不支持窗口信息的旧客户端。 */ }
    const cached = userService.getCachedUser();
    if (cached) this.applyUser(cached);
  },
  onUnload() {
    this.closeComments();
    this.setMenuTabBarOpen(false);
    this.setAuthBlocked(false);
    this._visible = false;
    this._viewVersion = (this._viewVersion || 0) + 1;
    this._unloaded = true;
    this._accountVersion = (this._accountVersion || 0) + 1;
  },
  onHide() {
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
    this._visible = true;
    this._viewVersion = (this._viewVersion || 0) + 1;
    this.syncNavigation();
    return this.refresh(false);
  },
  onReady() { this.syncNavigation(); },
  syncNavigation() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({
      selected: 4, menuOpen: this.data.menuOpen, authBlocked: this.interactionBlocked(), commentsOpen: Boolean(this.data.commentPostId),
    });
  },
  setMenuTabBarOpen(open) {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) tabBar.setData({ menuOpen: open });
  },
  setAuthBlocked(blocked) {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tabBar) tabBar.setData({ authBlocked: Boolean(blocked) });
  },
  interactionBlocked() { return Boolean(this.data.authChecking || this.data.loginSheetOpen); },
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
      this.closeComments();
      this.closeMenu();
      this._accountVersion = (this._accountVersion || 0) + 1;
      this._pendingCover = null;
      this._postsRequest = null;
      this.setData({ ownPosts: [], postsError: '', postsHasMore: false, postsOffset: 0, postsLoading: false, postsMoreLoading: false, postsMenuOpen: false });
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
    if (user) {
      const cachedPosts = square.cachedOwnFeed();
      if (cachedPosts) this.showOwnPosts(cachedPosts);
      if (this._visible === true && this.data.selectedContent === 'posts' && this.data.postScope === 'square') this.loadOwnPosts();
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
  backToHome() { wx.switchTab({ url: '/pages/home/index' }); },
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
  },
  async loadOwnPosts(force = false, append = false) {
    if (!this.data.user || this.interactionBlocked() || this._postsRequest) return;
    const cached = square.cachedOwnFeed();
    if (cached) this.showOwnPosts(cached);
    const request = { version: this._viewVersion || 0, account: this.data.user._id };
    this._postsRequest = request;
    const current = () => this._postsRequest === request && this.currentView(request.version) &&
      this.data.user && this.data.user._id === request.account;
    this.setData({ postsLoading: !cached && !this.data.ownPosts.length, postsMoreLoading: append, postsError: '' });
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
  },
  retryOwnPosts() { return this.loadOwnPosts(true); },
  async onPullDownRefresh() {
    try { if (this.data.selectedContent === 'posts' && this.data.postScope === 'square') await this.loadOwnPosts(true); }
    finally { wx.stopPullDownRefresh(); }
  },
  onReachBottom() {
    if (this.data.selectedContent === 'posts' && this.data.postScope === 'square' && this.data.postsHasMore) return this.loadOwnPosts(false, true);
  },
  async reactPost(event) {
    if (this.interactionBlocked() || this.data.postsMenuOpen || !this.data.user) return;
    const { id, kind } = event.detail;
    const post = this.data.ownPosts.find(item => item._id === id);
    this._reactions = this._reactions || new Set();
    if (!post || this._reactions.has(id)) return;
    this._reactions.add(id);
    const version = this._viewVersion || 0, account = this.data.user._id;
    const current = () => this.currentView(version) && this.data.user && this.data.user._id === account;
    try {
      const latest = await square.react(id, kind, !(kind === 'like' ? post.liked : post.reposted));
      if (current()) this.setData({ ownPosts: this.data.ownPosts.map(item => item._id === id ? postPreview(latest) : item) });
    } catch (error) {
      if (current()) {
        wx.showToast({ title: error.message, icon: 'none' });
        if (!userService.getCachedUser()) this.applyUser(null);
      }
    } finally { this._reactions.delete(id); }
  },
  onShareAppMessage(options) {
    return this.buildPostShare(options);
  },
  shareProfile() { if (!this.interactionBlocked()) wx.showToast({ title: '个人主页分享将在后续开放', icon: 'none' }); },
  publishPost() {
    if (this.interactionBlocked() || !this.data.user) return;
    wx.navigateTo({ url: '/pages/square-compose/index' });
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
