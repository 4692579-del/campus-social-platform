const MESSAGES = {
  AI_HOURLY_QUOTA_EXHAUSTED: '本小时小萃AI额度已用完，下一整点重置额度',
  AI_QUOTA_EXHAUSTED: '今日小萃AI额度已用完，每日0点重置额度',
  AI_QUOTA_BUSY: '小萃正在处理其他请求，请稍后再试',
  AI_USAGE_EXPIRED: '本次请求已过期，请重新尝试',
  AI_USAGE_UNAVAILABLE: '额度信息暂不可用，请稍后再试',
  AI_NOT_CONFIGURED: '小萃尚未配置，请联系管理员',
  AI_AUTH_FAILED: 'AI 密钥校验失败，请检查云端配置',
  AI_INSUFFICIENT_BALANCE: 'DeepSeek 可用余额不足',
  AI_INVALID_REQUEST: 'AI 服务参数不兼容，请更新云函数',
  AI_RATE_LIMIT: 'AI 服务繁忙，请稍后重试',
  AI_TIMEOUT: '小萃回复超时，请重试',
  AI_NETWORK: 'AI 网络连接失败，请重试',
  AI_EMPTY: 'AI 暂未生成回复，请重试',
  AI_RESPONSE_INVALID: 'AI 回复格式异常，请重试',
  AI_IMAGES_UNAVAILABLE: '小萃暂时无法读取动态或评论配图，请稍后重试',
  AI_CONTENT_REJECTED: '小萃的回复未通过内容检查',
  AI_CONTENT_CHECK_UNAVAILABLE: '回复内容检查暂不可用，请稍后重试',
  AI_SAVE_FAILED: 'AI 回复保存失败，请稍后重试',
  AI_UNAVAILABLE: '小萃暂时无法回复，请稍后重试',
};
const messageFor = code => MESSAGES[code] || MESSAGES.AI_UNAVAILABLE;
function aiError(code, extra = {}) { return Object.assign(new Error(messageFor(code)), { code }, extra); }
function httpError(status) {
  return aiError(({ 400: 'AI_INVALID_REQUEST', 401: 'AI_AUTH_FAILED', 402: 'AI_INSUFFICIENT_BALANCE', 403: 'AI_AUTH_FAILED',
    404: 'AI_INVALID_REQUEST', 408: 'AI_TIMEOUT', 422: 'AI_INVALID_REQUEST', 429: 'AI_RATE_LIMIT', 504: 'AI_TIMEOUT' })[status] || 'AI_UNAVAILABLE', { httpStatus: status });
}
module.exports = { messageFor, aiError, httpError };
