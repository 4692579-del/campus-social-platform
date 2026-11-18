const crypto = require('crypto');

const APPLICATIONS = 'certification_applications';
const REVIEWS = 'certification_reviews';
const STATUSES = ['pending', 'approved', 'rejected'];
const PAGE_SIZE = 20;
const REVIEW_ACTIONS = ['listCertifications', 'getCertificationDetail', 'getCertificationProof', 'reviewCertification'];
const REVIEW_CODES = ['INVALID_REVIEW', 'APPLICATION_NOT_FOUND', 'STALE_APPLICATION',
  'APPLICATION_ALREADY_REVIEWED', 'INVALID_APPLICANT', 'PROOF_UNAVAILABLE'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requireAdmin(user) {
  if (!user || user.status !== 'active' || user.role !== 'admin') fail('FORBIDDEN', '仅管理员可以审核学校认证');
}

function validateId(value) {
  if (typeof value !== 'string' || !/^cert_u_[a-f0-9]{32}$/.test(value)) fail('INVALID_REVIEW', '申请编号无效');
  return value;
}

function validateRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_REVIEW', '申请版本无效，请重新读取');
  return value;
}

function checkedText(value, min, max, message) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (Array.from(text).length < min || Array.from(text).length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    fail('INVALID_REVIEW', message);
  }
  return text;
}

function reviewView(record, detail = false) {
  const result = {
    _id: record._id, schoolName: record.schoolName, realName: record.realName,
    status: record.status, revision: record.revision, submittedAt: record.submittedAt,
    reviewedAt: record.reviewedAt || null,
  };
  if (detail) Object.assign(result, {
    studentNumber: record.studentNumber, hasProof: Boolean(record.proofFileID),
    rejectionReason: record.rejectionReason || '', approvedSchoolName: record.approvedSchoolName || '',
  });
  return result;
}

function checkProofPath(record, env) {
  const file = record.proofFileID;
  const prefix = `cloud://${env}.`;
  const marker = `/certification-proofs/${record.userId}/`;
  const position = typeof file === 'string' ? file.indexOf(marker) : -1;
  if (!env || typeof file !== 'string' || !file.startsWith(prefix) || position < prefix.length ||
      !/^[a-f0-9]{32}\.(png|jpg)$/.test(file.slice(position + marker.length))) {
    fail('PROOF_UNAVAILABLE', '认证材料路径异常，请驳回并要求重新提交');
  }
  return file;
}

function checkPending(record, revision) {
  if (!record || record.status === 'withdrawn') fail('APPLICATION_NOT_FOUND', '申请已撤回或不存在，请刷新列表');
  if (record.revision !== revision) fail('STALE_APPLICATION', '申请已重新提交，请刷新后核对最新材料');
  if (record.status !== 'pending') fail('APPLICATION_ALREADY_REVIEWED', '该申请已被审核，请刷新查看结果');
}

function createCertificationReviewService(db, { getProofUrl, verifyProof } = {}) {
  async function findApplication(applicationId) {
    const record = (await db.collection(APPLICATIONS).doc(applicationId).get()).data;
    if (!record || record.status === 'withdrawn') fail('APPLICATION_NOT_FOUND', '申请已撤回或不存在，请刷新列表');
    if (record._id !== `cert_${record.userId}`) fail('INVALID_APPLICANT', '申请人与记录不一致，请核查');
    return record;
  }

  return async function handleReview(action, event, operator, identity) {
    requireAdmin(operator);
    if (action === 'listCertifications') {
      const status = event.status === undefined ? 'pending' : event.status;
      const offset = event.offset === undefined ? 0 : event.offset;
      if (!STATUSES.includes(status) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) {
        fail('INVALID_REVIEW', '列表筛选或页码无效，请刷新');
      }
      const result = await db.collection(APPLICATIONS).where({ status })
        .orderBy('submittedAt', 'desc').orderBy('_id', 'desc').skip(offset).limit(PAGE_SIZE + 1).get();
      return { items: result.data.slice(0, PAGE_SIZE).map(record => reviewView(record)),
        hasMore: result.data.length > PAGE_SIZE, nextOffset: offset + Math.min(result.data.length, PAGE_SIZE) };
    }

    const applicationId = validateId(event.applicationId);
    const record = await findApplication(applicationId);
    if (action === 'getCertificationDetail') return reviewView(record, true);
    const revision = validateRevision(event.revision);
    if (record.revision !== revision) fail('STALE_APPLICATION', '申请已重新提交，请刷新后核对最新材料');
    if (action === 'getCertificationProof') {
      const file = checkProofPath(record, identity.env);
      if (typeof getProofUrl !== 'function') fail('PROOF_UNAVAILABLE', '认证材料暂不可查看，请稍后重试');
      const url = await getProofUrl(file);
      if (typeof url !== 'string' || !url.startsWith('https://')) fail('PROOF_UNAVAILABLE', '认证材料暂不可查看，请稍后重试');
      const latest = await findApplication(applicationId);
      if (latest.revision !== revision || latest.proofFileID !== file) {
        fail('STALE_APPLICATION', '申请已变化，请刷新后核对最新材料');
      }
      // 临时链接仅在管理员主动查看时生成，不出现在普通资料和申请列表中。
      return { url, expiresIn: 120, revision };
    }

    const review = event.review;
    if (!review || typeof review !== 'object' || Array.isArray(review) ||
        Object.keys(review).some(key => !['decision', 'schoolName', 'rejectionReason'].includes(key)) ||
        !['approved', 'rejected'].includes(review.decision)) fail('INVALID_REVIEW', '审核操作无效');
    const approved = review.decision === 'approved';
    const schoolName = approved ? checkedText(typeof review.schoolName === 'string' ? review.schoolName.normalize('NFKC') : '',
      2, 60, '请确认 2—60 个字的学校全称') : '';
    const rejectionReason = approved ? '' : checkedText(review.rejectionReason, 2, 200, '请填写 2—200 个字的驳回原因');
    // 暂无学校目录时，统一全称生成稳定标识；客户端不能任意指定 schoolId。
    const schoolId = approved ? 'school_' + crypto.createHash('sha256').update(schoolName.replace(/\s+/g, '')).digest('hex').slice(0, 32) : '';
    checkPending(record, revision);
    let checkedProof = '';
    if (approved) {
      checkedProof = checkProofPath(record, identity.env);
      if (typeof verifyProof !== 'function' || !await verifyProof(checkedProof)) {
        fail('PROOF_UNAVAILABLE', '材料不存在或无法读取，请核对后重试');
      }
    }

    await db.runTransaction(async transaction => {
      const operatorRef = transaction.collection('users').doc(operator._id);
      requireAdmin((await operatorRef.get()).data);
      const applicationRef = transaction.collection(APPLICATIONS).doc(applicationId);
      const application = (await applicationRef.get()).data;
      checkPending(application, revision);
      if (application.userId !== record.userId || applicationId !== `cert_${application.userId}` ||
          application.userId === operator._id) fail('INVALID_APPLICANT', '不能审核当前申请人');
      const applicantRef = transaction.collection('users').doc(application.userId);
      const applicant = (await applicantRef.get()).data;
      if (!applicant || applicant.status !== 'active' || !['user', 'student'].includes(applicant.role) ||
          applicant.certificationStatus !== 'pending') fail('INVALID_APPLICANT', '申请人状态已变化，请核查后处理');
      if (approved && application.proofFileID !== checkedProof) fail('STALE_APPLICATION', '材料已变化，请重新查看');
      const now = db.serverDate();
      const result = {
        status: review.decision, approvedSchoolName: schoolName, schoolId,
        rejectionReason, reviewerId: operator._id, reviewedAt: now, updatedAt: now,
      };
      await applicationRef.update({ data: result });
      await applicantRef.update({ data: {
        role: approved ? 'student' : 'user', certificationStatus: review.decision,
        schoolId, schoolName, updatedAt: now,
      } });
      // 独立记录保留每个版本的审核结果，驳回重提不会抹掉上一轮审核记录。
      await transaction.collection(REVIEWS).doc(`${applicationId}_v${revision}`).set({ data: {
        applicationId, revision, userId: application.userId, ...result,
      } });
      // 同时写审核员记录，让并发撤销管理员权限与本次审核产生写冲突并重新鉴权。
      await operatorRef.update({ data: { lastCertificationReviewAt: now } });
    });
    return reviewView(await findApplication(applicationId), true);
  };
}

module.exports = { createCertificationReviewService, REVIEW_ACTIONS, REVIEW_CODES };
