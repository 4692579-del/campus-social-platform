const { clamp, ease, CYCLE, drawLogo } = require('../../utils/cui-refresh-drawing');
Component({
  data: { canvasVisible: false },
  lifetimes: {
    ready() { this.initializeCanvas(); },
    detached() { this._dead = true; this.stopFrame(); this._canvas = null; this._ctx = null; },
  },
  pageLifetimes: { hide() { this.setState({ phase: 'idle' }); }, resize() { this.initializeCanvas(); } },
  methods: {
    initializeCanvas() {
      const version = this._measureVersion = (this._measureVersion || 0) + 1;
      this.createSelectorQuery().select('#cui-motion').fields({ node: true, size: true }).exec(result => {
        if (this._dead || version !== this._measureVersion) return;
        const item = result && result[0];
        if (!item || !item.node || !item.width || !item.height) return;
        let context;
        try { context = item.node.getContext('2d'); } catch (error) { return; }
        if (!context) return;
        this.stopFrame(); this._canvas = item.node; this._ctx = context;
        let ratio = 2; try { ratio = wx.getWindowInfo().pixelRatio || ratio; } catch (error) { /* 默认高清比例。 */ }
        this._width = item.width; this._height = item.height;
        item.node.width = Math.round(item.width * ratio); item.node.height = Math.round(item.height * ratio);
        this._ctx.scale(ratio, ratio);
        this.setState(this._state || { phase: 'idle' }); this.triggerEvent('ready');
      });
    },
    stopFrame() { if (this._frame !== undefined && this._canvas) this._canvas.cancelAnimationFrame(this._frame); this._frame = undefined; },
    setState(state) {
      if (this._dead) return;
      this._state = state;
      if (!this._ctx) return;
      this.stopFrame();
      if (state.phase === 'idle') { if (this.data.canvasVisible) this.setData({ canvasVisible: false }); this._progress = 0; return; }
      if (!this.data.canvasVisible) this.setData({ canvasVisible: true });
      if (state.phase === 'pulling' || state.phase === 'settling') {
        this._progress = clamp(state.progress); this.paint({ progress: this._progress }); return;
      }
      const start = state.startedAt ?? Date.now(), from = clamp(state.progress ?? this._progress);
      const tick = () => {
        if (this._dead || this._state !== state) return;
        const elapsed = Math.max(0, Date.now() - start);
        if (state.phase === 'loading') this.paint({ elapsed: elapsed % CYCLE });
        else {
          const p = clamp(elapsed / state.duration);
          this._progress = state.phase === 'returning' ? from * (1 - ease(p)) : p;
          this.paint({ progress: this._progress, refill: state.phase === 'refill' });
          if (p === 1) { this._frame = undefined; return; }
        }
        this._frame = this._canvas.requestAnimationFrame(tick);
      };
      tick();
    },
    paint(frame) { drawLogo(this._ctx, this._width, this._height, frame); },
  },
});
