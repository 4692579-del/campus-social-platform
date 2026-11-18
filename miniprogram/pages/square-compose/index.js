Page({
  closeComposer(event) {
    if (this._leaving) return;
    this._leaving = true;
    if (event.detail.published) wx.switchTab({ url: '/pages/home/index' });
    else wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) });
  },
});
