const crypto = require('crypto');
const { aiError, messageFor } = require('./ai-errors');
const { createAIUsage } = require('./ai-usage');
const BOT_ID = 'bot_xiaocui';
const BOT = { nickname: '小萃小萃', avatarFileID: '/images/ai/xiaocui.jpg', accountId: '', verified: false, isAI: true };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const jobId = id => `ai_${hash(id)}`;
const table = id => id.startsWith('c_') ? 'square_reply_children' : 'square_replies';
const error = (code, message) => Object.assign(new Error(message), { code });
function createSquareAI(db, options) {
  const usage = createAIUsage(db, options);
  const now = () => options.aiNow ? options.aiNow() : Date.now();
  const jobRef = (source, id) => source.collection('square_ai_jobs').doc(jobId(id));
  async function enqueue(transaction, row) {
    if (row.askAI !== true) return {};
    if ((row.ancestorIds || []).length >= 64) return { aiStatus: 'unavailable' };
    await jobRef(transaction, row._id).set({ data: { type: 'job', postId: row.postId, targetId: row._id,
      requesterId: row.authorId, status: 'queued', attempts: 0, createdAt: db.serverDate() } });
    return { aiStatus: 'queued', aiAttempts: 0 };
  }
  async function process(postId, targetId, user) {
    if (!/^p_[a-f0-9]{40}$/.test(postId || '') || !/^[rc]_[a-f0-9]{40}$/.test(targetId || '')) throw error('INVALID_POST', 'AI 回复参数不正确');
    const lease = crypto.randomBytes(12).toString('hex');
    let job, claimed = false;
    try { await db.runTransaction(async tx => {
      claimed = false;
      const account = (await tx.collection('users').doc(user._id).get()).data;
      if (!account || account.status !== 'active') throw error('ACCOUNT_DISABLED', '账号暂不可使用');
      const post = (await tx.collection('square_posts').doc(postId).get()).data;
      const target = (await tx.collection(table(targetId)).doc(targetId).get()).data;
      job = (await jobRef(tx, targetId).get()).data;
      if (!job || job.requesterId !== user._id || job.postId !== postId) throw error('FORBIDDEN', '只能处理自己唤起的 AI 回复');
      if (!post || post.scope !== 'square' || post.status !== 'published' || !target || target.postId !== postId || target.status !== 'published') throw error('POST_NOT_FOUND', '动态或评论已不可见');
      if (target.askAI !== true) throw error('INVALID_POST', '请通过“问问小萃”按钮唤起 AI');
      if (job.status === 'done' || job.status === 'unavailable' || job.attempts >= 2 && job.status !== 'processing') return;
      if (job.status === 'processing' && job.leaseUntil > now()) return;
      if (job.attempts >= 2) {
        job.status = 'unavailable';
        await jobRef(tx, targetId).update({ data: { status: job.status } });
        await tx.collection(table(targetId)).doc(targetId).update({ data: { aiStatus: job.status } });
        return;
      }
      job = { ...job, status: 'processing', attempts: job.attempts + 1, lease, leaseUntil: now() + 90000 };
      // get() 的结果带 _id；只更新可变字段，不将数据库主键重新提交。
      await jobRef(tx, targetId).update({ data: { status: job.status, attempts: job.attempts, lease, leaseUntil: job.leaseUntil } });
      await tx.collection(table(targetId)).doc(targetId).update({ data: { aiStatus: 'processing', aiAttempts: job.attempts, aiErrorCode: '' } });
      claimed = true;
    }); } catch (failure) {
      if (['FORBIDDEN', 'ACCOUNT_DISABLED', 'POST_NOT_FOUND'].includes(failure.code)) throw failure;
      const saved = (await jobRef(db, targetId).get()).data;
      if (!saved || saved.requesterId !== user._id || saved.postId !== postId || !['queued', 'failed'].includes(saved.status)) throw failure;
      await jobRef(db, targetId).update({ data: { status: 'failed', errorCode: 'AI_SAVE_FAILED', stage: 'claim',
        databaseCode: /^[A-Za-z0-9_.-]{1,80}$/.test(String(failure.code || '')) ? String(failure.code) : 'UNKNOWN' } });
      await db.collection(table(targetId)).doc(targetId).update({ data: { aiStatus: 'failed', aiErrorCode: 'AI_SAVE_FAILED' } });
      return { status: 'failed', replyId: '', created: false };
    }
    const replyId = `c_${hash('xiaocui:' + targetId).slice(0, 40)}`;
    if (!claimed) return { status: job.status, replyId: job.status === 'done' ? replyId : '', created: false };
    let stage = 'context', reservation;
    try {
      if (!options.generateAI) throw error('AI_NOT_CONFIGURED', 'AI 尚未配置');
      const post = (await db.collection('square_posts').doc(postId).get()).data;
      const target = (await db.collection(table(targetId)).doc(targetId).get()).data;
      const rootId = target.rootId || target._id;
      const root = rootId === targetId ? target : (await db.collection('square_replies').doc(rootId).get()).data;
      const parent = target.replyToId ? (await db.collection(table(target.replyToId)).doc(target.replyToId).get()).data : null;
      if (!post || post.status !== 'published' || post.scope !== 'square' || !target || target.status !== 'published' || !root || root.status !== 'published') throw error('POST_NOT_FOUND', '动态或评论已不可见');
      const context = { post: Array.from(post.content || '').slice(0, 2000).join(''), hasImages: Boolean(post.images && post.images.length),
        root: root && root.content || '', previous: parent && parent.content || '', comment: target.content };
      stage = 'usage';
      reservation = await usage.reserve(user._id);
      stage = 'generate';
      const generated = await options.generateAI(context);
      const content = typeof generated === 'string' ? Array.from(generated.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()).slice(0, reservation.chars).join('') : '';
      if (!content) throw error('AI_EMPTY', 'AI 暂未生成回复');
      stage = 'content_check';
      let permitted;
      try { permitted = options.checkText && await options.checkText(content, user.openid); }
      catch (failure) { throw aiError('AI_CONTENT_CHECK_UNAVAILABLE'); }
      if (!permitted) throw error('AI_CONTENT_REJECTED', 'AI 回复未通过检查');
      stage = 'save';
      let created = false, completed = false;
      await db.runTransaction(async tx => {
        created = false;
        completed = false;
        const latest = (await jobRef(tx, targetId).get()).data;
        const account = (await tx.collection('users').doc(user._id).get()).data;
        const latestPost = (await tx.collection('square_posts').doc(postId).get()).data;
        const latestTarget = (await tx.collection(table(targetId)).doc(targetId).get()).data;
        const latestRoot = (await tx.collection('square_replies').doc(rootId).get()).data;
        const exists = (await tx.collection('square_reply_children').doc(replyId).get()).data;
        if (!latest || latest.lease !== lease || latest.status !== 'processing') return;
        if (!account || account.status !== 'active' || !latestPost || latestPost.scope !== 'square' || latestPost.status !== 'published' ||
          !latestTarget || latestTarget.status !== 'published' || !latestRoot || latestRoot.status !== 'published') throw error('POST_NOT_FOUND', '动态或评论已不可见');
        if (!exists) {
          await usage.commit(tx, reservation, Array.from(content).length);
          await tx.collection('square_reply_children').doc(replyId).set({ data: { scope: 'square', status: 'published', postId,
            authorId: BOT_ID, content, rootId, replyToId: targetId, replyToAuthorId: user._id,
            ancestorIds: [...(target.ancestorIds || []), targetId], likeCount: 0, replyCount: 0,
            createdAt: db.serverDate(), sortKey: `${String(now()).padStart(16, '0')}_${replyId}` } });
          await tx.collection('square_posts').doc(postId).update({ data: { replyCount: (latestPost.replyCount || 0) + 1 } });
          await tx.collection('square_replies').doc(rootId).update({ data: { replyCount: (latestRoot.replyCount || 0) + 1 } });
          created = true;
        }
        await tx.collection(table(targetId)).doc(targetId).update({ data: { aiStatus: 'done', aiErrorCode: '' } });
        await jobRef(tx, targetId).update({ data: { status: 'done', completedAt: db.serverDate() } });
        completed = true;
      });
      if (!completed) return { status: 'processing', replyId: '', created: false };
      if (created) reservation = null;
      return { status: 'done', replyId, created };
    } catch (failure) {
      const code = messageFor(failure.code) !== messageFor('AI_UNAVAILABLE') ? failure.code : stage === 'save' ? 'AI_SAVE_FAILED' : 'AI_UNAVAILABLE';
      const status = stage === 'usage' ? 'failed' : job.attempts >= 2 || ['AI_NOT_CONFIGURED', 'AI_CONTENT_REJECTED', 'POST_NOT_FOUND'].includes(failure.code) ? 'unavailable' : 'failed';
      await db.runTransaction(async tx => {
        const latest = (await jobRef(tx, targetId).get()).data;
        if (!latest || latest.lease !== lease || latest.status !== 'processing') return;
        const attempts = stage === 'usage' ? job.attempts - 1 : job.attempts;
        await jobRef(tx, targetId).update({ data: { status, errorCode: code, stage, attempts,
          httpStatus: Number.isInteger(failure.httpStatus) ? failure.httpStatus : 0,
          networkCode: /^E[A-Z_]+$/.test(failure.networkCode || '') ? failure.networkCode : '' } });
        await tx.collection(table(targetId)).doc(targetId).update({ data: { aiStatus: status, aiErrorCode: code, aiAttempts: attempts } });
      });
      return { status, replyId: '', created: false };
    } finally { await usage.release(reservation); }
  }
  return { enqueue, process };
}
module.exports = { BOT_ID, BOT, createSquareAI };
