const { CYCLE, REFILL, THRESHOLD, clamp } = require('../../utils/cui-refresh-drawing');
const { patchState } = require('../../utils/tab-page-layout');

module.exports = {
  data: { searchRefreshPhase: 'idle', searchRefreshing: false, searchRefreshVisible: false, searchRefreshThreshold: THRESHOLD },
  methods: {
    canPullSearch() {
      return !this._unloaded && this._visible !== false && this.data.searchActive &&
        !this.data.menuOpen && !this.data.platformMenuOpen && !this.interactionBlocked() &&
        this.data.boardIndex !== 2 && !this._openingSearchEntry && !this._openingResults && !this._openingCuiPromoPost;
    },
    paintSearchBrand(state) {
      this._searchBrand = state;
      const brand = this.selectComponent?.('#search-cui');
      brand?.setState(state);
    },
    onSearchBrandReady() {
      if (this.data.searchRefreshVisible) this.paintSearchBrand(this._searchBrand);
    },
    beginSearchPull() {
      if (!this.canPullSearch() || this.data.searchRefreshing) return;
      if (this.data.searchRefreshPhase === 'pulling') this.stopSearchRefresh();
      this._searchPullActive = true;
    },
    pullSearch(event) {
      if (!this._searchPullActive || !this.canPullSearch() || this.data.searchRefreshing) return;
      const progress = clamp((Number(event.detail?.dy) || 0) / THRESHOLD);
      if (!progress && this.data.searchRefreshPhase !== 'pulling') return;
      // 字标固定在缺口中。可见空间足够后才显示，避免盖住尚未下移的标签栏。
      patchState(this, { searchRefreshPhase: 'pulling', searchRefreshVisible: progress >= 0.85 });
      this.paintSearchBrand({ phase: 'pulling', progress });
    },
    releaseSearchPull() {
      if (!this._searchPullActive) return;
      this._searchPullActive = false;
      if (this.data.searchRefreshPhase !== 'pulling') return;
      if (this._searchBrand.progress < 1) { this.cancelSearchPull(); return; }
      // 原生没有发出 refresh 或 restore 时，也不能把字标留在页面上。
      this.deferSearchPullCancel();
    },
    deferSearchPullCancel() {
      if (this.data.searchRefreshPhase !== 'pulling') return;
      this._searchPullActive = false;
      clearTimeout(this._searchRefreshTimer);
      this._searchRefreshTimer = setTimeout(() => {
        this._searchRefreshTimer = null;
        this.cancelSearchPull();
      }, 300);
    },
    cancelSearchPull() {
      this._searchPullActive = false;
      if (this.data.searchRefreshPhase !== 'pulling') return;
      this.stopSearchRefresh();
    },
    refreshSearch() {
      if (this._searchRefresh) return this._searchRefresh.promise;
      if (this.data.searchRefreshPhase !== 'pulling' || !this.canPullSearch()) return;
      clearTimeout(this._searchRefreshTimer);
      const refresh = this._searchRefresh = { startedAt: Date.now() };
      this._searchPullActive = false;
      this.setData({ searchRefreshPhase: 'loading', searchRefreshing: true, searchRefreshVisible: true });
      this.paintSearchBrand({ phase: 'loading', startedAt: refresh.startedAt });

      const load = this.data.boardIndex === 0 ? this.loadCuiHotboard(true) : this.loadHotboard(true);
      refresh.promise = Promise.resolve(load).finally(() => {
        if (this._searchRefresh !== refresh) return;
        const elapsed = Math.max(0, Date.now() - refresh.startedAt);
        const finishAt = Math.max(CYCLE, Math.ceil(elapsed / CYCLE) * CYCLE);
        this._searchRefreshTimer = setTimeout(() => {
          if (this._searchRefresh !== refresh) return;
          this.setData({ searchRefreshPhase: 'refill' });
          this.paintSearchBrand({ phase: 'refill', duration: REFILL, startedAt: Date.now() });
          this._searchRefreshTimer = setTimeout(() => {
            if (this._searchRefresh === refresh) this.stopSearchRefresh();
          }, REFILL);
        }, finishAt - elapsed);
      });
      return refresh.promise;
    },
    stopSearchRefresh() {
      clearTimeout(this._searchRefreshTimer);
      this._searchRefreshTimer = null;
      this._searchRefresh = null;
      this._searchPullActive = false;
      this._searchBrand = { phase: 'idle' };
      // 先撤掉字标；组件卸载会取消 Canvas 帧，避免结束时切回静态字标。
      patchState(this, { searchRefreshPhase: 'idle', searchRefreshing: false, searchRefreshVisible: false });
    },
  },
};
