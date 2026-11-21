const { rememberSize, imageLayout } = require('../../utils/post-image-layout');
Component({
  properties: { post: Object, viewer: Object, detail: Boolean, likeMotion: Boolean },
  data: { expanded: false, imageIndex: 0, imageFiles: [], galleryWidth: 100, galleryHeight: 471, likeMotionClass: '',
    likeParticleRays: [
      { angle: 0, color: '#b39ad4', accent: '#94c8d1' }, { angle: 51.4, color: '#ad83b3', accent: '#c1a4bf' },
      { angle: 102.9, color: '#a9d2a2', accent: '#86c6bd' }, { angle: 154.3, color: '#d4b275', accent: '#aec58e' },
      { angle: 205.7, color: '#9173ac', accent: '#c49ac7' }, { angle: 257.1, color: '#89bcca', accent: '#99d8be' },
      { angle: 308.6, color: '#95d3ab', accent: '#b4c9e5' },
    ],
  },
  lifetimes: { detached() { this._unloaded = true; this.clearLikeMotion(); } },
  pageLifetimes: {
    hide() { this._pageHidden = true; this.clearLikeMotion(); },
    show() { this._pageHidden = false; if (this._pendingImageLayout) { this._pendingImageLayout = false; this.updateImageLayout(); } },
  },
  observers: {
    'post._id': function (id) {
      if (this._postId === id) return;
      this.clearLikeMotion();
      this._postId = id;
      this.setData({ expanded: false, imageIndex: 0 });
    },
    'viewer._id': function (id) {
      if (this._likeViewerId === id) return;
      this._likeViewerId = id;
      this.clearLikeMotion();
    },
    'post.liked': function (liked) {
      const target = Boolean(liked), intent = this._likeIntent;
      if (!intent) {
        // 保存失败的回退只恢复真实图标，不再播放一次用户点击动画。
        if (this.data.likeMotionClass && this._animatedLikeTarget !== target) this.clearLikeMotion();
        return;
      }
      if (this._unloaded || this._pageHidden || !this.data.likeMotion || intent.id !== this.data.post._id || Date.now() > intent.expires) {
        this.clearLikeMotion(); return;
      }
      if (target === intent.from) return;
      this._likeIntent = null;
      this.playLikeMotion(target);
    },
    'post.images': function (images) {
      if (this._unloaded) return;
      const files = Array.isArray(images) ? images : [];
      // 时间、点赞或页面恢复重新传入同一组图片时，不重写 src 和轮播列表。
      if (files.length === this.data.imageFiles.length && files.every((file, index) => file === this.data.imageFiles[index])) return;
      this.setData({ imageFiles: files.slice(), ...imageLayout(files, this.data.detail), ...(this.data.imageIndex >= files.length && this.data.imageIndex !== 0 ? { imageIndex: 0 } : {}) });
    },
    detail() { if (!this._unloaded) this.updateImageLayout(); },
  },
  methods: {
    stopEvent() {},
    clearLikeMotion() {
      this._likeIntent = null;
      this._likeMotionSequence = (this._likeMotionSequence || 0) + 1;
      if (this._likeMotionTimer) { clearTimeout(this._likeMotionTimer); this._likeMotionTimer = null; }
      if (!this._unloaded && this.data.likeMotionClass) this.setData({ likeMotionClass: '' });
    },
    playLikeMotion(liked) {
      if (this._unloaded || this._pageHidden || !this.data.likeMotion) return;
      if (this._likeMotionTimer) clearTimeout(this._likeMotionTimer);
      const sequence = this._likeMotionSequence = (this._likeMotionSequence || 0) + 1;
      this._likeMotionVariant = !this._likeMotionVariant;
      this._animatedLikeTarget = liked;
      // 交替动画名可在一次视图更新中重播，不重建图片或等待一帧清空样式。
      this.setData({ likeMotionClass: `is-${liked ? 'like' : 'unlike'}-${this._likeMotionVariant ? 'a' : 'b'}` });
      this._likeMotionTimer = setTimeout(() => {
        if (this._unloaded || this._pageHidden || sequence !== this._likeMotionSequence) return;
        this._likeMotionTimer = null;
        this.setData({ likeMotionClass: '' });
      }, liked ? 960 : 440);
    },
    updateImageLayout() {
      if (this._unloaded) return;
      const next = imageLayout(this.data.imageFiles, this.data.detail);
      const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => this.data[key] !== value));
      if (Object.keys(changed).length) this.setData(changed);
    },
    photoLoaded(event) {
      const file = event.currentTarget.dataset.file;
      if (this._unloaded || !this.data.imageFiles.includes(file)) return;
      rememberSize(file, event.detail.width, event.detail.height);
      // 同一图片可能在首页和详情同时解码；缓存已由另一实例写入时，本实例仍需应用尺寸。
      if (file !== this.data.imageFiles[0]) return;
      if (this._pageHidden) this._pendingImageLayout = true;
      else this.updateImageLayout();
    },
    open() { if (!this.data.detail) this.triggerEvent('open', { id: this.data.post._id }); },
    toggleExpanded() { this.setData({ expanded: !this.data.expanded }); },
    reply() { this.triggerEvent('reply', { id: this.data.post._id }); },
    quote() { this.triggerEvent('quote', { id: this.data.post._id }); },
    like() {
      if (this._unloaded || this._pageHidden) return;
      this._likeIntent = this.data.likeMotion && this.data.viewer ? { id: this.data.post._id, from: Boolean(this.data.post.liked), expires: Date.now() + 750 } : null;
      this.triggerEvent('react', { id: this.data.post._id, kind: 'like' });
    },
    more() { this.triggerEvent('more', { id: this.data.post._id }); },
    imageChanged(event) {
      const index = event.detail.current, images = this.data.post.images || [];
      if (this._unloaded || this._pageHidden || !Number.isInteger(index) || index < 0 || index >= images.length || index === this.data.imageIndex) return;
      this.setData({ imageIndex: index });
    },
    async previewImage(event) {
      if (this._previewing) return;
      const files = this.data.post.images || [], current = files[Number(event.currentTarget.dataset.index)];
      if (!current) return;
      this._previewing = true;
      try { await require('../../services/post-images').previewImages(files, current); }
      catch (error) { if (!this._unloaded && error.code !== 'SESSION_CHANGED') wx.showToast({ title: error.message || '图片预览失败，请重试', icon: 'none' }); }
      finally { this._previewing = false; }
    },
  },
});
