const userService = require('../../services/user');
const { describeApplication } = require('../../utils/certification-view');

Page({
  data: { status: 'pending', items: [], loading: true, loadingMore: false, authorized: false,
    error: '', hasMore: false, nextOffset: 0 },
  onShow() { this.refresh(); },
  onPullDownRefresh() { this.refresh(); },
  onReachBottom() { this.loadMore(); },
  onHide() { this.clearPrivateData(); },
  onUnload() { this.clearPrivateData(); },
  clearPrivateData() {
    this._generation = (this._generation || 0) + 1;
    this._busy = false;
    this.setData({ items: [], authorized: false, error: '', loading: false, loadingMore: false, hasMore: false });
  },
  changeStatus(event) {
    const status = event.currentTarget.dataset.status;
    if (this._busy || !['pending', 'approved', 'rejected'].includes(status) || status === this.data.status) return;
    this.setData({ status });
    this.refresh();
  },
  refresh() { return this.load(false); },
  loadMore() {
    if (!this.data.authorized || !this.data.hasMore) return;
    return this.load(true);
  },
  async load(append) {
    if (this._busy) { wx.stopPullDownRefresh(); return; }
    this._busy = true;
    const generation = this._generation = (this._generation || 0) + 1;
    const offset = append ? this.data.nextOffset : 0;
    this.setData(append ? { loadingMore: true, error: '' } :
      { loading: true, error: '', items: [], authorized: false, hasMore: false, nextOffset: 0 });
    try {
      const user = await userService.restore({ force: false });
      if (!user) {
        const error = new Error('请先到“我的”页面登录');
        error.code = 'UNAUTHENTICATED';
        throw error;
      }
      const result = await userService.listCertifications(this.data.status, offset);
      if (!Array.isArray(result.items)) throw new Error('审核列表读取失败，请重试');
      if (generation !== this._generation) return;
      const items = (append ? this.data.items : []).concat(result.items.map(describeApplication));
      // 列表变化时可能出现重复条目，保留同一申请的最新一次显示。
      const unique = new Map(items.map(item => [item._id, item]));
      this.setData({ items: [...unique.values()], authorized: true,
        hasMore: result.hasMore, nextOffset: result.nextOffset });
    } catch (error) {
      if (generation !== this._generation) return;
      const denied = ['FORBIDDEN', 'ACCOUNT_DISABLED', 'NOT_REGISTERED', 'UNAUTHENTICATED', 'INVALID_ROLE'].includes(error.code);
      this.setData({ error: error.message || '列表读取失败，请重试',
        ...(!append || denied ? { items: [], authorized: false, hasMore: false } : {}) });
    } finally {
      if (generation === this._generation) {
        this._busy = false;
        this.setData({ loading: false, loadingMore: false });
        wx.stopPullDownRefresh();
      }
    }
  },
  openDetail(event) {
    if (this.data.authorized) wx.navigateTo({ url: '/pages/admin-certification-detail/index?id=' + encodeURIComponent(event.currentTarget.dataset.id) });
  },
  backToAdmin() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }); },
});
