const { hasDecodedSize, rememberSize } = require('../../utils/post-image-layout');
Component({
  properties: { src: String, mode: { type: String, value: 'aspectFill' }, lazyLoad: { type: Boolean, value: true } },
  data: { nodes: [], ready: false, failed: false, known: false, active: false },
  observers: { src(value) { this.syncSource(value); } },
  lifetimes: {
    attached() { this.syncSource(this.data.src); },
    ready() {
      if (this._dead) return;
      if (typeof this.createIntersectionObserver !== 'function') { this._inViewport = true; this.syncActivity(); return; }
      try {
        this._visibility = this.createIntersectionObserver({ thresholds: [0] });
        this._visibility.relativeToViewport({ top: 60, bottom: 60 }).observe('.media-frame', result => {
          if (this._dead) return;
          this._inViewport = result.intersectionRatio > 0; this.syncActivity();
        });
      } catch (error) {
        if (this._visibility) this._visibility.disconnect();
        this._inViewport = true; this.syncActivity();
      }
    },
    detached() { this._dead = true; if (this._visibility) this._visibility.disconnect(); },
  },
  pageLifetimes: {
    hide() { this._hidden = true; this.syncActivity(); },
    show() { this._hidden = false; this.syncActivity(); },
  },
  methods: {
    syncSource(value) {
      const src = typeof value === 'string' ? value : '';
      if (this._dead || this._source === src) return;
      this._source = src; this._generation = (this._generation || 0) + 1;
      // 只在真正换图时换原生节点，加载/切页/点赞都不重建image或重写src。
      this.setData({ nodes: src ? [{ key: this._generation, src }] : [], ready: false, failed: !src, known: hasDecodedSize(src) });
    },
    syncActivity() {
      if (this._dead) return;
      const active = Boolean(this._inViewport && !this._hidden);
      if (active !== this.data.active) this.setData({ active });
    },
    current(event) { return !this._dead && Number(event.currentTarget.dataset.key) === this._generation; },
    loaded(event) {
      if (!this.current(event) || this.data.ready) return;
      const width = Number(event.detail.width), height = Number(event.detail.height);
      if (!(width > 0 && height > 0)) { this.loadFailed(event); return; }
      // 复用既有256项公开成品尺寸缓存，不缓存私有原件、临时URL或图片数据。
      if (this._source.startsWith('cloud://') && this._source.includes('/square-media/')) rememberSize(this._source, width, height);
      this.setData({ ready: true, failed: false, ...(this._hidden ? { known: true } : {}) });
      this.triggerEvent('load', { width, height });
    },
    loadFailed(event) {
      if (!this.current(event) || this.data.ready || this.data.failed) return;
      this.setData({ failed: true });
      this.triggerEvent('error', { errMsg: '图片暂时无法加载' });
    },
  },
});
