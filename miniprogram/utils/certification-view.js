const STATUS_TEXT = { pending: '待审核', approved: '已通过', rejected: '已驳回' };

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeApplication(application) {
  return { ...application, statusText: STATUS_TEXT[application.status] || '状态异常',
    submittedTime: formatTime(application.submittedAt), reviewedTime: formatTime(application.reviewedAt) };
}

module.exports = { describeApplication };
