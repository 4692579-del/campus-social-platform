const users = require('../../services/user');
const history = require('../../services/search-history');
const { normalize, resultUrl } = require('../../utils/search-query');
const { DEFAULT_LAYOUT, readTabLayout, patchState } = require('../../utils/tab-page-layout');

Page({
  data: { ...DEFAULT_LAYOUT, keyword: '', accountId: '', focused: false, records: [],
    windowWidth: 375, swipeRevision: 0, removingId: '' },
  onLoad(options = {}) {
    const accountId = /^[1-9][0-9]{7}$/.test(options.accountId || '') && users.getCachedUser() ? options.accountId : '';
    this._session = users.searchSessionKey();
    this.updateLayout();
    this.setData({ accountId, focused: true });
  },
  onShow() {
    this._visible = true;
    this._navigation = null;
    this.syncSession(true);
  },
  onHide() {
    this._visible = false;
    patchState(this, { focused: false });
    this.finishHistoryRemoval();
  },
  onUnload() { clearTimeout(this._historyRemovalTimer); this._visible = false; this._unloaded = true; this._navigation = null; },
  onResize() { this.updateLayout(); },
  updateLayout() {
    patchState(this, readTabLayout(wx));
  },
  historyOwner() { return users.getCachedUser()?._id || 'guest'; },
  syncSession(refresh = false) {
    const current = users.searchSessionKey();
    const changed = this._session !== current;
    if (changed) this._session = current;
    if (changed || refresh) {
      clearTimeout(this._historyRemovalTimer);
      this._historyRemoval = null;
      let records = [];
      try { records = history.read(this.historyOwner()); } catch (_) { /* 本地存储不可用仍可搜索。 */ }
      this.setData({ records, removingId: '', swipeRevision: this.data.swipeRevision + 1,
        ...(changed ? { keyword: '', accountId: '' } : {}) });
    }
    return !changed;
  },
  onInput(event) { this.setData({ keyword: event.detail.value }); },
  removeAuthor() { this.setData({ accountId: '' }); },
  search() {
    if (!this.syncSession()) return;
    this.openResults({ keyword: this.data.keyword, accountId: this.data.accountId });
  },
  searchRecord(event) {
    if (this._navigation || !this.syncSession()) return;
    const record = this.data.records.find(row => row.id === event.currentTarget.dataset.id);
    if (!record || record.id === this.data.removingId) return;
    this.openResults(record);
  },
  deleteHistoryRecord({ id }) {
    if (this._navigation || this._unloaded || this._visible === false || !this.syncSession() || this._historyRemoval) return;
    if (!this.data.records.some(row => row.id === id)) return;
    let records;
    try { records = history.remove(this.historyOwner(), id); }
    catch (_) { wx.showToast({ title: '删除失败，请重试', icon: 'none' }); return; }
    const removal = this._historyRemoval = { session: this._session, records };
    this.setData({ removingId: id }, () => {
      if (this._historyRemoval === removal && !this._unloaded) {
        this._historyRemovalTimer = setTimeout(() => this.finishHistoryRemoval(), 240);
      }
    });
  },
  finishHistoryRemoval() {
    const removal = this._historyRemoval;
    if (!removal) return;
    if (removal.session !== users.searchSessionKey()) { this.syncSession(); return; }
    clearTimeout(this._historyRemovalTimer);
    this._historyRemoval = null;
    this.setData({ records: removal.records, removingId: '', swipeRevision: this.data.swipeRevision + 1 });
  },
  openResults(input) {
    if (this._navigation || this._unloaded || this._visible === false) return;
    let query;
    try { query = normalize(input); }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }); return; }
    const request = this._navigation = {};
    const session = this._session, owner = this.historyOwner();
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
    wx.navigateTo({
      url: resultUrl(query),
      success: () => {
        if (this._unloaded || users.searchSessionKey() !== session) return;
        if (this._navigation === request) patchState(this, { keyword: '', accountId: '' });
        try { history.remember(owner, query); }
        catch (_) { return; }
        if (this._visible && !this._navigation) this.syncSession(true);
      },
      fail: () => {
        if (this._navigation !== request || this._unloaded) return;
        this._navigation = null;
        wx.showToast({ title: '搜索结果页打开失败，请重试', icon: 'none' });
      },
    });
  },
  cancel() {
    if (this._navigation || this._unloaded || this._visible === false) return;
    const request = this._navigation = {};
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
    wx.navigateBack({ fail: () => {
      if (this._navigation !== request || this._unloaded) return;
      wx.switchTab({ url: '/pages/search/index', fail: () => {
        if (this._navigation === request && !this._unloaded) {
          this._navigation = null;
          wx.showToast({ title: '返回搜索页失败，请重试', icon: 'none' });
        }
      } });
    } });
  },
});
