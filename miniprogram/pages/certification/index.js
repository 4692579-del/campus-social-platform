const userService = require('../../services/user');

// 统一把微信回调接口转成 Promise，页面按“选择、压缩、读取、提交”的顺序执行。
function wxCall(name, options) {
  return new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
}

function maskTail(value, visible) {
  const characters = Array.from(typeof value === 'string' ? value : '');
  if (!characters.length) return '—';
  return '*'.repeat(Math.max(0, characters.length - visible)) + characters.slice(-visible).join('');
}

Page({
  data: {
    loading: true, saving: false, choosing: false, error: '', user: null, application: null,
    canApply: false, canWithdraw: false, withdrawing: false, confirmingWithdrawal: false, withdrawalBlocked: false,
    stateText: '', submittedTime: '', maskedRealName: '', maskedStudentNumber: '',
    schoolName: '', realName: '', studentNumber: '', proofPath: '', agreed: false,
    stage: 'intro', navTitle: '校园认证', navTop: 28, navButtonHeight: 32, navHeight: 72,
    schoolOption: '闽南科技学院', schoolQuery: '', hasSchoolResult: false,
    matchBefore: '', matchText: '', matchAfter: '',
    reasons: [
      '核验学校身份，区分普通用户与认证学生，建立更可信的校园互动环境。',
      '明确学校归属与内容访问边界，让校园信息、闲置交易和互助需求与所在学校关联。',
      '由管理员核对申请资料，结合内容审核与业务记录，规范校园平台的使用。',
    ],
    benefits: [
      { title: '学生身份标识', text: '通过审核后，个人主页显示蓝色认证标识，可在“关于你的账号”中查看认证学校。', ready: true },
      { title: '校园社交互动', text: '校园动态、点赞评论、关注私信，以及兴趣圈子和校园活动。', ready: false },
      { title: '校园二手集市', text: '发布闲置商品，参与校园内的模拟交易并保留业务记录。', ready: false },
      { title: '学生跑腿互助', text: '使用同一学生账号发布代办需求，或接取其他学生的互助任务。', ready: false },
    ],
    examples: [
      { key: 'complete', label: '清晰完整', valid: true },
      { key: 'cropped', label: '边框缺失', valid: false },
      { key: 'blurred', label: '照片模糊', valid: false },
      { key: 'glare', label: '反光强烈', valid: false },
    ],
  },
  onLoad() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    this._returnPage = pages[pages.length - 2];
    try {
      const info = wx.getWindowInfo();
      const capsule = wx.getMenuButtonBoundingClientRect();
      const status = info.statusBarHeight || 0;
      const valid = capsule && capsule.height > 0 && capsule.top >= status;
      const navTop = valid ? capsule.top : status + 8;
      const navButtonHeight = valid ? capsule.height : 32;
      this.setData({ navTop, navButtonHeight, navHeight: navTop + navButtonHeight + 8 });
    } catch (error) { /* 旧客户端使用默认顶部留白。 */ }
    return this.loadApplication(false);
  },
  onUnload() {
    this.prepareReturnSurface();
    this._returnPage = null;
    this._proofBase64 = ''; this._submission = null; this._unloaded = true;
  },
  prepareReturnSurface() {
    if (this._returnSurfacePrepared) return true;
    const previous = this._returnPage;
    if (!previous || typeof previous.prepareMenuReturn !== 'function') return false;
    previous.prepareMenuReturn();
    this._returnSurfacePrepared = true;
    return true;
  },
  async loadApplication(force = true) {
    if (this._loading || this.data.saving || this.data.choosing || this.data.withdrawing || this.data.confirmingWithdrawal) return;
    this._loading = true;
    const userCache = userService.getCachedUser();
    const cached = userService.getCachedCertification();
    if (cached) this.showCertification(cached);
    else if (userCache && userCache.role !== 'admin' && userCache.certificationStatus === 'unverified') {
      this.showCertification({ user: userCache, application: null });
    }
    const hasContent = Boolean(this.data.user && userCache && this.data.user._id === userCache._id);
    this.setData({ loading: !hasContent, error: '', ...(!hasContent ? {
      user: null, application: null, canApply: false, canWithdraw: false, maskedRealName: '', maskedStudentNumber: '' } : {}) });
    try {
      const user = await userService.restore({ force: false });
      if (!user) throw new Error('请先到“我的”页面登录');
      if (user.role === 'admin') throw new Error('管理员账号无需申请学校认证');
      this.showCertification(await userService.getCertification({ force: force !== false }), true);
    } catch (error) {
      if (!this._unloaded) this.setData({ error: error.message || '认证信息读取失败，请重试',
        ...(!userService.getCachedUser() ? { user: null, application: null, canApply: false, canWithdraw: false } : {}) });
    } finally {
      this._loading = false;
      if (!this._unloaded) this.setData({ loading: false });
    }
  },
  showCertification({ user, application }, preserveDraft = false) {
    if (this._unloaded) return;
    const status = application ? application.status : user.certificationStatus;
    const stateText = { unverified: '未认证', pending: '审核中', approved: '已认证', rejected: '已驳回' }[status];
    if (!stateText || (status === 'pending' && !application) ||
        (application && application.status !== user.certificationStatus)) {
      throw new Error('认证状态异常，请联系管理员核查');
    }
    const canApply = ['unverified', 'rejected'].includes(status) && user.certificationStatus !== 'approved';
    const keepDraft = preserveDraft && canApply && this.data.canApply && this.data.user && this.data.user._id === user._id &&
      (this.data.application && this.data.application.revision) === (application && application.revision);
    const canWithdraw = Boolean(application && ['pending', 'approved'].includes(status) &&
      Number.isSafeInteger(application.revision) && application.revision > 0);
    const values = { user, application, stateText, canApply, canWithdraw, withdrawalBlocked: false, error: '', submittedTime: '',
      maskedRealName: application ? maskTail(application.realName, 1) : '',
      maskedStudentNumber: application ? maskTail(application.studentNumber, 3) : '' };
    if (application && !keepDraft) {
      values.schoolName = application.schoolName;
      values.realName = application.realName;
      values.studentNumber = application.studentNumber;
      const date = new Date(application.submittedAt);
      if (!Number.isNaN(date.getTime())) {
        const pad = n => String(n).padStart(2, '0');
        values.submittedTime = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      }
    }
    if (!canApply) {
      this._proofBase64 = '';
      values.proofPath = '';
      values.agreed = false;
    }
    this.setData(values);
    if (!keepDraft) this.setStage(canApply ? 'intro' : 'status');
  },
  setStage(stage) {
    const titles = { intro: '校园认证', school: '请选择学校', search: '请选择学校', proof: '身份认证', status: '认证状态' };
    if (titles[stage]) this.setData({ stage, navTitle: titles[stage] });
  },
  busy() { return this.data.loading || this.data.saving || this.data.choosing || this.data.withdrawing || this.data.confirmingWithdrawal; },
  beginCertification() {
    if (!this.data.canApply || this.busy()) return;
    this.setData({ error: '' });
    this.setStage('school');
  },
  openSchoolSearch() {
    if (!this.data.canApply || this.busy()) return;
    this.clearSchoolSearch(); this.setStage('search');
  },
  onSchoolSearch(event) {
    const schoolQuery = event.detail.value;
    const query = schoolQuery.trim();
    const index = query ? this.data.schoolOption.indexOf(query) : -1;
    this.setData({ schoolQuery, hasSchoolResult: index >= 0,
      matchBefore: index >= 0 ? this.data.schoolOption.slice(0, index) : '',
      matchText: index >= 0 ? query : '', matchAfter: index >= 0 ? this.data.schoolOption.slice(index + query.length) : '' });
  },
  clearSchoolSearch() { this.setData({ schoolQuery: '', hasSchoolResult: false, matchBefore: '', matchText: '', matchAfter: '' }); },
  cancelSchoolSearch() { if (!this.busy()) this.setStage('school'); },
  selectSchool() {
    if (!this.data.canApply || this.busy()) return;
    this.setData({ schoolName: this.data.schoolOption, error: '' });
    this.setStage('school');
  },
  continueSchool() {
    if (!this.data.canApply || this.busy() || this.data.schoolName !== this.data.schoolOption) return;
    this.setData({ error: '' }); this.setStage('proof');
  },
  backStep() {
    if (this.busy()) return;
    if (this.data.stage === 'proof' || this.data.stage === 'search') this.setStage('school');
    else if (this.data.stage === 'school') this.setStage('intro');
    else this.backToProfile();
  },
  onFieldInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!this.data.saving && ['schoolName', 'realName', 'studentNumber'].includes(field)) {
      this.setData({ [field]: event.detail.value });
    }
  },
  onAgreementChange(event) { this.setData({ agreed: event.detail.value.includes('agree') }); },
  async chooseProof() {
    if (!this.data.canApply || this.data.saving || this.data.choosing) return;
    this.setData({ choosing: true, error: '' });
    try {
      const chosen = await wxCall('chooseMedia', { count: 1, mediaType: ['image'],
        sourceType: ['album', 'camera'], sizeType: ['compressed'] });
      let path = chosen.tempFiles[0].tempFilePath;
      const info = await wxCall('getImageInfo', { src: path });
      if (!['jpeg', 'jpg', 'png'].includes(info.type.toLowerCase())) {
        throw new Error('请选择 JPG 或 PNG 图片');
      }
      try {
        const compressed = await wxCall('compressImage', {
          src: path, quality: 70, compressedWidth: Math.min(info.width, 1600),
        });
        path = compressed.tempFilePath;
      } catch (error) {
        // 部分设备不支持压缩时，仍检查原图大小，不会直接上传超大图片。
      }
      const file = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
        filePath: path, encoding: 'base64', success: resolve, fail: reject,
      }));
      const padding = (file.data.match(/=+$/) || [''])[0].length;
      if (file.data.length * 3 / 4 - padding > 1024 * 1024) {
        throw new Error('压缩后的图片仍超过 1MB，请裁剪无关区域后重新选择');
      }
      if (this._unloaded) return;
      // 图片内容仅保存在当前页面内存中，不写本地缓存、不放入日志。
      this._proofBase64 = file.data;
      this.setData({ proofPath: path });
    } catch (error) {
      if (!this._unloaded && !/cancel/.test(error.errMsg || '')) {
        this.setData({ error: error.message || '图片选择失败，请重试' });
      }
    } finally {
      if (!this._unloaded) this.setData({ choosing: false });
    }
  },
  previewProof() {
    if (this.data.proofPath) wx.previewImage({ current: this.data.proofPath, urls: [this.data.proofPath] });
  },
  async submit(event) {
    if (!this.data.canApply || this.data.saving || this.data.choosing || this.data.loading ||
        this.data.withdrawing || this.data.confirmingWithdrawal) return;
    const form = event.detail.value;
    const schoolName = (form.schoolName || '').trim();
    const realName = (form.realName || '').trim();
    const studentNumber = (form.studentNumber || '').trim();
    const textValid = (value, min, max) => Array.from(value).length >= min &&
      Array.from(value).length <= max && !/[\u0000-\u001f\u007f]/.test(value);
    let error = '';
    if (schoolName !== this.data.schoolOption || schoolName !== this.data.schoolName) error = '请先选择闽南科技学院';
    else if (!textValid(realName, 2, 30)) error = '请填写 2—30 个字的姓名';
    else if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(studentNumber)) error = '学号应为 3—32 位字母、数字、短横线或下划线';
    else if (!this._proofBase64) error = '请选择一张认证材料图片';
    else if (!this.data.agreed) error = '请先确认资料用途和填写内容';
    this.setData({ schoolName, realName, studentNumber, error });
    if (error) return;

    const signature = JSON.stringify([schoolName, realName, studentNumber, this.data.proofPath]);
    if (!this._submission || this._submission.signature !== signature) {
      this._submission = { signature,
        requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}` };
    }
    this.setData({ saving: true });
    try {
      const result = await userService.submitCertification({ schoolName, realName, studentNumber,
        proofBase64: this._proofBase64, requestId: this._submission.requestId });
      this.showCertification(result);
      if (!this._unloaded) wx.showToast({ title: '申请已提交' });
    } catch (failure) {
      if (this._unloaded) return;
      // 网络超时不能证明提交失败：再查询一次，避免用户反复提交同一份材料。
      try {
        const latest = await userService.getCertification();
        if (latest.application && ['pending', 'approved'].includes(latest.application.status)) {
          this.showCertification(latest);
          return;
        }
        if (failure.code === 'CERTIFICATION_WITHDRAWN' && !latest.application && latest.user.certificationStatus === 'unverified') {
          this.showCertification(latest);
          this.clearWithdrawalDraft();
        }
      } catch (queryError) { /* 保留原错误和草稿，允许用户稍后刷新或重试。 */ }
      this.setData({ error: failure.message || '提交未确认，请刷新状态或稍后重试' });
    } finally {
      if (!this._unloaded) this.setData({ saving: false });
    }
  },
  async withdraw() {
    if (!this.data.canWithdraw || this.data.loading || this.data.saving || this.data.choosing ||
        this.data.withdrawing || this.data.confirmingWithdrawal || this.data.withdrawalBlocked) return;
    const application = this.data.application;
    const pending = application.status === 'pending';
    const title = pending ? '取消认证' : '撤回认证';
    let requested = false;
    this.setData({ confirmingWithdrawal: true, error: '' });
    try {
      const confirmation = await wxCall('showModal', {
        title: pending ? '取消认证申请' : '撤回学校认证',
        content: pending ? '取消后管理员将无法继续审核这条申请，你可以重新提交认证申请。确定取消吗？' :
          '撤回后将恢复为未认证的普通用户，并清空当前认证学校。之后可以重新申请认证。确定撤回吗？',
        confirmText: title,
      });
      if (this._unloaded || !confirmation.confirm) return;
      this.setData({ withdrawing: true });
      requested = true;
      const result = await userService.withdrawCertification(application._id, application.revision, application.status);
      if (this._unloaded) return;
      this.showCertification(result);
      this.clearWithdrawalDraft();
      wx.showToast({ title: pending ? '申请已取消' : '认证已撤回' });
    } catch (failure) {
      if (this._unloaded) return;
      if (['FORBIDDEN', 'ACCOUNT_DISABLED', 'NOT_REGISTERED', 'UNAUTHENTICATED', 'INVALID_ROLE'].includes(failure.code)) {
        this.clearWithdrawalDraft();
        this.setData({ user: null, application: null, canApply: false, canWithdraw: false,
          error: failure.message || '请重新登录后查看认证状态' });
        return;
      }
      if (!requested) { this.setData({ error: '确认窗口打开失败，请重试' }); return; }
      // 超时并不代表撤回失败，只查询状态，不自动再次撤回，以免影响后来审核/重提的申请。
      try {
        const latest = await userService.getCertification();
        if (this._unloaded) return;
        this.showCertification(latest);
        if (!latest.application && latest.user.certificationStatus === 'unverified') {
          this.clearWithdrawalDraft();
          wx.showToast({ title: pending ? '申请已取消' : '认证已撤回' });
        } else {
          this.setData({ error: failure.message || '操作未完成，已刷新认证状态，请核对后重试' });
        }
      } catch (queryError) {
        if (this._unloaded) return;
        if (['FORBIDDEN', 'ACCOUNT_DISABLED', 'NOT_REGISTERED', 'UNAUTHENTICATED', 'INVALID_ROLE'].includes(queryError.code)) {
          this.clearWithdrawalDraft();
          this.setData({ user: null, application: null, canApply: false, canWithdraw: false,
            error: queryError.message || '请重新登录后查看认证状态' });
          return;
        }
        this.setData({ withdrawalBlocked: true, error: '撤回结果尚未确认，请先刷新认证状态后再操作' });
      }
    } finally {
      if (!this._unloaded) this.setData({ withdrawing: false, confirmingWithdrawal: false });
    }
  },
  clearWithdrawalDraft() {
    // 重新认证必须重新选材料并生成新的提交标识，不能复用已撤回的请求。
    this._proofBase64 = '';
    this._submission = null;
    this.setData({ schoolName: '', realName: '', studentNumber: '', maskedRealName: '', maskedStudentNumber: '', proofPath: '', agreed: false });
    this.clearSchoolSearch();
    this.setStage('intro');
  },
  backToProfile() {
    if (this._returning || this._unloaded) return;
    this._returning = true;
    const prepared = this.prepareReturnSurface();
    const fallback = () => wx.switchTab({ url: '/pages/home/index', fail: () => {
      this._returning = false;
      if (!this._unloaded) wx.showToast({ title: '返回失败，请重试', icon: 'none' });
    } });
    const navigate = () => {
      if (this._unloaded) return;
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : null;
      if (pages && pages.length <= 1) fallback();
      else wx.navigateBack({ fail: fallback });
    };
    // 先提交首页和底栏的恢复，再开始原生返回过渡，避免露出中间状态。
    if (prepared && typeof wx.nextTick === 'function') wx.nextTick(navigate);
    else navigate();
  },
});
