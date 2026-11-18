const userService = require('../../services/user');

Page({
  data: { loading: true, dashboard: null, error: '' },
  onShow() { this.loadDashboard(); },
  onPullDownRefresh() { this.loadDashboard(); },
  async loadDashboard() {
    // 每次进入都清空旧数据并重新鉴权；缓存中的管理员标记不能授予权限。
    if (this._requestPending) {
      wx.stopPullDownRefresh();
      return;
    }
    this._requestPending = true;
    this.setData({ loading: true, dashboard: null, error: '' });
    try {
      const user = await userService.restore({ force: false });
      if (!user) throw new Error('请先到“我的”页面登录');
      const dashboard = await userService.getAdminDashboard();
      if (!dashboard || !dashboard.operator || dashboard.operator.role !== 'admin') {
        throw new Error('暂时无法确认管理权限，请稍后重试');
      }
      this.setData({ dashboard });
    } catch (error) {
      this.setData({ error: error.message || '工作台加载失败，请重试' });
    } finally {
      this._requestPending = false;
      this.setData({ loading: false });
      wx.stopPullDownRefresh();
    }
  },
  openCertifications() {
    if (this.data.dashboard) wx.navigateTo({ url: '/pages/admin-certifications/index' });
  },
  backToProfile() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }); },
});
