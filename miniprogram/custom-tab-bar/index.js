Component({
  data: {
    authBlocked: false,
    commentsOpen: false,
    composerOpen: false,
    menuOpen: false,
    menuInstant: false,
    selected: 0,
    items: [
      { label: '首页', path: '/pages/home/index', icon: 'home' },
      { label: '集市', path: '/pages/market/index', icon: 'market' },
      { label: '私信', path: '/pages/messages/index', icon: 'bell' },
      { label: '任务', path: '/pages/tasks/index', icon: 'tasks' },
      { label: '搜索', path: '/pages/search/index', icon: 'search' },
    ],
  },
  lifetimes: {
    attached() { this.syncPageState(); },
    ready() { this.syncPageState(); },
  },
  pageLifetimes: { show() { this.syncPageState(); } },
  methods: {
    syncPageState() {
      const pages = getCurrentPages(), page = pages[pages.length - 1];
      if (!page || !page.data) return;
      // 相册/相机返回时底栏可能比页面晚恢复，始终以当前页面为准。
      const next = {
        composerOpen: Boolean(page.data.composerOpen),
        commentsOpen: Boolean(page.data.commentPostId),
        authBlocked: Boolean(page.data.authChecking || page.data.loginSheetOpen || page.data.composerOpen),
        menuOpen: Boolean(page.data.menuOpen),
        menuInstant: Boolean(page.data.menuInstant),
      };
      const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => this.data[key] !== value));
      if (Object.keys(changed).length) this.setData(changed);
    },
    stopMenuTouch() {},
    closeProfileMenu() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && typeof page.closeMenu === 'function') page.closeMenu();
    },
    switchTab(event) {
      this.syncPageState();
      if (this.data.authBlocked || this.data.commentsOpen || this.data.composerOpen) return;
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
