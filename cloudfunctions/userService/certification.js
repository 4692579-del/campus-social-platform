const crypto = require('crypto');

const MAX_PROOF_BYTES = 1024 * 1024;
const COLLECTION = 'certification_applications';
const EXPECTED_CODES = ['INVALID_CERTIFICATION', 'INVALID_PROOF', 'CERTIFICATION_PENDING',
  'ALREADY_CERTIFIED', 'CERTIFICATION_STATE_ERROR', 'CERTIFICATION_NOT_READY'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function checkApplicant(user) {
  if (!user) fail('NOT_REGISTERED', '请先登录');
  if (user.status !== 'active') fail('ACCOUNT_DISABLED', '当前账号暂不可使用');
  if (!['user', 'student', 'admin'].includes(user.role)) fail('INVALID_ROLE', '账号身份异常，请联系管理员');
  if (user.role === 'admin') fail('FORBIDDEN', '管理员账号无需申请学校认证');
}

function textField(value, min, max, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (Array.from(text).length < min || Array.from(text).length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    fail('INVALID_CERTIFICATION', `请填写 ${min}—${max} 个字的${label}`);
  }
  return text;
}

function validateApplication(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['schoolName', 'realName', 'studentNumber', 'proofBase64', 'requestId'].includes(key))) {
    fail('INVALID_CERTIFICATION', '认证申请字段不正确');
  }
  const schoolName = textField(value.schoolName, 2, 60, '学校全称');
  const realName = textField(value.realName, 2, 30, '姓名');
  const studentNumber = typeof value.studentNumber === 'string' ? value.studentNumber.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(studentNumber)) {
    fail('INVALID_CERTIFICATION', '学号应为 3—32 位字母、数字、短横线或下划线');
  }
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value.requestId)) {
    fail('INVALID_CERTIFICATION', '提交标识无效，请重新打开页面');
  }
  const encoded = value.proofBase64;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_PROOF_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    fail('INVALID_PROOF', '请选择不超过 1MB 的 JPG 或 PNG 认证图片');
  }
  const buffer = Buffer.from(encoded, 'base64');
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (buffer.length < 16 || buffer.length > MAX_PROOF_BYTES || buffer.toString('base64') !== encoded || (!png && !jpeg)) {
    fail('INVALID_PROOF', '认证材料必须是有效的 JPG 或 PNG 图片，且不超过 1MB');
  }
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify([schoolName, realName, studentNumber])).update(buffer).digest('hex');
  return { schoolName, realName, studentNumber, requestId: value.requestId, fingerprint,
    buffer, extension: png ? 'png' : 'jpg' };
}

// 材料 fileID、请求标识及内部校验信息不返回客户端；姓名学号也不混入公开个人资料。
function ownApplication(record) {
  if (!record) return null;
  return {
    _id: record._id, schoolName: record.schoolName, realName: record.realName,
    studentNumber: record.studentNumber, status: record.status,
    submittedAt: record.submittedAt, rejectionReason: record.rejectionReason || '',
    hasProof: Boolean(record.proofFileID),
    reviewedAt: record.reviewedAt || null, approvedSchoolName: record.approvedSchoolName || '',
  };
}

function canSubmit(user, previous, incoming) {
  if (user.certificationStatus === 'approved' || (previous && previous.status === 'approved')) {
    fail('ALREADY_CERTIFIED', '你已通过学校认证，无需重复申请');
  }
  if (previous && previous.status === 'pending') {
    // 相同请求的网络重试返回原记录，不覆盖审核中的内容。
    if (previous.requestId === incoming.requestId && previous.fingerprint === incoming.fingerprint &&
        user.certificationStatus === 'pending') return false;
    fail('CERTIFICATION_PENDING', '已有待审核申请，请勿重复提交');
  }
  if (!['unverified', 'rejected'].includes(user.certificationStatus) ||
      (previous && previous.status !== 'rejected')) {
    fail('CERTIFICATION_STATE_ERROR', '认证状态异常，请联系管理员核查');
  }
  return true;
}

function createCertificationService(db, { uploadProof, proofStorageReady = false } = {}) {
  return async function certification(action, value, currentUser) {
    checkApplicant(currentUser);
    // 每人一个最新申请槽位，后续审核操作也会在同一事务内修改申请和用户。
    const applicationId = `cert_${currentUser._id}`;
    const applications = db.collection(COLLECTION);
    const readApplication = async () => {
      const result = await applications.doc(applicationId).get();
      return result.data || null;
    };
    if (action === 'getCertification') return ownApplication(await readApplication());

    const incoming = validateApplication(value);
    const previous = await readApplication();
    if (!canSubmit(currentUser, previous, incoming)) return ownApplication(previous);
    // 默认关闭真实材料上传，只有部署者配置好私有存储规则后才开启。
    if (!proofStorageReady || typeof uploadProof !== 'function') {
      fail('CERTIFICATION_NOT_READY', '认证材料存储尚未配置，请稍后再试');
    }
    const filename = crypto.randomBytes(16).toString('hex');
    const proofFileID = await uploadProof({
      cloudPath: `certification-proofs/${currentUser._id}/${filename}.${incoming.extension}`,
      fileContent: incoming.buffer,
    });
    if (typeof proofFileID !== 'string' || !proofFileID.startsWith('cloud://')) {
      throw new Error('Proof upload did not return a cloud file ID');
    }

    // 上传放在事务外，防止事务重试反复上传；事务内重读角色，避免并发封禁/授权后继续写入。
    await db.runTransaction(async transaction => {
      const userRef = transaction.collection('users').doc(currentUser._id);
      const applicationRef = transaction.collection(COLLECTION).doc(applicationId);
      const user = (await userRef.get()).data;
      const existing = (await applicationRef.get()).data || null;
      checkApplicant(user);
      if (!canSubmit(user, existing, incoming)) return;
      const now = db.serverDate();
      await applicationRef.set({ data: {
        userId: currentUser._id,
        schoolName: incoming.schoolName, realName: incoming.realName, studentNumber: incoming.studentNumber,
        proofFileID, requestId: incoming.requestId, fingerprint: incoming.fingerprint,
        status: 'pending', rejectionReason: '', reviewerId: '', reviewedAt: null, approvedSchoolName: '', schoolId: '',
        createdAt: existing ? existing.createdAt : now, submittedAt: now, updatedAt: now,
        revision: existing ? (existing.revision || 1) + 1 : 1,
      } });
      // 仅更新认证状态，保留角色与 schoolId；审核通过才能授予学生身份和学校归属。
      await userRef.update({ data: { certificationStatus: 'pending', updatedAt: now } });
    });
    // 请求超时也可能已提交，不在异常处理中删材料，避免把已使用的图片误删。
    return ownApplication(await readApplication());
  };
}

module.exports = { createCertificationService, EXPECTED_CODES };
