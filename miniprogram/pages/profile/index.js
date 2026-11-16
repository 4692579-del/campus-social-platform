const userService = require('../../services/user');
const { describeUser } = require('../../utils/user-role');

Page({
  data: { user: null, loading: false, error: '', identity: describeUser(null) },
  onShow() { this.refresh(); },
  async refresh() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '', user: null, identity: describeUser(null) });
    try {
      const user = await userService.restore();
      this.setData({ user, identity: describeUser(user) });
    }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async login() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      const user = await userService.login();
      this.setData({ user, identity: describeUser(user) });
      wx.showToast({ title: '登录成功' });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  editProfile() { wx.navigateTo({ url: '/pages/edit-profile/index' }); },
  openCertification() {
    if (this.data.user && !this.data.identity.isAdmin) wx.navigateTo({ url: '/pages/certification/index' });
  },
  openAdmin() {
    if (this.data.identity.isAdmin) wx.navigateTo({ url: '/pages/admin/index' });
  },
  logout() {
    wx.showModal({
      title: '退出登录', content: '退出后会保留你的账号和已保存的资料。',
      success: result => {
        if (!result.confirm) return;
        userService.logout();
        this.setData({ user: null, error: '', identity: describeUser(null) });
      },
    });
  },
});
