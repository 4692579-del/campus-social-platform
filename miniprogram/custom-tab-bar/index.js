Component({
  data: {
    authBlocked: false,
    commentsOpen: false,
    menuOpen: false,
    menuInstant: false,
    selected: 0,
    items: [
      { label: '首页', path: '/pages/home/index', icon: 'home' },
      { label: '集市', path: '/pages/market/index', icon: 'market' },
      { label: '私信', path: '/pages/messages/index', icon: 'bell', iconSource: '/images/interface/bell', iconExtension: 'svg' },
      { label: '任务', path: '/pages/tasks/index', icon: 'tasks' },
      { label: '搜索', path: '/pages/search/index', icon: 'search', iconSource: '/images/interface/search', iconExtension: 'svg' },
    ],
  },
  methods: {
    stopMenuTouch() {},
    closeProfileMenu() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && typeof page.closeMenu === 'function') page.closeMenu();
    },
    switchTab(event) {
      if (this.data.authBlocked || this.data.commentsOpen) return;
      if (this.data.menuOpen) { this.closeProfileMenu(); return; }
      const index = Number(event.currentTarget.dataset.index);
      if (!Number.isInteger(index) || !this.data.items[index] || index === this.data.selected || this._switching) return;
      this._switching = true;
      wx.switchTab({
        url: this.data.items[index].path,
        fail: () => wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }),
        complete: () => { this._switching = false; },
      });
    },
  },
});
