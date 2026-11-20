const { CYCLE, REFILL, THRESHOLD, clamp } = require('./cui-refresh-drawing');
module.exports = {
  canPullHomeFeed() {
    return !this._unloaded && this._visible !== false && !this.data.menuOpen && !this.data.tabMenuKey && !this.data.commentPostId && !this.interactionBlocked() && this.isSquareFeed();
  },
  paintHomeBrand(state) {
    this._brandVisual = state;
    const component = typeof this.selectComponent === 'function' && this.selectComponent('#home-cui');
    if (component && typeof component.setState === 'function') component.setState(state);
  },
  onHomeBrandReady() { this.paintHomeBrand(this._brandVisual || { phase: 'idle' }); },
  pullHomeFeed(event) {
    if (!this.canPullHomeFeed() || this.data.pullRefreshing) return;
    if (this._pullReturnTimer) { clearTimeout(this._pullReturnTimer); this._pullReturnTimer = null; }
    this._pullProgress = clamp(Number(event.detail.dy) / THRESHOLD);
    if (this.data.brandRefreshPhase !== 'pulling') { this.stopBrandBounce(); this.setData({ brandRefreshPhase: 'pulling' }); }
    this.paintHomeBrand({ phase: 'pulling', progress: this._pullProgress });
  },
  releaseHomePull() { if (this.data.brandRefreshPhase === 'pulling' && this._pullProgress < 1) this.cancelHomePull(); },
  cancelHomePull() {
    if (this.data.pullRefreshing || this.data.brandRefreshPhase !== 'pulling') return;
    const duration = Math.max(160, Math.round((this._pullProgress || 0) * 440));
    this.setData({ brandRefreshPhase: 'returning' });
    this.paintHomeBrand({ phase: 'returning', duration, startedAt: Date.now() });
    this._pullReturnTimer = setTimeout(() => {
      this._pullReturnTimer = null;
      if (this._unloaded || this._visible === false || this.data.brandRefreshPhase !== 'returning') return;
      this._pullProgress = 0; this.setData({ brandRefreshPhase: 'idle' }); this.paintHomeBrand({ phase: 'idle' });
    }, duration);
  },
  restoreHomePull() {
    if (this._pullRefresh && this.data.brandRefreshPhase === 'settling') this.startHomeRefreshWave(this._pullRefresh);
    else this.cancelHomePull();
  },
  startHomeRefreshWave(refresh) {
    if (this._pullRefresh !== refresh || refresh.startedAt !== null) return;
    if (refresh.settleTimer) clearTimeout(refresh.settleTimer);
    refresh.startedAt = Date.now();
    this.setData({ brandRefreshPhase: 'loading' });
    this.paintHomeBrand({ phase: 'loading', startedAt: refresh.startedAt });
    refresh.resolveWave();
  },
  waitHomeRefresh(refresh, duration) {
    if (this._pullRefresh !== refresh) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => { refresh.waits.delete(timer); resolve(); }, duration);
      refresh.waits.set(timer, resolve);
    });
  },
  refreshFeed() {
    if (this.data.pullRefreshing) return this._pullRefreshPromise;
    if (!this.canPullHomeFeed()) return;
    if (this._pullReturnTimer) { clearTimeout(this._pullReturnTimer); this._pullReturnTimer = null; }
    this.stopBrandBounce();
    const refresh = { startedAt: null, waits: new Map() };
    const waveReady = new Promise(resolve => { refresh.resolveWave = resolve; });
    this._pullRefresh = refresh; this._pullProgress = 1;
    this.paintHomeBrand({ phase: 'settling', progress: 1 });
    const collapse = () => {
      if (this._pullRefresh !== refresh) return;
      // 原生列表先回位，联网与字标状态独立，不能将列表悬停在刷新区域。
      this.setData({ nativeRefreshing: false });
      refresh.settleTimer = setTimeout(() => this.startHomeRefreshWave(refresh), 240);
    };
    this.setData({ pullRefreshing: true, nativeRefreshing: true, brandRefreshPhase: 'settling' },
      () => { if (typeof wx.nextTick === 'function') wx.nextTick(collapse); else collapse(); });
    const wasAppending = this._feedBusy && this._feedAppend;
    const request = (async () => {
      try {
        if (wasAppending) await this._feedPromise;
        if (this._pullRefresh === refresh) await this.loadFeed(true);
        if (this._pullRefresh !== refresh) return;
        await waveReady;
        if (this._pullRefresh !== refresh) return;
        const elapsed = Math.max(0, Date.now() - refresh.startedAt);
        const finishAt = Math.max(CYCLE, Math.ceil(elapsed / CYCLE) * CYCLE);
        await this.waitHomeRefresh(refresh, Math.max(0, finishAt - elapsed));
        if (this._pullRefresh !== refresh) return;
        this.setData({ brandRefreshPhase: 'refill' });
        this.paintHomeBrand({ phase: 'refill', duration: REFILL, startedAt: Date.now() });
        await this.waitHomeRefresh(refresh, REFILL);
      } finally { if (this._pullRefresh === refresh) this.stopHomeRefresh(); }
    })();
    this._pullRefreshPromise = request;
    return request;
  },
  stopHomeRefresh() {
    const refresh = this._pullRefresh;
    this._pullRefresh = null; this._pullRefreshPromise = null; this._pullProgress = 0;
    if (this._pullReturnTimer) { clearTimeout(this._pullReturnTimer); this._pullReturnTimer = null; }
    if (refresh) {
      if (refresh.settleTimer) clearTimeout(refresh.settleTimer);
      refresh.resolveWave();
      for (const [timer, resolve] of refresh.waits) { clearTimeout(timer); resolve(); }
      refresh.waits.clear();
    }
    if (this.data.pullRefreshing || this.data.nativeRefreshing || this.data.brandRefreshPhase !== 'idle')
      this.setData({ pullRefreshing: false, nativeRefreshing: false, brandRefreshPhase: 'idle' });
    this.paintHomeBrand({ phase: 'idle' });
  },
};
