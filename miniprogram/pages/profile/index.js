const userService = require('../../services/user');

Page({
  data: { user: null, loading: false, error: '' },
  onShow() { this.refresh(); },
  async refresh() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '', user: null });
    try { this.setData({ user: await userService.restore() }); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async login() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      this.setData({ user: await userService.login() });
      wx.showToast({ title: '登录成功' });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  editProfile() { wx.navigateTo({ url: '/pages/edit-profile/index' }); },
  logout() {
    wx.showModal({
      title: '退出登录', content: '退出后会保留你的账号和已保存的资料。',
      success: result => {
        if (!result.confirm) return;
        userService.logout();
        this.setData({ user: null, error: '' });
      },
    });
  },
});
