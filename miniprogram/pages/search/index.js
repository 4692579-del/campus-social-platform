Page({
  data: { keyword: '' },
  onShow() { this.syncNavigation(); },
  onReady() { this.syncNavigation(); },
  syncNavigation() {
    const bar = typeof this.getTabBar === 'function' && this.getTabBar();
    if (bar) bar.setData({ selected: 4, menuOpen: false, authBlocked: false });
  },
  onInput(event) { this.setData({ keyword: event.detail.value }); },
  search() { wx.showToast({ title: '搜索功能将在后续开放', icon: 'none' }); },
});
