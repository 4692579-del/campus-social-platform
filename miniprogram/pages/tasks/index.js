Page({
  onShow() { this.syncNavigation(); },
  onReady() { this.syncNavigation(); },
  syncNavigation() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 3 });
  },
});
