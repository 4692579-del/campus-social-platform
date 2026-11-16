// 只把服务端身份转换成显示文字，不承担权限判断。
const ROLE_TEXT = { user: '普通用户', student: '学生用户', admin: '管理员' };
const CERTIFICATION_TEXT = {
  unverified: '未认证', pending: '待审核', approved: '已认证', rejected: '已驳回',
};

function describeUser(user) {
  if (!user) return { roleText: '', certificationText: '未认证', isAdmin: false };
  const isAdmin = user.role === 'admin';
  return {
    roleText: ROLE_TEXT[user.role] || '身份待同步',
    certificationText: isAdmin ? '管理员不参与学生认证' : (CERTIFICATION_TEXT[user.certificationStatus] || '状态待确认'),
    isAdmin,
  };
}

module.exports = { describeUser };
