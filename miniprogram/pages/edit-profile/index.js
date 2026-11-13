const userService = require('../../services/user');

Page({
  data: { user: null, nickname: '', avatar: '', loading: true, saving: false, error: '' },
  async onLoad() { this.loadProfile(); },
  async loadProfile() {
    this.setData({ loading: true, error: '' });
    try {
      const user = await userService.restore();
      this.setData({ user, nickname: user ? user.nickname : '', avatar: user ? user.avatarFileID : '' });
      if (!user) this.setData({ error: '请先到“我的”页面登录' });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  onChooseAvatar(event) {
    if (!this.data.saving) this.setData({ avatar: event.detail.avatarUrl });
  },
  onNicknameChange(event) { this.setData({ nickname: event.detail.value }); },
  // 使用 form 的最终字段值，兼容微信昵称填写时 input/blur 的触发时机。
  async save(event) {
    if (this.data.saving || !this.data.user) return;
    const nickname = (event.detail.value.nickname || '').trim();
    if (!nickname || Array.from(nickname).length > 20) {
      this.setData({ error: '请输入 1—20 个字的昵称' });
      return;
    }
    this.setData({ saving: true, error: '' });
    let uploadedFile = '';
    try {
      let avatarFileID = this.data.avatar;
      if (avatarFileID && !avatarFileID.startsWith('cloud://')) {
        const extension = (avatarFileID.match(/\.(png|jpe?g|webp)(?:\?.*)?$/i) || [])[1] || 'jpg';
        const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 10);
        const uploaded = await wx.cloud.uploadFile({
          cloudPath: `avatars/${this.data.user._id}/${filename}.${extension.toLowerCase()}`,
          filePath: avatarFileID,
        });
        uploadedFile = uploaded.fileID;
        avatarFileID = uploadedFile;
      }
      await userService.updateProfile({ nickname, avatarFileID });
      wx.showToast({ title: '资料已保存' });
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) });
    } catch (error) {
      // 保存请求超时时，云端仍可能已提交，因此不删除刚上传的文件，避免出现失效头像。
      // 保留 fileID 以便重试时复用，避免重复上传。
      if (uploadedFile) this.setData({ avatar: uploadedFile });
      console.error('资料保存失败', error);
      this.setData({ error: error.message || '保存失败，请重试' });
    } finally { this.setData({ saving: false }); }
  },
  backToProfile() { wx.switchTab({ url: '/pages/profile/index' }); },
});
