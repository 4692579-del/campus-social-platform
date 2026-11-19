const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/certification-fixture');
const { BOT_ID } = require('../cloudfunctions/userService/square-ai');
async function setup(options = {}) {
  const f = fixture(options); const user = await f.login(); await f.login(f.bob);
  const published = await f.handle({ action: 'publishSquarePost', post: { scope: 'square', content: '校园食堂今天的饭很好吃', requestId: 'ai-post-request00001' } }, f.alice);
  const id = published.square.post._id;
  const send = (content = '@小萃 你觉得呢？', requestId = 'ai-comment-request001', replyToId, askAI = content.startsWith('@小萃')) => f.handle({ action: 'publishSquareReply', post: {
    scope: 'square', postId: id, content, requestId, askAI, ...(replyToId ? { replyToId } : {}) } }, f.alice);
  const process = (replyId, identity = f.alice) => f.handle({ action: 'processSquareAIReply', postId: id, replyId }, identity);
  return { ...f, user, id, send, process };
}
test('仅结构化按钮标记触发AI，评论落库后才独立调用模型', async () => {
  let called = 0;
  const f = await setup({ generateAI: async context => { called++; assert.equal(context.post, '校园食堂今天的饭很好吃'); assert.equal(context.comment, '@小萃 你觉得呢？'); return '看起来你很满意这顿饭呀！'; } });
  const first = await f.send(); assert.equal(first.success, true); assert.equal(first.square.reply.aiStatus, 'queued'); assert.equal(called, 0);
  const retried = await f.send(); assert.equal(retried.square.reply._id, first.square.reply._id); assert.equal(f.aiJobs.size, 1);
  const result = await f.process(first.square.reply._id); assert.equal(result.success, true, result.message);
  assert.equal(called, 1); assert.equal(result.square.status, 'done'); assert.equal(result.square.reply.author.nickname, '小萃小萃');
  assert.equal(result.square.reply.author.isAI, true); assert.equal(result.square.reply.author.verified, false);
  assert.equal(result.square.reply.rootId, first.square.reply._id); assert.equal(result.square.root.replyCount, 1);
  assert.equal(result.square.post.replyCount, 2); assert.equal(result.square.target.aiStatus, 'done');
  await f.process(first.square.reply._id); assert.equal(called, 1); assert.equal(f.squareReplyChildren.size, 1);
  const children = await f.handle({ action: 'listSquareReplyChildren', postId: f.id, rootId: first.square.reply._id, personalize: true }, f.alice);
  assert.equal(children.square.items[0].author.isAI, true);
});

test('手动输入两个别名不触发AI，非布尔参数被拒绝，重试不可更换唤起标记', async () => {
  const f = await setup();
  for (const [i, content] of ['@小萃', '@小萃小萃 你怎么看', '小萃小萃'].entries()) {
    const result = await f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId: f.id, content, requestId: `manual-ai-comment00${i}` } }, f.alice);
    assert.equal(result.success, true); assert.equal(result.square.reply.aiStatus, '');
  }
  assert.equal(f.aiJobs.size, 0);
  const invalid = await f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId: f.id, content: '问题', requestId: 'invalid-ask-comment01', askAI: 'true' } }, f.alice);
  assert.equal(invalid.code, 'INVALID_POST');
  await f.send('@小萃 问题', 'ask-flag-conflict001', undefined, false);
  assert.equal((await f.send('@小萃 问题', 'ask-flag-conflict001', undefined, true)).code, 'REQUEST_CONFLICT');
});
test('并发只调用一次，仅触发者可重试，客户端不能指定机器人身份或伪造AI任务', async () => {
  let resolve, calls = 0;
  const f = await setup({ generateAI: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const comment = (await f.send()).square.reply;
  assert.equal((await f.process(comment._id, f.bob)).code, 'FORBIDDEN');
  const running = f.process(comment._id);
  for (let i = 0; i < 50 && !resolve; i++) await new Promise(done => setImmediate(done)); assert.ok(resolve);
  const duplicate = await f.process(comment._id); assert.equal(duplicate.square.status, 'processing'); assert.equal(calls, 1);
  resolve('我是小萃。'); await running;
  const fake = await f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId: f.id, content: '冒充机器人', requestId: 'fake-bot-request0001', authorId: BOT_ID } }, f.alice);
  assert.equal(fake.code, 'INVALID_POST');
  assert.equal((await f.handle({ action: 'processSquareAIReply', postId: f.id, replyId: comment._id }, { openid: 'guest', env: 'test' })).code, 'NOT_REGISTERED');
});
test('楼中唤起沿用根评论与祖先链，AI文本不会自行触发新任务，字数限制150', async () => {
  let context;
  const f = await setup({ generateAI: async value => { context = value; return '@小萃 ' + '答'.repeat(400); } });
  const root = (await f.send('原评论', 'ai-root-comment001')).square.reply;
  const child = (await f.send('@小萃小萃 分析一下', 'ai-child-comment001', root._id)).square.reply;
  const result = await f.process(child._id); assert.equal(result.success, true, result.message);
  assert.equal(context.root, '原评论'); assert.equal(context.previous, '原评论');
  assert.equal(result.square.reply.replyToId, child._id); assert.equal(result.square.reply.rootId, root._id);
  assert.deepEqual(result.square.reply.ancestorIds, [root._id, child._id]); assert.equal(Array.from(result.square.reply.content).length, 150);
  assert.equal([...f.aiJobs.values()].filter(row => row.type === 'job').length, 1); assert.equal(result.square.post.replyCount, 3);
});
test('生成失败不影响用户评论，两次失败后停止；未配置与内容检查失败不能伪造回复', async () => {
  let calls = 0;
  const f = await setup({ generateAI: async () => { calls++; throw new Error('private provider failure'); } });
  const row = (await f.send()).square.reply;
  const first = await f.process(row._id); assert.equal(first.square.status, 'failed'); assert.equal(first.square.target.aiCanRetry, true);
  const second = await f.process(row._id); assert.equal(second.square.status, 'unavailable'); assert.equal(second.square.target.aiCanRetry, false);
  await f.process(row._id); assert.equal(calls, 2); assert.equal(f.squarePosts.get(f.id).replyCount, 1); assert.equal(f.squareReplyChildren.size, 0);
  const missing = await setup(); const target = (await missing.send()).square.reply;
  assert.equal((await missing.process(target._id)).square.status, 'unavailable');
  const moderated = await setup({ generateAI: async () => '不应发布的回答', checkText: async content => content !== '不应发布的回答' });
  const m = (await moderated.send()).square.reply; assert.equal((await moderated.process(m._id)).square.status, 'unavailable'); assert.equal(moderated.squareReplyChildren.size, 0);
});
test('生成期间删除动态或封禁触发账号，不落库AI回复、不增加计数', async () => {
  for (const operation of ['delete', 'ban']) {
    let finish;
    const f = await setup({ generateAI: () => new Promise(resolve => { finish = resolve; }) });
    const target = (await f.send()).square.reply; const pending = f.process(target._id);
    for (let i = 0; i < 50 && !finish; i++) await new Promise(done => setImmediate(done)); assert.ok(finish);
    if (operation === 'delete') await f.handle({ action: 'deleteSquarePost', postId: f.id }, f.alice);
    else f.users.get(f.user._id).status = 'banned';
    finish('迟到的回答'); await pending;
    assert.equal(f.squareReplyChildren.size, 0); assert.equal(f.squarePosts.get(f.id).replyCount, 1);
  }
});
test('同账号同一时刻连续25次唤起均可生成回复，旧配额不再限制或新增计数', async () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  const f = await setup({ aiNow: () => now, generateAI: async () => '正常回答' });
  const key = 'quota_' + require('node:crypto').createHash('sha256').update(f.user._id + '2026-11-20').digest('hex');
  const legacy = { type: 'quota', count: 999, lastAt: now };
  f.aiJobs.set(key, { ...legacy });
  for (let i = 0; i < 25; i++) {
    const result = await f.send('@小萃 继续', `ai-no-limit-comment-${i}`);
    assert.equal(result.success, true, result.message); assert.equal(result.square.reply.aiStatus, 'queued');
    assert.equal((await f.process(result.square.reply._id)).square.status, 'done');
  }
  assert.equal(f.squareReplyChildren.size, 25);
  assert.deepEqual(f.aiJobs.get(key), legacy);
  assert.equal([...f.aiJobs.values()].filter(row => row.type === 'quota').length, 1);
});

test('执行中断后的过期任务可恢复，AI提交事务失败不留下半条回复或虚增数量', async () => {
  const f = await setup({ generateAI: async () => '恢复完成' });
  const target = (await f.send()).square.reply;
  const job = [...f.aiJobs.values()].find(row => row.type === 'job');
  Object.assign(job, { status: 'processing', attempts: 1, leaseUntil: Date.now() - 1, lease: 'expired' });
  assert.equal((await f.process(target._id)).square.status, 'done'); assert.equal(f.squareReplyChildren.size, 1);
  const failing = await setup({ generateAI: async () => '不能部分保存', failCollection: 'square_reply_children' });
  const t = (await failing.send()).square.reply;
  assert.equal((await failing.process(t._id)).square.status, 'failed');
  assert.equal(failing.squareReplyChildren.size, 0); assert.equal(failing.squarePosts.get(failing.id).replyCount, 1);
  assert.equal(failing.squareReplies.get(t._id).replyCount, 0);
});

test('领取任务不回写不可变主键，严格主键校验的数据库中可从queued进入完成状态', async () => {
  const f = await setup({ rejectImmutableId: true, generateAI: async () => '真实回复' });
  const row = (await f.send()).square.reply;
  const job = [...f.aiJobs.values()].find(value => value.type === 'job');
  assert.equal(job.status, 'queued'); assert.equal(job.attempts, 0);
  await assert.rejects(f.db.collection('square_ai_jobs').doc(job._id).set({ data: job }), error => error.code === 'IMMUTABLE_ID');
  const result = await f.process(row._id); assert.equal(result.success, true, result.message);
  assert.equal(result.square.status, 'done'); assert.equal(f.squareReplyChildren.size, 1);
});

test('上游错误与内容检查故障保留安全诊断，前端只向触发者显示原因，不包含密钥或原始错误', async () => {
  for (const code of ['AI_AUTH_FAILED', 'AI_INSUFFICIENT_BALANCE', 'AI_TIMEOUT', 'AI_NETWORK']) {
    const f = await setup({ generateAI: async () => { throw Object.assign(new Error('private upstream details'), { code, httpStatus: 402 }); } });
    const row = (await f.send()).square.reply;
    const result = await f.process(row._id); assert.equal(result.success, true);
    assert.ok(result.square.target.aiMessage); assert.ok(!result.square.target.aiMessage.includes('private'));
    const job = [...f.aiJobs.values()].find(value => value.type === 'job');
    assert.equal(job.errorCode, code); assert.equal(job.stage, 'generate'); assert.equal(job.httpStatus, 402);
    const other = await f.handle({ action: 'listSquareReplies', postId: f.id, personalize: true }, f.bob);
    assert.equal(other.square.items[0].aiMessage, '');
  }
  const f = await setup({ generateAI: async () => '内容检查故障', checkText: async content => { if (content === '内容检查故障') throw new Error('private moderation response'); return true; } });
  const row = (await f.send()).square.reply; await f.process(row._id);
  const job = [...f.aiJobs.values()].find(value => value.type === 'job');
  assert.equal(job.errorCode, 'AI_CONTENT_CHECK_UNAVAILABLE'); assert.equal(job.stage, 'content_check');
});
