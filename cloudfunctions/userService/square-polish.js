const { messageFor } = require('./ai-errors');
const { checkUnavailableMessage } = require('./wechat-content-check');
const { createAIUsage } = require('./ai-usage');
const POLISH_CODES = ['AI_POLISH_FAILED'];
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function active(user) {
  if (!user) fail('NOT_REGISTERED', '请先登录');
  if (user.status !== 'active') fail('ACCOUNT_DISABLED', '当前账号暂不可使用');
  if (!['user', 'student', 'admin'].includes(user.role)) fail('INVALID_ROLE', '账号身份异常');
}
function createSquarePolisher(db, options = {}) {
  const usage = createAIUsage(db, options);
  return async (content, user, identity) => {
    active(user);
    if (typeof content !== 'string' || !content.trim() || Array.from(content).length > 150 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(content)) {
      fail('INVALID_POST', '请输入150字以内的动态正文');
    }
    if (!options.optimizeAI) fail('AI_POLISH_FAILED', '小萃优化尚未配置，请更新云函数');
    const check = async (value, stage) => {
      let permitted;
      try { permitted = options.checkText && await options.checkText(value, identity.openid); }
      catch (error) {
        // 只记录阶段及错误码，不记录原文、openid、密钥或上游错误全文。
        const rawCode = error && (error.errCode ?? error.errcode ?? error.code);
        const code = /^-?\d{1,10}$/.test(String(rawCode)) ? String(rawCode) : 'UNKNOWN';
        const nested = String(error && error.errMsg || '').match(/error\s*code\s*:\s*(-?\d{1,10})(?!\d)/i);
        const upstream = nested ? nested[1] : code;
        console.error('userService polish content check:', stage, 'code:', code, 'upstream:', upstream);
        const where = stage === 'original' ? '原文' : '优化结果';
        const detail = upstream === 'UNKNOWN' ? '' : `（${upstream}）`;
        const message = error && error.checkTransport ? `${checkUnavailableMessage(error)}，原文已保留`
          : upstream === '-604101' ? `内容检查权限未生效${detail}，请重新部署userService，原文已保留`
          : upstream === '45009' ? '微信文字检查调用受限（45009）；未上架小程序每日仅100次，原文已保留'
          : `${where}检查暂不可用${detail}，已保留原文`;
        fail('CONTENT_CHECK_UNAVAILABLE', message);
      }
      if (!options.checkText) {
        console.error('userService polish content check:', stage, 'code: CHECKER_MISSING');
        fail('CONTENT_CHECK_UNAVAILABLE', '内容检查未配置，请重新部署userService，原文已保留');
      }
      if (!permitted) fail('CONTENT_REJECTED', '内容未通过检查，已保留原文');
    };
    await check(content, 'original');
    // 原文检查期间账号可能停用，调用模型前仍须重新校验真实账号。
    active((await db.collection('users').doc(user._id).get()).data);
    let reservation = await usage.reserve(user._id);
    try {
      let raw;
      try { raw = await options.optimizeAI({ content }); }
      catch (error) {
        const message = error.code === 'AI_TIMEOUT' ? '小萃优化超时，请重试' : messageFor(error.code);
        fail('AI_POLISH_FAILED', message);
      }
      if (typeof raw !== 'string') fail('AI_POLISH_FAILED', '暂未生成优化内容，请重试');
      // 提示词不是长度保证：最终按码点硬限制，并检查实际返回结果。
      const optimized = Array.from(raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()).slice(0, reservation.chars).join('').trim();
      if (!optimized) fail('AI_POLISH_FAILED', '暂未生成优化内容，请重试');
      await check(optimized, 'optimized');
      await db.runTransaction(async tx => {
        active((await tx.collection('users').doc(user._id).get()).data);
        await usage.commit(tx, reservation, Array.from(optimized).length);
      });
      reservation = null;
      return { content: optimized };
    } finally { await usage.release(reservation); }
  };
}
module.exports = { createSquarePolisher, POLISH_CODES };
