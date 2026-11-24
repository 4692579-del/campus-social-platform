const { postView } = require('../../utils/post-view');
const { imageLayout, rememberSize, patchImageLayout } = require('../../utils/post-image-layout');
const { postMedia } = require('../../utils/post-media');
const ID = /^p_[a-f0-9]{40}$/;
Component({
  properties: { quote: Object, removable: Boolean, disabled: Boolean },
  data: { frames: [] },
  observers: { quote(value) {
    if (this._dead) return;
    const frames = [], seen = new Set();
    for (let item = value; item && ID.test(item._id || '') && !seen.has(item._id) && frames.length < 4; item = item.quote) {
      seen.add(item._id);
      const mediaItems = postMedia(item), images = mediaItems.map(media => media.fileID);
      const previous = this.data.frames.find(row => row._id === item._id);
      const { quote: nested, ...body } = item;
      const photoStrip = images.length > 1 && mediaItems.every(media => media.type === 'image');
      frames.push({ ...postView({ content: '', author: null, declaration: 'none', createdAt: '', ...body }),
        unavailable: Boolean(item.unavailable), collapsed: Boolean(item.collapsed), loading: Boolean(item.loading), failed: Boolean(item.failed), images, mediaItems,
        imageIndex: previous && previous.imageIndex < images.length ? previous.imageIndex : 0, photoStrip, photoFrames: [], ...imageLayout(images, false, this._imageWidths?.get(item._id)) });
    }
    const patch = {};
    if (frames.length !== this.data.frames.length || frames.some((row, i) => row._id !== this.data.frames[i]._id)) patch.frames = frames;
    else frames.forEach((row, i) => { for (const [key, value] of Object.entries(row)) {
      if (key !== 'quote' && JSON.stringify(value) !== JSON.stringify(this.data.frames[i][key])) patch[`frames[${i}].${key}`] = value;
    } });
    if (Object.keys(patch).length) this.setData(patch);
    if (typeof wx.nextTick === 'function') wx.nextTick(() => this.measureImages());
  } },
  lifetimes: { ready() { this.measureImages(); }, detached() { this._dead = true; } },
  pageLifetimes: { resize() { this.measureImages(); }, hide() { this._hidden = true; }, show() {
    this._hidden = false; this._opening = false;
    const patch = {};
    this.data.frames.forEach((row, i) => {
      patchImageLayout(patch, row, imageLayout(row.images, false, this._imageWidths?.get(row._id)), `frames[${i}].`);
    });
    if (Object.keys(patch).length) this.setData(patch);
    this.measureImages();
  } },
  methods: {
    stopEvent() {},
    measureImages() {
      if (this._dead || this._hidden || typeof this.createSelectorQuery !== 'function') return;
      const sequence = this._measureSequence = (this._measureSequence || 0) + 1;
      const ids = this.data.frames.map(row => row._id);
      this.createSelectorQuery().selectAll('.quote-media-width').fields({ size: true, dataset: true }).exec(result => {
        if (this._dead || this._hidden || sequence !== this._measureSequence || ids.join() !== this.data.frames.map(row => row._id).join()) return;
        let width = 375;
        try { width = wx.getWindowInfo().windowWidth || width; } catch (error) { /* 保留标准rpx换算。 */ }
        this._imageWidths = this._imageWidths || new Map();
        const patch = {};
        for (const box of result && result[0] || []) {
          const i = Number(box.dataset.frame), row = this.data.frames[i];
          if (!row || !(box.width > 0)) continue;
          const available = Math.round(box.width * 750 / width * 100) / 100;
          this._imageWidths.set(row._id, available);
          patchImageLayout(patch, row, imageLayout(row.images, false, available), `frames[${i}].`);
        }
        if (Object.keys(patch).length) this.setData(patch);
      });
    },
    remove() { if (!this.data.disabled && !this._dead) this.triggerEvent('remove'); },
    open(event) {
      if (this.data.removable || this._dead || this._hidden || this._opening) return;
      const id = event.currentTarget.dataset.id, row = this.data.frames.find(item => item._id === id);
      if (!row || row.loading) return;
      if (row.failed) { wx.showToast({ title: '原动态暂时无法读取，请稍后重试', icon: 'none' }); return; }
      if (row.unavailable) { wx.showToast({ title: '原动态已删除或不可见', icon: 'none' }); return; }
      this._opening = true;
      wx.navigateTo({ url: `/pages/square-detail/index?id=${id}`, fail: () => {
        this._opening = false;
        if (!this._dead && !this._hidden) wx.showToast({ title: '原动态打开失败，请重试', icon: 'none' });
      } });
    },
    imageChanged(event) {
      const i = Number(event.currentTarget.dataset.frame), row = this.data.frames[i], index = event.detail.current;
      if (!this._dead && !this._hidden && row && Number.isInteger(index) && index >= 0 && index < row.images.length && index !== row.imageIndex)
        this.setData({ [`frames[${i}].imageIndex`]: index });
    },
    photoLoaded(event) {
      const i = Number(event.currentTarget.dataset.frame), row = this.data.frames[i], file = event.currentTarget.dataset.file;
      if (this._dead || !row || !row.images.includes(file)) return;
      rememberSize(file, event.detail.width, event.detail.height);
      if (!this._hidden) {
        const patch = {};
        patchImageLayout(patch, row, imageLayout(row.images, false, this._imageWidths?.get(row._id)), `frames[${i}].`);
        if (Object.keys(patch).length) this.setData(patch);
      }
    },
  },
});
