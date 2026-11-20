const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { applyPageData } = require('./helpers/post-actions-fixture');

const user = { _id: 'alice' }, id = 'p_' + 'a'.repeat(40);
const reply = { _id: 'reply', content: '真实评论', author: { nickname: '同学' }, createdAt: '2026-11-18T00:00:00Z' };
function fixture(options = {}) {
  let definition, current = options.guest ? null : user, version = 0;
  const events = [], requests = [], toasts = [];
  let aiListener, keyboardHides = 0;
  const users = { getCachedUser: () => current, getSessionVersion: () => version };
  const square = { cachedReplies: () => options.cached || null,
    ...(options.replyContext ? { replyContext: options.replyContext } : {}),
    ...(options.ai ? { processAIReply: options.ai, subscribeAI: listener => { aiListener = listener; return () => { aiListener = null; }; } } : {}),
    cachedChildren: () => options.cachedChildren || null,
    listChildren: async (postId, rootId, args) => { requests.push({ type: 'children', postId, rootId, ...args }); return options.children ? options.children(args) : { items: [], hasMore: false, nextOffset: 0 }; },
    commentState: async (postId, replyId, kind, active) => { requests.push({ type: 'state', postId, replyId, kind, active }); return options.state(replyId, kind, active); },
    listReplies: async (postId, args) => { requests.push({ type: 'list', postId, ...args }); return options.list ? options.list(args) : { items: [], hasMore: false, nextOffset: 0 }; },
    reply: async (postId, content, requestId, replyToId, askAI = false, images = []) => { requests.push({ type: 'send', postId, content, requestId, replyToId, askAI, ...(images.length ? { images } : {}) }); return options.send ? options.send() : { post: { _id: id, replyCount: 1 }, reply: { ...reply, content, images } }; },
    deleteReply: async (postId, replyId) => { requests.push({ type: 'delete', postId, replyId }); return options.remove(replyId); },
    reportReply: async (postId, replyId, reason) => { requests.push({ type: 'report', postId, replyId, reason }); return options.report ? options.report() : {}; },
  };
  const media = {
    chooseImages: async count => { requests.push({ type: 'choose-images', count }); return options.chooseImages ? options.chooseImages(count) : []; },
    uploadImages: async (images, uploaded) => {
      if (options.uploadImages) return options.uploadImages(images, uploaded);
      return images.map((image, index) => { const file = image.fileID || `cloud://test.bucket/square-uploads/alice/${image.key}.jpg`; uploaded(index, file); return file; });
    },
    discardUploads: async files => { requests.push({ type: 'discard-images', files }); },
    previewImages: async (files, current) => { requests.push({ type: 'preview-images', files, current }); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/components/comments-sheet/index.js'), 'utf8'), {
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    Component: value => { definition = value; }, wx: { hideKeyboard(args) { keyboardHides++; if (options.hideKeyboard) options.hideKeyboard(args); }, showToast: value => toasts.push(value.title),
      showActionSheet: args => { requests.push({ type: 'sheet', itemList: args.itemList }); args.success((options.choices || []).shift() || { tapIndex: 0 }); },
      showModal: args => { requests.push({ type: 'modal', title: args.title }); args.success({ confirm: options.confirm !== false }); },
      getDeviceInfo: () => ({ platform: options.platform || 'devtools' }),
      getWindowInfo: () => options.window || { windowHeight: 812, statusBarHeight: 44 },
      getMenuButtonBoundingClientRect: () => options.capsule || { top: 52, height: 32 } },
    require: name => name.includes('services/user') ? users : name.includes('services/square') ? square : name.includes('services/post-images') ? media : name.includes('comment-state') ? require('../miniprogram/utils/comment-state') : name.includes('comment-threads') ? require('../miniprogram/utils/comment-threads') : require('../miniprogram/utils/post-view'),
  });
  const component = { ...definition.methods, data: { ...structuredClone(definition.data), postId: id, viewer: current, focusReplyId: options.focusReplyId || '', focusReplyInput: Boolean(options.focusReplyInput) },
    setData(value) { applyPageData(this.data, value); }, triggerEvent(name, detail) { events.push({ name, detail }); } };
  return { component, events, requests, toasts, keyboardHides: () => keyboardHides, emitAI: result => aiListener && aiListener(result), attach: () => definition.lifetimes.attached.call(component), detach: () => definition.lifetimes.detached.call(component),
    hide: () => definition.pageLifetimes.hide.call(component), show: () => definition.pageLifetimes.show.call(component),
    logout() { current = null; version++; },
  };
}

test('历史回复定位展开目标窗口和更早分页，仅明确点击回复才聚焦输入框', async () => {
  const rootId = 'r_' + 'b'.repeat(40), targetId = 'c_' + 'c'.repeat(40);
  const root = { ...reply, _id: rootId, replyCount: 65 }, target = { ...reply, _id: targetId, rootId, replyToId: rootId, ancestorIds: [rootId] };
  for (const focusReplyInput of [false, true]) {
    const f = fixture({ focusReplyId: targetId, focusReplyInput,
      replyContext: async () => ({ root, targetId, items: [target], startOffset: 40, nextOffset: 60, hasMore: true }),
      children: args => ({ items: [{ ...target, _id: 'c_' + 'd'.repeat(40) }], nextOffset: args.offset + 20, hasMore: true }) });
    await f.attach(); const c = f.component;
    assert.equal(c.data.scrollIntoView, `comment-${targetId}`);
    assert.equal(c.data.items[0].threadOpen, true); assert.equal(c.data.items[0].threadEarlier, true);
    assert.equal(c.data.items[0].visibleChildren[0].highlighted, true);
    assert.equal(c.data.inputFocusRequested, focusReplyInput);
    assert.equal(Boolean(c.data.replyTarget), focusReplyInput);
    await c.earlierChildren({ currentTarget: { dataset: { id: rootId } } });
    assert.equal(c._threads.get(rootId).focusStart, 20); assert.equal(c._threads.get(rootId).nextOffset, 60);
    assert.equal(c._threads.get(rootId).items.length, 2);
    f.detach();
  }
});
test('定位读取迟到或换账号时，不恢复旧评论、不弹键盘；定位失败可以重试', async () => {
  const targetId = 'r_' + 'b'.repeat(40); let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture({ focusReplyId: targetId, focusReplyInput: true, replyContext: () => new Promise(resolve => { finish = resolve; started(); }) });
  const attaching = f.attach(); await ready;
  f.logout(); finish({ root: { ...reply, _id: targetId }, targetId, items: [], startOffset: 0, nextOffset: 0, hasMore: false });
  await attaching;
  assert.equal(f.component.data.inputFocusRequested, false); assert.equal(f.component.data.scrollIntoView, '');
  f.detach();
  let fail = true;
  const g = fixture({ focusReplyId: targetId, replyContext: async () => {
    if (fail) throw new Error('评论不可见');
    return { root: { ...reply, _id: targetId }, targetId, items: [], startOffset: 0, nextOffset: 0, hasMore: false };
  } });
  await g.attach(); assert.equal(g.component.data.locateError, '评论不可见');
  fail = false; await g.component.retryLocate(); assert.equal(g.component.data.locateError, '');
  assert.equal(g.component.data.scrollIntoView, `comment-${targetId}`); g.detach();
});

test('恢复定位讨论的祖先折叠后重读窗口，但不把恢复操作当成再次请求键盘', async () => {
  const rootId = 'r_' + 'b'.repeat(40), targetId = 'c_' + 'c'.repeat(40);
  const root = { ...reply, _id: rootId, replyCount: 1 }, target = { ...reply, _id: targetId, rootId, ancestorIds: [rootId] };
  let folded = true, reads = 0;
  const f = fixture({ focusReplyId: targetId, focusReplyInput: true,
    replyContext: async () => { reads++; return { root: { ...root, folded }, targetId: folded ? rootId : targetId,
      items: folded ? [] : [target], startOffset: 0, nextOffset: 1, hasMore: false, blocked: folded }; },
    state: async () => { folded = false; return { ...root, folded: false }; } });
  await f.attach(); assert.equal(f.component.data.inputFocusRequested, false);
  await f.component.reactComment({ currentTarget: { dataset: { id: rootId, kind: 'fold' } } });
  assert.equal(reads, 2); assert.equal(f.component.data.scrollIntoView, `comment-${targetId}`);
  assert.equal(f.component.data.inputFocusRequested, false);
  assert.equal(f.component.data.items[0].visibleChildren[0]._id, targetId); f.detach();
});

test('评论图片先上传并在输入框上方显示，分次最多三张，可移除预览，纯图片发送后不存相册', async () => {
  let n = 0;
  const f = fixture({ chooseImages: count => Array.from({ length: Math.min(2, count) }, () => ({ key: 'photo' + (++n), path: '/photo' + n + '.jpg', type: 'jpg' })) });
  await f.attach(); const c = f.component;
  await c.chooseCommentImages(); assert.equal(c.data.selectedImages.length, 2); assert.equal(c.data.canSend, true);
  assert.ok(c.data.selectedImages.every(image => image.fileID.startsWith('cloud://')));
  await c.chooseCommentImages(); assert.equal(c.data.selectedImages.length, 3);
  assert.deepEqual(f.requests.filter(row => row.type === 'choose-images').map(row => row.count), [3, 1]);
  await c.chooseCommentImages(); assert.equal(f.toasts.at(-1), '一次最多发送3张图片');
  await c.previewCommentImages({ currentTarget: { dataset: { selected: true, index: 1 } } });
  assert.equal(f.requests.at(-1).current, '/photo2.jpg');
  c.removeCommentImage({ currentTarget: { dataset: { index: 1 } } }); assert.equal(c.data.selectedImages.length, 2);
  const hides = f.keyboardHides(); await c.send();
  const sent = f.requests.find(row => row.type === 'send');
  assert.equal(sent.content, ''); assert.equal(sent.images.length, 2); assert.equal(sent.askAI, false);
  assert.equal(c.data.items[0].images.length, 2); assert.equal(c.data.selectedImages.length, 0);
  await c.previewCommentImages({ currentTarget: { dataset: { id: c.data.items[0]._id, index: 1 } } });
  assert.equal(f.requests.at(-1).files.length, 2); assert.equal(f.requests.at(-1).current, sent.images[1]);
  assert.equal(c.data.canSend, false); assert.equal(f.keyboardHides(), hides + 1);
  f.detach();
});

test('带图问小萃携带独立标记；发送失败恢复文字、图序、回复对象和标记，重试保持提交ID', async () => {
  let failed = true;
  const target = { ...reply, _id: 'r_' + 'f'.repeat(40), author: { nickname: '同学' } };
  const f = fixture({ cached: { items: [target], hasMore: false, nextOffset: 1 },
    list: async () => ({ items: [target], hasMore: false, nextOffset: 1 }),
    chooseImages: () => [{ key: 'ai-picture', path: '/ai.jpg', type: 'jpg' }],
    send: () => { if (failed) throw new Error('网络失败'); return { reply: { ...reply, rootId: target._id, images: ['cloud://test.bucket/square-media/published.png'] } }; } });
  await f.attach(); const c = f.component; await c.chooseCommentImages();
  c.selectReply({ currentTarget: { dataset: { id: target._id } } }); c.askXiaocui();
  c.input({ detail: { value: c.data.inputValue + '和动态有什么区别？' } });
  await c.send(); const sent = f.requests.find(row => row.type === 'send');
  assert.equal(sent.askAI, true); assert.equal(sent.images.length, 1); assert.equal(sent.replyToId, target._id);
  assert.equal(c.data.askAI, true); assert.equal(c.data.selectedImages[0].key, 'ai-picture');
  assert.equal(c.data.text, '和动态有什么区别？'); assert.equal(c.data.replyTarget.id, target._id);
  assert.equal(c.data.inputFocusRequested, false); assert.equal(c.data.keyboardHeight, 0);
  failed = false; await c.send(); assert.equal(f.requests.filter(row => row.type === 'send')[1].requestId, sent.requestId);
  assert.equal(c.data.items[0].freshChildren[0].images.length, 1); assert.equal(c.data.selectedImages.length, 0);
  f.detach();
});

test('选图上传失败保留本地预览供重试；上传未结束不发送，账号变更或卸载不恢复旧图片', async () => {
  let finish, failed = true;
  const f = fixture({ chooseImages: () => [{ key: 'retry-image', path: '/retry.jpg', type: 'jpg' }],
    uploadImages: async (images, uploaded) => { if (failed) throw new Error('图片上传失败'); return images.map((image, index) => { const file = 'cloud://test.bucket/square-uploads/alice/retry-image.jpg'; uploaded(index, file); return file; }); } });
  await f.attach(); const c = f.component; await c.chooseCommentImages();
  assert.equal(c.data.sendError, '图片上传失败'); assert.equal(c.data.selectedImages.length, 1);
  failed = false; await c.send(); assert.equal(c.data.items[0].images.length, 1); f.detach();
  for (const mode of ['logout', 'detach']) {
    const g = fixture({ chooseImages: () => [{ key: 'late', path: '/late.jpg', type: 'jpg' }],
      uploadImages: (images, uploaded) => new Promise(resolve => { finish = () => { uploaded(0, 'cloud://test.bucket/square-uploads/alice/late.jpg'); resolve(['cloud://test.bucket/square-uploads/alice/late.jpg']); }; }) });
    await g.attach(); const pending = g.component.chooseCommentImages(); await new Promise(resolve => setImmediate(resolve));
    await g.component.send(); assert.equal(g.requests.filter(row => row.type === 'send').length, 0);
    if (mode === 'logout') { g.logout(); g.hide(); g.show(); } else g.detach();
    finish(); await pending;
    assert.equal(g.requests.filter(row => row.type === 'send').length, 0);
    if (mode === 'logout') assert.equal(g.component.data.selectedImages.length, 0);
    else assert.equal(g.component.data.selectedImages[0].fileID, undefined);
  }
});

test('AI生成独立于发送，正式评论立即展示并清空输入；AI随后作为新楼中回复显示且无成功弹窗', async () => {
  let finishAI;
  const root = { ...reply, _id: 'r_' + 'c'.repeat(40), aiStatus: 'queued', aiCanManage: true, replyCount: 0 };
  const f = fixture({ send: async () => ({ post: { _id: id }, reply: root }), ai: () => new Promise(resolve => { finishAI = resolve; }) });
  await f.attach(); const c = f.component;
  c.input({ detail: { value: '@小萃 你怎么看' } }); await c.send();
  assert.equal(c.data.sending, false); assert.equal(c.data.text, ''); assert.equal(c.data.items[0]._id, root._id); assert.ok(finishAI);
  assert.equal(f.keyboardHides(), 1); // 点击发送即收键盘，不等待云端确认或独立AI任务。
  const child = { ...reply, _id: 'c_' + 'd'.repeat(40), rootId: root._id, replyToId: root._id, author: { nickname: '小萃小萃', isAI: true } };
  c.applyCommentRow({ ...root, aiStatus: 'done', replyCount: 1 });
  f.emitAI({ postId: id, reply: child, created: true });
  assert.equal(c.data.items[0].freshChildren[0].author.isAI, true); assert.equal(c.data.items[0].freshChildren[0].content, child.content);
  assert.equal(c.data.items[0].showExpand, false); assert.equal(f.toasts.length, 0);
  f.detach(); finishAI({ status: 'done' });
  f.emitAI({ postId: id, reply: { ...child, content: '迟到内容' }, created: true });
  assert.equal(c.data.items[0].freshChildren[0].content, child.content);
});

test('评论面板首帧复用缓存，读取不会覆盖输入，分页在同一面板完成', async () => {
  let finish;
  const f = fixture({ cached: { items: [reply], hasMore: true, nextOffset: 20 }, list: () => new Promise(resolve => { finish = resolve; }) });
  const reading = f.attach();
  assert.equal(f.component.data.loading, false); assert.equal(f.component.data.items[0].content, reply.content);
  f.component.input({ detail: { value: '正在输入的内容' } });
  finish({ items: [reply], hasMore: true, nextOffset: 20 }); await reading;
  assert.equal(f.component.data.text, '正在输入的内容');
  const more = f.component.loadMore();
  assert.equal(f.requests.at(-1).offset, 20);
  finish({ items: [reply, { ...reply, _id: 'older' }], hasMore: false, nextOffset: 21 }); await more;
  assert.equal(f.component.data.items.length, 2);
});

test('点击问问小萃插入可退格删除的胶囊，手动输入昵称不唤起，零宽标记不进入正文', async () => {
  const f = fixture(); await f.attach(); const c = f.component;
  c.askXiaocui(); assert.equal(c.data.askAI, true); assert.equal(c.data.canSend, true); assert.equal(c.data.count, 3);
  const marker = c.data.inputValue; assert.equal(marker, '\u200B\u3000\u3000\u3000\u2002');
  c.askXiaocui(); assert.equal(c.data.inputValue, marker);
  c.input({ detail: { value: marker + '怎么看' } }); assert.equal(c.data.text, '怎么看'); assert.equal(c.data.count, 7);
  await c.send(); const sent = f.requests.find(row => row.type === 'send');
  assert.equal(sent.content, '@小萃 怎么看'); assert.equal(sent.askAI, true); assert.ok(!sent.content.includes(marker));
  assert.equal(c.data.askAI, false); assert.equal(c.data.inputValue, '');
  c.askXiaocui(); c.input({ detail: { value: '' } });
  assert.equal(c.data.askAI, false); assert.equal(c.data.canSend, false);
  c.input({ detail: { value: '@小萃小萃 怎么看' } }); await c.send();
  assert.equal(f.requests.filter(row => row.type === 'send').at(-1).askAI, false);
  c.askXiaocui(); c.input({ detail: { value: marker + '保留正文' } });
  c.input({ detail: { value: '保留正文' } }); assert.equal(c.data.askAI, false); assert.equal(c.data.text, '保留正文');
});

test('胶囊发送失败保留选择与正文和提交标识，胶囊本身也可发送且总长度受50字限制', async () => {
  let fail = true;
  const f = fixture({ send: () => { if (fail) throw new Error('网络失败'); return { reply }; } }); await f.attach(); const c = f.component;
  c.askXiaocui(); const marker = c.data.inputValue;
  c.input({ detail: { value: marker + '字'.repeat(47) } }); assert.equal(c.data.count, 50); assert.equal(c.data.limitHintVisible, true);
  c.input({ detail: { value: marker + '字'.repeat(46) } }); assert.equal(c.data.canSend, true);
  await c.send(); assert.equal(c.data.askAI, true); assert.equal(c.data.text.length, 46); assert.equal(c.data.count, 50);
  const requestId = f.requests.filter(row => row.type === 'send')[0].requestId;
  fail = false; await c.send(); assert.equal(f.requests.filter(row => row.type === 'send')[1].requestId, requestId);
  c.askXiaocui(); await c.send();
  assert.equal(f.requests.filter(row => row.type === 'send').at(-1).content, '@小萃');
});

const touch = y => ({ touches: [{ clientY: y }] });
const release = y => ({ touches: [], changedTouches: [{ clientY: y }] });

test('展开按钮往返两个固定高度，与拖动共用展开状态，保留正文、回复目标和评论', async () => {
  const f = fixture(); await f.attach(); const c = f.component;
  c.input({ detail: { value: '保留当前输入' } });
  c.setData({ items: [reply], replyTarget: { id: 'target', nickname: '同学' } });
  c.toggleExpanded(); assert.equal(c.data.expanded, true); assert.equal(c.data.sheetTop, 96);
  c.toggleExpanded(); assert.equal(c.data.expanded, false); assert.equal(c.data.sheetTop, 260);
  c.dragStart(touch(300)); c.dragEnd(release(0)); assert.equal(c.data.expanded, true);
  c.toggleExpanded(); assert.equal(c.data.expanded, false); assert.equal(c.data.sheetTop, 260);
  c.dragStart(touch(300)); c.dragMove(touch(240)); c.toggleExpanded();
  assert.equal(c.data.dragging, false); assert.equal(c.data.sheetTop, 96);
  c.dragEnd(release(500)); assert.equal(c.data.sheetTop, 96);
  assert.equal(c.data.text, '保留当前输入'); assert.equal(c.data.replyTarget.id, 'target'); assert.equal(c.data.items[0]._id, reply._id);
  c.close(); assert.equal(f.events.at(-1).name, 'close');
});

test('键盘弹起时按钮同步面板位置；详情内嵌评论与卸载后的回调不改变高度', async () => {
  const f = fixture(); await f.attach(); const c = f.component;
  c.keyboard({ detail: { height: 390 } }); assert.equal(c.data.keyboardTop, 202);
  c.toggleExpanded(); assert.equal(c.data.keyboardTop, 96); assert.equal(c.data.keyboardHeight, 390);
  c.toggleExpanded(); assert.equal(c.data.keyboardTop, 202);
  c.keyboard({ detail: { height: 0 } }); assert.equal(c.data.sheetTop, 260);
  c.setData({ embedded: true, topOffset: 92 }); c.measureSheet(); c.toggleExpanded();
  assert.equal(c.data.expanded, false); assert.equal(c.data.sheetTop, 92);
  c.setData({ embedded: false }); c.measureSheet(); f.detach(); c.toggleExpanded();
  assert.equal(c.data.expanded, false); assert.equal(c.data.sheetTop, 260);
});

test('评论拖动未过一半复位，超过一半吸附到胶囊下方，再下拉可回默认高度', async () => {
  const f = fixture(); await f.attach(); const c = f.component;
  const compact = 260, expanded = 96, half = (compact - expanded) / 2;
  assert.equal(c.data.sheetTop, compact);
  c.dragStart(touch(300)); c.dragMove(touch(300 - half + 1)); c.dragEnd(release(300 - half + 1));
  assert.equal(c.data.sheetTop, compact); assert.equal(c.data.expanded, false);
  c.dragStart(touch(300)); c.dragEnd(release(300 - half));
  assert.equal(c.data.sheetTop, compact);
  c.dragStart(touch(300)); c.dragMove(touch(300 - half - 1)); c.dragEnd(release(300 - half - 1));
  assert.equal(c.data.sheetTop, expanded); assert.equal(c.data.expanded, true); assert.equal(c.data.dragging, false);
  c.dragStart(touch(100)); c.dragEnd(release(100 + half - 1));
  assert.equal(c.data.sheetTop, expanded);
  c.dragStart(touch(100)); c.dragEnd(release(100 + half + 1));
  assert.equal(c.data.sheetTop, compact); assert.equal(c.data.expanded, false);
});

test('评论拖动限制上下边界，取消手势复位；设备尺寸适配并保留草稿和评论', async () => {
  const f = fixture({ window: { windowHeight: 900, statusBarHeight: 50 }, capsule: { top: 58, height: 32 } });
  await f.attach(); const c = f.component;
  c.input({ detail: { value: '保留草稿' } }); c.data.items = [reply];
  c.dragStart(touch(300)); c.dragMove(touch(-500)); assert.equal(c.data.sheetTop, 102);
  c.dragCancel(); assert.equal(c.data.sheetTop, 288); assert.equal(c.data.dragging, false);
  c.dragStart(touch(300)); c.dragEnd(release(-500)); assert.equal(c.data.sheetTop, 102);
  c.dragStart(touch(100)); c.dragMove(touch(3000)); assert.equal(c.data.sheetTop, 288);
  c.dragCancel(); assert.equal(c.data.sheetTop, 102);
  assert.equal(c.data.text, '保留草稿'); assert.equal(c.data.items[0].content, reply.content);
  c.keyboard({ detail: { height: 340 } }); assert.equal(c.data.keyboardTop, 102);
  c.keyboard({ detail: { height: 0 } }); assert.equal(c.data.sheetTop, 102);
  f.detach(); c.dragStart(touch(100)); assert.equal(c.data.dragging, false);
});

test('默认和展开档位的面板底部在可视窗口内，键盘弹出后输入区位于键盘上方', async () => {
  const f = fixture(); await f.attach(); const c = f.component;
  const bottom = () => {
    const top = c.data.keyboardHeight ? c.data.keyboardTop : c.data.sheetTop;
    const height = c.data.viewportHeight - top - c.data.keyboardHeight;
    assert.ok(height >= 220);
    return top + height;
  };
  assert.equal(bottom(), 812);
  c.keyboard({ detail: { height: 390 } }); assert.equal(bottom(), 422);
  assert.equal(c.data.keyboardTop, 202);
  c.keyboard({ detail: { height: 0 } }); assert.equal(c.data.sheetTop, 260);
  c.dragStart(touch(300)); c.dragEnd(release(0)); assert.equal(bottom(), 812);
  c.keyboard({ detail: { height: 390 } }); assert.equal(c.data.keyboardTop, 96); assert.equal(bottom(), 422);
  c.keyboard({ detail: { height: 0 } }); assert.equal(c.data.sheetTop, 96);
});

test('评论发送失败保留正文和提交标识，成功后才清空并同步原列表', async () => {
  let failed = true;
  const f = fixture({ send: () => { if (failed) throw new Error('连接失败'); return { post: { _id: id, replyCount: 1 }, reply }; } });
  await f.attach(); f.component.input({ detail: { value: reply.content } });
  await f.component.send();
  assert.equal(f.component.data.text, reply.content); assert.equal(f.component.data.sendError, '连接失败'); assert.equal(f.events.length, 0);
  failed = false; await f.component.send();
  assert.equal(f.requests.filter(request => request.type === 'send')[0].requestId, f.requests.filter(request => request.type === 'send')[1].requestId);
  assert.equal(f.component.data.text, ''); assert.equal(f.component.data.items[0].content, reply.content);
  assert.equal(f.events[0].name, 'changed'); assert.equal(f.events[0].detail.id, id);
  assert.deepEqual(f.toasts, []);
});

test('游客可读评论，发送需登录；超长内容不能提交，登录失效不会卡住发送状态', async () => {
  const guest = fixture({ guest: true }); await guest.attach();
  guest.component.input({ detail: { value: '想评论' } }); await guest.component.send();
  assert.equal(guest.events[0].name, 'login'); assert.equal(guest.requests.filter(request => request.type === 'send').length, 0);
  const f = fixture(); await f.attach();
  f.component.input({ detail: { value: '😊'.repeat(301) } });
  assert.equal(Array.from(f.component.data.text).length, 50); assert.equal(f.component.data.canSend, true);
  f.component.setData({ text: '字'.repeat(51) }); await f.component.send();
  assert.equal(f.requests.filter(request => request.type === 'send').length, 0);
  let fail;
  const expired = fixture({ send: () => new Promise((resolve, reject) => { fail = reject; }) }); await expired.attach();
  expired.component.input({ detail: { value: '登录过期' } });
  const pending = expired.component.send(); expired.logout(); fail(new Error('请重新登录')); await pending;
  assert.equal(expired.component.data.sending, false); assert.equal(expired.events.at(-1).name, 'login'); assert.equal(expired.toasts.length, 0);
});

test('面板关闭后的迟到读取不更新组件；动态不可见时显示错误并清空评论', async () => {
  let finish;
  const f = fixture({ list: () => new Promise(resolve => { finish = resolve; }) }); const reading = f.attach();
  f.detach(); finish({ items: [reply], hasMore: false, nextOffset: 1 }); await reading;
  assert.equal(f.component.data.items.length, 0);
  const missing = fixture({ cached: { items: [reply], hasMore: false, nextOffset: 1 }, list: () => { throw Object.assign(new Error('动态已不可见'), { code: 'POST_NOT_FOUND' }); } });
  await missing.attach(); assert.equal(missing.component.data.items.length, 0); assert.equal(missing.component.data.error, '动态已不可见');
});

test('动态卡片可进入详情，详情内不重复导航；原地展开和两条杠菜单保留', () => {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/components/square-post/index.js'), 'utf8'), { Component: value => { definition = value; }, require: () => require('../miniprogram/utils/post-image-layout') });
  const events = [];
  const component = { ...definition.methods, data: { post: { _id: id }, expanded: false }, setData(value) { Object.assign(this.data, value); }, triggerEvent(name, detail) { events.push({ name, detail }); } };
  component.open(); assert.equal(events.shift().name, 'open');
  component.data.detail = true; component.open(); assert.equal(events.length, 0);
  component.toggleExpanded(); assert.equal(component.data.expanded, true);
  component.more(); assert.equal(events[0].name, 'more'); assert.equal(events[0].detail.id, id);
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.ok(config.pages.includes('pages/square-detail/index'));
});

const commentEvent = (id, kind) => ({ currentTarget: { dataset: { id, kind } } });
const rootComment = { ...reply, _id: 'root', replyCount: 0, likeCount: 0 };
const childComment = { ...reply, _id: 'child', rootId: 'root', replyToId: 'root', replyToName: '同学', ancestorIds: ['root'] };
const roots = count => ({ items: [{ ...rootComment, replyCount: count }], hasMore: false, nextOffset: 1 });

test('评论菜单区分本人删除与他人举报；删除子回复同步数量且保留编辑正文', async () => {
  const ownChild = { ...childComment, isOwn: true };
  const f = fixture({ cached: roots(1), list: () => roots(1), cachedChildren: { items: [ownChild], hasMore: false, nextOffset: 1 },
    children: () => ({ items: [ownChild], hasMore: false, nextOffset: 1 }),
    remove: () => ({ deletedId: 'child', rootId: 'root', root: rootComment }) });
  await f.attach(); const c = f.component;
  await c.toggleThread(commentEvent('root'));
  c.selectReply(commentEvent('child')); c.input({ detail: { value: '保留草稿' } });
  await c.manageComment(commentEvent('child'));
  assert.equal(f.requests.find(row => row.type === 'sheet').itemList[0], '删除评论');
  assert.equal(c.data.items[0].visibleChildren.length, 0); assert.equal(c.data.items[0].replyCount, 0);
  assert.equal(c.data.replyTarget, null); assert.equal(c.data.text, '保留草稿');
  assert.equal(f.events.at(-1).name, 'changed');
  await c.manageComment(commentEvent('root'));
  assert.equal(f.requests.filter(row => row.type === 'sheet').at(-2).itemList[0], '举报评论');
  assert.equal(f.requests.find(row => row.type === 'report').reason, 'spam');
  assert.equal(f.toasts.at(-1), '举报已提交');
});

test('删除取消或失败保留评论，切换账号后菜单不得继续提交，游客先登录', async () => {
  const own = { ...rootComment, isOwn: true };
  const data = { items: [own], hasMore: false, nextOffset: 1 };
  const cancelled = fixture({ cached: data, list: () => data, confirm: false }); await cancelled.attach();
  await cancelled.component.manageComment(commentEvent('root'));
  assert.equal(cancelled.requests.some(row => row.type === 'delete'), false);
  const failed = fixture({ cached: data, list: () => data, remove: () => { throw new Error('删除失败'); } }); await failed.attach();
  await failed.component.manageComment(commentEvent('root'));
  assert.equal(failed.component.data.items.length, 1); assert.equal(failed.toasts.at(-1), '删除失败');
  const changed = fixture({ cached: data, list: () => data }); await changed.attach();
  const menu = changed.component.manageComment(commentEvent('root')); changed.logout(); await menu;
  assert.equal(changed.requests.some(row => row.type === 'delete'), false);
  const guest = fixture({ guest: true, cached: data, list: () => data }); await guest.attach();
  await guest.component.manageComment(commentEvent('root')); assert.equal(guest.events.at(-1).name, 'login');
});

test('点赞、心碎与恢复立即绘制，连续操作的旧响应不覆盖最后选择，失败恢复已确认状态', async () => {
  const writes = [];
  const f = fixture({ cached: roots(1), list: () => roots(1), state: (id, kind, active) => new Promise((resolve, reject) => writes.push({ kind, active, resolve, reject })) });
  await f.attach(); const c = f.component;
  const folding = c.reactComment(commentEvent('root', 'fold')); assert.equal(c.data.items[0].folded, true);
  const liking = c.reactComment(commentEvent('root', 'like'));
  assert.equal(c.data.items[0].folded, false); assert.equal(c.data.items[0].liked, true); assert.equal(c.data.items[0].likeCount, 1);
  writes[0].resolve({ ...rootComment, replyCount: 1, folded: true, liked: false }); await folding;
  assert.equal(c.data.items[0].folded, false); assert.equal(c.data.items[0].liked, true);
  writes[1].resolve({ ...rootComment, replyCount: 1, folded: false, liked: true, likeCount: 1 }); await liking;
  const failed = c.reactComment(commentEvent('root', 'fold')); assert.equal(c.data.items[0].folded, true);
  writes[2].reject(new Error('网络失败')); await failed;
  assert.equal(c.data.items[0].folded, false); assert.equal(c.data.items[0].liked, true); assert.equal(f.toasts.at(-1), '网络失败');
});

test('发送立即出现明确的发送中回复，不改变原有折叠数量，失败恢复原文和对象，重试不重复', async () => {
  let resolve, reject;
  const f = fixture({ cached: roots(2), list: () => roots(2), send: () => new Promise((yes, no) => { resolve = yes; reject = no; }) });
  await f.attach(); const c = f.component;
  c.selectReply(commentEvent('root')); c.input({ detail: { value: '这是一条回复' } });
  const failed = c.send();
  assert.equal(c.data.text, ''); assert.equal(c.data.sending, true);
  assert.equal(c.data.items[0].freshChildren.length, 1); assert.equal(c.data.items[0].freshChildren[0].pending, true);
  assert.equal(c.data.items[0].freshChildren[0].content, '这是一条回复'); assert.equal(c.data.items[0].remainingCount, 2);
  assert.equal(f.events.length, 0); assert.equal(f.toasts.length, 0);
  reject(new Error('审核或网络失败')); await failed;
  assert.equal(c.data.text, '这是一条回复'); assert.equal(c.data.replyTarget.id, 'root'); assert.equal(c.data.items[0].freshChildren.length, 0);
  const retry = c.send(); resolve({ reply: childComment, root: { ...rootComment, replyCount: 3 } }); await retry;
  assert.equal(f.requests.filter(row => row.type === 'send')[0].requestId, f.requests.filter(row => row.type === 'send')[1].requestId);
  assert.equal(c.data.items[0].freshChildren.length, 1); assert.equal(c.data.items[0].freshChildren[0]._id, 'child');
  assert.equal(c.data.items[0].freshChildren[0].pending, undefined); assert.equal(c.data.items[0].remainingCount, 2);
});

test('一级评论发送中可见但不进入真实缓存，关闭后的迟到确认不操作已卸载面板', async () => {
  let finish;
  const f = fixture({ send: () => new Promise(resolve => { finish = resolve; }) }); await f.attach();
  f.component.input({ detail: { value: '一级评论' } }); const sending = f.component.send();
  assert.equal(f.component.data.items.length, 1); assert.equal(f.component.data.items[0].pending, true);
  assert.equal(f.component._roots.length, 0); f.detach();
  finish({ reply: { ...rootComment, content: '一级评论' } }); await sending; assert.equal(f.events.length, 0);
});

test('详情内嵌评论占据导航下方，键盘仅压缩正文区域，不能误触面板拖动', async () => {
  const f = fixture({ cached: roots(0), list: () => roots(0) });
  const c = f.component;
  Object.assign(c.data, { embedded: true, topOffset: 92 });
  await f.attach();
  assert.equal(c.data.sheetTop, 92);
  c.input({ detail: { value: '保留输入' } });
  c.dragStart(touch(300)); c.dragEnd(release(0));
  assert.equal(c.data.sheetTop, 92); assert.equal(c.data.dragging, false);
  c.keyboard({ detail: { height: 390 } });
  assert.equal(c.data.keyboardTop, 92);
  assert.equal(c.data.viewportHeight - c.data.keyboardTop - c.data.keyboardHeight, 330);
  c.keyboard({ detail: { height: 0 } }); c.measureSheet();
  assert.equal(c.data.sheetTop, 92); assert.equal(c.data.text, '保留输入');
  c.focusComposer(); assert.equal(c.data.inputFocused, true);
  const guest = fixture({ guest: true }); await guest.attach(); guest.component.focusComposer();
  assert.equal(guest.events.at(-1).name, 'login');
});

test('内嵌评论沿用目标回复、发送、独立新回复和折叠行为', async () => {
  const f = fixture({ cached: roots(2), list: () => roots(2), send: () => ({ reply: childComment, root: { ...rootComment, replyCount: 3 } }) });
  const c = f.component;
  Object.assign(c.data, { embedded: true, topOffset: 92 });
  await f.attach(); c.selectReply(commentEvent('root'));
  c.input({ detail: { value: '详情页回复' } }); await c.send();
  assert.equal(f.requests.find(row => row.type === 'send').replyToId, 'root');
  assert.equal(c.data.items[0].freshChildren[0]._id, 'child');
  assert.equal(c.data.items[0].remainingCount, 2);
  assert.equal(c.data.items[0].showExpand, true); assert.equal(c.data.items[0].showCollapse, false);
  assert.equal(f.events.at(-1).name, 'changed');
});
test('零回复评论的新回复立即显示并可收起，关闭重开后恢复默认折叠', async () => {
  const f = fixture({ cached: roots(0), list: () => roots(0), send: () => ({ reply: childComment, root: { ...rootComment, replyCount: 1 } }) });
  await f.attach(); const c = f.component;
  c.selectReply(commentEvent('root')); c.input({ detail: { value: '第一条回复' } }); await c.send();
  assert.equal(f.requests.find(row => row.type === 'send').replyToId, 'root');
  assert.equal(c.data.items[0].showExpand, false); assert.equal(c.data.items[0].freshChildren[0]._id, 'child');
  assert.equal(c.data.items[0].showCollapse, true); assert.equal(c.data.replyTarget, null);
  c.collapseThread(commentEvent('root')); assert.equal(c.data.items[0].freshChildren.length, 0);
  assert.equal(c.data.items[0].showExpand, true); assert.equal(c.data.items[0].remainingCount, 1);
  f.detach();
  const reopened = fixture({ cached: roots(1), list: () => roots(1), cachedChildren: { items: [childComment], hasMore: false, nextOffset: 1 } });
  await reopened.attach(); assert.equal(reopened.component.data.items[0].freshChildren.length, 0);
  assert.equal(reopened.component.data.items[0].showExpand, true);
});

test('已有回复保持折叠，新回复独立显示；展开和分页不会重复插入新回复', async () => {
  const old = { ...childComment, _id: 'old' };
  const f = fixture({ cached: roots(2), list: () => roots(2), cachedChildren: { items: [old], hasMore: true, nextOffset: 1 },
    children: args => ({ items: args.offset ? [old, childComment, { ...old, _id: 'second' }] : [old, childComment], hasMore: !args.offset, nextOffset: args.offset ? 3 : 2 }),
    send: () => ({ reply: childComment, root: { ...rootComment, replyCount: 3 } }) });
  await f.attach(); const c = f.component;
  c.selectReply(commentEvent('root')); c.input({ detail: { value: '新增' } }); await c.send();
  assert.equal(c.data.items[0].children.length, 0); assert.equal(c.data.items[0].remainingCount, 2);
  assert.equal(c.data.items[0].showExpand, true); assert.equal(c.data.items[0].freshChildren.length, 1);
  assert.equal(c.data.items[0].showCollapse, false);
  await c.toggleThread(commentEvent('root'));
  assert.equal(c.data.items[0].showExpand, false); assert.equal(c.data.items[0].showCollapse, true);
  assert.equal(c.data.items[0].children.length, 1); assert.equal(c.data.items[0].freshChildren.length, 1);
  await c.moreChildren(commentEvent('root'));
  assert.equal(f.requests.filter(row => row.type === 'children').at(-1).offset, 2);
  assert.equal(c.data.items[0].children.length, 2); assert.equal(c.data.items[0].freshChildren.length, 1);
  c.selectReply(commentEvent('child')); assert.equal(c.data.replyTarget.id, 'child'); assert.equal(c.data.replyTarget.rootId, 'root');
  c.collapseThread(commentEvent('root')); assert.equal(c.data.items[0].remainingCount, 3);
  assert.equal(c.data.items[0].showExpand, true); assert.equal(c.data.items[0].showCollapse, false);
});

test('心碎隐藏整组回复，恢复后显示原状态；失败不伪造折叠，点赞不清空草稿', async () => {
  let root = { ...rootComment, replyCount: 1 }, failed = false;
  const f = fixture({ cached: { ...roots(1), items: [root] }, list: () => ({ ...roots(1), items: [root] }),
    cachedChildren: { items: [childComment], hasMore: false, nextOffset: 1 }, children: () => ({ items: [childComment], hasMore: false, nextOffset: 1 }),
    state: (id, kind, active) => { if (failed) throw new Error('网络失败'); root = { ...root, [kind === 'fold' ? 'folded' : 'liked']: active }; return root; } });
  await f.attach(); const c = f.component; await c.toggleThread(commentEvent('root'));
  c.input({ detail: { value: '保留这段内容' } });
  await c.reactComment(commentEvent('root', 'like')); assert.equal(c.data.items[0].liked, true); assert.equal(c.data.text, '保留这段内容');
  c.selectReply(commentEvent('child')); await c.reactComment(commentEvent('root', 'fold'));
  assert.equal(c.data.items[0].folded, true); assert.equal(c.data.items[0].children.length, 0); assert.equal(c.data.replyTarget, null);
  await c.reactComment(commentEvent('root', 'fold')); assert.equal(c.data.items[0].children.length, 1);
  failed = true; await c.reactComment(commentEvent('root', 'fold')); assert.equal(c.data.items[0].folded, false);
  assert.equal(f.toasts.at(-1), '网络失败');
});

test('折叠子评论时隐藏其后续回复，其他同级回复保留', () => {
  const { commentGroups } = require('../miniprogram/utils/comment-threads');
  const descendant = { ...childComment, _id: 'nested', replyToId: 'child', ancestorIds: ['root', 'child'] };
  const sibling = { ...childComment, _id: 'sibling' };
  const threads = new Map([['root', { items: [{ ...childComment, folded: true }, descendant, sibling], open: true, fresh: new Set() }]]);
  const result = commentGroups([{ ...rootComment, replyCount: 3 }], threads)[0];
  assert.deepEqual(result.children.map(row => row._id), ['child', 'sibling']);
  assert.equal(result.children[0].folded, true);
});

test('已点赞又心碎的评论再次点击爱心发送点赞目标状态，并恢复评论与回复可见', async () => {
  const root = { ...rootComment, replyCount: 1, liked: true, folded: true, likeCount: 1 };
  const f = fixture({ cached: { ...roots(1), items: [root] }, list: () => ({ ...roots(1), items: [root] }),
    children: () => ({ items: [childComment], hasMore: false, nextOffset: 1 }),
    state: (id, kind, active) => ({ ...root, liked: active, folded: false }) });
  await f.attach(); const c = f.component;
  await c.reactComment(commentEvent('root', 'like'));
  assert.equal(f.requests.find(row => row.type === 'state').active, true);
  assert.equal(c.data.items[0].folded, false); assert.equal(c.data.items[0].liked, true); assert.equal(c.data.items[0].likeCount, 1);
  assert.equal(c.data.items[0].showExpand, true);
  await c.toggleThread(commentEvent('root')); assert.equal(c.data.items[0].children.length, 1);
  await c.reactComment(commentEvent('root', 'like'));
  assert.equal(f.requests.filter(row => row.type === 'state').at(-1).active, false);
});


test('评论码点50字截断、圆环阈值、删除重置及小萃焦点保留', async () => {
  const f = fixture(); await f.attach(); const c = f.component;
  c.focusInput(); c.keyboard({ detail: { height: 320 } });
  const updates = []; const update = c.setData; c.setData = function(v) { updates.push(v); update.call(this, v); };
  c.askXiaocui(); assert.ok(!updates.some(v => Object.hasOwn(v, 'inputFocused'))); assert.equal(c.data.keyboardHeight, 320);
  const marker = c.data.inputValue; c.input({ detail: { value: marker + '😊'.repeat(160) } });
  assert.equal(c.data.count, 50); assert.equal(c.data.remainingCount, 0); assert.equal(c.data.countProgress, 360); assert.equal(c.data.limitHintVisible, true);
  assert.equal(Array.from(c.data.text).length, 46);
  c.input({ detail: { value: '字'.repeat(39) } }); assert.equal(c.data.countWarning, false);
  c.input({ detail: { value: '字'.repeat(40) } }); assert.equal(c.data.countWarning, true); assert.equal(c.data.remainingCount, 10);
  c.input({ detail: { value: '' } }); assert.equal(c.data.count, 0); assert.equal(c.data.countProgress, 0); assert.equal(c.data.limitHintVisible, false);
  const markup = fs.readFileSync('miniprogram/components/comments-sheet/index.wxml', 'utf8');
  assert.match(markup, /textarea[^>]* fixed hold-keyboard/); assert.ok(!markup.includes('<input '));
  f.detach();
});


test('评论原生输入框独立类样式去除iOS内边距，不用覆盖提示叠加拼音预编辑区', async () => {
  const markup = fs.readFileSync('miniprogram/components/comments-sheet/index.wxml', 'utf8');
  const css = fs.readFileSync('miniprogram/components/comments-sheet/index.wxss', 'utf8');
  const field = markup.match(/<textarea\b[^>]*>/)[0];
  assert.match(field, /class="comment-textarea"/);
  assert.match(field, /disable-default-padding="{{true}}"/);
  assert.match(field, /placeholder="{{askAI \? '' : '添加回复...'}}"/);
  assert.ok(!markup.includes('composer-ai-placeholder')); assert.ok(!css.includes('composer-ai-placeholder'));
  assert.ok(!css.includes('.comment-input-pill textarea'));
  assert.match(css, /\.comment-textarea[^}]*padding: 0/);
  assert.match(css, /\.comment-textarea[^}]*line-height: 40rpx/);
  assert.match(css, /\.comment-entry[^}]*display: block/);
  const f = fixture(); await f.attach(); const c = f.component;
  c.focusInput(); c.askXiaocui(); const marker = c.data.inputValue;
  // 拼音候选还未产生input事件时，正文仍为空，但模板中已没有可以覆盖光标的提示节点。
  assert.equal(c.data.askAI, true); assert.equal(c.data.text, '');
  c.input({ detail: { value: marker + 'nihao' } }); assert.equal(c.data.text, 'nihao');
  c.input({ detail: { value: marker + '你好' } }); assert.equal(c.data.text, '你好');
  c.input({ detail: { value: marker } }); assert.equal(c.data.text, ''); assert.equal(c.data.askAI, true);
  c.input({ detail: { value: '' } }); assert.equal(c.data.askAI, false);
  f.detach();
});


test('小萃首行占位不计数不提交，部分退格原子删除胶囊且保留正文前导全角空格', async () => {
  const f = fixture(); await f.attach(); const c = f.component;
  c.askXiaocui(); const prefix = c.data.inputValue;
  c.input({ detail: { value: prefix + '第一行\n第二行' } });
  assert.equal(c.data.text, '第一行\n第二行'); assert.equal(c.data.count, Array.from('@小萃 第一行\n第二行').length);
  await c.send(); assert.equal(f.requests.filter(r => r.type === 'send').at(-1).content, '@小萃 第一行\n第二行');
  for (let index = 0; index < prefix.length; index++) {
    c.setReplyInput('　保留正文', true);
    c.input({ detail: { value: prefix.slice(0, index) + prefix.slice(index + 1) + '　保留正文' } });
    assert.equal(c.data.askAI, false); assert.equal(c.data.text, '　保留正文');
  }
  c.setReplyInput('', true); c.input({ detail: { value: prefix.slice(0, -1) } });
  assert.equal(c.data.askAI, false); assert.equal(c.data.count, 0); assert.equal(c.data.inputValue, '');
  f.detach();
});

test('胶囊属于首行内容，原生输入自然增减高度；计数器始终在输入区域外右下对齐', async () => {
  const markup = fs.readFileSync('miniprogram/components/comments-sheet/index.wxml', 'utf8');
  const css = fs.readFileSync('miniprogram/components/comments-sheet/index.wxss', 'utf8');
  assert.match(markup, /class="comment-input-content"><textarea[^>]*auto-height[^>]*\/>\s*<view[^>]*class="composer-ai-chip composer-ai-mention"/);
  assert.match(markup, /<\/view>\s*<\/view>\s*<view class="comment-counter-slot/);
  assert.match(css, /\.composer-ai-mention[^}]*position: absolute[^}]*top: 3rpx[^}]*left: 0[^}]*width: 84rpx/);
  assert.match(css, /\.comment-counter-slot[^}]*align-self: flex-end[^}]*margin-bottom: 6rpx/);
  assert.match(css, /\.comment-textarea[^}]*max-height: 200rpx/);
  assert.ok(!css.includes('.comment-input-scroll'));
  assert.ok(!markup.includes('<scroll-view class="comment-input-scroll"')); // 不再让原生textarea成为滚动组件子节点。
  const f = fixture(); await f.attach(); const c = f.component;
  c.setReplyInput('', false); assert.equal(c.data.inputValue, '');
  f.detach();
});


test('评论回车保留原生键盘，普通及小萃多行输入都不收键盘、不重聚焦、不直接发送', async () => {
  const markup = fs.readFileSync('miniprogram/components/comments-sheet/index.wxml', 'utf8');
  const field = markup.match(/<textarea\b[^>]*>/)[0];
  assert.match(field, /confirm-type="return"/); assert.match(field, /confirm-hold="{{true}}"/);
  assert.ok(!field.includes('bindconfirm="send"'));
  const f = fixture(); await f.attach(); const c = f.component;
  for (const ai of [false, true]) {
    c.setReplyInput('', false); c.focusInput(); c.keyboard({ detail: { height: 320 } });
    if (ai) c.askXiaocui(); const prefix = ai ? c.data.inputValue : '';
    const writes = []; const update = c.setData;
    c.setData = function(v) { writes.push(v); update.call(this, v); };
    for (const value of ['第一行\n', '第一行\n第二行\n', '软换行'.repeat(10), '\n'.repeat(6)]) {
      c.input({ detail: { value: prefix + value, cursor: (prefix + value).length } });
      assert.equal(c.data.inputFocused, true); assert.equal(c.data.keyboardHeight, 320); assert.equal(c.data.text, value);
    }
    assert.ok(!writes.some(v => Object.hasOwn(v, 'inputFocused'))); c.setData = update;
  }
  assert.equal(f.keyboardHides(), 0); assert.equal(f.requests.filter(r => r.type === 'send').length, 0);
  f.detach();
});


test('正常键入、回车与软换行不回写原生value/cursor/focus，显式清空及重复超限仍能同步原生框', async () => {
  const f = fixture(); await f.attach(); const c = f.component;
  c.focusInput(); assert.equal(c.data.inputFocusRequested, false);
  const writes = [], update = c.setData;
  c.setData = function(v) { writes.push(v); update.call(this, v); };
  for (const value of ['拼音', '第一行\n', '第一行\n第二行', '\n'.repeat(8), '软换行'.repeat(12)]) {
    c.input({ detail: { value, cursor: value.length } });
    assert.equal(c.data.inputValue, value);
  }
  assert.ok(writes.every(v => !['nativeInputValue', 'inputCursor', 'inputFocusRequested', 'inputHeight', 'inputScrollTop'].some(key => Object.hasOwn(v, key))));
  writes.length = 0; c.setReplyInput('', false);
  assert.equal(c.data.nativeInputValue, ''); assert.ok(writes.some(v => v.nativeInputValue === '软换行'.repeat(12))); assert.equal(writes.at(-1).nativeInputValue, '');
  const over = '字'.repeat(51); c.input({ detail: { value: over } }); assert.equal(c.data.nativeInputValue, '字'.repeat(50));
  writes.length = 0; c.input({ detail: { value: over } });
  assert.equal(writes.filter(v => Object.hasOwn(v, 'nativeInputValue'))[0].nativeInputValue, over); assert.equal(writes.at(-1).nativeInputValue, '字'.repeat(50));
  c.askXiaocui(); writes.length = 0;
  c.setReplyInput('短正文', true); writes.length = 0;
  c.input({ detail: { value: c.data.inputValue + '\n' } });
  assert.ok(writes.every(v => !Object.hasOwn(v, 'nativeInputValue')));
  c.blurInput(); assert.equal(c.data.inputFocusRequested, false); c.focusComposer(); assert.equal(c.data.inputFocusRequested, true);
  f.detach();
});

test('评论textarea无scroll-view或拦截祖先，不绑定行高回写；安卓窗口缩小时不重复减键盘高度', async () => {
  const markup = fs.readFileSync('miniprogram/components/comments-sheet/index.wxml', 'utf8');
  const stack = []; let ancestors;
  for (const match of markup.matchAll(/<([\w-]+)\b([^>]*?)>|<\/([\w-]+)\s*>/g)) {
    if (match[3]) { stack.pop(); continue; }
    if (match[1] === 'textarea') { ancestors = [...stack]; break; }
    if (!match[2].trimEnd().endsWith('/')) stack.push({ tag: match[1], attr: match[2] });
  }
  assert.ok(ancestors && ancestors.every(n => n.tag !== 'scroll-view' && !n.attr.includes('catchtouchmove') && !n.attr.includes('inputSurfaceHeight')));
  const field = markup.match(/<textarea\b[^>]*>/)[0]; assert.match(field, /value="{{nativeInputValue}}"/); assert.match(field, /focus="{{inputFocusRequested}}"/);
  assert.ok(!field.includes('bindlinechange="inputLines"')); assert.ok(!markup.includes('scroll-top="{{inputScrollTop}}"'));
  const window = { windowHeight: 812, windowWidth: 375, statusBarHeight: 44 };
  const f = fixture({ window }); await f.attach(); const c = f.component;
  c.focusInput(); c.keyboard({ detail: { height: 320 } }); const originalTop = c.data.sheetTop, available = c.data.viewportHeight - c.data.keyboardTop - c.data.keyboardHeight;
  window.windowHeight = 492; c.measureSheet(); assert.equal(c.data.viewportHeight, 812); assert.equal(c.data.sheetTop, originalTop);
  assert.equal(c.data.viewportHeight - c.data.keyboardTop - c.data.keyboardHeight, available);
  f.detach();
});


test('换行诊断零界面更新，增行和退格缩行均不更新高度或原生绑定', async () => {
  const f = fixture(); await f.attach(); const c = f.component;
  c._inputDebug = true;
  const writes = [], update = c.setData;
  c.setData = function(value) { writes.push(value); update.call(this, value); };
  for (const lines of [...Array.from({ length: 30 }, (_, i) => i + 1), ...Array.from({ length: 30 }, (_, i) => 30 - i)]) {
    c.traceInputLines({ detail: { lineCount: lines, height: lines * 19.5, value: '绝不进入日志的正文' } });
  }
  assert.equal(writes.length, 0); assert.equal(c._inputTrace.length, 16);
  assert.ok(!JSON.stringify(c._inputTrace).includes('绝不进入日志的正文'));
  c._inputDebug = false; f.detach();
});

test('普通与小萃输入和退格合并换行不回写原生值/光标/焦点，清空亦不设置高度', async () => {
  for (const askAI of [false, true]) {
    const f = fixture(); await f.attach(); const c = f.component;
    c.focusComposer(); c.keyboard({ detail: { height: 320 } }); if (askAI) c.askXiaocui();
    const prefix = askAI ? c.data.inputValue : '';
    const writes = [], update = c.setData;
    c.setData = function(value) { writes.push(value); update.call(this, value); };
    // 包括实际回车删除、单纯字数减少引起的软折行合并及删除到临界字数以下。
    for (const text of ['第一行', '第一行\n第二行', '第一行\n第二行\n第三行', '第一行\n第二行\n第三',
      '第一行\n第二行第三', '第一行第二行第三', '字'.repeat(46), '字'.repeat(39), '字'.repeat(20), '字', '']) {
      c.input({ detail: { value: prefix + text } });
      c.traceInputLines({ detail: { lineCount: Math.max(1, text.split('\n').length) } });
      assert.equal(c.data.text, text); assert.equal(c.data.inputFocused, true); assert.equal(c.data.inputFocusRequested, true);
      assert.equal(c.data.keyboardHeight, 320);
    }
    assert.ok(writes.every(value => !['nativeInputValue', 'inputCursor', 'inputFocused', 'inputFocusRequested', 'inputSurfaceHeight', 'inputBoxHeight'].some(key => Object.hasOwn(value, key))));
    assert.equal(f.keyboardHides(), 0); f.detach();
  }
});

test('背景直接贴合原生实际高度，文字顶对齐，textarea无滚动或动态尺寸祖先', () => {
  const markup = fs.readFileSync('miniprogram/components/comments-sheet/index.wxml', 'utf8');
  const css = fs.readFileSync('miniprogram/components/comments-sheet/index.wxss', 'utf8');
  assert.ok(!markup.includes('comment-pill-surface')); assert.ok(!markup.includes('inputSurfaceHeight'));
  assert.ok(!markup.includes('comment-input-scroll'));
  assert.match(markup, /class="comment-entry"><view class="comment-input-content"><textarea/);
  assert.match(markup.match(/<textarea\b[^>]*>/)[0], /auto-height bindlinechange="traceInputLines"/);
  assert.match(css, /\.comment-input-pill[^}]*align-items: flex-start[^}]*padding: 15rpx 20rpx[^}]*background: #ededee/);
  assert.match(css, /\.comment-textarea[^}]*min-height: 40rpx[^}]*max-height: 200rpx/);
  for (const selector of ['comment-textarea', 'comment-input-content', 'comment-entry', 'comment-input-pill']) {
    const rule = css.match(new RegExp('\\.' + selector + ' \\{([^}]+)\\}'))[1];
    assert.ok(!/transition|animation|transform|overflow/.test(rule), selector);
  }
});

test('键盘仍打开时原生缩行的临时blur不发送取消聚焦指令，真实收键盘后才解除请求', async () => {
  const f = fixture(); await f.attach(); const c = f.component;
  c.focusComposer(); c.keyboard({ detail: { height: 320 } });
  c.input({ detail: { value: '第一行\n第二行' } });
  const writes = [], update = c.setData;
  c.setData = function(value) { writes.push(value); update.call(this, value); };
  c.input({ detail: { value: '第一行第二行' } }); c.traceInputLines({ detail: { lineCount: 1, height: 20 } }); c.blurInput();
  assert.equal(c.data.inputFocused, false); assert.equal(c.data.inputFocusRequested, true);
  assert.ok(writes.every(value => !Object.hasOwn(value, 'inputFocusRequested')));
  c.focusInput(); assert.equal(c.data.inputFocused, true); assert.equal(f.keyboardHides(), 0);
  c.keyboard({ detail: { height: 0 } }); assert.equal(c.data.inputFocusRequested, false);
  c.blurInput(); assert.equal(c.data.inputFocused, false); f.detach();
});

test('点击发送立即收键盘并恢复面板，不等待云端确认且成功回调不再收键盘', async () => {
  for (const askAI of [false, true]) {
  let finish;
  const f = fixture({ send: () => new Promise(resolve => { finish = resolve; }) }); await f.attach(); const c = f.component;
  c.focusComposer(); c.keyboard({ detail: { height: 320 } }); if (askAI) c.askXiaocui();
  c.input({ detail: { value: (askAI ? c.data.inputValue : '') + '发送正文' } });
  const sending = c.send(); assert.equal(f.keyboardHides(), 1); assert.equal(c.data.sending, true);
  assert.equal(c.data.inputFocusRequested, false); assert.equal(c.data.keyboardHeight, 0);
  finish({ reply }); await sending;
  assert.equal(f.keyboardHides(), 1); assert.equal(c.data.inputFocused, false); assert.equal(c.data.inputFocusRequested, false);
  assert.equal(c.data.keyboardHeight, 0); assert.equal(c.data.keyboardTop, c.keyboardTop(c.data.sheetTop, 0));
  assert.equal(c.data.text, ''); assert.equal(c.data.sendError, ''); f.detach();
  }
});

test('空白、超限、隐藏或卸载组件不进入发送，也不收键盘', async () => {
  for (const invalid of ['empty', 'long', 'hidden', 'dead']) {
    const f = fixture(); await f.attach(); const c = f.component;
    c.setReplyInput('正文', false);
    if (invalid === 'empty') c.setReplyInput('', false);
    if (invalid === 'long') c.setData({ text: '字'.repeat(51) });
    if (invalid === 'hidden') c._pageHidden = true;
    if (invalid === 'dead') f.detach();
    await c.send(); assert.equal(f.keyboardHides(), 0, invalid);
    assert.equal(f.requests.filter(row => row.type === 'send').length, 0, invalid);
    if (invalid !== 'dead') f.detach();
  }
});

test('点击发送先收键盘，失败保留正文、回复对象和小萃选择，不自动重新聚焦', async () => {
  const f = fixture({ send: async () => { throw new Error('审核暂不可用'); } }); await f.attach(); const c = f.component;
  const target = { id: 'parent', rootId: 'root', nickname: '同学' };
  c.askXiaocui(); c.keyboard({ detail: { height: 320 } }); c.input({ detail: { value: c.data.inputValue + '正文' } });
  c.setData({ replyTarget: target }); await c.send();
  assert.equal(f.keyboardHides(), 1); assert.equal(c.data.text, '正文'); assert.equal(c.data.askAI, true);
  assert.deepEqual(c.data.replyTarget, target); assert.equal(c.data.sendError, '审核暂不可用');
  assert.equal(c.data.inputFocusRequested, false); assert.equal(c.data.inputFocused, false); assert.equal(c.data.keyboardHeight, 0); f.detach();
});

test('切页、卸载或切换会话后的迟到发送确认不能收其他页面键盘', async () => {
  for (const action of ['hide', 'detach', 'logout']) {
    let finish;
    const f = fixture({ send: () => new Promise(resolve => { finish = resolve; }) }); await f.attach(); const c = f.component;
    c.input({ detail: { value: '原页面正文' } }); const sending = c.send();
    if (action === 'hide') c._pageHidden = true;
    else f[action]();
    assert.equal(f.keyboardHides(), 1, action);
    finish({ reply }); await sending; assert.equal(f.keyboardHides(), 1, action);
    if (action !== 'detach') f.detach();
  }
});

test('立即收键盘的API失败仍继续提交评论，不误报发送失败', async () => {
  for (const hideKeyboard of [args => args.fail({ errMsg: 'hideKeyboard:fail' }), () => { throw new Error('API unavailable'); }]) {
    const f = fixture({ hideKeyboard }); await f.attach(); const c = f.component;
    c.input({ detail: { value: '已经提交' } }); await c.send();
    assert.equal(f.keyboardHides(), 1); assert.equal(c.data.text, ''); assert.equal(c.data.sendError, '');
    assert.ok(c.data.items.some(row => row._id === reply._id)); assert.equal(f.events.filter(event => event.name === 'changed').length, 1);
    f.detach();
  }
});


test('评论单行文字/胶囊/竖线圆环共用垂直中线，真机基线补偿不用于开发工具', async () => {
  const css = fs.readFileSync('miniprogram/components/comments-sheet/index.wxss', 'utf8');
  const rule = name => css.slice(css.indexOf(name + ' {') + name.length + 2).split('}')[0];
  const dimension = (selector, key) => Number(rule(selector).match(new RegExp('(?:^|[;\\s])' + key + ': ([0-9.]+)rpx'))[1]);
  const line = dimension('.comment-textarea', 'line-height'), font = dimension('.comment-textarea', 'font-size');
  const inset = dimension('.comment-input-content', 'padding');
  const baseline = dimension('.has-native-textarea-metrics .comment-textarea', 'top');
  const chip = dimension('.composer-ai-mention', 'top') + dimension('.composer-ai-chip', 'height') / 2;
  assert.equal(baseline, (line - font) / 2);
  for (const lines of [1, 2, 5]) {
    const contentHeight = inset * 2 + line * lines;
    const lastTextCenter = inset + baseline + font / 2 + line * (lines - 1);
    const counterCenter = contentHeight - dimension('.comment-counter-slot', 'margin-bottom') - dimension('.comment-progress-anchor', 'height') / 2;
    assert.equal(lastTextCenter, counterCenter);
    assert.equal(chip, inset + baseline + font / 2);
  }
  assert.equal(dimension('.comment-input-content', 'min-height'), line + inset * 2);
  for (const platform of ['ios', 'android', 'ohos', 'devtools', 'windows']) {
    const f = fixture({ platform }); await f.attach();
    assert.equal(f.component.data.nativeTextareaMetrics, ['ios', 'android', 'ohos'].includes(platform));
    f.detach();
  }
});
