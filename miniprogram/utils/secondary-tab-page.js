const { DEFAULT_LAYOUT, readTabLayout, patchState } = require('./tab-page-layout');
const tabPageMotion = require('./tab-page-motion');

// 仍是独立原生 Page；统一视窗与首页一致，避免切页时创建/移除系统导航栏。
module.exports = function secondaryTabPage(index, extra = {}) {
  return {
    ...extra,
    ...tabPageMotion.methods,
    data: { ...DEFAULT_LAYOUT, ...tabPageMotion.data, ...extra.data },
    onLoad() { this.updateTabLayout(); },
    onShow() {
      this._visible = true;
      this.showTabMotion(`/pages/${['home', 'inbox', 'messages', 'search'][index]}/index`);
      this.syncNavigation();
    },
    onReady() { this.syncNavigation(); },
    onHide() { this.hideTabMotion(); this._visible = false; },
    onUnload() { this.hideTabMotion(); this._visible = false; this._unloaded = true; },
    onResize() { this.updateTabLayout(); },
    updateTabLayout() {
      const { windowWidth, ...layout } = readTabLayout(wx);
      patchState(this, layout);
    },
    syncNavigation() {
      const bar = typeof this.getTabBar === 'function' && this.getTabBar();
      if (bar) patchState(bar, { selected: index, compact: false, menuOpen: false, authBlocked: false,
        commentsOpen: false, composerOpen: false });
    },
  };
};
