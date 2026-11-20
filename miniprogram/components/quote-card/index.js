const { postView } = require('../../utils/post-view');
const { imageLayout, rememberSize } = require('../../utils/post-image-layout');
const ID = /^p_[a-f0-9]{40}$/;
const height = images => Math.min(360, Math.max(140, imageLayout(images, false).galleryHeight * .72));
Component({
  properties: { quote: Object, removable: Boolean, disabled: Boolean },
  data: { frames: [] },
  observers: { quote(value) {
    if (this._dead) return;
    const frames = [], seen = new Set();
    for (let item = value; item && ID.test(item._id || '') && !seen.has(item._id) && frames.length < 4; item = item.quote) {
      seen.add(item._id);
      const previous = this.data.frames.find(row => row._id === item._id), images = Array.isArray(item.images) ? item.images : [];
      const { quote: nested, ...body } = item;
      frames.push({ ...postView({ content: '', author: null, declaration: 'none', createdAt: '', ...body }),
        unavailable: Boolean(item.unavailable), collapsed: Boolean(item.collapsed), loading: Boolean(item.loading), failed: Boolean(item.failed), images,
        imageIndex: previous && previous.imageIndex < images.length ? previous.imageIndex : 0, galleryHeight: height(images) });
    }
    const patch = {};
    if (frames.length !== this.data.frames.length || frames.some((row, i) => row._id !== this.data.frames[i]._id)) patch.frames = frames;
    else frames.forEach((row, i) => { for (const [key, value] of Object.entries(row)) {
      if (key !== 'quote' && JSON.stringify(value) !== JSON.stringify(this.data.frames[i][key])) patch[`frames[${i}].${key}`] = value;
    } });
    if (Object.keys(patch).length) this.setData(patch);
  } },
  lifetimes: { detached() { this._dead = true; } },
  pageLifetimes: { hide() { this._hidden = true; }, show() {
    this._hidden = false; this._opening = false;
    const patch = {};
    this.data.frames.forEach((row, i) => { const next = height(row.images); if (next !== row.galleryHeight) patch[`frames[${i}].galleryHeight`] = next; });
    if (Object.keys(patch).length) this.setData(patch);
  } },
  methods: {
    stopEvent() {},
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
      const next = height(row.images);
      if (!this._hidden && file === row.images[0] && row.galleryHeight !== next) this.setData({ [`frames[${i}].galleryHeight`]: next });
    },
  },
});
