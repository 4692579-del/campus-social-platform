const users = require('../../services/user');
const square = require('../../services/square');
const gate = require('../../utils/login-gate');
const { nav, token } = require('../../utils/post-view');

Page({
  ...gate,
  data: { user: null, content: '', count: 0, canPublish: false, publishing: false, error: '',
    navTop: 28, navButtonHeight: 32, navHeight: 72, loginSheetOpen: false, loginLoading: false, loginError: '' },
  async onLoad() {
    nav(this);
    const cached = users.getCachedUser();
    if (cached) { this.onLoggedIn(cached); return; }
    try {
      const user = await users.restore({ force: false });
      if (this._unloaded) return;
      if (user) this.onLoggedIn(user);
      else this.requestLogin();
    } catch (error) { if (!this._unloaded) { this.setData({ error: error.message }); this.requestLogin(); } }
  },
  onLoggedIn(user) {
    if (!this.data.user || this.data.user._id !== user._id) { this.setContent(''); this._requestId = null; }
    this.setData({ user });
    try {
      const draft = wx.getStorageSync(`square.draft.${user._id}`);
      if (draft && typeof draft.content === 'string') {
        this._requestId = draft.requestId || token();
        this.setContent(draft.content);
      }
    } catch (error) { /* 无草稿时直接开始输入。 */ }
  },
  onUnload() { this._unloaded = true; if (!this._published) this.saveDraft(); },
  setContent(content) {
    const count = Array.from(content).length;
    this.setData({ content, count, canPublish: Boolean(content.trim()) && count <= 1000 });
  },
  onInput(event) {
    if (this.data.publishing) return;
    this._requestId = token();
    this.setContent(event.detail.value);
    this.setData({ error: '' });
    this.saveDraft();
  },
  saveDraft() {
    const user = users.getCachedUser();
    if (!user || !this.data.user || user._id !== this.data.user._id) return;
    try {
      const key = `square.draft.${user._id}`;
      if (this.data.content.trim()) wx.setStorageSync(key, { content: this.data.content, requestId: this._requestId || (this._requestId = token()) });
      else wx.removeStorageSync(key);
    } catch (error) { /* 存储空间不足不阻断在线发布。 */ }
  },
  async publish() {
    if (this.data.publishing || !this.data.canPublish || this.data.loginSheetOpen) return;
    if (!users.getCachedUser()) { this.requestLogin(); return; }
    this._requestId = this._requestId || token();
    this.saveDraft();
    this.setData({ publishing: true, error: '' });
    try {
      await square.publish(this.data.content, this._requestId);
      if (this._unloaded) return;
      this._published = true;
      wx.removeStorageSync(`square.draft.${this.data.user._id}`);
      wx.showToast({ title: '发布成功' });
      wx.switchTab({ url: '/pages/home/index' });
    } catch (error) {
      if (!this._unloaded) {
        this.setData({ error: error.message || '发布未确认，请重试' });
        if (!users.getCachedUser()) this.requestLogin();
      }
    } finally { if (!this._unloaded) this.setData({ publishing: false }); }
  },
  cancel() {
    if (this.data.publishing) return;
    this.saveDraft();
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) });
  },
});
