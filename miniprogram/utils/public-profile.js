const users = require('../services/user');
const square = require('../services/square');
const { describeUser } = require('./user-role');

module.exports = { methods: {
  initializePublicProfile(accountId) {
    this.setData({ isVisitor: true, profileAccountId: accountId, profileUser: null, authChecking: !users.getCachedUser(), loginSheetOpen: false,
      user: users.getCachedUser(), likeCount: '—', followingCount: '—', followerCount: '—' });
    this._publicViewerVersion = users.getSessionVersion();
    if (!/^[1-9][0-9]{7}$/.test(accountId || '')) { this.setData({ profileUnavailable: true, authChecking: false, error: '个人主页地址不正确' }); return; }
    const cached = users.getCachedPublicProfile(accountId);
    if (cached) this.applyPublicProfile(cached);
    this.prefillPublicContent();
  },
  cancelPublicReads() { this._publicRefresh = null; this._publicContentRequests = {}; },
  applyPublicViewer(viewer, keepRefresh = false, checking = false) {
    const changed = (this.data.user && this.data.user._id) !== (viewer && viewer._id) || this._publicViewerVersion !== users.getSessionVersion();
    if (changed) {
      this.resetProfilePull();
      this.resetProfileVideos();
      this.closeUnfollowPrompt(true);
      if (keepRefresh) this._publicContentRequests = {}; else this.cancelPublicReads();
      this.closeComments();
      this.setData({ profileUser: null, coverFileID: '', ownPosts: [], quotePosts: [], albumImages: [], pinnedPostId: '',
        postsHasMore: false, quotesHasMore: false, albumHasMore: false, postsOffset: 0, quotesOffset: 0, albumOffset: 0, postCountText: '帖子',
        likeCount: '—', followingCount: '—', followerCount: '—', followKnown: false, profileFollowing: false, profileBlocked: false, followBusy: false, followError: '', loading: false, error: '', profileUnavailable: false, postsError: '', quotesError: '', albumError: '', mediaMenuOpen: false, mediaTab: 'album' });
    }
    this._publicViewerVersion = users.getSessionVersion();
    this.setData({ user: viewer, identity: describeUser(viewer), authChecking: Boolean(checking && !viewer), loginSheetOpen: Boolean(!viewer && !checking) });
    this.setAuthBlocked(!viewer);
    if (viewer) {
      if (square.isBlocked?.(this.data.profileAccountId)) this.applyProfileBlock(true);
      const cached = users.getCachedPublicProfile(this.data.profileAccountId);
      if (cached) this.applyPublicProfile(cached);
      this.prefillPublicContent();
    }
  },
  applyPublicProfile(profile) {
    if (!profile || profile.accountId !== this.data.profileAccountId) return;
    const raw = profile.createdAt && profile.createdAt.$date || profile.createdAt;
    const date = raw ? new Date(new Date(raw).getTime() + 8 * 3600000) : null;
    const patch = { profileUser: profile, profileUnavailable: false, isVerified: Boolean(profile.isVerified),
      joinedText: profile.joinedMonth ? `${profile.joinedMonth} 加入` : date && Number.isFinite(date.getTime()) ? `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月 加入` : '',
      likeCount: Number.isSafeInteger(profile.receivedLikes) ? profile.receivedLikes : '—' };
    if (this.data.coverFileID !== (profile.coverFileID || '')) Object.assign(patch, { coverFileID: profile.coverFileID || '', coverFailed: false });
    if (Number.isSafeInteger(profile.postCount)) patch.postCountText = `${profile.postCount} 条帖子`;
    this.setData(patch);
    if (typeof profile.blocked === 'boolean') square.rememberBlock?.(profile.accountId, profile.blocked);
    this.applyProfileBlock(Boolean(profile.blocked || square.isBlocked?.(profile.accountId)));
    this.measureProfileNavigation(); this.refreshFollowPresentation();
  },
  applyProfileBlock(blocked) {
    if (blocked === Boolean(this.data.profileBlocked)) return;
    this._publicContentRequests = {};
    if (blocked) {
      this.resetProfileVideos();
      this.closeComments();
      this.closeUnfollowPrompt(true);
      this.setData({ ownPosts: [], quotePosts: [], albumImages: [], pinnedPostId: '', profileFollowing: false,
        postsLoading: false, quotesLoading: false, albumLoading: false, postsMoreLoading: false,
        quotesMoreLoading: false, albumMoreLoading: false, postsHasMore: false, quotesHasMore: false,
        albumHasMore: false, postsOffset: 0, quotesOffset: 0, albumOffset: 0, postsError: '', quotesError: '',
        albumError: '', postsMenuOpen: false, mediaMenuOpen: false });
    }
    this.setData({ profileBlocked: blocked });
  },
  prefillPublicContent() {
    if (!this.data.user || this.data.profileBlocked || square.isBlocked?.(this.data.profileAccountId)) return;
    for (const kind of ['posts', 'quotes', 'album']) {
      const cached = square.cachedPublicContent(this.data.profileAccountId, kind);
      if (cached) this.showPublicContent(kind, cached);
    }
  },
  showPublicContent(kind, result) { if (kind === 'album') this.showAlbum(result); else this.showProfilePosts(result, kind); },
  refreshPublicProfile(force = false) {
    if (this._unloaded || this._visible === false || !/^[1-9][0-9]{7}$/.test(this.data.profileAccountId || '')) return;
    this.applyPublicViewer(users.getCachedUser(), false, true);
    if (this._publicRefresh) return this._publicRefresh.promise;
    const request = { view: this._viewVersion, session: users.getSessionVersion(), accountId: this.data.profileAccountId };
    this._publicRefresh = request;
    const current = () => this._publicRefresh === request && this.currentView(request.view) && request.session === users.getSessionVersion();
    this.setData({ loading: !this.data.profileUser, error: '' });
    request.promise = (async () => {
      try {
        const viewer = await users.restore({ force: false });
        if (!current()) {
          if (this._publicRefresh === request && this.currentView(request.view) && request.session !== users.getSessionVersion()) this.applyPublicViewer(users.getCachedUser());
          return;
        }
        this.applyPublicViewer(viewer, true);
        if (!viewer) return;
        if (viewer.accountId === request.accountId) {
          this.setData({ isVisitor: false, profileAccountId: '', profileUnavailable: false }); this.applyUser(viewer); return;
        }
        const profile = await users.getPublicProfile(request.accountId, { force: force !== false });
        if (!current()) return;
        this.applyPublicProfile(profile);
        if (this.data.profileBlocked) return;
        const tab = this.data.selectedContent;
        if (tab === 'album' && this.data.mediaTab === 'videos') { await this.loadProfileVideos(force); return; }
        const kind = tab === 'reposts' ? 'quotes' : tab === 'replies' ? null : tab;
        if (kind) await this.loadPublicContent(kind, force !== false);
      } catch (error) {
        if (!this._unloaded && this._visible !== false && this._publicRefresh === request) {
          if (request.session !== users.getSessionVersion()) { this.applyPublicViewer(users.getCachedUser()); return; }
          if (error.code === 'PROFILE_NOT_FOUND') this.markPublicUnavailable(error.message);
          if (!['SESSION_CHANGED', 'PROFILE_CHANGED'].includes(error.code)) this.setData({ error: error.message || '个人主页读取失败，请重试' });
        }
      } finally {
        if (this._publicRefresh === request) { this._publicRefresh = null; if (!this._unloaded && this._visible !== false) this.setData({ loading: false, authChecking: false }); }
      }
    })();
    return request.promise;
  },
  markPublicUnavailable(message) {
    this.cancelPublicReads();
    this.resetProfileVideos();
    if (typeof users.invalidatePublicProfile === 'function') users.invalidatePublicProfile(this.data.profileAccountId, { unavailable: true });
    if (typeof square.clearPublicAccount === 'function') square.clearPublicAccount(this.data.profileAccountId);
    this.setData({ profileUnavailable: true, profileUser: null, coverFileID: '', ownPosts: [], quotePosts: [], albumImages: [], pinnedPostId: '', isVerified: false, joinedText: '', loading: false,
      postsLoading: false, quotesLoading: false, albumLoading: false, postsMoreLoading: false, quotesMoreLoading: false, albumMoreLoading: false, error: message || '该用户暂不可查看' });
    this.closeComments();
  },
  publicProfileUnavailable(event) {
    if (!this.data.isVisitor) return;
    if (event.detail.code !== 'USER_BLOCKED') { this.markPublicUnavailable(event.detail.message); return; }
    this.markProfileBlocked();
  },
  markProfileBlocked() {
    const accountId = this.data.profileAccountId;
    users.invalidatePublicProfile?.(accountId);
    square.rememberBlock?.(accountId, true);
    this.applyProfileBlock(true);
  },
  loadPublicContent(kind, force = false, append = false) {
    if (this._unloaded || this._visible === false || !this.data.user || this.interactionBlocked() || this.data.profileUnavailable || this.data.profileBlocked) return Promise.resolve();
    const requests = this._publicContentRequests || (this._publicContentRequests = {});
    if (requests[kind]) return requests[kind].promise;
    const prefix = kind === 'quotes' ? 'quotes' : kind === 'album' ? 'album' : 'posts';
    const rows = kind === 'quotes' ? 'quotePosts' : kind === 'album' ? 'albumImages' : 'ownPosts';
    const cached = square.cachedPublicContent(this.data.profileAccountId, kind);
    if (cached) this.showPublicContent(kind, cached);
    const request = { view: this._viewVersion, session: users.getSessionVersion() }; requests[kind] = request;
    const current = () => this._publicContentRequests === requests && requests[kind] === request && this.currentView(request.view) && request.session === users.getSessionVersion();
    this.setData({ [prefix + 'Loading']: !this.data[rows].length, [prefix + 'MoreLoading']: append, [prefix + 'Error']: '' });
    request.promise = square.listPublicContent(this.data.profileAccountId, kind, { force, offset: append ? this.data[prefix + 'Offset'] : 0 }).then(result => {
      if (current()) this.showPublicContent(kind, result);
    }).catch(error => {
      if (current() && error.code === 'USER_BLOCKED') this.markProfileBlocked();
      else if (current() && error.code === 'PROFILE_NOT_FOUND') this.markPublicUnavailable(error.message);
      else if (current() && error.code !== 'SESSION_CHANGED') this.setData({ [prefix + 'Error']: error.message || '内容读取失败，请重试' });
    }).finally(() => {
      if (current()) { requests[kind] = null; this.setData({ [prefix + 'Loading']: false, [prefix + 'MoreLoading']: false }); }
    });
    return request.promise;
  },
  backFromPublicProfile() {
    if (this._returningHome || this._unloaded) return;
    this._returningHome = true;
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [], previous = pages[pages.length - 2];
    if (previous && previous.route === 'pages/home/index' && typeof previous.prepareMenuReturn === 'function') previous.prepareMenuReturn();
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/home/index', fail: () => { this._returningHome = false; } }) });
  },
} };
