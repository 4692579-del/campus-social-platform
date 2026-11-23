const test = require('node:test');
const assert = require('node:assert/strict');
const { composerFixture, user } = require('./helpers/square-composer-fixture');
const input = value => ({ detail: { value } });
const option = key => ({ currentTarget: { dataset: { key } } });
const panel = name => ({ currentTarget: { dataset: { panel: name } } });
const quote = { _id: 'p_' + 'b'.repeat(40), content: '原动态正文不会放进我的输入框', images: ['cloud://test.bucket/square-media/bob/source/image.jpg'], author: { nickname: '原作者' } };
test('发布表情保留原生选区并插入标准字符，允许连续点选且提交原字符', async () => {
  const f = composerFixture({ getSelectedTextRange: ({ success }) => success({ start: 1, end: 3 }) });
  await f.attach(); const c = f.component;
  c.onInput({ detail: { value: '左😀右', cursor: 4 } });
  c.editorDidFocus(); c.toggleEmoji();
  const emoji = { currentTarget: { dataset: { emoji: '🎉' } } };
  c.chooseEmoji(emoji); c.chooseEmoji(emoji);
  assert.equal(c.data.content, '左🎉🎉右');
  assert.equal(c.data.editorCursor, 5);
  assert.equal(c.data.count, 4);
  assert.equal(c.data.editorFocusRequested, false);
  assert.equal(c.data.emojiOpen, true);
  await c.publish();
  assert.equal(c.data.emojiOpen, false);
  assert.equal(f.calls[0].content, '左🎉🎉右');
  f.detach();
});

test('发布 Emoji 达到上限时保留原正文，切换账号后旧面板不能插入', async () => {
  const f = composerFixture(); await f.attach(); const c = f.component;
  const emoji = { currentTarget: { dataset: { emoji: '😀' } } };
  c.onInput(input('字'.repeat(150))); c.toggleEmoji(); c.chooseEmoji(emoji);
  assert.equal(c.data.content, '字'.repeat(150));
  assert.equal(c.data.limitHintVisible, true);
  f.setUser({ ...user, _id: 'bob' }); c.chooseEmoji(emoji);
  assert.equal(c.data.content, '字'.repeat(150));
  f.hide(); assert.equal(c.data.emojiOpen, false);
  f.detach();
});

test('引用入口预填原卡片，支持仅引用发布，原帖文字和图片不进入本次正文与上传参数', async () => {
  const f = composerFixture({ initialQuote: quote, cachedQuote: quote, detail: async () => quote });
  await f.attach(); const c = f.component;
  assert.equal(c.data.quotePostId, quote._id); assert.equal(c.data.content, ''); assert.equal(c.data.images.length, 0);
  assert.equal(c.data.quote.content, quote.content); assert.equal(c.data.canPublish, true); assert.equal(c.data.canOptimize, false);
  assert.equal(f.storage.size, 0); await c.publish();
  assert.equal(f.calls[0].quotePostId, quote._id); assert.equal(f.calls[0].content, ''); assert.equal(f.calls[0].images, undefined);
  assert.equal(f.events.length, 0); f.flushClose(); assert.equal(f.events[0].detail.published, true); f.detach();
});
test('移除引用保留自己的文案图片与焦点，取消和草稿保存真实记录引用ID，不存原帖快照', async () => {
  const f = composerFixture({ initialQuote: quote, detail: async () => quote });
  await f.attach(); const c = f.component;
  c.cancel(); assert.equal(c.data.exitConfirmVisible, true);
  c.continueEditing(); c.onInput(input('自己的文案'));
  c.setData({ images: [{ key: 'mine', fileID: 'cloud://test.bucket/square-uploads/alice/mine.jpg', type: 'jpg' }] });
  c.removeQuote(); assert.equal(c.data.content, '自己的文案'); assert.equal(c.data.images.length, 1);
  assert.equal(c.data.quotePostId, ''); assert.equal(c.data.editorFocusRequested, true);
  await c.attachQuote(quote._id); await c.saveAndClose();
  const saved = f.storage.get('square.draft.alice'); assert.equal(saved.quotePostId, quote._id); assert.equal(saved.quote, undefined);
  const g = composerFixture({ storage: f.storage, detail: async () => quote }); await g.attach();
  assert.equal(g.component.data.quotePostId, quote._id); assert.equal(g.component.data.content, '自己的文案');
  g.component.cancel(); assert.equal(g.component.data.exitConfirmVisible, false); f.detach(); g.detach();
});
test('迟到引用读取不能恢复已移除内容或覆盖新账号；读取失败保留草稿并可移除', async () => {
  let finish;
  const f = composerFixture({ initialQuote: quote, detail: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.attach(); f.component.removeQuote(); finish(quote); await pending;
  assert.equal(f.component.data.quotePostId, ''); assert.equal(f.component.data.canPublish, false); f.detach();
  const g = composerFixture({ initialQuote: quote, detail: () => new Promise(resolve => { finish = resolve; }) });
  const old = g.attach(); g.setUser({ ...user, _id: 'bob' }); g.show(); finish(quote); await old;
  assert.equal(g.component.data.user._id, 'bob'); assert.equal(g.component.data.quotePostId, ''); g.detach();
  const h = composerFixture({ initialQuote: quote, detail: async () => { throw Object.assign(new Error('原动态不可见'), { code: 'POST_NOT_FOUND' }); } });
  await h.attach(); h.component.onInput(input('保留自己的文案'));
  assert.equal(h.component.data.canPublish, false); assert.equal(h.component.data.quote.unavailable, true);
  h.component.removeQuote(); assert.equal(h.component.data.canPublish, true); assert.equal(h.component.data.content, '保留自己的文案'); h.detach();
});
test('本轮小萃只优化本人输入和本次附图，引用原文及配图不进入请求', async () => {
  const f = composerFixture({ initialQuote: quote, detail: async () => quote, optimize: (content, images) => {
    assert.equal(content, '自己的文案'); assert.equal(images.length, 0); return '润色后的本人文案';
  } });
  await f.attach(); f.component.onInput(input('自己的文案')); await f.component.optimizeContent();
  assert.equal(f.component.data.content, '润色后的本人文案'); assert.equal(f.component.data.quotePostId, quote._id); f.detach();
});
test('引用后台读取网络失败保留已有真实预览，不误报原帖已删除或清空正在输入的文案', async () => {
  const f = composerFixture({ initialQuote: quote, detail: async () => { throw new Error('网络失败'); } });
  await f.attach(); f.component.onInput(input('继续编辑'));
  assert.equal(f.component.data.quote.content, quote.content); assert.equal(f.component.data.quote.unavailable, undefined);
  assert.equal(f.component.data.quoteError, '网络失败'); assert.equal(f.component.data.canPublish, true); f.detach();
});

test('仅选图片即显示小萃入口，上传后请求图文生成，可恢复空文案且不自动存草稿或发布', async () => {
  const selected = [{ key: 'only-photo', path: '/photo.jpg', type: 'jpg' }];
  const f = composerFixture({ chooseImages: () => selected, optimize: (content, images) => {
    assert.equal(content, ''); assert.equal(images.length, 1);
    assert.equal(images[0], 'cloud://test.bucket/square-uploads/alice/only-photo.jpg');
    return '镜头里的一份好心情。';
  } });
  await f.attach(); const c = f.component;
  assert.equal(c.data.canOptimize, false); await c.choosePostImages();
  assert.equal(c.data.canOptimize, true); assert.deepEqual(Array.from(c.data.noticeOrder), ['optimize']);
  await c.optimizeContent();
  assert.equal(c.data.content, '镜头里的一份好心情。'); assert.equal(c.data.canUndoOptimization, true);
  assert.equal(c.data.images[0].key, 'only-photo'); assert.equal(f.calls.length, 0); assert.equal(f.storage.size, 0);
  c.undoOptimization(); assert.equal(c.data.content, ''); assert.equal(c.data.images.length, 1); assert.equal(c.data.canOptimize, true);
  c.removeImage({ currentTarget: { dataset: { index: 0 } } }); assert.equal(c.data.canOptimize, false);
  assert.deepEqual(Array.from(c.data.noticeOrder), []);
});

test('图文润色按原图顺序传入，修改图片后旧结果不回填，上传回调不写到换位图片', async () => {
  const selected = [{ key: 'first', path: '/one.jpg', type: 'jpg' }, { key: 'second', path: '/two.jpg', type: 'jpg' }];
  let finish, uploaded, complete;
  const f = composerFixture({ chooseImages: () => selected, uploadImages: (images, onUploaded) => {
    uploaded = onUploaded; return new Promise(resolve => { complete = () => resolve(images.map(image => `cloud://test.bucket/square-uploads/alice/${image.key}.jpg`)); });
  }, optimize: () => new Promise(resolve => { finish = resolve; }) });
  await f.attach(); const c = f.component; await c.choosePostImages(); c.onInput(input('原有文案'));
  const pending = c.optimizeContent();
  c.removeImage({ currentTarget: { dataset: { index: 0 } } });
  uploaded(0, 'cloud://test.bucket/square-uploads/alice/first.jpg');
  uploaded(1, 'cloud://test.bucket/square-uploads/alice/second.jpg');
  assert.equal(c.data.images.length, 1); assert.equal(c.data.images[0].fileID, 'cloud://test.bucket/square-uploads/alice/second.jpg');
  complete(); await pending; assert.equal(f.requests.filter(row => row && row.optimize).length, 0);
  const next = c.optimizeContent(); complete(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(f.requests.at(-1).images), ['cloud://test.bucket/square-uploads/alice/second.jpg']);
  c.removeImage({ currentTarget: { dataset: { index: 0 } } });
  finish('不该回填的图文结果'); await next;
  assert.equal(c.data.content, '原有文案'); assert.equal(c.data.optimizing, false); assert.equal(c.data.canUndoOptimization, false);
});

test('图片上传失败保留当前原文及所选图片，不请求模型、不写草稿、不发布', async () => {
  const f = composerFixture({ chooseImages: () => [{ key: 'failed', path: '/p.jpg', type: 'jpg' }],
    uploadImages: async () => { throw new Error('图片上传失败'); } });
  await f.attach(); const c = f.component; await c.choosePostImages(); c.onInput(input('我的原文'));
  await c.optimizeContent();
  assert.equal(c.data.content, '我的原文'); assert.equal(c.data.images.length, 1);
  assert.equal(c.data.optimizeError, '图片上传失败'); assert.equal(c.data.optimizing, false);
  assert.equal(f.requests.filter(row => row && row.optimize).length, 0); assert.equal(f.storage.size, 0); assert.equal(f.calls.length, 0);
});

test('小萃问号只展示本次打开的一次说明，不请求模型或保存草稿，重新打开恢复', async () => {
  const storage = new Map(), f = composerFixture({ storage }); await f.attach(); const c = f.component;
  c.onInput(input('待发布正文')); c.editorDidFocus();
  const content = c.data.content, requestId = c._requestId;
  c.showOptimizeHelp(); assert.equal(c.data.optimizeHelpVisible, true); assert.equal(c.data.optimizeHelpUsed, true);
  assert.equal(c.data.content, content); assert.equal(c._requestId, requestId); assert.equal(c.data.editorFocused, true);
  assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0); assert.equal(storage.size, 0);
  c.closeOptimizeHelp(); assert.equal(c.data.optimizeHelpVisible, false);
  c.showOptimizeHelp(); assert.equal(c.data.optimizeHelpVisible, false);
  c.onInput(input('')); c.onInput(input('重新输入正文')); f.hide(); f.show();
  assert.equal(c.data.optimizeHelpUsed, true); assert.equal(c.data.optimizeHelpVisible, false); f.detach();
  const reopened = composerFixture({ storage }); await reopened.attach(); reopened.component.onInput(input('正文'));
  assert.equal(reopened.component.data.optimizeHelpUsed, false);
  await reopened.component.optimizeContent();
  assert.equal(reopened.component.data.optimizeHelpUsed, true); assert.equal(reopened.component.data.optimizeHelpVisible, false);
  assert.deepEqual(reopened.requests.filter(value => value && value.optimize), [{ optimize: '正文' }]);
  reopened.detach();
});

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
  c.focusEditor(); assert.equal(c.data.editorFocused, false); c.editorDidFocus(); c.keyboard({ detail: { height: 340 } });
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
  assert.equal(empty.toasts.at(-1), '请先写点内容或选择图片、视频'); assert.equal(empty.component.data.closing, false);
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
test('纯视频草稿重开后可与图片混排发布，封面不占用媒体名额', async () => {
  const video = { key: 'clip', path: '/tmp/clip.mp4', type: 'mp4', poster: chosenImage('cover') };
  const draft = composerFixture({ chooseImages: async (_, mixed) => { assert.equal(mixed, true); return [video]; } });
  await draft.attach(); await draft.component.choosePostImages();
  assert.equal(draft.component.data.canPublish, true); assert.equal(draft.component.data.canOptimize, false);
  await draft.component.saveAndClose();
  const reopened = composerFixture({ storage: draft.storage, chooseImages: async count => {
    assert.equal(count, 2); return [chosenImage('one'), chosenImage('two')];
  } });
  await reopened.attach(); await reopened.component.choosePostImages(); await reopened.component.publish();
  const published = reopened.calls[0];
  assert.equal(published.images, undefined); assert.equal(published.media.length, 3);
  assert.equal(published.media[0].type, 'video'); assert.match(published.media[0].fileID, /\/clip\.mp4$/);
  assert.match(published.media[0].poster, /\/cover\.jpg$/); assert.equal(published.media[2].type, 'image');
});
test('图片可以独立发布、限制三张；取消原生选图不丢文字，移除最后一图恢复不可发布', async () => {
  const remaining = [];
  const f = composerFixture({ chooseImages: async count => { remaining.push(count); return Array.from({ length: count }, (_, i) => chosenImage('image' + i)); } });
  await f.attach(); await f.component.choosePostImages();
  assert.equal(f.component.data.images.length, 3); assert.equal(f.component.data.canPublish, true); assert.equal(remaining[0], 3);
  await f.component.choosePostImages(); assert.equal(remaining.length, 1);
  await f.component.publish(); assert.equal(f.calls[0].content, ''); assert.equal(f.calls[0].images.length, 3);
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


test('快速润色满5秒后才替换正文，等待期间编辑或卸载会取消展示且释放计时器', async () => {
  const f = composerFixture({ manualOptimizationDelay: true }); await f.attach(); const c = f.component;
  c.onInput(input('原文')); const task = c.optimizeContent(); await new Promise(r => setImmediate(r));
  assert.equal(c.data.optimizing, true); assert.equal(c.data.content, '原文');
  const delay = [...f.delays.values()][0]; assert.ok(delay > 4900 && delay <= 5000);
  f.flushClose(); await task; assert.equal(c.data.content, '优化后的内容'); assert.equal(c.data.optimizing, false);
  for (const cancel of ['edit', 'hide', 'detach']) {
    const other = composerFixture({ manualOptimizationDelay: true }); await other.attach(); other.component.onInput(input('原文'));
    const request = other.component.optimizeContent(); await new Promise(r => setImmediate(r));
    if (cancel === 'edit') other.component.onInput(input('新文')); else if (cancel === 'hide') other.hide(); else other.detach();
    await request; assert.equal(other.timers.size, 0); assert.notEqual(other.component.data.content, '优化后的内容');
  }
});

test('第五行、连续回车及长正文不再改写原生输入框尺寸或主动抢焦点', async () => {
  const f = composerFixture(); await f.attach(); const c = f.component;
  c.editorDidFocus(); c.keyboard({ detail: { height: 320 } });
  assert.equal(c.data.editorFocused, true); assert.equal(c.data.editorFocusRequested, false);
  const writes = []; const update = c.setData;
  c.setData = function(value) { writes.push(value); update.call(this, value); };
  for (const value of ['一\n二\n三\n四', '一\n二\n三\n四\n五', '\n'.repeat(5), '\n'.repeat(20), '正文'.repeat(70)]) {
    c.onInput(input(value)); c.editorDidFocus(); c.keyboard({ detail: { height: 320 } });
    assert.equal(c.data.content, value); assert.equal(c.data.keyboardHeight, 320);
  }
  for (const value of writes) assert.ok(!Object.keys(value).some(key => ['editorHeight', 'editorFocusRequested', 'editorFocused', 'sheetTop', 'viewportHeight', 'keyboardHeight'].includes(key)));
  c.blurEditor(); assert.equal(c.data.editorFocusRequested, false);
  c.focusEditor(); assert.equal(c.data.editorFocusRequested, true);
  c.openPanel(panel('options')); assert.equal(c.data.editorFocusRequested, false);
});

test('发布textarea没有纵向滚动祖先、手势拦截祖先和行高回写，动画结束不保留transform', () => {
  const fs = require('fs'), markup = fs.readFileSync('miniprogram/components/square-composer/index.wxml', 'utf8');
  const stack = []; let ancestors;
  for (const match of markup.matchAll(/<([\w-]+)\b([^>]*?)>|<\/([\w-]+)\s*>/g)) {
    if (match[3]) { stack.pop(); continue; }
    if (match[1] === 'textarea') { ancestors = [...stack]; break; }
    if (!match[2].trimEnd().endsWith('/')) stack.push({ tag: match[1], attributes: match[2] });
  }
  assert.ok(ancestors && ancestors.length);
  assert.ok(ancestors.every(node => node.tag !== 'scroll-view' && !node.attributes.includes('catchtouchmove')));
  const textarea = markup.match(/<textarea\b[^>]*>/)[0];
  assert.match(textarea, /auto-height="{{!!quotePostId}}"/); assert.ok(!textarea.includes('bindlinechange'));
  assert.ok(!textarea.includes('editorHeight')); assert.match(textarea, /focus="{{editorFocusRequested}}"/);
  const css = fs.readFileSync('miniprogram/components/square-composer/index.wxss', 'utf8');
  assert.match(css, /\.compose-textarea[^}]*height: 100%/);
  assert.match(css, /\.compose-sheet[^}]*animation: compose-rise[^;]*backwards/);
});


test('发布正文回车键只换行并原生保持键盘，不绑定回车发布或重新唤起逻辑', () => {
  const field = require('fs').readFileSync('miniprogram/components/square-composer/index.wxml', 'utf8').match(/<textarea\b[^>]*>/)[0];
  assert.match(field, /confirm-type="return"/); assert.match(field, /confirm-hold="{{true}}"/);
  assert.ok(!field.includes('bindconfirm="publish"'));
});


test('引用发布的原生输入框不在引用滚动区域内，不再用隐藏占位裁剪固定大输入框', () => {
  const fs = require('fs'), markup = fs.readFileSync('miniprogram/components/square-composer/index.wxml', 'utf8');
  const css = fs.readFileSync('miniprogram/components/square-composer/index.wxss', 'utf8');
  const stack = []; let ancestors;
  for (const match of markup.matchAll(/<([\w-]+)\b([^>]*?)>|<\/([\w-]+)\s*>/g)) {
    if (match[3]) { stack.pop(); continue; }
    if (match[1] === 'textarea') { ancestors = [...stack]; break; }
    if (!match[2].trimEnd().endsWith('/')) stack.push({ tag: match[1], attributes: match[2] });
  }
  assert.ok(ancestors.every(node => node.tag !== 'scroll-view' && !node.attributes.includes('catchtouchmove')));
  assert.ok(markup.indexOf('<textarea') < markup.indexOf('class="compose-attachments'));
  assert.match(markup, /scroll-y="{{!!quotePostId}}"/); assert.match(markup, /bindtouchstart="editorTouchStart"/);
  assert.doesNotMatch(markup + css, /compose-editor-measure/);
  assert.doesNotMatch(css, /\.compose-body\.is-quoted[^}]*overflow-y/);
  assert.doesNotMatch(css, /\.has-quote \.compose-textarea[^}]*[;{]\s*height:\s*260rpx/);
  assert.match(css, /\.has-quote \.compose-textarea[^}]*position: relative[^}]*max-height: 260rpx/);
});

test('带图引用点击后先缩小窗口再收到focus/键盘事件时，仍保留完整视窗，不主动收键盘', async () => {
  const quote = { _id: 'p_' + 'b'.repeat(40), content: '引用原文', images: ['public-quote-image'] };
  for (const focusFirst of [true, false]) {
    const window = { windowHeight: 812, windowWidth: 375, statusBarHeight: 44 };
    const f = composerFixture({ window, initialQuote: quote, cachedQuote: quote, detail: async () => quote }); await f.attach(); const c = f.component;
    c.editorTouchStart(); if (focusFirst) c.editorDidFocus();
    window.windowHeight = 472; c.measure();
    if (!focusFirst) c.editorDidFocus();
    c.keyboard({ detail: { height: 340 } });
    assert.equal(c.data.viewportHeight, 812); assert.equal(c.data.sheetTop, 102);
    assert.equal(c.data.viewportHeight - c.data.sheetTop - c.data.keyboardHeight, 370);
    assert.equal(c.data.editorFocusRequested, false); assert.equal(c.data.quotePostId, quote._id);
    assert.equal(c.data.quote.images[0], 'public-quote-image'); assert.equal(f.requests.includes('hideKeyboard'), false);
    const writes = [], update = c.setData;
    c.setData = function(value) { writes.push(value); update.call(this, value); };
    c.measure(); c.measure(); c.keyboard({ detail: { height: 340 } });
    assert.equal(writes.length, 0, '相同窗口及重复键盘事件不再次触发布局'); f.detach();
  }
});

test('键盘仍打开时发布输入框临时blur只观测状态，不下发focus=false或反复拉起；真实收起才释放请求', async () => {
  const f = composerFixture(); await f.attach(); const c = f.component;
  c.focusEditor(); c.editorDidFocus(); c.keyboard({ detail: { height: 320 } });
  const writes = [], update = c.setData;
  c.setData = function(value) { writes.push(value); update.call(this, value); };
  c.blurEditor(); assert.equal(c.data.editorFocused, false); assert.equal(c.data.editorFocusRequested, true);
  assert.ok(writes.every(value => !('editorFocusRequested' in value)));
  c.editorDidFocus(); assert.equal(c.data.editorFocusRequested, true);
  c.keyboard({ detail: { height: 0 } }); assert.equal(c.data.editorFocusRequested, false); assert.equal(c.data.keyboardHeight, 0);
  assert.equal(f.requests.includes('hideKeyboard'), false); f.detach();
});


test('引用与首个编辑器同批确定模式，原动态网络读取不阻塞输入框挂载', async () => {
  const quote = { _id: 'p_' + 'c'.repeat(40), content: '引用正文', images: ['published-photo'] };
  let finish;
  const f = composerFixture({ initialQuote: quote, detail: () => new Promise(resolve => { finish = resolve; }) });
  const c = f.component, writes = [], update = c.setData;
  c.setData = function(value) { writes.push(value); update.call(this, value); };
  assert.equal(c.data.editorReady, false);
  const attaching = f.attach();
  assert.equal(c.data.editorReady, true); assert.equal(c.data.quotePostId, quote._id); assert.equal(c.data.quoteLoading, true);
  const firstMount = writes.find(value => value.editorReady === true);
  assert.equal(firstMount.quotePostId, quote._id, '禁止先挂载满高控件，再切换引用auto-height');
  finish(quote); await attaching; assert.equal(c.data.editorReady, true); f.detach();
});

test('设置声明与退出确认只覆盖和禁用编辑器，不卸载或替换正文节点，引用位置不重新初始化', async () => {
  const quote = { _id: 'p_' + 'd'.repeat(40), content: '原动态', images: ['published-photo'] };
  const f = composerFixture({ initialQuote: quote, detail: async () => quote }); await f.attach(); const c = f.component;
  c.onInput(input('本次正文')); const currentQuote = c.data.quote, images = c.data.quote.images;
  const writes = [], update = c.setData; c.setData = function(value) { writes.push(value); update.call(this, value); };
  for (const key of ['options', 'declaration', 'options']) { c.openPanel(panel(key)); assert.equal(c.data.editorReady, true); c.closePanel(); }
  c.cancel(); assert.equal(c.data.exitConfirmVisible, true); assert.equal(c.data.editorReady, true); c.continueEditing();
  assert.equal(c.data.content, '本次正文'); assert.equal(c.data.quote, currentQuote); assert.equal(c.data.quote.images, images);
  assert.ok(writes.every(value => !('editorReady' in value)), '面板往返不能重新走挂载流程');
  const fs = require('fs'), markup = fs.readFileSync('miniprogram/components/square-composer/index.wxml', 'utf8');
  const field = markup.match(/<textarea\b[^>]*>/)[0];
  assert.match(field, /wx:if="{{editorReady}}"/); assert.match(field, /disabled="{{[^}]*panel[^}]*exitConfirmVisible/);
  assert.doesNotMatch(markup, /compose-editor-preview/);
  const css = fs.readFileSync('miniprogram/components/square-composer/index.wxss', 'utf8');
  const rule = css.split('.has-quote .compose-textarea {')[1].split('}')[0];
  assert.ok(rule.includes('height: 53rpx;')); assert.ok(rule.includes('max-height: 260rpx;')); assert.ok(!rule.includes('height: auto;'));
  f.detach();
});
