const menuItems = [
  { key: 'profile', label: '个人资料', icon: 'user' },
  { key: 'membership', label: '荟萃计划', icon: 'crown' },
  { key: 'certification', label: '认证' },
  { key: 'friends', label: '萃友', icon: 'users' },
  { key: 'history', label: '历史', icon: 'history' },
  { key: 'creator', label: '创作者空间', icon: 'pen-square' },
];

const utilityMenuItems = [
  { key: 'xiaocui', label: '关于小萃AI', icon: 'xiaocui-black' },
  { key: 'settings', label: '设置', icon: 'settings' },
  { key: 'help', label: '帮助中心', icon: 'help-circle' },
];

function accountMenuRoutes(api) {
  return {
    closeMembership() {
      if (!this.data.membershipOpen) return;
      this.setData({ membershipOpen: false });
      this.syncNavigation();
    },
    openProfile() {
      if (this.interactionBlocked() || this.data.loading || this.data.confirmingLogout) return;
      if (!this.data.user) { this.openMenu(); return; }
      this.navigateFromMenu('/pages/profile/index', '个人主页打开失败，请重试');
    },
    navigateFromMenu(url, failureMessage) {
      if (this._menuNavigating || this._unloaded || this._visible === false) return;
      this._menuNavigating = true;
      // 等目标页覆盖后再恢复底层，避免离开时先播放收起动画。
      api.navigateTo({ url, fail: () => {
        this._menuNavigating = false;
        if (!this._unloaded && this._visible !== false) api.showToast({ title: failureMessage, icon: 'none' });
      } });
    },
    selectMenuItem(event) {
      if (this._menuNavigating || this.interactionBlocked() || this.data.loading || this.data.confirmingLogout) return;
      const item = [...menuItems, ...utilityMenuItems].find(entry => entry.key === event.currentTarget.dataset.key);
      if (!item) return;
      if (item.key === 'membership') {
        if (this.data.menuOpen && !this._unloaded && this._visible !== false) {
          this.setData({ membershipOpen: true });
          this.syncNavigation();
        }
        return;
      }
      if (item.key === 'xiaocui') { this.navigateFromMenu('/pages/xiaocui-about/index', '小萃AI页面打开失败，请重试'); return; }
      if (item.key === 'profile') { this.openProfile(); return; }
      if (item.key === 'certification') {
        if (!this.data.user) { this.closeMenu(); this.openMenu(); return; }
        if (this.data.user.role === 'admin') { api.showToast({ title: '管理员账号无需学生认证', icon: 'none' }); return; }
        this.navigateFromMenu('/pages/certification/index', '认证页面打开失败，请重试');
        return;
      }
      api.showToast({ title: `${item.label}功能将在后续开放`, icon: 'none' });
    },
  };
}

module.exports = { menuItems, utilityMenuItems, accountMenuRoutes };
