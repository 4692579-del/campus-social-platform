const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/certification-fixture');
const optimize = (f, content, identity = f.alice) => f.handle({ action: 'optimizeSquareContent', content, userId: 'forged' }, identity);

test('发布仅图片写文案及图文润色使用本人上传，审核实际输出、共用双周期额度，不保存未发布正文', async () => {
  const checks = [], generated = [], resolved = [];
  const urls = ['https://test.bucket.tcb.qcloud.la/one.jpg?sign=synthetic'];
  const f = fixture({ resolveComposeImages: async (files, user, identity) => { resolved.push({ files, user, identity }); return urls; },
    optimizeAI: async (context, attachments) => { generated.push({ context, attachments }); return '绿树下的一点好心情。'; },
    checkText: async text => { checks.push(text); return true; } });
  const user = await f.login(), images = [`cloud://test.bucket/square-uploads/${user._id}/photo.jpg`];
  for (const content of ['', '今天拍了照片']) {
    const result = await f.handle({ action: 'optimizeSquareContent', content, images, userId: 'forged' }, f.alice);
    assert.equal(result.success, true, result.message); assert.equal(result.square.content, '绿树下的一点好心情。');
    assert.deepEqual(generated.at(-1), { context: { content, hasImages: true, imageCount: 1 }, attachments: { images: urls } });
  }
  assert.equal(resolved[0].user._id, user._id); assert.deepEqual(resolved[0].files, images);
  assert.deepEqual(checks, ['绿树下的一点好心情。', '今天拍了照片', '绿树下的一点好心情。']);
  for (const type of ['daily_usage', 'hourly_usage']) {
    const usage = [...f.aiJobs.values()].find(row => row.type === type);
    assert.equal(usage.usedChars, 2 * Array.from('绿树下的一点好心情。').length);
  }
  assert.equal(f.squarePosts.size, 0);
  assert.ok(!/绿树|https|photo.jpg|sign=/.test(JSON.stringify([...f.aiJobs.values()])));
});

test('图文失败不降级纯文字，失败释放双周期额度，图片错误仅返回安全提示', async () => {
  for (const mode of ['missing', 'reject', 'output', 'banned']) {
    let model = 0; let f;
    f = fixture({ resolveComposeImages: mode === 'missing' ? undefined : async () => {
      if (mode === 'reject') throw new Error('private-signature');
      if (mode === 'banned') [...f.users.values()][0].status = 'banned';
      return ['https://test.bucket.tcb.qcloud.la/photo.jpg'];
    }, optimizeAI: async () => { model++; return '待审核的结果'; }, checkText: async value => mode !== 'output' || value !== '待审核的结果' });
    const user = await f.login();
    const result = await f.handle({ action: 'optimizeSquareContent', content: '', images: [`cloud://test.bucket/square-uploads/${user._id}/photo.jpg`] }, f.alice);
    assert.equal(result.success, false); assert.ok(!result.message.includes('private'));
    assert.equal(result.code, mode === 'output' ? 'CONTENT_REJECTED' : mode === 'banned' ? 'ACCOUNT_DISABLED' : 'AI_IMAGES_UNAVAILABLE');
    assert.equal(model, mode === 'output' ? 1 : 0);
    for (const row of f.aiJobs.values()) if (['daily_usage', 'hourly_usage'].includes(row.type)) assert.equal(row.usedChars, 0);
    assert.equal(f.squarePosts.size, 0);
  }
});

test('图文接口不接受外链、认证材料、跨账号或跨环境上传，模型和解析器均不调用', async () => {
  const f = fixture({ optimizeAI: () => assert.fail('不能调用模型'), resolveComposeImages: () => assert.fail('不能解析未授权图片') });
  const user = await f.login();
  const owned = `cloud://test.bucket/square-uploads/${user._id}/photo.jpg`;
  for (const images of [[owned.replace(user._id, 'another')], [owned.replace('test.bucket', 'foreign.bucket')],
    [owned.replace('square-uploads', 'certification-proofs')], ['https://example.com/photo.jpg'], [owned, owned]]) {
    const result = await f.handle({ action: 'optimizeSquareContent', content: '', images }, f.alice);
    assert.equal(result.code, 'INVALID_IMAGES');
  }
});

test('微信45009返回额度提示，原文检查已受限时不继续调用DeepSeek', async () => {
  let calls = 0, checks = 0;
  const f = fixture({ optimizeAI: async () => { calls++; return '优化结果'; }, checkText: async () => {
    checks++; throw Object.assign(new Error('private details'), { errCode: -604100, errMsg: 'system error: error code: 45009' });
  } });
  await f.login(); const result = await optimize(f, '待优化原文');
  assert.equal(result.success, false); assert.equal(result.code, 'CONTENT_CHECK_UNAVAILABLE');
  assert.match(result.message, /微信文字检查调用受限（45009）/);
  assert.equal(calls, 0); assert.equal(checks, 1); assert.equal(f.aiJobs.size, 0);
  assert.equal(f.squarePosts.size, 0); assert.ok(!result.message.includes('private'));
});

test('内容检查异常区分原文与优化结果，返回安全错误码，权限问题给出明确提示且不泄露错误全文', async () => {
  for (const stage of ['original', 'optimized', 'permission']) {
    let calls = 0;
    const f = fixture({ optimizeAI: async () => { calls++; return '润色结果'; }, checkText: async text => {
      if (stage !== 'optimized' || text === '润色结果') throw Object.assign(new Error('private source and credential'),
        { errCode: stage === 'permission' ? -604101 : -1, errMsg: stage === 'permission' ? 'system error: error code: -604101 private' : 'private details' });
      return true;
    } });
    await f.login(); const result = await optimize(f, '原文');
    assert.equal(result.success, false); assert.equal(result.code, 'CONTENT_CHECK_UNAVAILABLE');
    assert.ok(!result.message.includes('private')); assert.ok(result.message.includes('原文'));
    assert.equal(calls, stage === 'optimized' ? 1 : 0);
    assert.match(result.message, stage === 'permission' ? /权限未生效（-604101）/ : stage === 'optimized' ? /优化结果检查暂不可用（-1）/ : /原文检查暂不可用（-1）/);
    assert.equal(f.squarePosts.size, 0);
  }
});

test('润色按码点硬限制150字符，包含emoji空格换行标点，检查最终结果且不保存或发布正文', async () => {
  const checks = [], generated = [];
  const raw = '😊 空格，\n'.repeat(40), expected = Array.from(raw.trim()).slice(0, 150).join('').trim();
  const f = fixture({ optimizeAI: async context => { generated.push(context); return raw; }, checkText: async (text, openid) => { checks.push({ text, openid }); return true; } });
  await f.login();
  const result = await optimize(f, '今天去公园，好开心！');
  assert.equal(result.success, true, result.message); assert.equal(result.square.content, expected);
  assert.ok(Array.from(result.square.content).length <= 150);
  assert.deepEqual(generated, [{ content: '今天去公园，好开心！' }]);
  assert.deepEqual(checks.map(item => item.text), ['今天去公园，好开心！', expected]);
  assert.ok(checks.every(item => item.openid === 'alice'));
  assert.equal(f.squarePosts.size, 0); assert.equal(f.squareReplies.size, 0);
  assert.equal([...f.aiJobs.values()].filter(row => row.type === 'daily_usage').length, 1);
  assert.equal([...f.aiJobs.values()].find(row => row.type === 'daily_usage').usedChars, Array.from(expected).length);
  assert.ok(!JSON.stringify([...f.aiJobs.values()]).includes('公园'));
});

test('仅真实登录且正常的账号可优化，空文本及超150字不调用模型，普通未认证账号可使用', async () => {
  let calls = 0;
  const f = fixture({ optimizeAI: async () => { calls++; return '润色'; } });
  assert.equal((await optimize(f, '文字')).code, 'NOT_REGISTERED');
  const user = await f.login();
  for (const text of ['', ' \n ', '😊'.repeat(151), '字'.repeat(149) + '  ']) {
    assert.equal((await optimize(f, text)).code, 'INVALID_POST');
  }
  assert.equal(calls, 0);
  assert.equal((await optimize(f, '😊'.repeat(150))).success, true);
  f.users.get(user._id).status = 'banned';
  assert.equal((await optimize(f, '文字')).code, 'ACCOUNT_DISABLED');
  assert.equal(calls, 1);
});

test('润色失败、空结果和检查拒绝不伪造结果或发布，密钥和原始错误不泄露', async () => {
  for (const mode of ['network', 'empty', 'input', 'output']) {
    let generated = 0;
    const f = fixture({ optimizeAI: async () => { generated++; if (mode === 'network') throw Object.assign(new Error('secret-key'), { code: 'AI_NETWORK' }); return mode === 'empty' ? '  \n ' : '优化后的正文'; },
      checkText: async text => mode !== 'input' && !(mode === 'output' && text === '优化后的正文') });
    await f.login(); const result = await optimize(f, '原文');
    assert.equal(result.success, false); assert.ok(!result.message.includes('secret-key'));
    assert.equal(generated, mode === 'input' ? 0 : 1); assert.equal(f.squarePosts.size, 0);
    assert.equal(result.square, undefined);
  }
});

test('润色同一时刻超过20次仍可使用，旧次数配额不限制请求', async () => {
  const now = Date.parse('2026-11-20T00:00:00Z'); let calls = 0;
  const f = fixture({ aiNow: () => now, optimizeAI: async () => { calls++; return '优化结果'; } });
  const user = await f.login(); await f.login(f.bob);
  const key = 'polish_quota_' + require('node:crypto').createHash('sha256').update(user._id + '2026-11-20').digest('hex');
  const legacy = { type: 'polish_quota', count: 999, lastAt: now };
  f.aiJobs.set(key, { ...legacy });
  const results = await Promise.all([optimize(f, '正文'), optimize(f, '正文')]);
  assert.equal(results.filter(row => row.success).length, 2); assert.equal(calls, 2);
  assert.equal((await optimize(f, '正文', f.bob)).success, true);
  for (let i = 0; i < 25; i++) assert.equal((await optimize(f, '正文')).success, true);
  assert.equal(calls, 28); assert.deepEqual(f.aiJobs.get(key), legacy);
  assert.equal([...f.aiJobs.values()].filter(row => row.type === 'polish_quota').length, 1);
  assert.equal([...f.aiJobs.values()].filter(row => row.type === 'daily_usage').length, 2);
  assert.equal(f.squarePosts.size, 0);
});
