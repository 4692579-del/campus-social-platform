const secondaryTabPage = require('../../utils/secondary-tab-page');
Page(secondaryTabPage(3, {
  data: { keyword: '' },
  onInput(event) { this.setData({ keyword: event.detail.value }); },
  search() { wx.showToast({ title: '搜索功能将在后续开放', icon: 'none' }); },
}));
