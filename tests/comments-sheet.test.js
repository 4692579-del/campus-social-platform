const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const user = { _id: 'alice' }, id = 'p_' + 'a'.repeat(40);
const reply = { _id: 'reply', content: '真实评论', author: { nickname: '同学' }, createdAt: '2026-11-18T00:00:00Z' };
function fixture(options = {}) {
  let definition, current = options.guest ? null : user, version = 0;
  const events = [], requests = [], toasts = [];
  const users = { getCachedUser: () => current, getSessionVersion: () => version };
  const square = { cachedReplies: () => options.cached || null,
    cachedChildren: () => options.cachedChildren || null,
    listChildren: async (postId, rootId, args) => { requests.push({ type: 'children', postId, rootId, ...args }); return options.children ? options.children(args) : { items: [], hasMore: false, nextOffset: 0 }; },
    commentState: async (postId, replyId, kind, active) => { requests.push({ type: 'state', postId, replyId, kind, active }); return options.state(replyId, kind, active); },
    listReplies: async (postId, args) => { requests.push({ type: 'list', postId, ...args }); return options.list ? options.list(args) : { items: [], hasMore: false, nextOffset: 0 }; },
    reply: async (postId, content, requestId, replyToId) => { requests.push({ type: 'send', postId, content, requestId, replyToId }); return options.send ? options.send() : { post: { _id: id, replyCount: 1 }, reply: { ...reply, content } }; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/components/comments-sheet/index.js'), 'utf8'), {
    Component: value => { definition = value; }, wx: { hideKeyboard() {}, showToast: value => toasts.push(value.title),
      getWindowInfo: () => options.window || { windowHeight: 812, statusBarHeight: 44 },
      getMenuButtonBoundingClientRect: () => options.capsule || { top: 52, height: 32 } },
    require: name => name.includes('services/user') ? users : name.includes('services/square') ? square : name.includes('comment-threads') ? require('../miniprogram/utils/comment-threads') : require('../miniprogram/utils/post-view'),
  });
  const component = { ...definition.methods, data: { ...structuredClone(definition.data), postId: id, viewer: current },
    setData(value) { Object.assign(this.data, value); }, triggerEvent(name, detail) { events.push({ name, detail }); } };
  return { component, events, requests, toasts, attach: () => definition.lifetimes.attached.call(component), detach: () => definition.lifetimes.detached.call(component),
    logout() { current = null; version++; },
  };
}

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

const touch = y => ({ touches: [{ clientY: y }] });
const release = y => ({ touches: [], changedTouches: [{ clientY: y }] });

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
  assert.deepEqual(f.toasts, ['评论已发布']);
});

test('游客可读评论，发送需登录；超长内容不能提交，登录失效不会卡住发送状态', async () => {
  const guest = fixture({ guest: true }); await guest.attach();
  guest.component.input({ detail: { value: '想评论' } }); await guest.component.send();
  assert.equal(guest.events[0].name, 'login'); assert.equal(guest.requests.filter(request => request.type === 'send').length, 0);
  const f = fixture(); await f.attach();
  f.component.input({ detail: { value: '😊'.repeat(301) } }); await f.component.send();
  assert.equal(f.component.data.canSend, false); assert.equal(f.requests.filter(request => request.type === 'send').length, 0);
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

test('动态正文只在卡片内展开，两条杠保留更多操作，不再触发详情导航', () => {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/components/square-post/index.js'), 'utf8'), { Component: value => { definition = value; } });
  const events = [];
  const component = { ...definition.methods, data: { post: { _id: id }, expanded: false }, setData(value) { Object.assign(this.data, value); }, triggerEvent(name, detail) { events.push({ name, detail }); } };
  assert.equal(component.open, undefined);
  component.toggleExpanded(); assert.equal(component.data.expanded, true);
  component.more(); assert.equal(events[0].name, 'more'); assert.equal(events[0].detail.id, id);
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.ok(!config.pages.includes('pages/square-detail/index'));
});

const commentEvent = (id, kind) => ({ currentTarget: { dataset: { id, kind } } });
const rootComment = { ...reply, _id: 'root', replyCount: 0, likeCount: 0 };
const childComment = { ...reply, _id: 'child', rootId: 'root', replyToId: 'root', replyToName: '同学', ancestorIds: ['root'] };
const roots = count => ({ items: [{ ...rootComment, replyCount: count }], hasMore: false, nextOffset: 1 });
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
  await c.toggleThread(commentEvent('root'));
  assert.equal(c.data.items[0].children.length, 1); assert.equal(c.data.items[0].freshChildren.length, 1);
  await c.moreChildren(commentEvent('root'));
  assert.equal(f.requests.filter(row => row.type === 'children').at(-1).offset, 2);
  assert.equal(c.data.items[0].children.length, 2); assert.equal(c.data.items[0].freshChildren.length, 1);
  c.selectReply(commentEvent('child')); assert.equal(c.data.replyTarget.id, 'child'); assert.equal(c.data.replyTarget.rootId, 'root');
  c.collapseThread(commentEvent('root')); assert.equal(c.data.items[0].remainingCount, 3);
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
