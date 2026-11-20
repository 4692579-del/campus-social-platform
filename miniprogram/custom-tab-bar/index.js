const tabSelection = require('../utils/tab-selection');

Component({
  data: {
    authBlocked: false,
    commentsOpen: false,
    composerOpen: false,
    menuOpen: false,
    menuInstant: false,
    compact: false,
    selected: -1,
    indicatorPosition: 0,
    indicatorFrom: 0,
    indicatorTo: 0,
    indicatorDuration: 320,
    indicatorDelay: 0,
    indicatorAnimating: false,
    items: [
      { label: '首页', path: '/pages/home/index', icon: 'home' },
      { label: '私信', path: '/pages/messages/index', icon: 'bell' },
      { label: '消息', path: '/pages/inbox/index', icon: 'paper-plane' },
      { label: '搜索', path: '/pages/search/index', icon: 'search' },
    ],
  },
  observers: {
    selected(index) { this.syncIndicator(index); },
    'authBlocked, commentsOpen, composerOpen, menuOpen'() {
      if (this.data.authBlocked || this.data.commentsOpen || this.data.composerOpen || this.data.menuOpen) this.stopIndicator();
      else this.syncIndicator(this.data.selected);
    },
  },
  lifetimes: {
    attached() { this._indicatorVisible = true; this.syncPageState(true); this.syncIndicator(this.data.selected); },
    ready() { this.syncPageState(true); this.syncIndicator(this.data.selected); },
    detached() { this._indicatorDetached = true; this.stopIndicator(); },
  },
  pageLifetimes: {
    show() { this._indicatorVisible = true; this.syncPageState(true); this.syncIndicator(this.data.selected); },
    hide() { this._indicatorVisible = false; this.stopIndicator(false); },
  },
  methods: {
    stopIndicator(resetView = true) {
      this._indicatorEpoch = (this._indicatorEpoch || 0) + 1;
      this._indicatorFlight = null;
      if (this._indicatorTimer) { clearTimeout(this._indicatorTimer); this._indicatorTimer = null; }
      if (resetView && this._indicatorVisible !== false && !this._indicatorDetached && this.data.indicatorAnimating)
        this.setData({ indicatorAnimating: false });
    },
    syncIndicator(index) {
      if (!Number.isInteger(index) || !this.data.items[index]) return;
      if (this._indicatorDetached || this._indicatorVisible === false || this.data.authBlocked ||
          this.data.commentsOpen || this.data.composerOpen || this.data.menuOpen) { this.stopIndicator(); return; }
      const state = tabSelection.read(index), key = `${index}:${state.id}`;
      if (this._indicatorFlight === key) return;
      // 只取消旧回调；不能先撤掉 CSS 动画暴露 inline 终点，再写回当前坐标。
      this.stopIndicator(false);
      this._indicatorFlight = key;
      const epoch = this._indicatorEpoch;
      if (!state.active) { this.setData({ indicatorAnimating: false, indicatorPosition: state.position }); return; }
      // 先呈现当前进度，再从同一时间点接续 CSS 动画；跨页不从上次停留的标签重播。
      const animate = () => {
        if (epoch !== this._indicatorEpoch || this._indicatorDetached || this._indicatorVisible === false) return;
        const latest = tabSelection.read(index);
        if (!latest.active || latest.id !== state.id) {
          this.setData({ indicatorPosition: latest.position });
          this._indicatorFlight = null;
          return;
        }
        this.setData({ indicatorAnimating: true, indicatorPosition: latest.to, indicatorFrom: latest.from,
          indicatorTo: latest.to, indicatorDuration: latest.duration, indicatorDelay: -latest.elapsed });
        this._indicatorTimer = setTimeout(() => {
          if (epoch !== this._indicatorEpoch || this._indicatorDetached || this._indicatorVisible === false) return;
          this._indicatorTimer = null;
          this.setData({ indicatorAnimating: false, indicatorPosition: latest.to });
          this._indicatorFlight = null;
        }, latest.duration - latest.elapsed);
      };
      this.setData({ indicatorAnimating: false, indicatorPosition: state.position }, () => {
        if (typeof wx.nextTick === 'function') wx.nextTick(animate); else animate();
      });
    },
    syncPageState(arriving = false) {
      const pages = getCurrentPages(), page = pages[pages.length - 1];
      const pending = arriving ? tabSelection.pendingIndex() : null;
      if (!page || !page.data) {
        if (pending !== null && !this._switching) this.setData({ selected: pending });
        return;
      }
      // 相册/相机返回时底栏可能比页面晚恢复，始终以当前页面为准。
      const next = {
        composerOpen: Boolean(page.data.composerOpen),
        commentsOpen: Boolean(page.data.commentPostId),
        authBlocked: Boolean(page.data.authChecking || page.data.loginSheetOpen || page.data.composerOpen),
        menuOpen: Boolean(page.data.menuOpen),
        menuInstant: Boolean(page.data.menuInstant),
        compact: page.route === 'pages/home/index' && Boolean(page.data.chromeCompact) &&
          !page.data.menuOpen && !page.data.commentPostId && !page.data.composerOpen && !page.data.authChecking && !page.data.loginSheetOpen,
      };
      const selected = pending === null ? this.data.items.findIndex(item => item.path === `/${page.route}`) : pending;
      // 原生页面栈可能尚未完成切换；不要把正在前往的标签反写回源页索引。
      if (selected >= 0 && !this._switching) next.selected = selected;
      const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => this.data[key] !== value));
      if (Object.keys(changed).length) this.setData(changed);
    },
    stopMenuTouch() {},
    closeProfileMenu() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && typeof page.closeMenu === 'function') page.closeMenu();
    },
    openComposer() {
      this.syncPageState();
      if (this.data.authBlocked || this.data.commentsOpen || this.data.composerOpen || this._switching) return;
      if (this.data.menuOpen) { this.closeProfileMenu(); return; }
      const pages = getCurrentPages(), page = pages[pages.length - 1];
      if (!page || !page.data || page._unloaded || page._visible === false || page.data.tabMenuKey) return;
      if (typeof page.openComposer === 'function') { page.openComposer(); return; }
      this._switching = true;
      wx.switchTab({
        url: '/pages/home/index',
        success: () => {
          const open = () => {
            const currentPages = getCurrentPages(), home = currentPages[currentPages.length - 1];
            if (home && home.route === 'pages/home/index' && !home._unloaded && home._visible !== false &&
                typeof home.openComposer === 'function') home.openComposer();
          };
          if (typeof wx.nextTick === 'function') wx.nextTick(open); else open();
        },
        fail: () => wx.showToast({ title: '发布入口打开失败，请重试', icon: 'none' }),
        complete: () => { this._switching = false; },
      });
    },
    switchTab(event) {
      if (this._switching) return;
      this.syncPageState();
      if (this.data.authBlocked || this.data.commentsOpen || this.data.composerOpen) return;
      if (this.data.menuOpen) { this.closeProfileMenu(); return; }
      const index = Number(event.currentTarget.dataset.index);
      if (!Number.isInteger(index) || !this.data.items[index] || index === this.data.selected || this._switching) return;
      this._switching = true;
      const previous = this.data.selected, previousCompact = this.data.compact, animationId = tabSelection.begin(previous, index);
      this.setData({ selected: index, compact: false });
      const pages = getCurrentPages(), source = pages[pages.length - 1];
      const motionTicket = source && typeof source.prepareTabLeave === 'function' ?
        source.prepareTabLeave(this.data.items[index].path) : null;
      const rollback = () => {
        this._switching = false;
        if (!tabSelection.rollback(animationId, previous)) return false;
        if (!this._indicatorDetached) this.setData({ selected: previous, compact: previousCompact });
        return true;
      };
      wx.switchTab({
        url: this.data.items[index].path,
        success: () => {
          if (motionTicket !== null && source && typeof source.finishTabLeave === 'function') source.finishTabLeave(motionTicket);
        },
        fail: () => {
          if (!rollback()) return;
          if (motionTicket !== null && source && typeof source.cancelTabLeave === 'function') source.cancelTabLeave(motionTicket);
          wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
        },
        complete: () => { tabSelection.complete(animationId); this._switching = false; },
      });
    },
  },
});
