const { patchState } = require('./tab-page-layout');
const RESTORE_SCROLL_GRACE_MS = 120;

// 过滤触摸抖动与两端回弹。输出只有两个目标状态，不使用滚动进度作为缩放比例。
function createDirectionTracker(initial = 0) {
  let previous = initial, direction = 0, distance = 0;
  return {
    reset(top = previous) { previous = top; direction = 0; distance = 0; },
    update(top) {
      const delta = top - previous;
      previous = top;
      if (top <= 1) { direction = 0; distance = 0; return false; }
      if (Math.abs(delta) < .5) return null;
      const next = delta > 0 ? 1 : -1;
      distance = next === direction ? distance + Math.abs(delta) : Math.abs(delta);
      direction = next;
      if (distance < 3) return null;
      distance = 0;
      return direction > 0;
    },
  };
}

module.exports = {
  createDirectionTracker,
  data: { chromeCompact: false, chromeSafeTop: 20, chromeHeaderHeight: 116.5 },
  methods: {
    configureHomeChrome() {
      try {
        const info = wx.getWindowInfo();
        this._chromeViewportHeight = info.windowHeight || 0;
        const width = info.windowWidth || this._homeWidth || 375;
        patchState(this, { chromeSafeTop: Math.max(0, Math.min(info.statusBarHeight || 0, this.data.navTop)),
          chromeHeaderHeight: this.data.navHeight + 89 * width / 750 });
      } catch (error) { /* 旧客户端保留顶部安全留白。 */ }
    },
    resetHomeChrome(returning = false) {
      this._chromeRestoreUntil = returning ? Date.now() + RESTORE_SCROLL_GRACE_MS : 0;
      this._chromeNeedsBaseline = true;
      this._chromeTrackers = {};
      this.setHomeChrome(false, !returning);
    },
    revealHomeChrome() { this.setHomeChrome(false); },
    setHomeChrome(compact, animate = true) {
      if (this._unloaded) return;
      compact = Boolean(compact);
      if (this.data.chromeCompact === compact) return;
      this.setData({ chromeCompact: compact });
      const bar = typeof this.getTabBar === 'function' && this.getTabBar();
      if (animate && typeof bar?.setDockScrollCompact === 'function') bar.setDockScrollCompact(compact);
      this.syncNavigation();
    },
    onHomeFeedTouchStart(event) {
      const key = event.currentTarget.dataset.feed;
      if (key !== this.data.activeTab) return;
      this._chromeRestoreUntil = 0;
      this._chromeNeedsBaseline = false;
      const positions = this._chromePositions || {};
      const trackers = this._chromeTrackers || (this._chromeTrackers = {});
      trackers[key] = createDirectionTracker(positions[key] || 0);
    },
    onHomeFeedDragStart(event) {
      if (this._chromeNeedsBaseline || this._chromeRestoreUntil) this.onHomeFeedTouchStart(event);
    },
    onHomeFeedScroll(event) {
      if (this._unloaded || this._visible === false) return;
      const key = event.currentTarget.dataset.feed;
      if (key !== this.data.activeTab) return;
      const raw = Number(event.detail.scrollTop);
      if (!Number.isFinite(raw)) return;
      const height = Number(event.detail.scrollHeight);
      const max = this._chromeViewportHeight > 0 && height > 0 ? Math.max(0, height - this._chromeViewportHeight) : Infinity;
      const top = Math.max(0, Math.min(raw, max));
      const positions = this._chromePositions || (this._chromePositions = {});
      const previous = positions[key] || 0;
      if (this.data.authorMenu && Math.abs(top - previous) > 1 && typeof this.closeAuthorMenu === 'function') this.closeAuthorMenu();
      positions[key] = top;
      const trackers = this._chromeTrackers || (this._chromeTrackers = {});
      const tracker = trackers[key] || (trackers[key] = createDirectionTracker(previous));
      if (this._chromeRestoreUntil) {
        if (Date.now() < this._chromeRestoreUntil) {
          this._chromeNeedsBaseline = false;
          tracker.reset(top);
          return;
        }
        this._chromeRestoreUntil = 0;
      }
      if (this.data.menuOpen || this.data.authorMenu || this.data.commentPostId || this.interactionBlocked() ||
          this.data.pullRefreshing || this.data.nativeRefreshing || this.data.brandRefreshPhase !== 'idle') {
        tracker.reset(top);
        this.revealHomeChrome();
        return;
      }
      if (this._chromeNeedsBaseline) {
        this._chromeNeedsBaseline = false;
        tracker.reset(top);
        if (top <= 1) this.revealHomeChrome();
        return;
      }
      const compact = tracker.update(top);
      if (compact !== null && compact !== this.data.chromeCompact) {
        const bar = typeof this.getTabBar === 'function' && this.getTabBar();
        if (!bar || !bar._switching) this.setHomeChrome(compact);
      }
    },
  },
};
