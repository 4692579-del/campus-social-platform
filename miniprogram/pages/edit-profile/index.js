const userService = require('../../services/user');

function wxCall(name, options) {
  return new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
}
function todayText() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    user: null, nickname: '', avatar: '', bio: '', bioLength: 0, birthDate: '',
    cover: '', coverType: 'jpg', coverFailed: false, choosingCover: false,
    loading: true, saving: false, dirty: false, error: '', navTop: 28, navButtonHeight: 32, navHeight: 72, today: '',
  },
  onLoad() {
    try {
      const info = wx.getWindowInfo();
      const capsule = wx.getMenuButtonBoundingClientRect();
      const statusBarHeight = info.statusBarHeight || 0;
      const valid = capsule && capsule.height > 0 && capsule.top >= statusBarHeight;
      const top = valid ? capsule.top + capsule.height + 8 : statusBarHeight + 48;
      this.setData({ navTop: valid ? capsule.top : statusBarHeight + 8, navButtonHeight: valid ? capsule.height : 32, navHeight: top });
    } catch (error) { /* 旧客户端使用默认顶部留白。 */ }
    this.setData({ today: todayText() });
    return this.loadProfile();
  },
  onUnload() { this._unloaded = true; },
  async loadProfile(force = false) {
    if (this.data.saving || this.data.choosingCover) return;
    const cached = userService.getCachedUser();
    this.setData({ loading: !cached, error: '' });
    try {
      // 编辑表单使用会话内最新资料，避免后台响应覆盖用户正在输入的草稿。
      const user = cached && force === false ? cached : await userService.restore({ force: force !== false });
      if (this._unloaded) return;
      this.setData({ user, nickname: user ? user.nickname : '', avatar: user ? user.avatarFileID : '',
        bio: user ? user.bio || '' : '', bioLength: user ? Array.from(user.bio || '').length : 0,
        birthDate: user ? user.birthDate || '' : '', cover: user ? user.coverFileID || '' : '', coverFailed: false, dirty: false });
      if (!user) this.setData({ error: '请先到“我的”页面登录' });
    } catch (error) { if (!this._unloaded) this.setData({ user: null, error: error.message }); }
    finally { if (!this._unloaded) this.setData({ loading: false }); }
  },
  onChooseAvatar(event) {
    if (!this.data.saving && !this.data.choosingCover) { this.setData({ avatar: event.detail.avatarUrl }); this.updateDirty(); }
  },
  onNicknameChange(event) { if (!this.data.saving) { this.setData({ nickname: event.detail.value }); this.updateDirty(); } },
  onBioChange(event) {
    if (this.data.saving) return;
    this.setData({ bio: event.detail.value, bioLength: Array.from(event.detail.value).length });
    this.updateDirty();
  },
  onBirthDateChange(event) { if (!this.data.saving) { this.setData({ birthDate: event.detail.value }); this.updateDirty(); } },
  clearBirthDate() { if (!this.data.saving) { this.setData({ birthDate: '' }); this.updateDirty(); } },
  updateDirty() {
    const user = this.data.user;
    if (user) this.setData({ dirty: this.data.nickname.trim() !== user.nickname || this.data.avatar !== user.avatarFileID ||
      this.data.bio.replace(/\r\n?/g, '\n').trim() !== (user.bio || '') || this.data.birthDate !== (user.birthDate || '') ||
      this.data.cover !== (user.coverFileID || '') });
  },
  showLocationNotice() { wx.showToast({ title: '位置功能暂未开放', icon: 'none' }); },
  onCoverError() { this.setData({ coverFailed: true }); },
  async chooseCover() {
    if (this.data.loading || this.data.saving || this.data.choosingCover || !this.data.user) return;
    this.setData({ choosingCover: true, error: '' });
    try {
      const chosen = await wxCall('chooseMedia', { count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['compressed'] });
      let filePath = chosen.tempFiles[0].tempFilePath;
      let info = await wxCall('getImageInfo', { src: filePath });
      if (!['jpg', 'jpeg', 'png', 'webp'].includes(info.type.toLowerCase())) throw new Error('请选择 JPG、PNG 或 WebP 封面图片');
      try {
        filePath = (await wxCall('compressImage', { src: filePath, quality: 80, compressedWidth: Math.min(info.width, 1600) })).tempFilePath;
        info = await wxCall('getImageInfo', { src: filePath });
      } catch (error) { /* 无法压缩时检查原图。 */ }
      const file = await new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath, success: resolve, fail: reject }));
      if (!Number.isFinite(file.size) || file.size <= 0 || file.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5MB 的有效封面图片');
      if (this._unloaded) return;
      this.setData({ cover: filePath, coverType: info.type.toLowerCase(), coverFailed: false });
      this.updateDirty();
    } catch (error) {
      if (!this._unloaded && !/cancel/.test(error.errMsg || '')) this.setData({ error: error.message || '封面选择失败，请重试' });
    } finally { if (!this._unloaded) this.setData({ choosingCover: false }); }
  },
  // 使用 form 的最终字段值，兼容微信昵称填写时 input/blur 的触发时机。
  async save(event) {
    if (this.data.loading || this.data.saving || this.data.choosingCover || !this.data.user) return;
    const nickname = this.data.user.xiaocuiProfile ? this.data.user.nickname : (event.detail.value.nickname || '').trim();
    const bio = (event.detail.value.bio === undefined ? this.data.bio : event.detail.value.bio).replace(/\r\n?/g, '\n').trim();
    const birthDate = this.data.birthDate;
    if (!nickname || Array.from(nickname).length > 20) {
      this.setData({ error: '请输入 1—20 个字的昵称' });
      return;
    }
    if (Array.from(bio).length > 160 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(bio)) {
      this.setData({ error: '简介最多 160 个字，请勿包含控制字符' }); return;
    }
    const date = new Date(birthDate + 'T00:00:00.000Z');
    if (birthDate && (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== birthDate || birthDate < '1900-01-01' || birthDate > todayText())) {
      this.setData({ error: '请选择 1900 年至今天之间的有效出生日期' }); return;
    }
    this.setData({ saving: true, error: '' });
    let uploadedFile = '';
    let uploadedCover = '';
    try {
      let avatarFileID = this.data.avatar;
      if (avatarFileID && !this.data.user.xiaocuiProfile && !avatarFileID.startsWith('cloud://')) {
        const extension = (avatarFileID.match(/\.(png|jpe?g|webp)(?:\?.*)?$/i) || [])[1] || 'jpg';
        const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 10);
        const uploaded = await wx.cloud.uploadFile({
          cloudPath: `avatars/${this.data.user._id}/${filename}.${extension.toLowerCase()}`,
          filePath: avatarFileID,
        });
        uploadedFile = uploaded.fileID;
        avatarFileID = uploadedFile;
      }
      if (this._unloaded) return;
      const profile = { nickname, avatarFileID, bio, birthDate };
      if (this.data.cover !== (this.data.user.coverFileID || '')) {
        let coverFileID = this.data.cover;
        if (coverFileID && !coverFileID.startsWith('cloud://')) {
          const filename = `cover-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${this.data.coverType}`;
          uploadedCover = (await wx.cloud.uploadFile({ cloudPath: `avatars/${this.data.user._id}/${filename}`, filePath: coverFileID })).fileID;
          coverFileID = uploadedCover;
        }
        profile.coverFileID = coverFileID;
      }
      if (this._unloaded) return;
      await userService.updateProfile(profile);
      if (this._unloaded) return;
      wx.showToast({ title: '资料已保存' });
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) });
    } catch (error) {
      // 保存请求超时时，云端仍可能已提交，因此不删除刚上传的文件，避免出现失效头像。
      // 保留 fileID 以便重试时复用，避免重复上传。
      if (this._unloaded) return;
      if (uploadedFile) this.setData({ avatar: uploadedFile });
      if (uploadedCover) this.setData({ cover: uploadedCover });
      console.error('资料保存失败', error);
      this.setData({ error: error.message || '保存失败，请重试' });
    } finally { if (!this._unloaded) this.setData({ saving: false }); }
  },
  cancel() {
    if (this.data.saving || this.data.choosingCover) return;
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) });
  },
  backToProfile() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }); },
});
