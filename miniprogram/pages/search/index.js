const secondaryTabPage = require('../../utils/secondary-tab-page');
const users = require('../../services/user');
const tabSelection = require('../../utils/tab-selection');
const { resultUrl } = require('../../utils/search-query');
const hotboard = require('../../services/hotboard');
const square = require('../../services/square');
const postActions = require('../../utils/post-actions');
const { accountMenuRoutes, menuItems, utilityMenuItems } = require('../../utils/account-menu');
const { patchState } = require('../../utils/tab-page-layout');
const searchRefresh = require('./refresh');
const base = secondaryTabPage(3);
const DEFAULT_HOT_VISIBLE = 10;
const HOT_VISIBLE_INCREMENT = 10;
const HOT_BOARD_INDEX = 2;
const CUI_HOT_TYPE = 'toutiao';
const RECOMMENDED_ACCOUNTS = ['10000001', '19090448', '58732480', '45214114'];
const DEFAULT_AVATAR = '/images/avatar.png';
const CUI_PROMO_FILE = 'cloud://campus-social-dev-d3dmcsfefdcae4.6361-campus-social-dev-d3dmcsfefdcae4-1531135264/square-media/cui-brand/cui-promo.mp4';
// 账号 10000001 发布的「你好，欢迎来到『萃』」宣传动态。
const CUI_PROMO_POST_ID = 'p_1efff1a54dbe48e2e8e6ceb309fc2f56bde1a7e6';
Page({
  ...base,
  ...accountMenuRoutes(wx),
  ...searchRefresh.methods,
  data: { ...base.data, ...searchRefresh.data,
    user:null, avatarSource:DEFAULT_AVATAR, avatarReady:true, loading:false, accountError:'', accountHint:'未登录',
    menuOpen:false, menuInstant:false, authChecking:false, loginSheetOpen:false, confirmingLogout:false, membershipOpen:false,
    menuLikeCount:'—', followerCount:'—', followingCount:'—', menuItems, utilityMenuItems,
    hotPlatforms: [{ key:'weibo', label:'微博' }, { key:'zhihu', label:'知乎' }, { key:'bilibili', label:'B站' }, { key:'baidu', label:'百度' }],
    hotType:'weibo', hotRows:[], hotHasMore:false, hotLoading:false, hotError:'', hotWarning:'',
    cuiHotRows:[], cuiHotHasMore:false, cuiHotLoading:false, cuiHotError:'', cuiHotWarning:'',
    boardMinHeight:300, boardsMounted:false,
    cuiPromoSrc:'', cuiPromoError:false, cuiPromoLoading:false, cuiPromoMuted:true,
    recommendations:[],
    boardIndex:0, boardTabs:['Cui热榜','校园热榜','探索'], hotBoardIndex:HOT_BOARD_INDEX, platformMenuOpen:false, chromeCompact:false, searchActive:false,
  },
  onLoad() { base.onLoad.call(this); this._searchSession = users.searchSessionKey(); this.applyMenuUser(users.getCachedUser()); },
  onShow() {
    this._openingNews = false;
    this._openingAuthor = false;
    this._openingCuiPromoPost = false;
    const returningFromMenu = this._menuNavigating || this._menuReturning;
    const firstShow = !this.data.boardsMounted;
    const session = users.searchSessionKey(), entry = users.consumeSearchEntry();
    const enteredFromTabBar = !returningFromMenu && tabSelection.pendingIndex() === 3;
    this._searchSession = session;
    this._openingResults = false;
    this._openingSearchEntry = false;
    this._menuNavigating = false;
    this._menuReturning = false;
    this._searchContentPending = true;
    this.applyMenuUser(users.getCachedUser());
    this.setData({ ...(returningFromMenu ? {} : { chromeCompact:false }), menuOpen:false, menuInstant:true,
      platformMenuOpen:false, searchActive:true, cuiPromoMuted:true, ...(enteredFromTabBar ? { boardIndex:0 } : {}) });
    base.onShow.call(this);
    this._stopRecommendationFollows?.();
    this._stopRecommendationFollows = square.subscribeFollow?.(({ accountId }) => {
      if (RECOMMENDED_ACCOUNTS.includes(accountId) && this.data.searchActive && this.data.boardIndex === 0) this.syncRecommendations();
    });
    this._hotView = (this._hotView || 0) + 1; this._hotRequest = null;
    // 已有的会话榜单可同步显示，联网刷新和视频初始化留到页面显示后。
    if (!firstShow && this.data.boardIndex === 0) {
      const board = hotboard.cached(CUI_HOT_TYPE);
      if (board) this.showCuiHotboard(board);
    } else if (!firstShow && this.data.boardIndex === HOT_BOARD_INDEX) {
      const board = hotboard.cached(this.data.hotType);
      if (board) this.showHotboard(board);
    }
    if (entry) this.openSearchEntry(entry.accountId);
    const view = this._hotView;
    const load = () => this.loadVisibleSearchContent(view);
    if (typeof wx.nextTick !== 'function') load();
    else if (this._searchReady) wx.nextTick(load);
  },
  onReady() {
    base.onReady?.call(this);
    this._searchReady = true;
    this.loadVisibleSearchContent(this._hotView);
  },
  loadVisibleSearchContent(view) {
    if (!this._searchContentPending || view !== this._hotView || !this.data.searchActive || this._visible === false || this._unloaded) return;
    this._searchContentPending = false;
    patchState(this, { boardsMounted:true });
    this.measureSearchLayout();
    this.refreshMenuAvatar();
    if (this.data.boardIndex === HOT_BOARD_INDEX) this.activateHotboard();
    else if (this.data.boardIndex === 0) this.activateCuiBoard();
  },
  onResize() { base.onResize?.call(this); this.measureSearchLayout(); },
  onHide() {
    this.stopRecommendations();
    this.closeMembership();
    this.stopSearchRefresh();
    this.pauseCuiPromo();
    this._hotView = (this._hotView || 0) + 1;
    this._hotRequest = null;
    this._cuiHotRequest = null;
    this._menuAuthRequest = null;
    this._menuAvatarRequest = null;
    this._logoutRequest = null;
    this.setData({ hotLoading:false, cuiHotLoading:false, ...(this._menuNavigating ? {} : { menuOpen:false, chromeCompact:false }),
      platformMenuOpen:false, searchActive:false, loading:false, loginSheetOpen:false, authChecking:false, confirmingLogout:false });
    base.onHide.call(this);
  },
  onUnload() {
    this.stopRecommendations();
    this.closeMembership();
    this.stopSearchRefresh();
    this.pauseCuiPromo();
    this._hotView = (this._hotView || 0) + 1;
    this._hotRequest = null;
    this._cuiHotRequest = null;
    this._menuAuthRequest = null;
    this._menuAvatarRequest = null;
    this._logoutRequest = null;
    base.onUnload.call(this);
  },
  applyMenuUser(user) {
    const changed = this.data.user?._id !== user?._id;
    const avatar = user?.avatarFileID || DEFAULT_AVATAR;
    patchState(this, { user, ...(changed || this._menuAvatar !== avatar ? { avatarSource:avatar, avatarReady:avatar === DEFAULT_AVATAR } : {}),
      ...(changed ? { menuLikeCount:'—', followerCount:'—', followingCount:'—' } : {}) });
    this._menuAvatar = avatar;
    const session = users.searchSessionKey();
    if (this._recommendationSession !== session || changed) {
      this.syncRecommendations();
      if (!this._searchContentPending && this.data.searchActive && this.data.boardIndex === 0) this.loadRecommendations();
    }
  },
  async refreshMenuAvatar() {
    const request = this._menuAvatarRequest = {};
    try {
      const user = await users.restore({ force:false });
      if (this._menuAvatarRequest !== request || user !== users.getCachedUser()) return;
      if (this._searchSession !== users.searchSessionKey()) {
        this._searchSession = users.searchSessionKey();
        this.stopSearchRefresh();
        this.closeMenu();
      }
      this.applyMenuUser(user);
    } catch (_) { /* 保留已显示的会话头像。 */ }
  },
  onHomeAvatarLoad(event) {
    if (event.currentTarget.dataset.source === this.data.avatarSource) patchState(this, { avatarReady:true });
  },
  onAvatarError(event) {
    if (event.currentTarget.dataset.source === this.data.avatarSource && this.data.avatarSource !== DEFAULT_AVATAR)
      patchState(this, { avatarSource:DEFAULT_AVATAR, avatarReady:true });
  },
  interactionBlocked() { return this.data.authChecking || this.data.loginSheetOpen || this.data.membershipOpen === true; },
  stopMenuEvent() {},
  openMenu() {
    if (this._unloaded || this._visible === false || this.data.menuOpen || this.interactionBlocked() || this._openingSearchEntry || this._openingResults || this._openingCuiPromoPost) return;
    this.stopSearchRefresh();
    this.closePlatformMenu();
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
    const cached = users.getCachedUser();
    if (cached) { this.showAccountMenu(cached); return; }
    return this.confirmMenuAccount();
  },
  showAccountMenu(user) {
    this.pauseCuiPromo();
    this.applyMenuUser(user);
    patchState(this, { menuOpen:true, menuInstant:false, loginSheetOpen:false, authChecking:false, accountError:'' });
    this.syncNavigation();
    const session = users.searchSessionKey();
    const current = () => !this._unloaded && this._visible !== false && this.data.menuOpen && users.searchSessionKey() === session;
    const showLikes = stats => { if (stats && current()) patchState(this, { menuLikeCount:stats.receivedLikes }); };
    const showFollows = stats => { if (stats && current()) patchState(this, { followerCount:stats.followerCount, followingCount:stats.followingCount }); };
    showLikes(square.cachedOwnStats());
    showFollows(square.cachedFollowProfile(user.accountId));
    square.getOwnStats().then(showLikes).catch(() => {});
    if (user.accountId) square.getFollowProfile(user.accountId).then(showFollows).catch(() => {});
  },
  async confirmMenuAccount() {
    this.pauseCuiPromo();
    const request = this._menuAuthRequest = {};
    patchState(this, { authChecking:true, accountError:'' });
    this.syncNavigation();
    let accountError = '';
    try {
      const user = await users.restore({ force:false });
      if (this._menuAuthRequest !== request) return;
      if (user) { this.showAccountMenu(user); return; }
    } catch (error) { accountError = error.message || '账号信息暂不可用'; }
    if (this._menuAuthRequest !== request) return;
    patchState(this, { authChecking:false, loginSheetOpen:true, accountError });
    this.syncNavigation();
  },
  async login() {
    if (!this.data.loginSheetOpen || this.data.loading) return;
    const request = this._menuAuthRequest = {};
    patchState(this, { loading:true, accountError:'' });
    try {
      const user = await users.login();
      if (this._menuAuthRequest === request) {
        if (!user?._id) throw new Error('登录信息读取失败，请重试');
        this._searchSession = users.searchSessionKey();
        this.showAccountMenu(user);
        wx.showToast({ title:'登录成功' });
      }
    } catch (error) {
      if (this._menuAuthRequest === request) patchState(this, { accountError:error.message || '登录失败，请重试' });
    } finally {
      if (this._menuAuthRequest === request) patchState(this, { loading:false });
    }
  },
  cancelLogin() {
    if (!this.data.loginSheetOpen) return;
    this._menuAuthRequest = null;
    users.logout();
    this.applyMenuUser(null);
    patchState(this, { loading:false, loginSheetOpen:false, authChecking:false, accountError:'' });
    this.syncNavigation();
    this.playCuiPromo();
  },
  closeMenu() {
    if (!this.data.menuOpen || this._menuNavigating) return;
    patchState(this, { menuOpen:false });
    this.syncNavigation();
    this.playCuiPromo();
  },
  prepareMenuReturn() {
    if (this._unloaded || (!this._menuNavigating && !this.data.menuOpen)) return;
    this._menuReturning = true;
    this._menuNavigating = false;
    this.applyMenuUser(users.getCachedUser());
    patchState(this, { menuOpen:false, menuInstant:true });
    this.syncNavigation(true);
  },
  logout() {
    if (this._unloaded || this._visible === false || this._menuNavigating || !this.data.user || this.data.loading || this.data.confirmingLogout) return;
    const session = users.searchSessionKey(), request = this._logoutRequest = {};
    patchState(this, { confirmingLogout:true });
    wx.showModal({
      title:'退出登录', content:'退出后会保留你的账号和已保存的资料。',
      success: result => {
        if (!result.confirm || this._logoutRequest !== request || session !== users.searchSessionKey()) return;
        users.logout();
        this.applyMenuUser(null);
        this._searchSession = users.searchSessionKey();
        this.closeMenu();
        wx.showToast({ title:'已退出登录' });
      },
      fail: () => { if (this._logoutRequest === request) wx.showToast({ title:'暂时无法确认，请重试', icon:'none' }); },
      complete: () => { if (this._logoutRequest === request) patchState(this, { confirmingLogout:false }); },
    });
  },
  playCuiPromo() {
    if (this._unloaded || this._visible === false || this.data.boardIndex !== 0 || this.data.menuOpen || this.interactionBlocked()) return;
    if (!this.data.cuiPromoSrc) return this.loadCuiPromo();
    if (typeof wx.createVideoContext === 'function') wx.createVideoContext('cui-promo').play();
  },
  async loadCuiPromo() {
    if (this._unloaded || this._visible === false || this.data.boardIndex !== 0 || this._cuiPromoRequest || this.data.cuiPromoSrc || !wx.cloud?.getTempFileURL) return;
    const request = this._cuiPromoRequest = {};
    this.setData({ cuiPromoLoading:true, cuiPromoError:false });
    try {
      const result = await wx.cloud.getTempFileURL({ fileList:[CUI_PROMO_FILE] });
      const file = result.fileList?.[0];
      if (this._cuiPromoRequest !== request || this._unloaded) return;
      if (file?.status === 0 && file.tempFileURL) this.setData({ cuiPromoSrc:file.tempFileURL });
      else this.setData({ cuiPromoError:true });
    } catch (_) {
      if (this._cuiPromoRequest === request && !this._unloaded) this.setData({ cuiPromoError:true });
    } finally {
      if (this._cuiPromoRequest === request) {
        this._cuiPromoRequest = null;
        if (!this._unloaded) this.setData({ cuiPromoLoading:false });
      }
    }
  },
  cuiPromoFailed() { this.setData({ cuiPromoSrc:'', cuiPromoError:true }); },
  toggleCuiPromoSound() {
    if (this._unloaded || this._visible === false || this._openingCuiPromoPost || !this.data.cuiPromoSrc ||
        this.data.boardIndex !== 0 || this.data.menuOpen || this.interactionBlocked()) return;
    this.setData({ cuiPromoMuted:!this.data.cuiPromoMuted });
  },
  openCuiPromoPost() {
    if (this._openingCuiPromoPost || this._openingSearchEntry || this._openingResults || this._unloaded ||
        this._visible === false || this.data.boardIndex !== 0 || this.data.menuOpen || this.interactionBlocked()) return;
    this._openingCuiPromoPost = true;
    wx.navigateTo({ url: `/pages/square-detail/index?id=${CUI_PROMO_POST_ID}`, fail: () => {
      this._openingCuiPromoPost = false;
      if (!this._unloaded && this._visible !== false) wx.showToast({ title: '动态打开失败，请重试', icon: 'none' });
    } });
  },
  pauseCuiPromo() {
    if (this.data.cuiPromoSrc && typeof wx.createVideoContext === 'function') wx.createVideoContext('cui-promo').pause();
  },
  activateCuiBoard() {
    this.playCuiPromo();
    this.loadRecommendations();
    const cached = hotboard.cached(CUI_HOT_TYPE);
    if (cached) this.showCuiHotboard(cached);
    return this.loadCuiHotboard();
  },
  syncRecommendations() {
    const session = users.searchSessionKey(), viewer = users.getCachedUser();
    if (session !== this._recommendationSession) {
      this._recommendationSession = session;
      this._recommendationsRequest = null;
    }
    const ids = viewer && this.data.user?._id === viewer._id
      ? RECOMMENDED_ACCOUNTS.filter(id => id !== viewer.accountId && !square.isBlocked?.(id)) : [];
    const recommendations = ids.flatMap(accountId => {
      const profile = users.getCachedPublicProfile?.(accountId);
      if (!profile || profile.blocked) return [];
      return [{ accountId, nickname: profile.nickname, avatarFileID: profile.avatarFileID || '',
        verified: Boolean(profile.isVerified), officialVerified: Boolean(profile.officialVerified),
        following: Boolean(square.cachedFollowState?.(accountId)?.following) }];
    });
    if (JSON.stringify(recommendations) !== JSON.stringify(this.data.recommendations)) this.setData({ recommendations });
    return ids;
  },
  loadRecommendations() {
    const ids = this.syncRecommendations();
    if (!ids.length || !this.data.searchActive || this.data.boardIndex !== 0 || this._unloaded) return;
    if (this._recommendationsRequest) return this._recommendationsRequest.promise;
    const request = this._recommendationsRequest = { session: this._recommendationSession };
    const paint = () => {
      if (this._recommendationsRequest === request && request.session === users.searchSessionKey() &&
          this.data.searchActive && this.data.boardIndex === 0) this.syncRecommendations();
    };
    const profiles = Promise.allSettled(ids.map(id => users.getPublicProfile(id))).then(paint);
    const follows = square.getFollowStates(ids).then(paint).catch(() => { /* 保留当前关注状态。 */ });
    request.promise = Promise.all([profiles, follows]).finally(() => {
      if (this._recommendationsRequest === request) this._recommendationsRequest = null;
    });
    return request.promise;
  },
  stopRecommendations() {
    this._recommendationsRequest = null;
    this._stopRecommendationFollows?.();
    this._stopRecommendationFollows = null;
  },
  canUseRecommendations() {
    const viewer = users.getCachedUser();
    return !this._unloaded && this._visible !== false && this.data.searchActive && this.data.boardIndex === 0 &&
      !this.data.menuOpen && !this.interactionBlocked() && !this._openingAuthor && !this._openingSearchEntry &&
      !this._openingResults && !this._openingCuiPromoPost && viewer && this.data.user?._id === viewer._id &&
      this._recommendationSession === users.searchSessionKey();
  },
  openRecommendation(event) {
    if (!this.canUseRecommendations()) return;
    const author = this.data.recommendations.find(row => row.accountId === event.currentTarget.dataset.accountId);
    if (!author) return;
    this.stopSearchRefresh();
    postActions.viewAuthorProfile.call(this, { detail: { author } });
  },
  followRecommendation(event) {
    if (!this.canUseRecommendations()) return;
    const accountId = event.currentTarget.dataset.accountId;
    if (!this.data.recommendations.some(row => row.accountId === accountId && !row.following) || square.cachedFollowState(accountId)?.following) return;
    return postActions.persistFollowIntent.call(this, accountId, true);
  },
  paintFollowPresentation(accountId) {
    if (RECOMMENDED_ACCOUNTS.includes(accountId) && this._visible !== false && this.data.searchActive && this.data.boardIndex === 0) this.syncRecommendations();
  },
  showCuiHotboard(board) {
    const count = this._cuiHotVisible || DEFAULT_HOT_VISIBLE;
    this.setData({ cuiHotRows:board.list.slice(0, count), cuiHotHasMore:count < board.list.length, cuiHotError:'',
      cuiHotWarning:board.stale ? '更新暂不可用，显示上次获取的榜单' : '' });
  },
  loadCuiHotboard(force = false) {
    if (this._unloaded || this._visible === false || this.data.boardIndex !== 0) return;
    if (this._cuiHotRequest) return this._cuiHotRequest.promise;
    const request = this._cuiHotRequest = {};
    const current = () => this._cuiHotRequest === request && this._visible !== false && !this._unloaded;
    patchState(this, { cuiHotLoading:true, cuiHotError:'' });
    request.promise = hotboard.load(CUI_HOT_TYPE, { force:force === true }).then(board => {
      if (current() && this.data.boardIndex === 0) this.showCuiHotboard(board);
    }).catch(error => {
      if (current() && this.data.boardIndex === 0) this.setData({ cuiHotError:error.message || '热榜暂不可用，请稍后再试' });
    }).finally(() => {
      if (!current()) return;
      this._cuiHotRequest = null;
      patchState(this, { cuiHotLoading:false });
    });
    return request.promise;
  },
  showMoreCuiHotwords() {
    if (this._unloaded || this._visible === false || this.data.boardIndex !== 0 || !this.data.cuiHotHasMore) return;
    const board = hotboard.cached(CUI_HOT_TYPE);
    if (!board) return this.loadCuiHotboard();
    this._cuiHotVisible = (this._cuiHotVisible || DEFAULT_HOT_VISIBLE) + HOT_VISIBLE_INCREMENT;
    this.showCuiHotboard(board);
  },
  showHotboard(board) {
    if (board.type !== this.data.hotType) return;
    const count = Math.min(this._hotVisible?.[board.type] || DEFAULT_HOT_VISIBLE, board.list.length);
    this.setData({ hotRows:board.list.slice(0, count), hotHasMore:count < board.list.length, hotError:'',
      hotWarning:board.stale ? '更新暂不可用，显示上次获取的榜单' : '' });
  },
  showMoreHotwords() {
    if (this._visible === false || this._unloaded || !this.data.hotHasMore) return;
    const board = hotboard.cached(this.data.hotType); if (!board) return this.loadHotboard();
    const counts = this._hotVisible || (this._hotVisible = {});
    counts[board.type] = (counts[board.type] || DEFAULT_HOT_VISIBLE) + HOT_VISIBLE_INCREMENT; this.showHotboard(board);
  },
  loadHotboard(force = false) {
    if (this._visible === false || this._unloaded) return Promise.resolve();
    if (this._hotRequest) return this._hotRequest.promise;
    const request = this._hotRequest = { type:this.data.hotType, view:this._hotView };
    const current = () => this._hotRequest === request && !this._unloaded && this._visible !== false && request.view === this._hotView && request.type === this.data.hotType;
    this.setData({ hotLoading:true, hotError:'' });
    request.promise = hotboard.load(request.type, { force:force === true }).then(board => { if (current()) this.showHotboard(board); })
      .catch(error => { if (current()) this.setData({ hotError:error.message || '热榜暂不可用，请稍后再试' }); })
      .finally(() => { if (current()) { this._hotRequest = null; this.setData({ hotLoading:false }); } });
    return request.promise;
  },
  selectHotPlatform(event) {
    if (this._visible === false || this._unloaded) return;
    const type = event.currentTarget.dataset.type;
    this.closePlatformMenu();
    if (type === this.data.hotType || !this.data.hotPlatforms.some(item => item.key === type)) return;
    this.stopSearchRefresh();
    this._hotView = (this._hotView || 0) + 1; this._hotRequest = null;
    const cached = hotboard.cached(type);
    this.setData({ hotType:type, hotRows:[], hotHasMore:false, hotError:'', hotWarning:'' });
    if (cached) this.showHotboard(cached);
    return this.loadHotboard();
  },
  searchHotword(event) {
    if (this._openingResults || this._openingSearchEntry || this._visible === false || this._unloaded || this.data.menuOpen || this.interactionBlocked()) return;
    const rows = this.data.boardIndex === 0 ? this.data.cuiHotRows : this.data.hotRows;
    const row = rows.find(item => item.rank === Number(event.currentTarget.dataset.rank));
    if (!row) return;
    // 热搜入口查询站内所有作者；只传文字，绝不跟随第三方 URL。
    const keyword = Array.from(row.title).slice(0, 100).join('');
    let url;
    try { url = resultUrl({ keyword }); } catch (error) { wx.showToast({ title: error.message, icon: 'none' }); return; }
    this._openingResults = true;
    wx.navigateTo({ url, fail: () => {
      this._openingResults = false;
      if (!this._unloaded && this._visible !== false) wx.showToast({ title: '搜索结果页打开失败，请重试', icon: 'none' });
    } });
  },
  tapSearchEntry() { this.openSearchEntry(); },
  openSearchEntry(accountId = '') {
    if (this._openingSearchEntry || this._openingResults || this._openingCuiPromoPost || this._unloaded ||
        this._visible === false || this.data.menuOpen || this.interactionBlocked()) return;
    this._openingSearchEntry = true;
    const author = /^[1-9][0-9]{7}$/.test(accountId) ? `?accountId=${accountId}` : '';
    wx.navigateTo({ url: '/pages/search-entry/index' + author, fail: () => {
      this._openingSearchEntry = false;
      if (!this._unloaded && this._visible !== false) wx.showToast({ title:'搜索页打开失败，请重试', icon:'none' });
    } });
  },
  measureSearchLayout() {
    const version = this._searchMeasure = (this._searchMeasure || 0) + 1;
    const measure = () => {
      if (this._unloaded || this._visible === false || version !== this._searchMeasure || typeof this.createSelectorQuery !== 'function') return;
      const query = this.createSelectorQuery(); query.select('.search-discovery').boundingClientRect();
      query.exec(rows => {
        if (this._unloaded || this._visible === false || version !== this._searchMeasure) return;
        let width = 375; try { width = wx.getWindowInfo().windowWidth || width; } catch (_) {}
        this.setData({ boardMinHeight:Math.max(0, (rows[0]?.height || 400) - 84 * width / 750) });
      });
    };
    if (typeof wx.nextTick === 'function') wx.nextTick(measure); else measure();
  },
  stopSearchEvent() {},
  selectBoardTab(event) {
    if (this.data.menuOpen || this.interactionBlocked()) return;
    const index = Number(event.currentTarget.dataset.index);
    if (![0,1,2].includes(index)) return;
    if (index !== this.data.boardIndex) this.stopSearchRefresh();
    if (index !== 0) this.pauseCuiPromo();
    this.setData({ boardIndex:index, platformMenuOpen:false });
    if (index === 0) this.activateCuiBoard();
    else if (index === HOT_BOARD_INDEX) this.activateHotboard();
  },
  activateHotboard() {
    const cached = hotboard.cached(this.data.hotType);
    if (cached) this.showHotboard(cached);
    return this.loadHotboard();
  },
  exploreHotList() {
    if (!this.data.searchActive || this.data.boardIndex !== HOT_BOARD_INDEX || this._openingNews || this._openingResults ||
        this._openingSearchEntry || this._unloaded || this._visible === false || this.data.menuOpen || this.interactionBlocked()) return;
    this.closePlatformMenu();
    this._openingNews = true;
    wx.navigateTo({ url: '/pages/global-news/index', fail: () => {
      this._openingNews = false;
      if (!this._unloaded && this._visible !== false) wx.showToast({ title: '全球新闻打开失败，请重试', icon: 'none' });
    } });
  },
  togglePlatformMenu() {
    if (this.data.menuOpen || this.interactionBlocked()) return;
    this.stopSearchRefresh();
    this.pauseCuiPromo();
    this.setData({ boardIndex:HOT_BOARD_INDEX, platformMenuOpen:!this.data.platformMenuOpen });
    this.activateHotboard();
  },
  closePlatformMenu() { if (this.data.platformMenuOpen) this.setData({ platformMenuOpen:false }); },
  setSearchCompact(value) {
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (this._unloaded || this._visible === false || bar?._switching || this.data.menuOpen || this.interactionBlocked()) return;
    if (this.data.chromeCompact !== value.compact) {
      this.setData({ chromeCompact:value.compact });
      if (typeof bar?.setDockScrollCompact === 'function') bar.setDockScrollCompact(value.compact);
      else if (bar) bar.setData({ compact:value.compact });
    }
    this.closePlatformMenu();
  },
  syncNavigation(preparingReturn = false) {
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (!bar || this._unloaded || (this._visible === false && !preparingReturn) || bar._switching) return;
    const values = { compact:Boolean(this.data.chromeCompact), menuOpen:this.data.menuOpen, menuInstant:this.data.menuInstant,
      authBlocked:Boolean(this.interactionBlocked()), commentsOpen:false, composerOpen:false };
    if (typeof bar.syncFromPage === 'function' && !preparingReturn) bar.syncFromPage(3, values);
    else if (typeof bar.syncFromPage === 'function') patchState(bar, values);
    else patchState(bar, { ...values, selected:3 });
  },
});
