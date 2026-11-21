const secondaryTabPage = require('../../utils/secondary-tab-page');
const users = require('../../services/user');
const tabSelection = require('../../utils/tab-selection');
const { resultUrl } = require('../../utils/search-query');
const base = secondaryTabPage(3);
Page({
  ...base,
  data: { ...base.data, keyword: '', accountId: '' },
  onLoad() { base.onLoad.call(this); this._searchSession = users.searchSessionKey(); },
  onShow() {
    const session = users.searchSessionKey(), entry = users.consumeSearchEntry();
    if (session !== this._searchSession) this.setData({ keyword: '', accountId: '' });
    this._searchSession = session;
    if (entry) this.setData({ accountId: entry.accountId, keyword: '' });
    else if (tabSelection.pendingIndex() === 3) { if (this.data.accountId) this.setData({ accountId: '' }); }
    this._openingResults = false;
    base.onShow.call(this);
  },
  onInput(event) { this.setData({ keyword: event.detail.value }); },
  removeAuthor() { this.setData({ accountId: '' }); },
  search() {
    if (this._openingResults || this._unloaded || this._visible === false) return;
    const keyword = this.data.keyword.trim(), accountId = this.data.accountId;
    if (!keyword && !accountId) { wx.showToast({ title: '请输入搜索内容', icon: 'none' }); return; }
    let url;
    try { url = resultUrl({ keyword, accountId }); } catch (error) { wx.showToast({ title: error.message, icon: 'none' }); return; }
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
    this._openingResults = true;
    wx.navigateTo({ url,
      fail: () => { this._openingResults = false; if (!this._unloaded && this._visible !== false) wx.showToast({ title: '搜索结果页打开失败，请重试', icon: 'none' }); } });
  },
});
