const userService = require('../../services/user');
const { describeApplication } = require('../../utils/certification-view');

Page({
  data: { loading: true, detail: null, error: '', notice: '', schoolName: '', rejectionReason: '',
    proofUrl: '', proofLoading: false, proofLoaded: false, saving: false, confirming: false, reviewBlocked: false },
  onLoad(options) { this._applicationId = options.id || ''; },
  onShow() { this.loadDetail(); },
  onHide() { this.clearPrivateData(); },
  onUnload() { this.clearPrivateData(); },
  clearPrivateData() {
    this._generation = (this._generation || 0) + 1;
    this._loading = false;
    this.setData({ detail: null, proofUrl: '', proofLoaded: false, proofLoading: false,
      schoolName: '', rejectionReason: '', loading: false, saving: false, confirming: false, error: '', notice: '' });
  },
  async loadDetail() {
    if (this._loading || this.data.saving || this.data.confirming) return;
    this._loading = true;
    const generation = this._generation = (this._generation || 0) + 1;
    this.setData({ loading: true, detail: null, proofUrl: '', proofLoaded: false, proofLoading: false, error: '', notice: '' });
    try {
      const user = await userService.restore();
      if (!user) throw new Error('请先到“我的”页面登录');
      const detail = await userService.getCertificationDetail(this._applicationId);
      if (generation === this._generation) this.showDetail(detail);
    } catch (error) {
      if (generation === this._generation) this.setData({ error: error.message || '申请读取失败，请重试' });
    } finally {
      if (generation === this._generation) { this._loading = false; this.setData({ loading: false }); }
    }
  },
  showDetail(detail) {
    if (!detail || !detail._id || !['pending', 'approved', 'rejected'].includes(detail.status)) throw new Error('申请信息异常，请重新读取');
    this.setData({ detail: describeApplication(detail), schoolName: detail.approvedSchoolName || detail.schoolName,
      rejectionReason: '', proofUrl: '', proofLoaded: false, reviewBlocked: false, error: '' });
  },
  onSchoolInput(event) { if (!this.data.saving && !this.data.confirming) this.setData({ schoolName: event.detail.value }); },
  onReasonInput(event) { if (!this.data.saving && !this.data.confirming) this.setData({ rejectionReason: event.detail.value }); },
  async loadProof() {
    const detail = this.data.detail;
    if (!detail || this.data.proofLoading || this.data.saving || this.data.confirming) return;
    const generation = this._generation;
    this.setData({ proofLoading: true, proofLoaded: false, proofUrl: '', error: '' });
    try {
      const proof = await userService.getCertificationProof(detail._id, detail.revision);
      if (generation !== this._generation) return;
      this.setData({ proofUrl: proof.url });
    } catch (error) {
      if (generation !== this._generation) return;
      const denied = ['FORBIDDEN', 'ACCOUNT_DISABLED', 'NOT_REGISTERED', 'UNAUTHENTICATED', 'INVALID_ROLE'].includes(error.code);
      this.setData({ error: error.message || '材料读取失败，请重试',
        ...(denied ? { detail: null, schoolName: '', rejectionReason: '' } : {}),
        ...(error.code === 'STALE_APPLICATION' ? { reviewBlocked: true } : {}) });
    } finally {
      if (generation === this._generation) this.setData({ proofLoading: false });
    }
  },
  onProofLoaded(event) {
    if (this.data.proofUrl && event.currentTarget.dataset.url === this.data.proofUrl) this.setData({ proofLoaded: true });
  },
  onProofError(event) {
    if (event.currentTarget.dataset.url === this.data.proofUrl) {
      this.setData({ proofLoaded: false, error: '材料图片无法显示，请重新查看材料或驳回申请要求补充' });
    }
  },
  previewProof() {
    if (this.data.proofLoaded) wx.previewImage({ current: this.data.proofUrl, urls: [this.data.proofUrl] });
  },
  approve(event) { return this.decide('approved', { schoolName: event.detail.value.schoolName || '' }); },
  reject(event) { return this.decide('rejected', { rejectionReason: event.detail.value.rejectionReason || '' }); },
  async decide(decision, fields) {
    const detail = this.data.detail;
    if (!detail || detail.status !== 'pending' || this.data.saving || this.data.confirming || this.data.reviewBlocked) return;
    const value = (decision === 'approved' ? fields.schoolName : fields.rejectionReason).trim();
    const length = Array.from(value).length;
    if (length < 2 || length > (decision === 'approved' ? 60 : 200) || /[\u0000-\u001f\u007f]/.test(value)) {
      this.setData({ error: decision === 'approved' ? '请确认 2—60 个字的学校全称' : '请填写 2—200 个字的驳回原因' });
      return;
    }
    if (decision === 'approved' && !this.data.proofLoaded) { this.setData({ error: '请先查看并核对认证材料' }); return; }
    const generation = this._generation;
    this.setData({ confirming: true, error: '', notice: '' });
    try {
      const confirmation = await new Promise((resolve, reject) => wx.showModal({
        title: decision === 'approved' ? '确认通过认证' : '确认驳回申请',
        content: decision === 'approved' ? `确认 ${detail.realName} 为“${value}”在读学生？通过后该账号将获得学生身份。` : `确认驳回 ${detail.realName} 的申请？原因：${value}`,
        confirmText: decision === 'approved' ? '确认通过' : '确认驳回', success: resolve,
        fail: () => reject(new Error('确认窗口打开失败，请重试')),
      }));
      if (generation !== this._generation || !confirmation.confirm) return;
      this.setData({ saving: true });
      const result = await userService.reviewCertification(detail._id, detail.revision,
        decision === 'approved' ? { decision, schoolName: value } : { decision, rejectionReason: value });
      if (generation !== this._generation) return;
      this.showDetail(result);
      this.setData({ notice: result.revision !== detail.revision ? '审核已保存，用户已重新提交，当前显示最新申请。' :
        decision === 'approved' ? '认证已通过，用户重新进入个人页面即可看到学生身份。' : '申请已驳回，用户可查看原因并重新提交。' });
    } catch (error) {
      if (generation !== this._generation) return;
      const denied = ['FORBIDDEN', 'ACCOUNT_DISABLED', 'NOT_REGISTERED', 'UNAUTHENTICATED', 'INVALID_ROLE'].includes(error.code);
      if (denied) {
        this.setData({ detail: null, proofUrl: '', proofLoaded: false, schoolName: '', rejectionReason: '', error: error.message });
        return;
      }
      this.setData({ reviewBlocked: true, proofUrl: '', proofLoaded: false, error: error.message || '审核结果未确认，请重新读取' });
      // 超时或重复审核时查询当前状态，不自动重复执行审核。
      try {
        const latest = await userService.getCertificationDetail(detail._id);
        if (generation !== this._generation) return;
        this.showDetail(latest);
        this.setData({ notice: latest.status === 'pending' ? '请重新核对最新信息和材料后再操作。' : '当前显示云端最新审核结果。' });
      } catch (queryError) {
        if (generation === this._generation && ['FORBIDDEN', 'ACCOUNT_DISABLED', 'NOT_REGISTERED', 'UNAUTHENTICATED', 'INVALID_ROLE'].includes(queryError.code)) {
          this.setData({ detail: null, proofUrl: '', schoolName: '', rejectionReason: '', error: queryError.message });
        }
        // 其他查询失败保留原错误并暂停审核，等待用户主动重新读取。
      }
    } finally {
      if (generation === this._generation) this.setData({ saving: false, confirming: false });
    }
  },
  backToList() { wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/admin-certifications/index' }) }); },
});
