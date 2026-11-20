const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/certification-fixture');
const { createAIUsage, usageId, usageDay } = require('../cloudfunctions/userService/ai-usage');
const get = (f, identity = f.alice, extra = {}) => f.handle({ action: 'getAIUsage', ...extra }, identity);
const polish = (f, identity = f.alice) => f.handle({ action: 'optimizeSquareContent', content: '待优化正文' }, identity);
async function setup(options = {}) {
  const clock = { now: Date.parse('2026-11-20T04:00:00Z') };
  const f = fixture({ ...options, aiNow: () => clock.now, generateAI: options.generateAI || (async () => '答'.repeat(150)), optimizeAI: options.optimizeAI || (async () => '润'.repeat(150)) });
  const user = await f.login(); await f.login(f.bob);
  const post = await f.handle({ action: 'publishSquarePost', post: { scope: 'square', content: '正常动态', requestId: 'usage-post-request01' } }, f.alice);
  let sequence = 0;
  const send = async () => (await f.handle({ action: 'publishSquareReply', post: { scope: 'square', postId: post.square.post._id, content: '@小萃 问题', askAI: true, requestId: `usage-comment-request-${++sequence}` } }, f.alice)).square.reply;
  const process = row => f.handle({ action: 'processSquareAIReply', postId: post.square.post._id, replyId: row._id }, f.alice);
  const record = () => f.aiJobs.get(usageId(user._id, usageDay(clock.now)));
  const seed = usedChars => f.aiJobs.set(usageId(user._id, usageDay(clock.now)), { type: 'daily_usage', userId: user._id, day: usageDay(clock.now), usedChars, reservations: {} });
  return { ...f, clock, user, send, process, record, seed };
}

test('额度只读查询要求真实身份，忽略伪造账号和客户端百分比，普通未认证用户可查看', async () => {
  const f = fixture();
  assert.equal((await get(f)).code, 'NOT_REGISTERED');
  const user = await f.login();
  const value = await get(f, f.alice, { userId: 'bob', usedPercent: 100 });
  assert.equal(value.success, true); assert.equal(value.aiUsage.usedPercent, 0);
  assert.equal(value.aiUsage.userId, undefined); assert.equal(value.aiUsage.usedChars, undefined);
  assert.equal(f.aiJobs.size, 0);
  f.users.get(user._id).status = 'banned'; assert.equal((await get(f)).code, 'ACCOUNT_DISABLED');
});

test('问答和润色共用额度，按实际输出码点累计，空格换行标点emoji均计数，重复已完成任务不扣第二次', async () => {
  const output = '答😊 空格，\n下一行。';
  const f = await setup({ generateAI: async () => output, optimizeAI: async () => output });
  const row = await f.send(); await f.process(row); await f.process(row);
  assert.equal(f.record().usedChars, Array.from(output).length);
  await polish(f);
  assert.equal(f.record().usedChars, Array.from(output).length * 2);
  assert.equal((await get(f)).aiUsage.usedPercent, Number((Array.from(output).length * 2 / 150).toFixed(2)));
  assert.deepEqual(f.record().reservations, {});
  assert.equal((await get(f, f.bob)).aiUsage.usedPercent, 0);
  assert.ok(!JSON.stringify([...f.aiJobs.values()]).includes(output));
});

test('达到100%后拒绝调用模型，用户评论仍成功，额度失败不消耗模型尝试次数', async () => {
  let calls = 0;
  const f = await setup({ generateAI: async () => { calls++; return '回答'; }, optimizeAI: async () => { calls++; return '润色'; } });
  f.seed(15000);
  assert.equal((await polish(f)).code, 'AI_QUOTA_EXHAUSTED');
  const row = await f.send(); assert.equal(row.aiStatus, 'queued');
  const result = await f.process(row);
  assert.equal(result.square.status, 'failed'); assert.equal(result.square.target.aiCanRetry, true);
  assert.match(result.square.target.aiMessage, /每日0点重置额度/);
  const job = [...f.aiJobs.values()].find(value => value.type === 'job'); assert.equal(job.attempts, 0);
  assert.equal(calls, 0); assert.equal(f.squareReplies.size, 1); assert.equal(f.squareReplyChildren.size, 0);
  assert.equal((await get(f)).aiUsage.usedPercent, 100);
});

test('问答及润色并发争抢最后额度不会超限，少于150字的余额按实际剩余量截断', async () => {
  let calls = 0;
  const f = await setup({ generateAI: async () => { calls++; return '答'.repeat(150); }, optimizeAI: async () => { calls++; return '润'.repeat(150); } });
  f.seed(14970);
  const row = await f.send();
  await Promise.all([f.process(row), polish(f), polish(f), polish(f)]);
  assert.equal(calls, 1); assert.equal(f.record().usedChars, 15000); assert.deepEqual(f.record().reservations, {});
  const aiChars = [...f.squareReplyChildren.values()].reduce((sum, value) => sum + Array.from(value.content).length, 0);
  assert.ok(aiChars === 0 || aiChars === 30);
  assert.equal((await polish(f)).code, 'AI_QUOTA_EXHAUSTED');
});

test('模型故障、空结果、内容拒绝、评论保存失败均释放预留，不增加实际用量', async () => {
  for (const mode of ['model', 'empty', 'moderation', 'save']) {
    const f = await setup({ generateAI: async () => { if (mode === 'model') throw new Error('private'); return mode === 'empty' ? '' : 'AI结果'; },
      checkText: async value => mode !== 'moderation' || value !== 'AI结果', failCollection: mode === 'save' ? 'square_reply_children' : undefined });
    const row = await f.send(); await f.process(row);
    assert.equal(f.record().usedChars, 0); assert.deepEqual(f.record().reservations, {}); assert.equal(f.squareReplyChildren.size, 0); assert.ok([...f.aiJobs.values()].filter(row => row.type === 'hourly_usage').every(row => row.usedChars === 0 && Object.keys(row.reservations).length === 0));
  }
  const f = await setup({ optimizeAI: async () => '拒绝的润色', checkText: async value => value !== '拒绝的润色' });
  assert.equal((await polish(f)).code, 'CONTENT_REJECTED'); assert.equal(f.record().usedChars, 0); assert.deepEqual(f.record().reservations, {});
});

test('中国时区0点自动切换每日额度，跨午夜完成的在途请求只结算原周期，不污染新一天', async () => {
  let resolve;
  const f = await setup({ optimizeAI: () => new Promise(done => { resolve = done; }) });
  f.clock.now = Date.parse('2026-11-20T15:59:59Z'); f.seed(14900);
  const request = polish(f);
  for (let i = 0; i < 40 && !resolve; i++) await new Promise(done => setImmediate(done)); assert.ok(resolve);
  const previousId = usageId(f.user._id, '2026-11-20');
  f.clock.now = Date.parse('2026-11-20T16:00:01Z');
  assert.equal((await get(f)).aiUsage.usedPercent, 0);
  assert.equal((await get(f)).aiUsage.resetsAt, '2026-11-21T16:00:00.000Z');
  resolve('跨日结果'); assert.equal((await request).success, true);
  assert.equal(f.aiJobs.get(previousId).usedChars, 14904); assert.equal((await get(f)).aiUsage.usedPercent, 0);
});

test('中断请求的预留到期后释放，过期结果不能结算或发布，异常计数不能重置成免费额度', async () => {
  const f = await setup(), usage = createAIUsage(f.db, { aiNow: () => f.clock.now });
  f.seed(14900); const first = await usage.reserve(f.user._id);
  await assert.rejects(usage.reserve(f.user._id), error => error.code === 'AI_QUOTA_BUSY');
  f.clock.now += 120001;
  const second = await usage.reserve(f.user._id); assert.equal(second.chars, 100);
  await assert.rejects(f.db.runTransaction(tx => usage.commit(tx, first, 50)), error => error.code === 'AI_USAGE_EXPIRED');
  await usage.release(second); assert.deepEqual(f.record().reservations, {});
  f.record().usedChars = -1;
  assert.equal((await get(f)).code, 'AI_USAGE_UNAVAILABLE');
});

test('生成期间封禁账号或删除评论，回复和扣额一同取消', async () => {
  for (const operation of ['ban', 'delete']) {
    let resolve;
    const f = await setup({ generateAI: () => new Promise(done => { resolve = done; }) });
    const row = await f.send(), request = f.process(row);
    for (let i = 0; i < 40 && !resolve; i++) await new Promise(done => setImmediate(done)); assert.ok(resolve);
    if (operation === 'ban') f.users.get(f.user._id).status = 'banned';
    else f.squareReplies.get(row._id).status = 'deleted';
    resolve('迟到结果'); await request;
    assert.equal(f.record().usedChars, 0); assert.deepEqual(f.record().reservations, {}); assert.equal(f.squareReplyChildren.size, 0); assert.ok([...f.aiJobs.values()].filter(row => row.type === 'hourly_usage').every(row => row.usedChars === 0 && Object.keys(row.reservations).length === 0));
  }
});


test('小时与每日按实际输出同时计费，小时耗尽阻断模型并在下一整点恢复，每日计数保留', async () => {
  const { usageHour } = require('../cloudfunctions/userService/ai-usage');
  let calls = 0; const f = await setup({ optimizeAI: async () => { calls++; return '润'.repeat(150); } });
  const hour = usageHour(f.clock.now), id = usageId(f.user._id, hour);
  f.aiJobs.set(id, { type: 'hourly_usage', userId: f.user._id, day: hour, usedChars: 4950, reservations: {} });
  const result = await polish(f); assert.equal(result.success, true); assert.equal(Array.from(result.square.content).length, 50);
  assert.equal(f.record().usedChars, 50); assert.equal(f.aiJobs.get(id).usedChars, 5000);
  const value = (await get(f)).aiUsage; assert.equal(value.hourly.usedPercent, 100); assert.equal(value.hourly.resetsAt, '2026-11-20T05:00:00.000Z');
  assert.equal((await polish(f)).code, 'AI_HOURLY_QUOTA_EXHAUSTED'); assert.equal(calls, 1);
  f.clock.now += 3600000; assert.equal((await get(f)).aiUsage.hourly.usedPercent, 0);
  await polish(f); assert.equal(f.record().usedChars, 200); assert.equal((await get(f)).aiUsage.hourly.usedPercent, 3);
});

test('小时最后余额并发预留不超发，失败及过期同时释放两个周期，跨整点只结算发起周期', async () => {
  const { usageHour } = require('../cloudfunctions/userService/ai-usage');
  const f = await setup(), usage = createAIUsage(f.db, { aiNow: () => f.clock.now });
  f.clock.now = Date.parse('2026-11-20T04:59:59Z');
  const hour = usageHour(f.clock.now), id = usageId(f.user._id, hour);
  f.aiJobs.set(id, { type: 'hourly_usage', userId: f.user._id, day: hour, usedChars: 4990, reservations: {} });
  const reservations = await Promise.allSettled([usage.reserve(f.user._id), usage.reserve(f.user._id)]);
  assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 1);
  const held = reservations.find(r => r.status === 'fulfilled').value; assert.equal(held.chars, 10);
  f.clock.now += 2000; await f.db.runTransaction(tx => usage.commit(tx, held, 8));
  assert.equal(f.aiJobs.get(id).usedChars, 4998); assert.equal((await get(f)).aiUsage.hourly.usedPercent, 0); assert.equal(f.record().usedChars, 8);
  const abandoned = await usage.reserve(f.user._id); await usage.release(abandoned);
  assert.deepEqual(f.record().reservations, {});
  assert.deepEqual(f.aiJobs.get(abandoned.hourlyId).reservations, {});
  const expired = await usage.reserve(f.user._id); f.clock.now += 120001;
  await assert.rejects(f.db.runTransaction(tx => usage.commit(tx, expired, 5)), e => e.code === 'AI_USAGE_EXPIRED');
  await usage.release(expired); assert.equal(f.record().usedChars, 8); assert.deepEqual(f.aiJobs.get(expired.hourlyId).reservations, {});
});
