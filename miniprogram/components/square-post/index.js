Component({
  properties: { post: Object, viewer: Object, detail: Boolean },
  data: { expanded: false, imageIndex: 0, imageFiles: [] },
  lifetimes: { detached() { this._unloaded = true; } },
  pageLifetimes: {
    hide() { this._pageHidden = true; },
    show() { this._pageHidden = false; },
  },
  observers: {
    'post._id': function (id) {
      if (this._postId === id) return;
      this._postId = id;
      this.setData({ expanded: false, imageIndex: 0 });
    },
    'post.images': function (images) {
      if (this._unloaded) return;
      const files = Array.isArray(images) ? images : [];
      // 时间、点赞或页面恢复重新传入同一组图片时，不重写 src 和轮播列表。
      if (files.length === this.data.imageFiles.length && files.every((file, index) => file === this.data.imageFiles[index])) return;
      this.setData({ imageFiles: files.slice(), ...(this.data.imageIndex >= files.length && this.data.imageIndex !== 0 ? { imageIndex: 0 } : {}) });
    },
  },
  methods: {
    stopEvent() {},
    open() { if (!this.data.detail) this.triggerEvent('open', { id: this.data.post._id }); },
    toggleExpanded() { this.setData({ expanded: !this.data.expanded }); },
    reply() { this.triggerEvent('reply', { id: this.data.post._id }); },
    like() { this.triggerEvent('react', { id: this.data.post._id, kind: 'like' }); },
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
