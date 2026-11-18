const userService = require('../../services/user');

// 云端时间统一按中国标准时间展示，缺失时间不使用资料更新时间代替。
function formatTime(value, withTime = false) {
  const raw = value && typeof value === 'object' && '$date' in value ? value.$date : value;
  if (raw === null || raw === undefined || raw === '') return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const day = `${local.getUTCFullYear()}年${local.getUTCMonth() + 1}月${local.getUTCDate()}日`;
  const pad = number => String(number).padStart(2, '0');
  return withTime ? `${day} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` : day;
}

Page({
  data: {
    user: null, loading: true, error: '', isVerified: false,
    schoolText: '', joinedText: '', changeCount: null, lastChangedText: '',
    navTop: 28, navButtonHeight: 32, navHeight: 72,
  },
  onLoad() {
    try {
      const info = wx.getWindowInfo();
      const capsule = wx.getMenuButtonBoundingClientRect();
      const status = info.statusBarHeight || 0;
      const valid = capsule && capsule.height > 0 && capsule.top >= status;
      const navTop = valid ? capsule.top : status + 8;
      const navButtonHeight = valid ? capsule.height : 32;
      this.setData({ navTop, navButtonHeight, navHeight: navTop + navButtonHeight + 8 });
    } catch (error) { /* 旧客户端使用默认导航栏高度。 */ }
    const cached = userService.getCachedAccountInfo();
    if (cached) this.applyAccountInfo(cached);
    else if (userService.getCachedUser()) this.showUser(userService.getCachedUser());
  },
  onShow() { return this.refresh(false); },
  onHide() { this._requestVersion = (this._requestVersion || 0) + 1; },
  onUnload() { this.clearAccount(); },
  clearAccount() {
    this._requestVersion = (this._requestVersion || 0) + 1;
    this.setData({ user: null, loading: false, error: '', schoolText: '', joinedText: '',
      isVerified: false, changeCount: 0, lastChangedText: '' });
  },
  showUser(user) {
    const isVerified = user.role === 'student' && user.certificationStatus === 'approved' && Boolean(user.schoolId);
    this.setData({ user, isVerified, loading: false,
      schoolText: isVerified ? (user.schoolName || '认证学校信息暂缺') : '未认证',
      joinedText: formatTime(user.createdAt) || '暂无加入日期记录' });
  },
  applyAccountInfo(info) {
    this.showUser(info.user);
    this.setData({ changeCount: info.nicknameHistory.changeCount,
      lastChangedText: info.nicknameHistory.lastChangedAt ? (formatTime(info.nicknameHistory.lastChangedAt, true) || '时间记录暂不可用') : '尚无更改记录' });
  },
  async refresh(force = true) {
    const version = this._requestVersion = (this._requestVersion || 0) + 1;
    const cachedUser = userService.getCachedUser();
    const cached = userService.getCachedAccountInfo();
    if (cached) this.applyAccountInfo(cached);
    else if (cachedUser) {
      this.showUser(cachedUser);
      this.setData({ changeCount: null, lastChangedText: '正在读取更改记录…' });
    }
    this.setData({ loading: !cachedUser, error: '', ...(!cachedUser ? { user: null } : {}) });
    try {
      const info = await userService.getAccountInfo({ force: force !== false });
      if (version !== this._requestVersion) return;
      this.applyAccountInfo(info);
    } catch (error) {
      if (version === this._requestVersion) {
        if (!userService.getCachedUser()) this.setData({ user: null });
        this.setData({ error: error.message || '账号信息读取失败，请重试' });
      }
    } finally {
      if (version === this._requestVersion) this.setData({ loading: false });
    }
  },
  copyAccountId() {
    const user = this.data.user;
    if (!user || !/^[1-9][0-9]{7}$/.test(user.accountId || '') || this._copying) return;
    const version = this._requestVersion;
    this._copying = true;
    wx.setClipboardData({
      data: user.accountId,
      // 仅在系统确认复制成功后展示指定文案。
      success: () => {
        if (version === this._requestVersion) wx.showToast({ title: '已复制ID账号', icon: 'none' });
      },
      fail: () => {
        if (version === this._requestVersion) wx.showToast({ title: '复制失败，请重试', icon: 'none' });
      },
      complete: () => { this._copying = false; },
    });
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }); },
});
