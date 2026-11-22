const users = require('../../services/user');
Page({
  data: { user: null, usage: null, percentText: '', hourlyPercentText: '', hourlyResetText: '', loading: false, refreshing: false, error: '',
    navTop: 28, navButtonHeight: 32, navHeight: 72 },
  onLoad() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    this._returnPage = pages[pages.length - 2];
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
  onUnload() { this.prepareReturn(); this._returnPage = null; this._unloaded = true; this.onHide(); },
  syncCached() {
    const user = users.getCachedUser();
    const usage = users.getCachedAIUsage() || (user && this.data.user && user._id === this.data.user._id ? this.data.usage : null);
    this.setData({ user, usage, ...this.usageText(usage) });
    return user;
  },
  usageText(usage) {
    const hourly = usage && usage.hourly;
    const time = hourly && new Date(Date.parse(hourly.resetsAt) + 8 * 3600000).toISOString().slice(11, 16);
    return { percentText: usage ? String(Math.round(usage.usedPercent)) : '', hourlyPercentText: hourly ? String(Math.round(hourly.usedPercent)) : '', hourlyResetText: time ? time + ' 重置额度' : '每小时整点重置额度' };
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
      if (!user) { this.setData({ user: null, usage: null, ...this.usageText(null) }); return; }
      this.setData({ user, loading: !this.data.usage });
      const usage = await users.getAIUsage({ force: force !== false });
      if (!this.live(sequence)) return;
      if (version !== users.getSessionVersion() || !users.getCachedUser() || users.getCachedUser()._id !== user._id) { this.syncCached(); return; }
      this.setData({ usage, ...this.usageText(usage) });
      // 整点或0点重新读取真实额度，保留当前内容，不在客户端伪造清零。
      this._resetTimer = setTimeout(() => { if (this.live(sequence)) this.refresh(true); }, Math.max(1000, Math.min(Date.parse(usage.resetsAt), usage.hourly ? Date.parse(usage.hourly.resetsAt) : Infinity) - Date.now() + 100));
    } catch (error) {
      if (!this.live(sequence)) return;
      if (version !== users.getSessionVersion()) this.syncCached();
      else this.setData({ error: error.message || '额度信息读取失败，请重试' });
    } finally {
      if (this.live(sequence)) this.setData({ loading: false, refreshing: false });
    }
  },
  prepareReturn() {
    if (this._returnPrepared) return true;
    if (!this._returnPage || typeof this._returnPage.prepareMenuReturn !== 'function') return false;
    this._returnPage.prepareMenuReturn(); this._returnPrepared = true; return true;
  },
  back() {
    if (this._returning || this._unloaded) return;
    this._returning = true;
    const prepared = this.prepareReturn();
    const fallbackUrl = this._returnPage?.route === 'pages/search/index' ? '/pages/search/index' : '/pages/home/index';
    const navigate = () => wx.navigateBack({ fail: () => wx.switchTab({ url: fallbackUrl, fail: () => { this._returning = false; } }) });
    if (prepared && typeof wx.nextTick === 'function') wx.nextTick(navigate); else navigate();
  },
});
