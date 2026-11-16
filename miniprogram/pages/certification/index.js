const userService = require('../../services/user');

// 统一把微信回调接口转成 Promise，页面按“选择、压缩、读取、提交”的顺序执行。
function wxCall(name, options) {
  return new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
}

Page({
  data: {
    loading: true, saving: false, choosing: false, error: '', user: null, application: null,
    canApply: false, stateText: '', submittedTime: '',
    schoolName: '', realName: '', studentNumber: '', proofPath: '', agreed: false,
  },
  onLoad() { this.loadApplication(); },
  onUnload() { this._proofBase64 = ''; this._submission = null; this._unloaded = true; },
  async loadApplication() {
    if (this._loading || this.data.saving || this.data.choosing) return;
    this._loading = true;
    this.setData({ loading: true, error: '', user: null, application: null, canApply: false });
    try {
      const user = await userService.restore();
      if (!user) throw new Error('请先到“我的”页面登录');
      if (user.role === 'admin') throw new Error('管理员账号无需申请学校认证');
      this.showCertification(await userService.getCertification());
    } catch (error) {
      if (!this._unloaded) this.setData({ error: error.message || '认证信息读取失败，请重试' });
    } finally {
      this._loading = false;
      if (!this._unloaded) this.setData({ loading: false });
    }
  },
  showCertification({ user, application }) {
    if (this._unloaded) return;
    const status = application ? application.status : user.certificationStatus;
    const stateText = { unverified: '未认证', pending: '审核中', approved: '已认证', rejected: '已驳回' }[status];
    if (!stateText || (status === 'pending' && !application) ||
        (application && application.status !== user.certificationStatus)) {
      throw new Error('认证状态异常，请联系管理员核查');
    }
    const canApply = ['unverified', 'rejected'].includes(status) && user.certificationStatus !== 'approved';
    const values = { user, application, stateText, canApply, error: '', submittedTime: '' };
    if (application) {
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
    if (!this.data.canApply || this.data.saving || this.data.choosing || this.data.loading) return;
    const form = event.detail.value;
    const schoolName = (form.schoolName || '').trim();
    const realName = (form.realName || '').trim();
    const studentNumber = (form.studentNumber || '').trim();
    const textValid = (value, min, max) => Array.from(value).length >= min &&
      Array.from(value).length <= max && !/[\u0000-\u001f\u007f]/.test(value);
    let error = '';
    if (!textValid(schoolName, 2, 60)) error = '请填写 2—60 个字的学校全称';
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
      } catch (queryError) { /* 保留原错误和草稿，允许用户稍后刷新或重试。 */ }
      this.setData({ error: failure.message || '提交未确认，请刷新状态或稍后重试' });
    } finally {
      if (!this._unloaded) this.setData({ saving: false });
    }
  },
  backToProfile() { wx.switchTab({ url: '/pages/profile/index' }); },
});
