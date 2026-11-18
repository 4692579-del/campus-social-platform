const users = require('../services/user');
module.exports = {
  requestLogin() {
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
    this.setData({ user: users.getCachedUser(), loginSheetOpen: true, loginError: '', replyFocus: false, keyboardHeight: 0 });
  },
  async login() {
    if (this.data.loginLoading) return;
    const version = this._authVersion || 0;
    this.setData({ loginLoading: true, loginError: '' });
    try {
      const user = await users.login();
      if (this._unloaded || version !== (this._authVersion || 0)) return;
      if (!user || !user._id) throw new Error('登录失败，请重试');
      this.setData({ loginSheetOpen: false });
      if (this.onLoggedIn) this.onLoggedIn(user);
      else this.setData({ user });
    } catch (error) {
      if (!this._unloaded && version === (this._authVersion || 0)) this.setData({ loginError: error.message });
    } finally {
      if (!this._unloaded && version === (this._authVersion || 0)) this.setData({ loginLoading: false });
    }
  },
  cancelLogin() {
    this._authVersion = (this._authVersion || 0) + 1;
    users.logout();
    this.setData({ user: null, loginSheetOpen: false, loginLoading: false, loginError: '' });
  },
  stopMenuEvent() {},
};
