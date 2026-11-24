const { DEFAULT_LAYOUT, readTabLayout, patchState } = require('./tab-page-layout');

// 仍是独立原生 Page；统一视窗与首页一致，避免切页时创建/移除系统导航栏。
module.exports = function secondaryTabPage(index, extra = {}) {
  return {
    ...extra,
    data: { ...DEFAULT_LAYOUT, ...extra.data },
    onLoad() { this.updateTabLayout(); },
    onShow() {
      this._visible = true;
      this.syncNavigation();
    },
    onReady() { this.syncNavigation(); },
    onHide() { this._visible = false; },
    onUnload() { this._visible = false; this._unloaded = true; },
    onResize() { this.updateTabLayout(); },
    updateTabLayout() {
      const { windowWidth, ...layout } = readTabLayout(wx);
      patchState(this, layout);
    },
    syncNavigation() {
      const bar = typeof this.getTabBar === 'function' && this.getTabBar();
      if (!bar || this._unloaded || this._visible === false) return;
      const values = { compact: false, menuOpen: false, authBlocked: false, commentsOpen: false, composerOpen: false };
      if (typeof bar.syncFromPage === 'function') bar.syncFromPage(index, values);
      else if (!bar._switching) patchState(bar, { ...values, selected: index });
    },
  };
};
