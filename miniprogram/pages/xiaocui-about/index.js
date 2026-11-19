const users = require('../../services/user');
Page({
  data: { user: null, usage: null, percentText: '', loading: false, refreshing: false, error: '',
    navTop: 28, navButtonHeight: 32, navHeight: 72 },
  onLoad() {
    try {
      const info = wx.getWindowInfo(), capsule = wx.getMenuButtonBoundingClientRect();
      const status = info.statusBarHeight || 0, valid = capsule && capsule.height > 0 && capsule.top >= status;
      const navTop = valid ? capsule.top : status + 8, navButtonHeight = valid ? capsule.height : 32;
      this.setData({ navTop, navButtonHeight, navHeight: navTop + navButtonHeight + 8 });
    } catch (error) { /* 沿用默认导航栏布局。 */ }
    this.syncCached();
  },
  onShow() { this._visible = true; return this.refresh(false); },
  onHide() { this._visible = false; this._sequence = (this._sequence || 0) + 1; clearTimeout(this._resetTimer); },
  onUnload() { this._unloaded = true; this.onHide(); },
  syncCached() {
    const user = users.getCachedUser(), usage = users.getCachedAIUsage();
    this.setData({ user, usage, percentText: usage ? String(usage.usedPercent) : '' });
    return user;
  },
  live(sequence) { return !this._unloaded && this._visible !== false && sequence === this._sequence; },
  async refresh(force = true) {
    const sequence = this._sequence = (this._sequence || 0) + 1, version = users.getSessionVersion();
    clearTimeout(this._resetTimer);
    const cached = this.syncCached();
    this.setData({ loading: Boolean(cached && !this.data.usage), refreshing: true, error: '' });
    try {
      const user = await users.restore({ force: false });
      if (!this.live(sequence)) return;
      if (version !== users.getSessionVersion()) { this.syncCached(); return; }
      if (!user) { this.setData({ user: null, usage: null, percentText: '' }); return; }
      this.setData({ user, loading: !this.data.usage });
      const usage = await users.getAIUsage({ force: force !== false });
      if (!this.live(sequence)) return;
      if (version !== users.getSessionVersion() || !users.getCachedUser() || users.getCachedUser()._id !== user._id) { this.syncCached(); return; }
      this.setData({ usage, percentText: String(usage.usedPercent) });
      // 页面停留跨过0点时重新读取真实额度，不在客户端伪造清零。
      this._resetTimer = setTimeout(() => { if (this.live(sequence)) this.refresh(true); }, Math.max(1000, Date.parse(usage.resetsAt) - Date.now() + 100));
    } catch (error) {
      if (!this.live(sequence)) return;
      if (version !== users.getSessionVersion()) this.syncCached();
      else this.setData({ error: error.message || '额度信息读取失败，请重试' });
    } finally {
      if (this.live(sequence)) this.setData({ loading: false, refreshing: false });
    }
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }); },
});
