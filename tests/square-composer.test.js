const test = require('node:test');
const assert = require('node:assert/strict');
const { composerFixture, user } = require('./helpers/square-composer-fixture');
const input = value => ({ detail: { value } });
const option = key => ({ currentTarget: { dataset: { key } } });
const panel = name => ({ currentTarget: { dataset: { panel: name } } });

test('优化与声明按实际出现先后排序；隐藏再出现排到末尾，改字和切换声明种类不乱序', async () => {
  const f = composerFixture(); await f.attach(); const c = f.component;
  assert.deepEqual(Array.from(c.data.noticeOrder), []);
  c.onInput(input('先写正文')); c.selectDeclaration(option('ai'));
  assert.deepEqual(Array.from(c.data.noticeOrder), ['optimize', 'declaration']);
  c.onInput(input('继续写正文')); c.selectDeclaration(option('opinion'));
  assert.deepEqual(Array.from(c.data.noticeOrder), ['optimize', 'declaration']);
  c.onInput(input(''));
  assert.deepEqual(Array.from(c.data.noticeOrder), ['declaration']);
  c.onInput(input('后写正文'));
  assert.deepEqual(Array.from(c.data.noticeOrder), ['declaration', 'optimize']);
  c.selectDeclaration(option('none'));
  assert.deepEqual(Array.from(c.data.noticeOrder), ['optimize']);
  c.selectDeclaration(option('fiction'));
  assert.deepEqual(Array.from(c.data.noticeOrder), ['optimize', 'declaration']);
});

test('恢复原文入口出现及消失保留按钮顺序，切换账号重置顺序且草稿恢复不重复插入', async () => {
  const f = composerFixture({ optimize: async () => '优化正文' }); await f.attach(); const c = f.component;
  c.onInput(input('原文')); c.selectDeclaration(option('ai'));
  await c.optimizeContent();
  assert.equal(c.data.canUndoOptimization, true);
  assert.deepEqual(Array.from(c.data.noticeOrder), ['optimize', 'declaration']);
  c.undoOptimization();
  assert.equal(c.data.canUndoOptimization, false);
  assert.deepEqual(Array.from(c.data.noticeOrder), ['optimize', 'declaration']);
  f.setUser({ ...user, _id: 'bob' }); f.show();
  assert.deepEqual(Array.from(c.data.noticeOrder), []);
  c.selectDeclaration(option('opinion')); c.onInput(input('新账号正文'));
  assert.deepEqual(Array.from(c.data.noticeOrder), ['declaration', 'optimize']);
  const restored = composerFixture({ storage: new Map([['square.draft.alice', { content: '草稿正文', declaration: 'ai' }]]) });
  await restored.attach();
  assert.deepEqual(Array.from(restored.component.data.noticeOrder), ['declaration', 'optimize']);
  restored.component.setContent('草稿正文');
  assert.equal(restored.component.data.noticeOrder.length, 2);
});

test('正文优化在150字边界静默截断，含emoji空格符号，不触发上限气泡，可恢复原文且不自动保存发布', async () => {
  let finish;
  const f = composerFixture({ optimize: () => new Promise(resolve => { finish = resolve; }) }); await f.attach(); const c = f.component;
  c.onInput(input('')); assert.equal(c.data.canOptimize, false);
  c.onInput(input('字'.repeat(150))); assert.equal(c.data.limitHintVisible, true);
  const original = c.data.content, requestId = c._requestId;
  c.setData({ images: [{ key: 'keep-image', path: '/image.jpg' }], declaration: 'opinion' });
  const task = c.optimizeContent();
  assert.equal(c.data.optimizing, true); assert.equal(c.data.content, original); assert.equal(c.data.limitHintVisible, false);
  await c.optimizeContent(); assert.equal(f.requests.filter(row => row.optimize).length, 1);
  finish('😊 空格，\n'.repeat(40)); await task;
  assert.equal(c.data.optimizing, false); assert.equal(c.data.count, 150); assert.equal(c.data.remainingCount, 0);
  assert.equal(c.data.limitHintVisible, false); assert.equal(f.timers.size, 0); assert.equal(c.data.canPublish, true);
  assert.equal(c.data.images[0].key, 'keep-image'); assert.equal(c.data.declaration, 'opinion');
  assert.equal(f.storage.size, 0); assert.equal(f.calls.length, 0); assert.notEqual(c._requestId, requestId);
  assert.equal(c.data.canUndoOptimization, true);
  c.undoOptimization(); assert.equal(c.data.content, original); assert.equal(c.data.limitHintVisible, false);
  assert.equal(c.data.canUndoOptimization, false);
});

test('优化期间继续修改、退出、切换账号或卸载后，迟到结果不覆盖正文或草稿', async () => {
  for (const mode of ['edit', 'cancel', 'switch', 'detach', 'hide', 'publish', 'save']) {
    let finish;
    const f = composerFixture({ optimize: () => new Promise(resolve => { finish = resolve; }) }); await f.attach(); const c = f.component;
    c.onInput(input('原始正文')); const task = c.optimizeContent();
    if (mode === 'edit') { c.onInput(input('最新编辑')); c.onInput(input('原始正文')); }
    if (mode === 'cancel') c.cancel();
    if (mode === 'switch') { f.setUser({ ...user, _id: 'bob' }); f.show(); }
    if (mode === 'detach') f.detach();
    if (mode === 'hide') f.hide();
    if (mode === 'publish') await c.publish();
    if (mode === 'save') await c.saveAndClose();
    finish('不应覆盖的旧结果'); await task;
    assert.notEqual(c.data.content, '不应覆盖的旧结果', mode);
    assert.equal(c.data.limitHintVisible, false);
    if (mode === 'save') assert.equal(f.storage.get('square.draft.alice').content, '原始正文');
    if (mode === 'publish') assert.equal(f.calls[0].content, '原始正文');
  }
});

test('优化失败保留原文和已保存草稿；恢复后继续编辑使旧的撤销入口失效', async () => {
  let failed = true;
  const storage = new Map([['square.draft.alice', { content: '已保存原文', requestId: 'old-draft-id' }]]);
  const f = composerFixture({ storage, optimize: async () => { if (failed) throw new Error('优化连接失败'); return '优化结果'; } }); await f.attach(); const c = f.component;
  await c.optimizeContent(); assert.equal(c.data.content, '已保存原文'); assert.equal(c.data.optimizeError, '优化连接失败');
  assert.equal(c.data.optimizing, false); assert.equal(c._requestId, 'old-draft-id');
  failed = false; await c.optimizeContent();
  assert.equal(c.data.content, '优化结果'); assert.equal(storage.get('square.draft.alice').content, '已保存原文');
  c.onInput(input('优化后又编辑')); assert.equal(c.data.canUndoOptimization, false);
  c.undoOptimization(); assert.equal(c.data.content, '优化后又编辑');
});

test('150字包含空格标点，剩余20字进入圆环警示，删除恢复，旧超长草稿保留但不能发布', async () => {
  const storage = new Map([['square.draft.alice', { content: '字'.repeat(50), requestId: 'ring-draft' }]]);
  const f = composerFixture({ storage }); await f.attach(); const c = f.component;
  assert.equal(c.data.countProgress, 120); assert.equal(c.data.remainingCount, 100); assert.equal(c.data.countWarning, false);
  c.onInput(input('你 好，！')); assert.equal(c.data.count, 5); assert.equal(c.data.remainingCount, 145);
  c.onInput(input('😊'.repeat(75))); assert.equal(c.data.count, 75); assert.equal(c.data.countProgress, 180);
  c.onInput(input('字'.repeat(129))); assert.equal(c.data.remainingCount, 21); assert.equal(c.data.countWarning, false);
  c.onInput(input('字'.repeat(130))); assert.equal(c.data.remainingCount, 20); assert.equal(c.data.countWarning, true);
  c.onInput(input('字'.repeat(150))); assert.equal(c.data.remainingCount, 0); assert.equal(c.data.countProgress, 360); assert.equal(c.data.canPublish, true);
  c.onInput(input('字'.repeat(151))); assert.equal(c.data.remainingCount, 0); assert.equal(c.data.countProgress, 360); assert.equal(c.data.count, 150); assert.equal(c.data.canPublish, true);
  c.onInput(input('')); assert.equal(c.data.countProgress, 0); assert.equal(c.data.canPublish, false); assert.equal(c.data.remainingCount, 150); assert.equal(c.data.countWarning, false);
  assert.equal(f.calls.length, 0);
  const legacy = composerFixture({ storage: new Map([['square.draft.alice', { content: '旧'.repeat(250) }]]) }); await legacy.attach();
  assert.equal(legacy.component.data.content.length, 250); assert.equal(legacy.component.data.canPublish, false);
  assert.equal(legacy.component.data.remainingCount, 0);
  await legacy.component.publish(); assert.equal(legacy.calls.length, 0);
});

test('输入或粘贴最多录入150个字符并返回原生输入修正值，圆环气泡自动消失且删除后可继续输入', async () => {
  const f = composerFixture(); await f.attach(); const c = f.component;
  const prefix = '你 好，！😊'.repeat(25);
  assert.equal(Array.from(prefix).length, 150);
  assert.equal(c.onInput(input(prefix + '超出部分')), prefix);
  assert.equal(c.data.content, prefix); assert.equal(c.data.count, 150); assert.equal(c.data.remainingCount, 0);
  assert.equal(c.data.limitHintVisible, true); assert.equal(f.storage.size, 0);
  assert.deepEqual([...f.delays.values()], [2500]);
  const id = c._requestId;
  assert.equal(c.onInput(input(prefix + '再输入')), prefix); assert.equal(c._requestId, id);
  assert.equal(f.timers.size, 1);
  f.flushClose(); assert.equal(c.data.limitHintVisible, false); assert.equal(c.data.content, prefix);
  c.onInput(input('字'.repeat(149))); assert.equal(c.data.limitHintVisible, false);
  assert.equal(c.data.remainingCount, 1); c.onInput(input('字'.repeat(150)));
  assert.equal(c.data.limitHintVisible, true);
  f.hide(); assert.equal(c.data.limitHintVisible, false); assert.equal(f.timers.size, 0);
  f.show(); c.onInput(input('字'.repeat(151))); f.detach(); assert.equal(f.timers.size, 0);
});

test('面板首帧复用真实头像昵称与草稿，不请求登录；关闭动画结束后才通知来源页', async () => {
  const storage = new Map([['square.draft.alice', { content: '已存正文', requestId: 'draft-original' }]]);
  const f = composerFixture({ storage }); const opening = f.attach();
  assert.equal(f.component.data.user.nickname, user.nickname);
  assert.equal(f.component.data.user.avatarFileID, user.avatarFileID);
  assert.equal(f.component.data.content, '已存正文'); assert.equal(f.requests.length, 0);
  await opening; f.component.saveAndClose();
  assert.equal(f.storage.get('square.draft.alice').requestId, 'draft-original');
  assert.equal(f.component.data.closing, true); assert.equal(f.events.length, 0);
  assert.equal(f.toasts.at(-1), '已保存为草稿');
  f.component.saveAndClose(); assert.equal(f.timers.size, 1);
  f.flushClose(); assert.equal(f.events[0].name, 'close'); assert.equal(f.events[0].detail.published, false);
});

test('键盘抬升仅缩短面板底部，顶部安全留白稳定，关闭后迟到的键盘事件不抖动', async () => {
  const f = composerFixture(); await f.attach(); const c = f.component;
  assert.equal(c.data.sheetTop, 102); assert.equal(c.data.viewportHeight, 812);
  c.focusEditor(); c.keyboard({ detail: { height: 340 } });
  assert.equal(c.data.editorFocused, true); assert.equal(c.data.viewportHeight - c.data.sheetTop - c.data.keyboardHeight, 370);
  c.onInput(input('保留内容')); c.openPanel(panel('options'));
  assert.equal(c.data.keyboardHeight, 0); assert.equal(c.data.editorFocused, false);
  c.closePanel(); assert.equal(c.data.content, '保留内容'); assert.equal(c.data.sheetTop, 102);
  c.cancel(); c.keyboard({ detail: { height: 340 } }); assert.equal(c.data.keyboardHeight, 0); assert.equal(c.data.closing, false);
  c.continueEditing(); c.keyboard({ detail: { height: 340 } }); assert.equal(c.data.keyboardHeight, 340);
});

test('Android 输入时窗口缩小与键盘事件先后顺序不同，也不重复扣除键盘高度', async () => {
  for (const resizeFirst of [true, false]) {
    const window = { windowHeight: 812, windowWidth: 375, statusBarHeight: 44 };
    const f = composerFixture({ window }); await f.attach(); const c = f.component;
    c.focusEditor(); window.windowHeight = 472;
    if (!resizeFirst) c.keyboard({ detail: { height: 340 } });
    c.measure();
    if (resizeFirst) c.keyboard({ detail: { height: 340 } });
    assert.equal(c.data.viewportHeight, 812);
    assert.equal(c.data.viewportHeight - c.data.sheetTop - c.data.keyboardHeight, 370);
  }
});

test('动态设置的回复与查看范围独立选择且不传给云端，内容声明随真实发布提交', async () => {
  const f = composerFixture(); await f.attach(); const c = f.component;
  c.onInput(input('普通用户发布'));
  c.openPanel(panel('options')); c.selectAudience(option('friends')); c.selectViewAudience(option('followers'));
  assert.deepEqual(Array.from(c.data.audiences, item => item.label), ['任何人', '我的萃友', '我的粉丝', '我的关注']);
  assert.equal(c.data.replyAudience, 'friends'); assert.equal(c.data.viewAudience, 'followers');
  c.selectViewAudience(option('invalid')); assert.equal(c.data.viewAudience, 'followers');
  await c.publish(); assert.equal(f.calls.length, 0);
  c.closePanel(); c.openPanel(panel('declaration')); c.selectDeclaration(option('ai')); c.closePanel();
  assert.equal(c.data.declaration, 'ai'); assert.equal(f.calls.length, 0);
  await c.publish();
  assert.deepEqual(Object.keys(f.calls[0]).sort(), ['content', 'declaration', 'id']); assert.equal(f.calls[0].content, '普通用户发布'); assert.equal(f.calls[0].declaration, 'ai');
  assert.equal(f.events.length, 0); f.flushClose(); assert.equal(f.events[0].detail.published, true);
});

test('内容声明随文字和图片草稿恢复，修改声明会提示未保存并使用新的提交标识', async () => {
  const fileID = 'cloud://test.bucket/square-uploads/alice/one.jpg';
  const storage = new Map([['square.draft.alice', { content: '已有正文', declaration: 'opinion', requestId: 'saved-declaration-001', images: [{ key: 'one', fileID, type: 'jpg' }] }]]);
  const f = composerFixture({ storage }); await f.attach(); const c = f.component;
  assert.equal(c.data.declaration, 'opinion');
  c.selectDeclaration(option('ai')); assert.notEqual(c._requestId, 'saved-declaration-001');
  c.cancel(); assert.equal(c.data.exitConfirmVisible, true); await c.saveAndClose();
  assert.equal(storage.get('square.draft.alice').declaration, 'ai');
  const reopened = composerFixture({ storage }); await reopened.attach();
  assert.equal(reopened.component.data.declaration, 'ai'); assert.equal(reopened.component.data.images.length, 1);
  await reopened.component.publish(); assert.equal(reopened.calls[0].declaration, 'ai');
  assert.equal(reopened.calls[0].content, '已有正文'); assert.equal(reopened.calls[0].images[0], fileID);
  const legacy = composerFixture({ storage: new Map([['square.draft.alice', { content: '旧草稿' }]]) }); await legacy.attach();
  assert.equal(legacy.component.data.declaration, 'none');
  legacy.component.selectDeclaration(option('invalid')); assert.equal(legacy.component.data.declaration, 'none');
});

test('存储失败不提示草稿成功、不收起面板，空草稿不会假装保存成功', async () => {
  const f = composerFixture({ failStorage: true }); await f.attach();
  f.component.onInput(input('不能丢失的文字')); f.component.saveAndClose();
  assert.equal(f.component.data.error, '草稿保存失败，请稍后重试'); assert.equal(f.component.data.closing, false);
  assert.equal(f.toasts.length, 0); assert.equal(f.timers.size, 0);
  f.component.cancel(); assert.equal(f.component.data.closing, false);
  const empty = composerFixture(); await empty.attach(); empty.component.saveAndClose();
  assert.equal(empty.toasts.at(-1), '请先写点内容或选择图片'); assert.equal(empty.component.data.closing, false);
});

test('后台恢复不覆盖输入也不自动保存，新账号不继承未保存内容，迟到发布不关闭新账号', async () => {
  let finish;
  const f = composerFixture({ publish: () => new Promise(resolve => { finish = resolve; }) }); await f.attach();
  const c = f.component;
  c.onInput(input('账号甲的草稿')); c.selectAudience(option('followers')); c.selectViewAudience(option('friends'));
  f.hide(); f.show(); assert.equal(c.data.content, '账号甲的草稿');
  const pending = c.publish();
  f.setUser({ ...user, _id: 'bob', nickname: '账号乙' }); f.show();
  assert.equal(c.data.user._id, 'bob'); assert.equal(c.data.content, ''); assert.equal(c.data.replyAudience, 'anyone'); assert.equal(c.data.viewAudience, 'anyone');
  finish({}); await pending; assert.equal(c.data.closing, false); assert.equal(f.toasts.length, 0);
  assert.equal(f.storage.has('square.draft.alice'), false); assert.equal(f.timers.size, 0);
});

test('组件卸载后取消关闭定时器和迟到请求，不自动保存未确认内容', async () => {
  let finish;
  const f = composerFixture({ publish: () => new Promise(resolve => { finish = resolve; }) }); await f.attach();
  f.component.onInput(input('后台发送')); const pending = f.component.publish(); f.detach();
  finish({}); await pending; assert.equal(f.events.length, 0); assert.equal(f.toasts.length, 0);
  assert.equal(f.storage.size, 0);
  const closing = composerFixture(); await closing.attach(); closing.component.cancel(); closing.detach(); closing.flushClose();
  assert.equal(closing.events.length, 0);
});

test('未保存内容取消弹出三选项，阻止编辑和发布，继续编辑后原文仍在且不自动保存', async () => {
  const f = composerFixture(); await f.attach(); const c = f.component;
  c.onInput(input('未保存内容')); c.cancel();
  assert.equal(c.data.exitConfirmVisible, true); assert.equal(c.data.closing, false);
  assert.equal(f.events.length, 0); assert.equal(f.storage.size, 0);
  assert.equal(f.timers.size, 0);
  c.onInput(input('迟到输入')); await c.publish(); c.focusEditor();
  assert.equal(c.data.editorFocused, false); assert.equal(f.calls.length, 0);
  assert.equal(f.events.length, 0); assert.equal(c.data.content, '未保存内容');
  c.continueEditing(); assert.equal(c.data.exitConfirmVisible, false); assert.equal(c.data.editorFocused, true);
  c.onInput(input('继续编辑')); assert.equal(c.data.content, '继续编辑');
});

test('反复取消不重复创建弹窗，选择保存为草稿后保存并关闭', async () => {
  const f = composerFixture(); await f.attach(); const c = f.component;
  c.onInput(input('需要保存')); c.cancel(); c.cancel();
  assert.equal(f.timers.size, 0); assert.equal(c.data.closing, false);
  c.saveAndClose(); assert.equal(c.data.exitConfirmVisible, false);
  assert.equal(f.storage.get('square.draft.alice').content, '需要保存');
  assert.deepEqual([...f.delays.values()], [260]); f.flushClose(); assert.equal(f.events.length, 1);
});

test('清空内容后取消同时删除本账号草稿，关闭与卸载后再打开仍为空', async () => {
  const original = { content: '之前明确保存的版本', requestId: 'saved-before' };
  const storage = new Map([['square.draft.alice', original]]);
  const f = composerFixture({ storage }); await f.attach(); const c = f.component;
  c.onInput(input('未保存的新版本')); c.cancel(); assert.equal(c.data.exitConfirmVisible, true);
  c.continueEditing(); c.onInput(input('')); c.cancel(); assert.equal(c.data.closing, true); assert.equal(c.data.exitConfirmVisible, false);
  f.flushClose(); f.detach(); assert.equal(storage.has('square.draft.alice'), false);
  const reopened = composerFixture({ storage }); await reopened.attach();
  assert.equal(reopened.component.data.content, '');
  reopened.component.cancel(); assert.equal(reopened.component.data.closing, true);
  const empty = composerFixture(); await empty.attach(); empty.component.cancel();
  assert.equal(empty.component.data.closing, true);
});

test('未修改的已存草稿可以保留，清空退出不会删除其他账号的草稿', async () => {
  const alice = { content: '甲的草稿', requestId: 'alice-draft' };
  const bob = { content: '乙的草稿', requestId: 'bob-draft' };
  const storage = new Map([['square.draft.alice', alice], ['square.draft.bob', bob]]);
  const saved = composerFixture({ storage }); await saved.attach(); saved.component.cancel(); saved.flushClose(); saved.detach();
  assert.equal(storage.get('square.draft.alice'), alice);
  const f = composerFixture({ storage }); await f.attach(); f.component.onInput(input('')); f.component.cancel();
  f.flushClose(); f.detach(); assert.equal(storage.has('square.draft.alice'), false);
  assert.equal(storage.get('square.draft.bob'), bob);
  const switched = composerFixture({ storage: new Map([['square.draft.alice', alice], ['square.draft.bob', bob]]) }); await switched.attach();
  switched.component.onInput(input('')); switched.setUser({ ...user, _id: 'bob' }); switched.component.cancel();
  assert.equal(switched.storage.get('square.draft.bob'), bob);
  assert.equal(switched.storage.get('square.draft.alice'), alice);
});

test('清除草稿失败时保留发布面板并提示错误，不能假装已经清空退出', async () => {
  const storage = new Map([['square.draft.alice', { content: '旧内容', requestId: 'old-draft' }]]);
  const f = composerFixture({ storage, failRemoveStorage: true }); await f.attach();
  f.component.onInput(input('')); f.component.cancel();
  assert.equal(f.component.data.closing, false);
  assert.equal(f.component.data.error, '草稿清除失败，请稍后重试');
  assert.equal(f.events.length, 0); assert.equal(f.timers.size, 0);
});

test('退出确认卸载后不能继续编辑、保存或触发退出通知', async () => {
  const f = composerFixture(); await f.attach(); f.component.onInput(input('仍在编辑')); f.component.cancel();
  assert.equal(f.timers.size, 0); f.detach(); const c = f.component;
  c.continueEditing(); c.discardAndClose(); await c.saveAndClose(); f.flushClose();
  assert.equal(f.events.length, 0); assert.equal(f.storage.size, 0);
});

test('选择不保存删除当前文字和图片草稿，重新打开为空，其他账号草稿保留', async () => {
  const fileID = 'cloud://test.bucket/square-uploads/alice/one.jpg';
  const storage = new Map([
    ['square.draft.alice', { content: '已存版本', images: [{ key: 'one', fileID, type: 'jpg' }] }],
    ['square.draft.bob', { content: '乙的草稿' }],
  ]);
  const f = composerFixture({ storage }); await f.attach(); const c = f.component;
  c.onInput(input('未保存的新版本')); c.cancel(); c.discardAndClose();
  assert.equal(storage.has('square.draft.alice'), false); assert.equal(storage.get('square.draft.bob').content, '乙的草稿');
  assert.equal(c.data.content, ''); assert.equal(c.data.images.length, 0); assert.equal(c.data.closing, true);
  await Promise.resolve();
  assert.deepEqual(Array.from(f.requests.find(value => value.discard).discard), [fileID]);
  f.flushClose(); assert.equal(f.events.filter(event => event.name === 'close').length, 1);
  const reopened = composerFixture({ storage }); await reopened.attach();
  assert.equal(reopened.component.data.content, ''); assert.equal(reopened.component.data.images.length, 0);
});

test('弹窗保存或丢弃失败保留内容并可继续编辑，不能假装退出成功', async () => {
  for (const failure of ['save', 'discard']) {
    const f = composerFixture({ failStorage: failure === 'save', failRemoveStorage: failure === 'discard' }); await f.attach();
    const c = f.component; c.onInput(input('保留的正文')); c.cancel();
    if (failure === 'save') await c.saveAndClose(); else c.discardAndClose();
    assert.equal(c.data.exitConfirmVisible, true); assert.equal(c.data.closing, false);
    assert.equal(c.data.content, '保留的正文'); assert.ok(c.data.error); assert.equal(f.toasts.length, 0);
    c.continueEditing(); assert.equal(c.data.exitConfirmVisible, false); assert.equal(c.data.content, '保留的正文');
  }
});

test('弹窗保存图片期间不能丢弃或重复保存，切换账号后不保存旧账号内容或关闭新面板', async () => {
  let finish;
  const f = composerFixture({ uploadImages: () => new Promise(resolve => { finish = resolve; }) }); await f.attach();
  const c = f.component;
  c.setData({ images: [{ key: 'one', path: '/tmp/one.jpg', fileID: '', type: 'jpg' }] });
  c.onInput(input('甲的图文')); c.cancel(); const saving = c.saveAndClose();
  c.discardAndClose(); c.continueEditing(); await c.saveAndClose();
  assert.equal(c.data.exitConfirmVisible, true); assert.equal(c.data.content, '甲的图文'); assert.equal(c.data.closing, false);
  f.setUser({ ...user, _id: 'bob' }); f.show();
  finish([]); await saving;
  assert.equal(c.data.exitConfirmVisible, false); assert.equal(c.data.content, ''); assert.equal(c.data.user._id, 'bob');
  assert.equal(f.storage.size, 0); assert.equal(c.data.closing, false); assert.equal(f.toasts.length, 0);
});

test('同一账号登录失效后重新登录，保留当前未保存正文且不覆盖已有草稿', async () => {
  const original = { content: '已存版本', requestId: 'saved-before-login' };
  const storage = new Map([['square.draft.alice', original]]);
  const f = composerFixture({ storage }); await f.attach();
  f.component.onInput(input('重新登录也不能丢失的编辑内容'));
  f.setUser(null); f.component.requestLogin(); await f.component.login();
  assert.equal(f.component.data.content, '重新登录也不能丢失的编辑内容');
  assert.equal(storage.get('square.draft.alice'), original);
  f.component.cancel(); assert.equal(f.component.data.exitConfirmVisible, true);
});

test('游客入口按需提示登录，未认证账号登录后可输入，附件与预览均不调用业务接口', async () => {
  const f = composerFixture({ guest: true }); await f.attach();
  assert.equal(f.component.data.loginSheetOpen, true); assert.equal(f.component.data.user, null);
  await f.component.login(); assert.equal(f.component.data.user.certificationStatus, 'unverified');
  f.component.onInput(input('无需学校认证的内容')); assert.equal(f.component.data.canPublish, true);
  assert.equal(f.calls.length, 0); assert.equal(f.component.data.loginSheetOpen, false);
});

test('账号已变更时点击发布，只切换到新账号草稿，不把旧账号正文带入新账号', async () => {
  const storage = new Map([['square.draft.bob', { content: '乙的草稿', requestId: 'bob-draft' }]]);
  const f = composerFixture({ storage }); await f.attach();
  f.component.onInput(input('甲的正文'));
  f.setUser({ ...user, _id: 'bob' }); await f.component.publish();
  assert.equal(f.calls.length, 0); assert.equal(f.component.data.user._id, 'bob');
  assert.equal(f.component.data.content, '乙的草稿'); assert.equal(f.component.data.loginSheetOpen, false);
});

const chosenImage = key => ({ key, path: `/tmp/${key}.jpg`, fileID: '', type: 'jpg' });
test('图片可以独立发布、限制九张；取消原生选图不丢文字，移除最后一图恢复不可发布', async () => {
  const remaining = [];
  const f = composerFixture({ chooseImages: async count => { remaining.push(count); return Array.from({ length: count }, (_, i) => chosenImage('image' + i)); } });
  await f.attach(); await f.component.choosePostImages();
  assert.equal(f.component.data.images.length, 9); assert.equal(f.component.data.canPublish, true); assert.equal(remaining[0], 9);
  await f.component.choosePostImages(); assert.equal(remaining.length, 1);
  await f.component.publish(); assert.equal(f.calls[0].content, ''); assert.equal(f.calls[0].images.length, 9);
  assert.equal(f.component.data.closing, true); assert.equal(f.storage.size, 0);
  const empty = composerFixture({ chooseImages: async () => [chosenImage('one')] }); await empty.attach(); await empty.component.choosePostImages();
  empty.component.removeImage({ currentTarget: { dataset: { index: 0 } } }); assert.equal(empty.component.data.canPublish, false);
  const cancelled = composerFixture({ chooseImages: async () => { throw { errMsg: 'chooseMedia:fail cancel' }; } });
  await cancelled.attach(); cancelled.component.onInput(input('保留')); await cancelled.component.choosePostImages();
  assert.equal(cancelled.component.data.content, '保留'); assert.equal(cancelled.component.data.error, '');
});

test('图片草稿只在明确保存后持久化云文件，重新打开可恢复；清空图片取消后不再出现', async () => {
  const f = composerFixture({ chooseImages: async () => [chosenImage('one')] }); await f.attach(); await f.component.choosePostImages();
  assert.equal(f.storage.size, 0); f.component.cancel(); assert.equal(f.component.data.exitConfirmVisible, true);
  await f.component.saveAndClose();
  const draft = f.storage.get('square.draft.alice'); assert.equal(draft.images.length, 1);
  assert.match(draft.images[0].fileID, /square-uploads\/alice\/one.jpg$/); assert.equal(draft.images[0].path, undefined);
  const reopened = composerFixture({ storage: f.storage }); await reopened.attach();
  assert.equal(reopened.component.data.images[0].fileID, draft.images[0].fileID); assert.equal(reopened.component.data.canPublish, true);
  reopened.component.removeImage({ currentTarget: { dataset: { index: 0 } } }); reopened.component.cancel();
  assert.equal(f.storage.size, 0);
  const cleared = composerFixture({ storage: f.storage }); await cleared.attach(); assert.equal(cleared.component.data.images.length, 0);
});

test('图片上传失败保留文字及完成的上传，重试沿用提交标识；账号切换不恢复旧图', async () => {
  let first = true;
  const f = composerFixture({ chooseImages: async () => [chosenImage('one'), chosenImage('two')], uploadImages: async (images, uploaded) => {
    uploaded(0, 'cloud://test.bucket/square-uploads/alice/one.jpg');
    if (first) { first = false; throw new Error('图片上传失败'); }
    assert.match(images[0].fileID, /one.jpg$/);
    return [images[0].fileID, 'cloud://test.bucket/square-uploads/alice/two.jpg'];
  } });
  await f.attach(); f.component.onInput(input('保留图文')); await f.component.choosePostImages();
  await f.component.publish(); const id = f.component._requestId;
  assert.equal(f.calls.length, 0); assert.equal(f.component.data.content, '保留图文'); assert.equal(f.component.data.images.length, 2);
  assert.equal(f.component.data.closing, false); await f.component.publish(); assert.equal(f.calls[0].id, id);
  const changed = composerFixture({ storage: f.storage }); await changed.attach();
  changed.component.setData({ images: [chosenImage('private')] }); changed.setUser({ ...user, _id: 'bob' }); changed.show();
  assert.equal(changed.component.data.images.length, 0);
});

test('选图成功、取消及大图预览返回都请求恢复来源页导航状态，卸载后的回调不干扰新页面', async () => {
  for (const cancel of [false, true]) {
    const f = composerFixture({ chooseImages: async () => { if (cancel) throw { errMsg: 'chooseMedia:fail cancel' }; return [chosenImage('one')]; } });
    await f.attach(); await f.component.choosePostImages();
    assert.equal(f.events.filter(event => event.name === 'resumenavigation').length, 1);
    assert.equal(f.component.data.choosingImages, false);
    assert.equal(f.component.data.closing, false);
    if (!cancel) {
      await f.component.previewSelectedImage({ currentTarget: { dataset: { index: 0 } } });
      assert.equal(f.events.filter(event => event.name === 'resumenavigation').length, 2);
    }
  }
  let finish;
  const gone = composerFixture({ chooseImages: () => new Promise(resolve => { finish = resolve; }) });
  await gone.attach(); const pending = gone.component.choosePostImages(); gone.detach(); finish([chosenImage('late')]); await pending;
  assert.equal(gone.events.length, 0);
});
