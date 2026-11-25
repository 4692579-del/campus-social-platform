const tabSelection = require('../utils/tab-selection');
const { DEFAULT_TRANSPARENCY, glassStyle, readTransparency, observeTransparency } = require('../utils/dock-transparency');

Component({
  properties: {
    previewTransparency: { type: Number, value: -1, observer: 'updatePreviewTransparency' },
  },
  data: {
    authBlocked: false,
    commentsOpen: false,
    composerOpen: false,
    menuOpen: false,
    menuInstant: false,
    compact: false,
    dockScrollMotion: false,
    dockHandoff: false,
    dockScaleFrom: 1,
    glassPress: '',
    dockGlassStyle: glassStyle(DEFAULT_TRANSPARENCY),
    glassPressedIndex: -1,
    selected: -1,
    litIcons: {},
    iconLeaves: {},
    iconContact: 0,
    indicatorPosition: 0,
    indicatorTo: 0,
    indicatorScale: 'scale(1,1)',
    indicatorMotionStyle: '',
    indicatorDuration: 660,
    indicatorDelay: 0,
    indicatorAnimating: false,
    indicatorVariant: false,
    items: [
      { label: '首页', path: '/pages/home/index', icon: 'home' },
      { label: '消息', path: '/pages/inbox/index', icon: 'paper-plane' },
      { label: '私信', path: '/pages/messages/index', icon: 'bell' },
      { label: '搜索', path: '/pages/search/index', icon: 'search' },
    ],
  },
  observers: {
    'authBlocked, commentsOpen, composerOpen, menuOpen'() {
      if (this.data.authBlocked || this.data.commentsOpen || this.data.composerOpen || this.data.menuOpen) {
        this.clearGlassPress();
        this.stopIndicator();
      }
      else if (this._indicatorVisible !== false && this._indicatorFlight === null) this.paintSelection(this.data.selected);
    },
  },
  lifetimes: {
    attached() {
      if (this.data.previewTransparency >= 0) {
        this.setData({ selected: 0, litIcons: { 0: true } });
        this.updatePreviewTransparency(this.data.previewTransparency);
        return;
      }
      this.updateGlassStyle(readTransparency(wx));
      this._stopObservingTransparency = observeTransparency(value => this.updateGlassStyle(value));
      this._indicatorVisible = true;
      this.syncPageState();
    },
    ready() { if (!(this.data.previewTransparency >= 0)) this.syncPageState(true); },
    detached() {
      if (this.data.previewTransparency >= 0) return;
      this._stopObservingTransparency?.();
      this._indicatorDetached = true; this._glassTouch = null; this.stopIndicator();
      tabSelection.unregister(this._tabOwner, this);
    },
  },
  pageLifetimes: {
    show() {
      if (this.data.previewTransparency >= 0) return;
      this._indicatorVisible = true;
      this._dockDeparture = null;
      const page = this._tabPageState;
      this._tabPageState = null;
      if (page && tabSelection.pendingIndex() === page.index) this.syncFromPage(page.index, page.values);
      else this.syncPageState(true);
    },
    hide() {
      if (this.data.previewTransparency >= 0) return;
      this._indicatorVisible = false;
      this._arrivingFlight = null;
      this._tabPageState = null;
      this.clearGlassPress(); this.stopIndicator(false);
      if (this.data.dockScrollMotion) this.setData({ dockScrollMotion: false });
      this.clearDepartedDock();
    },
  },
  methods: {
    updatePreviewTransparency(value) {
      if (value >= 0) this.updateGlassStyle(value);
    },
    updateGlassStyle(value) {
      const dockGlassStyle = glassStyle(value);
      if (this.data.dockGlassStyle !== dockGlassStyle) this.setData({ dockGlassStyle });
    },
    setDockScrollCompact(compact) {
      if (this._indicatorDetached || this._indicatorVisible === false || this._switching ||
          compact === this.data.compact) return;
      this.setData({ compact, dockScrollMotion: true, dockHandoff: false });
    },
    clearDepartedDock() {
      const departure = this._dockDeparture;
      if (!departure?.succeeded || this._indicatorVisible !== false || this._indicatorDetached) return;
      this._dockDeparture = null;
      const page = departure.page;
      if (page && !page._unloaded && page.data?.chromeCompact && typeof page.setData === 'function') page.setData({ chromeCompact: false });
      // 快速返回若已预填了下一次交接，旧页面的成功回调不能覆盖那一帧。
      if (this.data.selected !== departure.target) return;
      if (this.data.compact || this.data.dockHandoff || this.data.dockScaleFrom !== 1) {
        this.setData({ compact: false, dockHandoff: false, dockScaleFrom: 1 });
      }
    },
    pressGlass(event) {
      if (this.data.previewTransparency >= 0 || this._indicatorDetached || this._indicatorVisible === false || this._switching ||
          this.data.authBlocked || this.data.commentsOpen || this.data.composerOpen || this.data.menuOpen) return;
      if (event.touches.length !== 1) { this.clearGlassPress(); return; }
      const { glass, index } = event.currentTarget.dataset;
      if (glass !== 'tabs' && glass !== 'compose') return;
      const { identifier, clientX, clientY } = event.touches[0];
      this._glassTouch = { identifier, x: clientX, y: clientY };
      const pressedIndex = glass === 'tabs' ? Number(index) : -1;
      if (this.data.glassPress !== glass || this.data.glassPressedIndex !== pressedIndex) {
        this.setData({ glassPress: glass, glassPressedIndex: pressedIndex });
      }
    },
    moveGlassPress(event) {
      const start = this._glassTouch;
      if (!start) return;
      const touch = event.touches.length === 1 && event.touches[0];
      if (!touch || touch.identifier !== start.identifier ||
          Math.abs(touch.clientX - start.x) > 12 || Math.abs(touch.clientY - start.y) > 12) this.clearGlassPress();
    },
    releaseGlass(event) {
      if (this._glassTouch && !(event.touches || []).some(touch => touch.identifier === this._glassTouch.identifier)) {
        this.clearGlassPress();
      }
    },
    clearGlassPress() {
      this._glassTouch = null;
      if (!this._indicatorDetached && this.data.glassPress) this.setData({ glassPress: '', glassPressedIndex: -1 });
    },
    stopIndicator(resetView = true) {
      this._indicatorEpoch = (this._indicatorEpoch || 0) + 1;
      this._indicatorFlight = null;
      if (this._indicatorTimer) { clearTimeout(this._indicatorTimer); this._indicatorTimer = null; }
      if (resetView && this._indicatorVisible !== false && !this._indicatorDetached && (this.data.indicatorAnimating || this.data.dockHandoff))
        this.setData({ indicatorAnimating: false, dockHandoff: false });
    },
    paintSelection(index, patch = {}, onPaint) {
      if (this._indicatorDetached || !this.data.items[index]) return;
      const state = tabSelection.read(index), key = `${index}:${state.id}${state.waiting ? ':waiting' : ''}`;
      // 交接首帧由来源底栏的尺寸决定，目标页缓存的缩小状态不能盖过它。
      if (state.waiting) patch = { ...patch, compact: false, dockScrollMotion: false };
      if (this._indicatorFlight === key) {
        if (onPaint) this.setData({ ...patch, indicatorPosition: state.position }, onPaint);
        else if (Object.keys(patch).length) this.setData(patch);
        return;
      }
      this.stopIndicator(false);
      this._indicatorFlight = key;
      const epoch = this._indicatorEpoch;
      const dockScaleFrom = state.scaleFrom ?? 1;
      const dockHandoff = dockScaleFrom < 1;
      const litIcons = Object.fromEntries(state.litIcons.map(icon => [icon, true]));
      if (!state.active) {
        this.setData({ ...patch, dockHandoff, dockScaleFrom, selected: index, litIcons,
          indicatorScale: state.waiting ? `scale(${state.scaleX},${state.scaleY})` : 'scale(1,1)',
          indicatorMotionStyle: state.waiting ? state.motionStyle : '',
          iconContact: 0, iconLeaves: {}, indicatorAnimating: false, indicatorPosition: state.position }, onPaint);
        return;
      }
      this._indicatorTimer = setTimeout(() => {
        if (epoch !== this._indicatorEpoch || this._indicatorDetached || this._indicatorVisible === false) return;
        this._indicatorTimer = null;
        this.setData({ litIcons: { [index]: true }, iconContact: 0, iconLeaves: {}, indicatorAnimating: false,
          indicatorPosition: state.to, indicatorScale: 'scale(1,1)', indicatorMotionStyle: '', dockHandoff: false });
        this._indicatorFlight = `${index}:0`;
      }, state.duration - state.elapsed);
      this.setData({ ...patch, dockHandoff, dockScaleFrom, selected: index, litIcons,
        iconContact: litIcons[index] ? 0 : state.iconContact, iconLeaves: state.iconLeaves,
        indicatorAnimating: true, indicatorPosition: state.position, indicatorScale: 'scale(1,1)', indicatorMotionStyle: state.motionStyle,
        indicatorTo: state.to, indicatorDuration: state.duration, indicatorDelay: -state.elapsed || 0, indicatorVariant: !this.data.indicatorVariant }, onPaint);
    },
    syncFromPage(index, values, arriving = true) {
      if (this._indicatorDetached) return;
      if (this._tabOwner !== undefined && this._tabOwner !== index) return;
      const pending = tabSelection.pendingIndex();
      if (pending !== null && pending !== index) return;
      if (this._tabOwner !== index) {
        tabSelection.unregister(this._tabOwner, this);
        this._tabOwner = index;
        tabSelection.register(index, this);
      }
      if (this._indicatorVisible === false) {
        if (pending === index && arriving) this._tabPageState = { index, values };
        return;
      }
      if (this._switching) return;
      const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => this.data[key] !== value));
      const state = tabSelection.read(index);
      if (!state.waiting || !arriving) {
        if (arriving) tabSelection.acknowledge(index);
        this.paintSelection(index, changed);
        return;
      }
      if (this._arrivingFlight === state.id) return;
      this._arrivingFlight = state.id;
      this.paintSelection(index, changed, () => {
        if (this._indicatorDetached || this._arrivingFlight !== state.id) return;
        this._arrivingFlight = null;
        if (this._indicatorVisible === false || this._switching) return;
        if (tabSelection.start(index, state.id) || tabSelection.pendingIndex() === null) this.paintSelection(index);
      });
    },
    syncPageState(arriving = false) {
      const pages = getCurrentPages(), page = pages[pages.length - 1];
      if (!page || !page.data || (typeof page.getTabBar === 'function' && page.getTabBar() !== this)) return;
      const index = this.data.items.findIndex(item => item.path === `/${page.route}`);
      if (this._tabOwner !== undefined && this._tabOwner !== index) return;
      // 相册/相机返回时底栏可能比页面晚恢复，始终以当前页面为准。
      const next = {
        composerOpen: Boolean(page.data.composerOpen),
        commentsOpen: Boolean(page.data.commentPostId),
        authBlocked: Boolean(page.data.authChecking || page.data.loginSheetOpen || page.data.composerOpen || page.data.membershipOpen),
        menuOpen: Boolean(page.data.menuOpen),
        menuInstant: Boolean(page.data.menuInstant),
        compact: ['pages/home/index', 'pages/search/index'].includes(page.route) && Boolean(page.data.chromeCompact) &&
          !page.data.menuOpen && !page.data.commentPostId && !page.data.composerOpen && !page.data.authChecking && !page.data.loginSheetOpen && !page.data.membershipOpen,
      };
      // 组件 show/ready 可能比页面 onShow 早，不能用还没重置的旧滚动状态。
      if (arriving && index >= 0 && tabSelection.read(index).scaleFrom !== undefined) next.compact = false;
      if (index >= 0) this.syncFromPage(index, next, arriving);
      else if (!this._switching) {
        const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => this.data[key] !== value));
        if (Object.keys(changed).length) this.setData(changed);
      }
    },
    stopMenuTouch() {},
    closeProfileMenu() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && typeof page.closeMenu === 'function') page.closeMenu();
    },
    openComposer() {
      if (this.data.previewTransparency >= 0) return;
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
      if (this.data.previewTransparency >= 0 || this._switching) return;
      this.syncPageState();
      if (this.data.authBlocked || this.data.commentsOpen || this.data.composerOpen) return;
      if (this.data.menuOpen) { this.closeProfileMenu(); return; }
      const index = Number(event.currentTarget.dataset.index);
      if (!Number.isInteger(index) || !this.data.items[index] || index === this.data.selected || this._switching) return;
      const previous = this.data.selected, previousCompact = this.data.compact;
      const animationId = tabSelection.begin(previous, index, previousCompact);
      this._switching = true;
      this._tabNavigationId = animationId;
      const pages = getCurrentPages(), source = pages[pages.length - 1];
      const departure = this._dockDeparture = { target: index, page: source, succeeded: false };
      const rollback = () => {
        if (this._tabNavigationId !== animationId) return false;
        if (!tabSelection.rollback(animationId, previous)) return false;
        this.paintSelection(previous, { compact: previousCompact });
        tabSelection.prepare(index, this);
        return true;
      };
      const cachedTarget = tabSelection.prepare(index, this);
      if (!cachedTarget) tabSelection.start(index, animationId, true);
      this.paintSelection(index, { compact: false, dockScrollMotion: false });
      wx.switchTab({
          url: this.data.items[index].path,
          success: () => {
            if (this._dockDeparture === departure) {
              departure.succeeded = true;
              this.clearDepartedDock();
            }
          },
          fail: () => {
            if (this._dockDeparture === departure) this._dockDeparture = null;
            if (!rollback()) return;
            wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
          },
          complete: () => {
            if (this._tabNavigationId !== animationId) return;
            this._tabNavigationId = null;
            this._switching = false;
            if (this._indicatorVisible !== false && tabSelection.pendingIndex() === this._tabOwner) this.syncPageState(true);
          },
      });
    },
  },
});
