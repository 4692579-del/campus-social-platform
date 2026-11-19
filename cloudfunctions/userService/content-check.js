const { createWeChatTextChecker } = require('./wechat-content-check');
const { createTencentTextChecker } = require('./tencent-content-check');
function createTextChecker(options = {}) {
  const getEnv = options.getEnv || (() => process.env);
  const wechat = createWeChatTextChecker(options);
  const tencent = createTencentTextChecker({ ...options, getEnv });
  return async (content, openid) => {
    const provider = String(getEnv().TEXT_CHECK_PROVIDER || 'wechat').trim();
    if (provider === 'tencent_tms') return tencent(content);
    if (provider === 'wechat') return wechat(content, openid);
    // 配置拼写错误不得静默回退到其他服务。
    throw Object.assign(new Error('Unknown text check provider'), {
      errCode: 'TEXT_CHECK_PROVIDER_INVALID', checkTransport: 'config', checkStage: 'check',
    });
  };
}
module.exports = { createTextChecker };
