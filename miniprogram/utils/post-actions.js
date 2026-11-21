const users = require('../services/user');
const square = require('../services/square');
const { postPreview } = require('./post-view');

const reasons = [
  { key: 'spam', label: '垃圾广告' }, { key: 'illegal', label: '违法违规' },
  { key: 'sexual', label: '色情低俗' }, { key: 'abuse', label: '辱骂骚扰' }, { key: 'other', label: '其他问题' },
];
const popup = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
function snapshot() { const user = users.getCachedUser(); return { id: user && user._id, version: users.getSessionVersion() }; }
function current(page, account) {
  const user = users.getCachedUser();
  return !page._unloaded && page._visible !== false && user && user._id === account.id && users.getSessionVersion() === account.version;
}
function profileAccount(page, viewer) {
  if (!page) return '';
  const data = page.data || {};
  const route = String(page.route || page.__route__ || '').replace(/^\/+/, '').split('?')[0];
  // 页面状态也是身份依据，不依赖各运行环境是否暴露 route 字段。
  if (route !== 'pages/profile/index' && !(typeof data.isVisitor === 'boolean' && Object.prototype.hasOwnProperty.call(data, 'profileAccountId'))) return '';
  if (data.isVisitor === true) return data.profileAccountId || page.options && page.options.accountId || '';
  // 本人页在重新展示时跟随当前会话；旧会话的资料不能被当成另一个人的访客页复用。
  return viewer && viewer.accountId || '';
}
function find(page, id) {
  return square.cachedPost(id) || [...(page.data.posts || []), ...(page.data.ownPosts || []), ...(page.data.quotePosts || [])].find(post => post._id === id);
}
function login(page) {
  if (users.getCachedUser()) return true;
  if (typeof page.requestLogin === 'function') page.requestLogin();
  else { page.applyUser(null); if (typeof page.openMenu === 'function') page.openMenu(); }
  return false;
}
function syncCommentsTabBar(page) {
  const bar = typeof page.getTabBar === 'function' && page.getTabBar();
  if (bar) bar.setData({ commentsOpen: Boolean(page.data.commentPostId) });
}
function sync(page, id, removed = false) {
  const latest = removed ? null : square.cachedPost(id), values = {};
  for (const key of ['posts', 'ownPosts', 'quotePosts']) if (Array.isArray(page.data[key])) {
    const found = page.data[key].some(post => post._id === id);
    values[key] = removed ? page.data[key].filter(post => post._id !== id) : page.data[key].map(post => post._id === id && latest ? postPreview(latest) : post);
    if (removed && found) {
      const offset = key === 'posts' ? 'feedOffset' : key === 'quotePosts' ? 'quotesOffset' : 'postsOffset';
      values[offset] = Math.max(0, (page.data[offset] || 0) - 1);
    }
  }
  if (removed) {
    if (page.data.pinnedPostId === id) values.pinnedPostId = '';
    if (page.data.commentPostId === id) values.commentPostId = '';
  }
  page.setData(values);
  if (removed) syncCommentsTabBar(page);
  if (removed && typeof page.updatePostCount === 'function') page.updatePostCount();
}
function paintLike(page, id, post) {
  if (!post) return;
  const values = {}, liked = Boolean(post.liked), count = Math.max(0, Number(post.likeCount) || 0);
  for (const key of ['posts', 'ownPosts', 'quotePosts']) if (Array.isArray(page.data[key])) {
    const index = page.data[key].findIndex(row => row._id === id);
    if (index < 0) continue;
    const row = page.data[key][index];
    if (Boolean(row.liked) !== liked) values[`${key}[${index}].liked`] = liked;
    if ((Number(row.likeCount) || 0) !== count) values[`${key}[${index}].likeCount`] = count;
    if (Number.isSafeInteger(post.quoteCount) && row.quoteCount !== post.quoteCount) values[`${key}[${index}].quoteCount`] = post.quoteCount;
    if (typeof post.quoted === 'boolean' && row.quoted !== post.quoted) values[`${key}[${index}].quoted`] = post.quoted;
    if (post.quote && JSON.stringify(row.quote) !== JSON.stringify(post.quote)) values[`${key}[${index}].quote`] = post.quote;
  }
  if (Object.keys(values).length) page.setData(values);
}

module.exports = {
  refreshFollowPresentation(force = false) {
    if (typeof square.getFollowProfile !== 'function' || this._unloaded || this._visible === false) return;
    const viewer = users.getCachedUser(), account = snapshot();
    if (this._unfollowPrompt && (!current(this, this._unfollowPrompt.account))) this.closeUnfollowPrompt(true);
    if (!viewer) { this.setData({ followKnown: false, profileFollowing: false, followingCount: '—', followerCount: '—' }); return; }
    const target = this.data.isVisitor ? this.data.profileAccountId : viewer.accountId;
    const apply = value => {
      if (!value || !current(this, account) || this.data.isVisitor && this.data.profileUnavailable) return;
      const patch = { followingCount: value.followingCount, followerCount: value.followerCount };
      if (this.data.isVisitor) { patch.followError = ''; patch.followKnown = true; patch.profileFollowing = Boolean(square.cachedFollowState(target)?.following); }
      const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => this.data[key] !== value));
      if (Object.keys(changed).length) this.setData(changed);
    };
    apply(square.cachedFollowProfile(target));
    return square.getFollowProfile(target, { force }).then(apply).catch(error => {
      if (current(this, account) && this.data.isVisitor && error.code !== 'FOLLOW_PENDING') this.setData({ followError: error.message || '关注状态暂不可用' });
    });
  },
  hydrateFollowAuthors(rows) {
    if (typeof square.getFollowStates !== 'function' || !users.getCachedUser()) return;
    const account = snapshot(), ids = [...new Set((rows || []).map(post => post.author && post.author.accountId).filter(Boolean))];
    const paint = () => {
      if (!current(this, account)) return;
      if (typeof this.refreshFollowPreviews === 'function') this.refreshFollowPreviews();
      const patch = {}; for (const id of ids) { const state = square.cachedFollowState(id); if (state) patch[`followByAccount.${id}`] = state; }
      if (this.data.authorMenu) { const post = (this.data.posts || []).find(row => row._id === this.data.authorMenu.id), state = post && square.cachedFollowState(post.author.accountId); if (state && this.data.authorMenu.following !== state.following) patch['authorMenu.following'] = state.following; }
      if (Object.keys(patch).length) this.setData(patch);
    };
    paint(); return square.getFollowStates(ids).then(paint).catch(() => { /* 不把未知状态伪造成已关注。 */ });
  },
  paintFollowPresentation(accountId) {
    const state = square.cachedFollowState(accountId) || { accountId, following: false, version: 0 }, patch = {};
    if (this.data.followByAccount) patch[`followByAccount.${accountId}`] = state;
    if (this.data.isVisitor && this.data.profileAccountId === accountId) Object.assign(patch, { profileFollowing: state.following, followKnown: true, followError: '' });
    const viewer = users.getCachedUser(), profileId = this.data.isVisitor ? this.data.profileAccountId : viewer && viewer.accountId;
    const stats = typeof square.cachedFollowProfile === 'function' && square.cachedFollowProfile(profileId);
    if (stats) Object.assign(patch, { followingCount: stats.followingCount, followerCount: stats.followerCount });
    if (Object.keys(patch).length) this.setData(patch);
    if (typeof this.refreshFollowPreviews === 'function') this.refreshFollowPreviews();
  },
  async persistFollowIntent(accountId, following) {
    const account = snapshot(), ticket = {}, intents = this._followIntents || (this._followIntents = new Map());
    intents.set(accountId, ticket);
    try {
      const request = square.setFollow(accountId, following);
      this.paintFollowPresentation(accountId);
      const result = await request;
      if (intents.get(accountId) === ticket && current(this, account)) this.paintFollowPresentation(accountId);
      return result;
    } catch (error) {
      if (intents.get(accountId) === ticket && current(this, account) && error.code !== 'SESSION_CHANGED') {
        this.paintFollowPresentation(accountId);
        wx.showToast({ title: error.message || '关注操作保存失败，请重试', icon: 'none' });
      }
      return null;
    } finally { if (intents.get(accountId) === ticket) intents.delete(accountId); }
  },
  onFollowConfirmed(event) {
    if (this._unloaded || this._visible === false || !users.getCachedUser()) return;
    if (this.data.followByAccount) this.setData({ [`followByAccount.${event.accountId}`]: event });
    if (typeof this.refreshFollowPreviews === 'function') this.refreshFollowPreviews();
    if (this.data.authorMenu) this.setData({ 'authorMenu.following': Boolean(square.cachedFollowState(this.data.posts.find(row => row._id === this.data.authorMenu.id)?.author?.accountId)?.following) });
    this.refreshFollowPresentation();
    if (typeof this.onFollowingChanged === 'function') this.onFollowingChanged(event);
  },
  requestUnfollowConfirmation(author) {
    if (!author || !/^[1-9][0-9]{7}$/.test(author.accountId || '') || !current(this, snapshot())) return Promise.resolve(false);
    this.closeUnfollowPrompt(true);
    const prompt = { account: snapshot(), accountId: author.accountId, timer: null, resolve: null };
    prompt.promise = new Promise(resolve => { prompt.resolve = resolve; });
    this._unfollowPrompt = prompt;
    this.setData({ unfollowTarget: { accountId: author.accountId, nickname: author.nickname || '该用户', avatar: author.avatarFileID || '' }, unfollowClosing: false, unfollowBusy: false });
    if (typeof this.syncNavigation === 'function') this.syncNavigation();
    return prompt.promise;
  },
  closeUnfollowPrompt(immediate = false, confirmed = false) {
    const prompt = this._unfollowPrompt;
    if (!prompt) return;
    if (prompt.timer) { clearTimeout(prompt.timer); prompt.timer = null; }
    if (prompt.resolve) { prompt.resolve(confirmed); prompt.resolve = null; }
    const finish = () => {
      if (this._unfollowPrompt !== prompt) return;
      this._unfollowPrompt = null;
      if (!this._unloaded) {
        this.setData({ unfollowTarget: null, unfollowClosing: false, unfollowBusy: false, ...(this.data.followBusy ? { followBusy: false } : {}) });
        if (typeof this.syncNavigation === 'function') this.syncNavigation();
      }
    };
    if (immediate || this._unloaded) { finish(); return; }
    this.setData({ unfollowClosing: true }); prompt.timer = setTimeout(finish, 200);
  },
  cancelUnfollowPrompt() { if (!this.data.unfollowBusy && !this.data.unfollowClosing) this.closeUnfollowPrompt(); },
  confirmUnfollowPrompt() {
    const prompt = this._unfollowPrompt;
    if (!prompt || this.data.unfollowClosing) return;
    if (!current(this, prompt.account)) { this.closeUnfollowPrompt(true); return; }
    const request = this.persistFollowIntent(prompt.accountId, false);
    this.closeUnfollowPrompt(false, true);
    return request;
  },
  toggleProfileFollow() {
    if (!this.data.isVisitor || this.data.profileUnavailable || !this.data.profileUser || this.interactionBlocked() || !login(this)) return;
    const id = this.data.profileAccountId, state = square.cachedFollowState(id);
    if (state ? state.following : this.data.profileFollowing) return this.requestUnfollowConfirmation(this.data.profileUser);
    return this.persistFollowIntent(id, true);
  },
  openProfileMessage() { if (!this._unloaded && this._visible !== false && this.data.isVisitor && this.data.profileFollowing) wx.showToast({ title: '私信功能暂未开放', icon: 'none' }); },
  followPostAuthor(event) {
    if (this._unloaded || this._visible === false || this.interactionBlocked && this.interactionBlocked() || !login(this)) return;
    const post = find(this, event.detail.id), id = post && post.author.accountId;
    if (!id || id === users.getCachedUser().accountId) return;
    const state = square.cachedFollowState(id) || this.data.followByAccount && this.data.followByAccount[id];
    if (state && state.following) return this.requestUnfollowConfirmation(post.author);
    return this.persistFollowIntent(id, true);
  },
  viewAuthorProfile(event) {
    if (this._openingAuthor || this._unloaded || this._visible === false || this.interactionBlocked && this.interactionBlocked()) return;
    const author = event && event.detail && event.detail.author, accountId = author && author.accountId;
    if (!/^[1-9][0-9]{7}$/.test(accountId || '')) { wx.showToast({ title: '该账号暂不支持查看个人主页', icon: 'none' }); return; }
    const viewer = users.getCachedUser(), own = viewer && viewer.accountId === accountId;
    if (profileAccount(this, viewer) === accountId) return;
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const sourceIndex = pages.indexOf(this), top = sourceIndex >= 0 ? sourceIndex : pages.length - 1;
    if (top >= 0 && profileAccount(pages[top], viewer) === accountId) return;
    let targetIndex = -1;
    for (let index = top - 1; index >= 0; index--) {
      if (profileAccount(pages[index], viewer) === accountId) { targetIndex = index; break; }
    }
    const navigation = { account: snapshot() };
    this._authorNavigation = navigation;
    this._openingAuthor = true;
    const fail = () => {
      if (this._authorNavigation !== navigation) return;
      this._authorNavigation = null;
      this._openingAuthor = false;
      const user = users.getCachedUser();
      if (!this._unloaded && this._visible !== false && navigation.account.version === users.getSessionVersion() && navigation.account.id === (user && user._id))
        wx.showToast({ title: '个人主页打开失败，请重试', icon: 'none' });
    };
    if (targetIndex >= 0) {
      // 原生回到已有实例，保留目标页的标签、滚动位置和图片节点，不新增相同账号的主页。
      wx.navigateBack({ delta: top - targetIndex, fail });
      return;
    }
    if (typeof users.seedPublicProfile === 'function') users.seedPublicProfile(author);
    wx.navigateTo({ url: '/pages/profile/index' + (own ? '' : '?accountId=' + encodeURIComponent(accountId)), fail });
  },
  quotePost(event) {
    if (this._unloaded || this._visible === false || this.data.menuOpen || this.data.postsMenuOpen || this.data.commentPostId || this.interactionBlocked && this.interactionBlocked() || !login(this)) return;
    const post = find(this, event.detail.id);
    if (!post) return;
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
    if (typeof this.openComposer === 'function') this.openComposer({ quotePost: post });
    else if (typeof this.publishPost === 'function') this.publishPost({ quotePost: post });
    else this.setData({ composerOpen: true, composerQuote: post, composerQuoteOwnerId: users.getCachedUser()._id });
  },
  openPost(event) {
    if (this._openingPost || this._unloaded || this._visible === false || this.data.menuOpen || this.data.postsMenuOpen || this.interactionBlocked && this.interactionBlocked()) return;
    const id = event.detail.id;
    if (!/^p_[a-f0-9]{40}$/.test(id || '')) return;
    this._openingPost = true;
    wx.navigateTo({ url: `/pages/square-detail/index?id=${encodeURIComponent(id)}`, fail: () => {
      this._openingPost = false;
      if (!this._unloaded && this._visible !== false) wx.showToast({ title: '动态打开失败，请重试', icon: 'none' });
    } });
  },
  startPostUpdates() {
    this.stopPostUpdates();
    if (typeof square.subscribeFollow === 'function') this._stopFollowUpdates = square.subscribeFollow(event => this.onFollowConfirmed(event));
    this.refreshFollowPresentation();
    if (typeof square.subscribePost !== 'function') return;
    this._stopPostUpdates = square.subscribePost(post => {
      if (current(this, snapshot()) && this.data.user && this.data.user._id === users.getCachedUser()._id) paintLike(this, post._id, post);
    });
    if (typeof square.subscribeAI === 'function') this._stopAIUpdates = square.subscribeAI(result => {
      if (!current(this, snapshot()) || !this.data.user || this.data.user._id !== users.getCachedUser()._id || !result.post || !Number.isSafeInteger(result.post.replyCount)) return;
      const values = {};
      for (const key of ['posts', 'ownPosts', 'quotePosts']) if (Array.isArray(this.data[key])) {
        const index = this.data[key].findIndex(row => row._id === result.postId);
        if (index >= 0) values[`${key}[${index}].replyCount`] = result.post.replyCount;
      }
      if (Object.keys(values).length) this.setData(values);
    });
  },
  stopPostUpdates() { this.closeUnfollowPrompt(true); if (this._stopFollowUpdates) this._stopFollowUpdates(); this._stopFollowUpdates = null; if (this._stopPostUpdates) this._stopPostUpdates(); if (this._stopAIUpdates) this._stopAIUpdates(); this._stopPostUpdates = null; this._stopAIUpdates = null; },
  async reactPost(event) {
    if (this._unloaded || this._visible === false || this.data.menuOpen || this.data.postsMenuOpen || this.interactionBlocked && this.interactionBlocked()) return;
    const { id, kind } = event.detail;
    if (kind !== 'like' || !login(this)) return;
    const account = snapshot();
    if (!this.data.user || this.data.user._id !== account.id) return;
    const post = [...(this.data.posts || []), ...(this.data.ownPosts || []), ...(this.data.quotePosts || [])].find(row => row._id === id);
    if (!post) return;
    this._likeClicks = this._likeClicks || new Map();
    let operation = this._likeClicks.get(id);
    if (!operation || operation.account.id !== account.id || operation.account.version !== account.version) {
      operation = { account, original: { ...post }, sequence: 0 };
      this._likeClicks.set(id, operation);
    }
    const sequence = ++operation.sequence, active = !Boolean(post.liked), sourcePost = { ...post };
    paintLike(this, id, { liked: active, likeCount: Math.max(0, (Number(post.likeCount) || 0) + (active ? 1 : -1)) });
    const latest = () => this._likeClicks.get(id) === operation && operation.sequence === sequence;
    try {
      const confirmed = await square.react(id, 'like', active, sourcePost);
      if (latest() && current(this, account)) paintLike(this, id, square.cachedPost(id) || confirmed);
    } catch (error) {
      if (!latest() || error.code === 'SESSION_CHANGED') return;
      if (current(this, account)) {
        paintLike(this, id, square.cachedPost(id) || operation.original);
        wx.showToast({ title: error.message || '点赞保存失败，请重试', icon: 'none' });
      } else if (!this._unloaded && this._visible !== false && !users.getCachedUser() && this.data.user && this.data.user._id === account.id) {
        paintLike(this, id, operation.original);
        this.applyUser(null);
        wx.showToast({ title: error.message || '请重新登录', icon: 'none' });
      }
    } finally { if (latest()) this._likeClicks.delete(id); }
  },
  openComments(event) {
    if (this._unloaded || this._visible === false || this.data.menuOpen || this.data.postsMenuOpen || this.interactionBlocked && this.interactionBlocked()) return;
    if (event.detail.id) { this.setData({ commentPostId: event.detail.id }); syncCommentsTabBar(this); }
  },
  closeComments() { if (this.data.commentPostId) this.setData({ commentPostId: '' }); syncCommentsTabBar(this); },
  commentsUsingNativeMedia() {
    const panel = typeof this.selectComponent === 'function' && this.selectComponent('#active-comments');
    return Boolean(panel && typeof panel.isNativeMediaActive === 'function' && panel.isNativeMediaActive());
  },
  commentLogin() { if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard(); this.closeComments(); login(this); },
  commentChanged(event) { sync(this, event.detail.id); },
  async managePost(event) {
    if (this._postMenuBusy || this._unloaded || this._visible === false || !login(this)) return;
    const id = event.detail.id, post = find(this, id), user = users.getCachedUser();
    if (!post) return;
    const own = user.accountId && post.author && post.author.accountId ? post.author.accountId === user.accountId :
      post.isOwn === true && this.data.user && this.data.user._id === user._id;
    const account = snapshot();
    this._postMenuBusy = true;
    try {
      const pinContext = () => own && this.route === 'pages/profile/index' && this.data.selectedContent === 'posts' && this.data.postScope === 'square' &&
        event.detail.profilePosts === true && !post.quotePostId && (this.data.ownPosts || []).some(row => row._id === id);
      const pinnedId = typeof square.cachedProfilePin === 'function' && square.cachedProfilePin() ? square.cachedProfilePin().pinnedPostId : this.data.pinnedPostId || '';
      const canManagePin = pinContext() && (!pinnedId || pinnedId === id);
      const choices = [own ? '删除动态' : '举报动态', ...(canManagePin ? [pinnedId === id ? '取消置顶' : '置顶'] : [])];
      const choice = await popup('showActionSheet', { itemList: choices, itemColor: canManagePin ? '#171b20' : own ? '#d84a4a' : '#171b20' });
      if (!current(this, account)) return;
      if (choice.tapIndex === 1 && canManagePin) {
        if (!pinContext()) return;
        await square.setProfilePin(id, pinnedId !== id);
        if (!current(this, account)) return;
        const saved = square.cachedOwnFeed('posts');
        if (saved && typeof this.showOwnPosts === 'function') this.showOwnPosts(saved);
        wx.showToast({ title: pinnedId === id ? '已取消置顶' : '已置顶', icon: 'none' });
        return;
      }
      if (choice.tapIndex !== 0) return;
      if (own) {
        const confirm = await popup('showModal', { title: '删除动态', content: '确定删除这条动态吗？删除后将不再展示。', confirmText: '删除', confirmColor: '#d84a4a' });
        if (!confirm.confirm || !current(this, account)) return;
        await square.deletePost(id);
        if (!current(this, account)) return;
        sync(this, id, true);
        wx.showToast({ title: '动态已删除' });
      } else {
        const selection = await popup('showActionSheet', { itemList: reasons.map(reason => reason.label) });
        if (!current(this, account) || !reasons[selection.tapIndex]) return;
        const reason = reasons[selection.tapIndex];
        const confirm = await popup('showModal', { title: '举报动态', content: `举报原因：${reason.label}。提交后将交由管理员处理。`, confirmText: '提交举报', confirmColor: '#4775fa' });
        if (!confirm.confirm || !current(this, account)) return;
        const result = await square.reportPost(id, reason.key);
        if (current(this, account)) wx.showToast({ title: result.alreadyReported ? '你已举报过这条动态' : '举报已提交', icon: 'none' });
      }
    } catch (error) {
      if (current(this, account) && !/cancel/.test(error.errMsg || '')) wx.showToast({ title: error.message || '操作失败，请重试', icon: 'none' });
      if (current(this, account) && ['PIN_EXISTS', 'PIN_CHANGED'].includes(error.code) && typeof this.loadOwnPosts === 'function') await this.loadOwnPosts(true);
    } finally { this._postMenuBusy = false; }
  },
};
