const users = require('../../services/user');
const square = require('../../services/square');
const media = require('../../services/post-images');
const { token } = require('../../utils/post-view');
const { commentGroups } = require('../../utils/comment-threads');
const { reactComment: optimisticReaction } = require('../../utils/comment-state');
const { emojiChoices, selectionOf, captureSelection, insertEmoji } = require('../../utils/emoji-input');
// 原生首行保留98rpx给84rpx胶囊和14rpx间隔，后续行自然回到左边界。
// 占位仅用于布局和捕获退格，解码后才计数/发送；不能作为真实空格提交。
const COMMENT_MAX = 50;
const COMMENT_WARNING = 10;
const AI_MENTION_CHARS = 4; // @小萃及正文前的空格
const AI_MARKER = '\u200B';
const AI_PREFIX = AI_MARKER + '\u3000\u3000\u3000\u2002';
function decodeInput(value, selected, previousText) {
  if (selected && value.startsWith(AI_PREFIX)) return { askAI: true, raw: value.slice(AI_PREFIX.length).replace(/\u200B/g, '') };
  // 原正文未变而首行占位被局部删除时，原子删除胶囊，保留正文真实的前导空格。
  if (selected && value.endsWith(previousText)) {
    const fragment = value.slice(0, value.length - previousText.length);
    if (fragment.length <= AI_PREFIX.length && /^[\u200B\u3000\u2002]*$/.test(fragment)) return { askAI: false, raw: previousText };
  }
  if (selected && value.startsWith(AI_MARKER)) value = value.slice(1).replace(/^[\u3000\u2002]{0,4}/, '');
  return { askAI: false, raw: value.replace(/\u200B/g, '') };
}
const replyText = (text, askAI) => askAI ? '@小萃' + (text ? ' ' + text : '') : text;
const reportReasons = [{ key: 'spam', label: '垃圾广告' }, { key: 'illegal', label: '违法违规' },
  { key: 'sexual', label: '色情低俗' }, { key: 'abuse', label: '辱骂骚扰' }, { key: 'other', label: '其他问题' }];
const popup = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));

Component({
  options: { multipleSlots: true },
  properties: { postId: String, viewer: Object, embedded: Boolean, topOffset: Number, focusReplyId: String, focusReplyInput: Boolean, commentsDisabled: Boolean, newsComments: Boolean },
  observers: { topOffset() { if (this._sheetStops && this.data.embedded) this.measureSheet(); },
    focusReplyId() { if (this._roots) this.locateReply(); },
    'commentsDisabled, commentsClosed, newsComments': function () { if (this.commentsAreClosed()) this.closeEmoji(); },
    'postId, viewer._id': function (id, account) {
      const owner = `${id || ''}:${account || ''}`;
      if (owner === this._commentMotionOwner) return;
      this._commentMotionOwner = owner;
      this.clearCommentMotions();
      this.closeEmoji(); this._commentSelection = null;
    } },
  data: { items: [], loading: false, loadingMore: false, error: '', sendError: '', hasMore: false, nextOffset: 0, commentsClosed: false,
    selectedImages: [], choosingImages: false,
    text: '', inputValue: '', nativeInputValue: '', inputCursor: -1, askAI: false, count: 0, remainingCount: COMMENT_MAX, countWarning: false, countProgress: 0, limitHintVisible: false, canSend: false, sending: false, keyboardHeight: 0, keyboardTop: 0,
    viewportHeight: 812, sheetTop: 260, expanded: false, dragging: false,
    replyTarget: null, inputFocused: false, inputFocusRequested: false, nativeTextareaMetrics: false, scrollIntoView: '', emojiOpen: false, emojiChoices },
  lifetimes: {
    attached() {
      try {
        const device = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : wx.getSystemInfoSync();
        this.setData({ nativeTextareaMetrics: ['ios', 'android', 'ohos', 'harmony'].includes(String(device.platform).toLowerCase()) });
      } catch (error) { /* 不支持设备API时保留WebView标准行盒。 */ }
      try { this._inputDebug = wx.getAccountInfoSync().miniProgram.envVersion === 'develop'; } catch (error) { this._inputDebug = false; }
      this._epoch = 0;
      this._commentMotions = new Map();
      this._roots = []; this._threads = new Map(); this._commentClicks = new Map();
      this._removedComments = new Set();
      this._aiPending = new Set(); this._aiTimers = new Map();
      const version = users.getSessionVersion();
      this._mediaVersion = version; this._knownUploads = new Set();
      if (typeof square.subscribeComment === 'function') this._stopComments = square.subscribeComment(row => {
        if (this.valid(0, version)) this.applyCommentRow(row);
      });
      if (typeof square.subscribeAI === 'function') this._stopAI = square.subscribeAI(result => {
        if (!this.valid(0, version) || result.postId !== this.data.postId || !this.findComment(result.reply.rootId)) return;
        const thread = this.thread(result.reply.rootId);
        thread.items = [...thread.items.filter(row => row._id !== result.reply._id), result.reply];
        if (result.created) thread.fresh.add(result.reply._id);
        this.renderComments();
        this.triggerEvent('changed', { id: this.data.postId });
      });
      this.measureSheet();
      const cached = square.cachedReplies(this.data.postId);
      if (cached) this.showReplies(cached);
      return this.load().then(() => this.locateReply());
    },
    detached() { this.clearCommentMotions('', false); this.discardCommentUploads(); clearTimeout(this._limitHintTimer); this._dead = true; this._drag = null; this.clearAITimers(); this._epoch = (this._epoch || 0) + 1; if (this._stopComments) this._stopComments(); if (this._stopAI) this._stopAI(); },
  },
  pageLifetimes: { resize() { this.measureSheet(); }, hide() { this.hideLimitHint(); this._pageHidden = true; this.closeEmoji(); this.clearCommentMotions(); this.clearAITimers(); }, show() {
    this._pageHidden = false;
    if (this._mediaVersion !== users.getSessionVersion()) {
      this.clearCommentMotions('', false);
      this.discardCommentUploads(); this._epoch++; this._pendingReply = null;
      this.setData({ selectedImages: [], choosingImages: false, replyTarget: null }); this.setReplyInput('', false); this.triggerEvent('close'); return;
    }
    this.resumeAIReplies(this._roots); for (const thread of this._threads.values()) this.resumeAIReplies(thread.items);
    if (this.data.focusReplyId) this.locateReply();
  } },
  methods: {
    stopEvent() {},
    commentsAreClosed() { return this.data.newsComments || this.data.commentsDisabled || this.data.commentsClosed; },
    clearCommentMotions(id = '', render = true) {
      if (!this._commentMotions) return;
      const ids = id ? [id] : [...this._commentMotions.keys()];
      let changed = false;
      for (const key of ids) {
        const motion = this._commentMotions.get(key);
        if (!motion) continue;
        clearTimeout(motion.timer); this._commentMotions.delete(key); changed = true;
      }
      if (changed && render && !this._dead && this._roots) this.renderComments();
    },
    startCommentMotion(id, kind, active) {
      if (this._dead || this._pageHidden) return;
      const previous = this._commentMotions.get(id);
      this.clearCommentMotions(id, false);
      const variant = previous && previous.variant === 'a' ? 'b' : 'a', epoch = this._epoch, version = users.getSessionVersion();
      const motion = { variant, likeClass: kind === 'like' ? `comment-${active ? 'like' : 'unlike'}-${variant}` : '',
        foldClass: kind === 'fold' ? `comment-${active ? 'break' : 'restore'}-${variant}` : '' };
      this._commentMotions.set(id, motion);
      motion.timer = setTimeout(() => {
        if (!this.valid(epoch, version) || this._pageHidden || this._commentMotions.get(id) !== motion) return;
        this._commentMotions.delete(id); this.renderComments();
      }, kind === 'fold' && active ? 1320 : 440);
    },
    commentMotionView(row, lookup) {
      const motion = this._commentMotions && this._commentMotions.get(row._id);
      // 只投影到当前组件视图，不把动画状态或额外保留的节点写入共享评论缓存。
      const ancestors = (row.ancestorIds || []).filter(id => id !== row.rootId);
      const foldedAncestor = ancestors.find(id => { const parent = lookup ? lookup.get(id) : this.findComment(id); return parent && parent.folded; });
      const restoringAncestor = !foldedAncestor && ancestors.find(id => {
        const state = this._commentMotions && this._commentMotions.get(id);
        return state && state.foldClass.startsWith('comment-restore-');
      });
      const parentMotion = this._commentMotions && this._commentMotions.get(foldedAncestor || restoringAncestor);
      return { ...row, motionManaged: true, motionLikeClass: motion ? motion.likeClass : '', motionFoldClass: motion ? motion.foldClass : '',
        motionAncestorFolded: Boolean(foldedAncestor), motionAncestorClass: parentMotion ? parentMotion.foldClass : '' };
    },
    isNativeMediaActive() { return Boolean(this._nativeMediaActive); },
    discardCommentUploads(files = [...(this._knownUploads || [])]) {
      if (typeof media.discardUploads === 'function') Promise.resolve().then(() => media.discardUploads(files)).catch(() => {});
    },
    syncImageComposer() {
      this.setData({ canSend: !this.data.choosingImages && Boolean(replyText(this.data.text, this.data.askAI).trim() || this.data.selectedImages.length) && this.data.count <= COMMENT_MAX,
        keyboardTop: this.keyboardTop(this.data.sheetTop, this.data.keyboardHeight) });
    },
    async uploadCommentImages(images, epoch, version) {
      return media.uploadImages(images, (index, fileID) => {
        images[index].fileID = fileID;
        if (!this.valid(epoch, version)) { this.discardCommentUploads([fileID]); return; }
        this._knownUploads.add(fileID);
        const at = this.data.selectedImages.findIndex(image => image.key === images[index].key);
        if (at >= 0) this.setData({ [`selectedImages[${at}].fileID`]: fileID });
      });
    },
    async chooseCommentImages() {
      if (this._dead || this.data.sending || this.data.choosingImages) return;
      if (!users.getCachedUser()) { this.login(); return; }
      if (this.data.selectedImages.length >= 3) { wx.showToast({ title: '一次最多发送3张图片', icon: 'none' }); return; }
      const epoch = this._epoch, version = users.getSessionVersion();
      this.closeEmoji();
      this._nativeMediaActive = true;
      this.setData({ choosingImages: true, sendError: '', inputFocused: false, inputFocusRequested: false, keyboardHeight: 0 });
      if (typeof wx.hideKeyboard === 'function') { try { wx.hideKeyboard({ fail() {} }); } catch (error) { /* 收键盘失败仍允许选择图片。 */ } }
      try {
        const selected = await media.chooseImages(3 - this.data.selectedImages.length);
        if (!this.valid(epoch, version) || !selected.length) return;
        this.setData({ selectedImages: [...this.data.selectedImages, ...selected].slice(0, 3) });
        this._requestId = token(); this.syncImageComposer();
        await this.uploadCommentImages(this.data.selectedImages.map(image => ({ ...image })), epoch, version);
      } catch (error) {
        if (this.valid(epoch, version) && !/cancel/.test(error.errMsg || '')) this.setData({ sendError: error.message || '图片上传失败，请重试' });
      } finally {
        this._nativeMediaActive = false;
        if (this.valid(epoch, version)) { this.setData({ choosingImages: false }); this.syncImageComposer(); }
      }
    },
    removeCommentImage(event) {
      if (this._dead || this.data.sending || this.data.choosingImages) return;
      const index = Number(event.currentTarget.dataset.index), image = this.data.selectedImages[index];
      if (!image) return;
      this.setData({ selectedImages: this.data.selectedImages.filter((_, at) => at !== index), sendError: '' });
      this._requestId = token(); this.syncImageComposer();
      if (image.fileID) { this._knownUploads.delete(image.fileID); this.discardCommentUploads([image.fileID]); }
    },
    async previewCommentImages(event) {
      if (this._dead || this.data.choosingImages) return;
      const data = event.currentTarget.dataset;
      const row = this._pendingReply && this._pendingReply._id === data.id ? this._pendingReply : this.findComment(data.id);
      const files = data.selected ? this.data.selectedImages.map(image => image.path || image.fileID) : row && row.images;
      const current = files && files[Number(event.currentTarget.dataset.index)];
      if (!current) return;
      this._nativeMediaActive = true;
      try { await media.previewImages(files, current); }
      catch (error) { if (!this._dead && error.code !== 'SESSION_CHANGED') wx.showToast({ title: error.message || '图片暂时无法查看', icon: 'none' }); }
      finally { this._nativeMediaActive = false; }
    },
    traceInput(kind, extra = {}) {
      if (!this._inputDebug) return;
      // 仅开发版本地诊断：无正文、拼音、用户标识、令牌或云端发送。
      const event = { kind, time: Date.now(), focused: this.data.inputFocused, requested: this.data.inputFocusRequested,
        keyboard: this.data.keyboardHeight, viewport: this.data.viewportHeight, ...extra };
      this._inputTrace = [...(this._inputTrace || []), event].slice(-16);
      if (kind === 'blur' && this.data.keyboardHeight > 0 && !this.data.sending) console.warn('[comments-input blur]', JSON.stringify(this._inputTrace));
    },
    traceInputLines(event) {
      if (this._dead || this._pageHidden) return;
      const lines = Math.max(1, Number(event.detail.lineCount) || 1);
      this.traceInput('linechange', { lines, height: Math.max(0, Number(event.detail.height) || 0) });
      // 输入和退格缩行均只观测，不setData、不动画、不回写原生尺寸/滚动/焦点。
    },
    clearAITimers() { if (this._aiTimers) { for (const timer of this._aiTimers.values()) clearTimeout(timer); this._aiTimers.clear(); } },
    resumeAIReplies(rows) { for (const row of (rows || []).filter(row => row.aiCanManage && ['queued', 'processing'].includes(row.aiStatus)).slice(0, 2)) this.startAIReply(row); },
    async startAIReply(row, poll = 0) {
      if (!row || !row.aiCanManage || this._dead || this._pageHidden || !square.processAIReply || this._aiPending.has(row._id)) return;
      if (!['queued', 'processing'].includes(row.aiStatus) && !(row.aiStatus === 'failed' && row.aiCanRetry)) return;
      const epoch = this._epoch, version = users.getSessionVersion();
      this._aiPending.add(row._id);
      try {
        const result = await square.processAIReply(this.data.postId, row._id);
        if (this.valid(epoch, version) && !this._pageHidden && result.status === 'processing' && poll < 40 && typeof setTimeout === 'function') {
          const timer = setTimeout(() => { this._aiTimers.delete(row._id); this.startAIReply(row, poll + 1); }, 3000);
          this._aiTimers.set(row._id, timer);
        }
      } catch (error) { /* 正文已发送成功，AI 失败由该评论下的重试状态展示，不恢复输入或弹成功提示。 */ }
      finally { this._aiPending.delete(row._id); }
    },
    retryAI(event) {
      const row = this.findComment(event.currentTarget.dataset.id);
      if (row && row.aiCanRetry) return this.startAIReply(row);
    },
    measureSheet() {
      let width = 375;
      let height = 812, capsuleBottom = 84;
      try {
        const info = wx.getWindowInfo();
        height = info.windowHeight || height;
        width = info.windowWidth || width;
        capsuleBottom = (info.statusBarHeight || 0) + 48;
        const capsule = wx.getMenuButtonBoundingClientRect();
        if (capsule && capsule.height > 0 && capsule.top >= (info.statusBarHeight || 0)) capsuleBottom = capsule.top + capsule.height;
      } catch (error) { /* 不支持布局 API 的客户端使用默认安全位置。 */ }
      if (this._layoutWidth === width && (this.data.inputFocused || this.data.keyboardHeight)) height = Math.max(height, this.data.viewportHeight);
      this._layoutWidth = width;
      this._windowHeight = height;
      const compact = this.data.embedded ? this.data.topOffset : Math.round(height * .32);
      this._sheetStops = { compact, expanded: this.data.embedded ? compact : Math.min(compact, capsuleBottom + 12) };
      this._drag = null;
      const sheetTop = this.data.expanded ? this._sheetStops.expanded : compact;
      this.setData({ viewportHeight: height, sheetTop, dragging: false, keyboardTop: this.keyboardTop(sheetTop, this.data.keyboardHeight) });
    },
    keyboardTop(top, height) {
      if (this.data.embedded) return this.data.topOffset;
      return Math.min(top, Math.max(this._sheetStops.expanded, this._windowHeight - height - (this.data.selectedImages.length ? 320 : 220)));
    },
    touchY(event) {
      const touch = event.touches && event.touches[0] || event.changedTouches && event.changedTouches[0];
      return touch && (typeof touch.clientY === 'number' ? touch.clientY : touch.pageY);
    },
    dragStart(event) {
      const y = this.touchY(event);
      if (this.data.embedded || this._dead || typeof y !== 'number' || !this._sheetStops) return;
      this.closeEmoji();
      if (this.data.keyboardHeight && typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
      this._drag = { y, top: this.data.sheetTop, expanded: this.data.expanded };
      this.setData({ dragging: true, keyboardHeight: 0 });
    },
    dragMove(event) {
      const y = this.touchY(event);
      if (!this._drag || typeof y !== 'number') return;
      const { compact, expanded } = this._sheetStops;
      this.setData({ sheetTop: Math.max(expanded, Math.min(compact, this._drag.top + y - this._drag.y)) });
    },
    dragEnd(event) {
      if (!this._drag) return;
      this.dragMove(event);
      const { compact, expanded } = this._sheetStops;
      const midpoint = (compact + expanded) / 2;
      // 松手后只停靠在两个固定位置；恰好一半时保留开始拖动前的档位。
      const expand = this.data.sheetTop === midpoint ? this._drag.expanded : this.data.sheetTop < midpoint;
      this._drag = null;
      this.setData({ expanded: expand, sheetTop: expand ? expanded : compact, dragging: false });
    },
    dragCancel() {
      if (!this._drag) return;
      const expanded = this._drag.expanded;
      this._drag = null;
      this.setData({ expanded, sheetTop: this._sheetStops[expanded ? 'expanded' : 'compact'], dragging: false });
    },
    toggleExpanded() {
      if (this.data.embedded || this._dead || !this._sheetStops) return;
      this._drag = null;
      const expanded = !this.data.expanded;
      const sheetTop = this._sheetStops[expanded ? 'expanded' : 'compact'];
      this.setData({ expanded, sheetTop, dragging: false, keyboardTop: this.keyboardTop(sheetTop, this.data.keyboardHeight) });
    },
    close() {
      if (this.data.sending || this.data.choosingImages) return;
      if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
      this.triggerEvent('close');
    },
    login() { this.triggerEvent('login'); },
    focusComposer() {
      if (this.commentsAreClosed()) return;
      if (!users.getCachedUser()) { this.login(); return; }
      this.closeEmoji();
      this.cancelReply();
      this.setData({ inputFocused: true, inputFocusRequested: true });
    },
    valid(epoch, version) { return !this._dead && this._epoch === epoch && users.getSessionVersion() === version; },
    renderComments() {
      let roots = this._roots, threads = this._threads;
      const pending = this._pendingReply;
      if (pending) {
        if (!pending.rootId) roots = [...roots, pending];
        else {
          roots = roots.map(row => row._id === pending.rootId ? { ...row, replyCount: (row.replyCount || 0) + 1 } : row);
          threads = new Map(threads);
          const thread = threads.get(pending.rootId) || { items: [], fresh: new Set(), open: false };
          threads.set(pending.rootId, { ...thread, items: [...thread.items, pending], fresh: new Set([...thread.fresh, pending._id]) });
        }
      }
      const lookup = new Map([...roots, ...[...threads.values()].flatMap(thread => thread.items)].map(row => [row._id, row]));
      const items = commentGroups(roots, threads), values = {};
      const layout = new Map(commentGroups(roots, threads, { retainFolded: true }).map(row => [row._id, row]));
      for (const root of items) {
        root.highlighted = root._id === this._highlightReply;
        const thread = threads.get(root._id);
        root.threadEarlier = Boolean(thread && thread.focusStart > 0);
        const retained = layout.get(root._id);
        Object.assign(root, this.commentMotionView(root, lookup));
        root.motionVisibleChildren = retained.visibleChildren.map(row => this.commentMotionView({ ...row, highlighted: row._id === this._highlightReply }, lookup));
        root.motionFreshChildren = retained.freshChildren.map(row => this.commentMotionView({ ...row, highlighted: row._id === this._highlightReply }, lookup));
        root.motionShowExpand = retained.showExpand; root.motionShowCollapse = retained.showCollapse;
        for (const row of [...root.visibleChildren, ...root.freshChildren]) row.highlighted = row._id === this._highlightReply;
      }
      if (items.length !== this.data.items.length || items.some((row, index) => row._id !== this.data.items[index]._id)) values.items = items;
      else for (let index = 0; index < items.length; index++) if (JSON.stringify(items[index]) !== JSON.stringify(this.data.items[index])) values[`items[${index}]`] = items[index];
      if (Object.keys(values).length) this.setData(values);
    },
    applyCommentRow(row) {
      if (row.status === 'deleted') { this.removeCommentRow(row); return; }
      if (this._removedComments.has(row._id) || this._removedComments.has(row.rootId)) return;
      let found = false;
      if (this._focusRoot && this._focusRoot._id === row._id) this._focusRoot = row;
      const replace = item => { if (item._id !== row._id) return item; found = true; return row; };
      this._roots = this._roots.map(replace);
      for (const thread of this._threads.values()) thread.items = thread.items.map(replace);
      if (found) this.renderComments();
    },
    removeCommentRow(row) {
      if (row.postId !== this.data.postId) return;
      this._removedComments.add(row._id);
      this._commentClicks.delete(row._id);
      const gone = item => this._removedComments.has(item._id) || this._removedComments.has(item.rootId);
      this._roots = this._roots.filter(item => !gone(item));
      const affectedIds = !row.rootId && this._threads.has(row._id) ? this._threads.get(row._id).items.map(item => item._id) : [];
      for (const id of [row._id, ...affectedIds]) {
        this.clearCommentMotions(id, false);
        this._commentClicks.delete(id);
        if (this._aiTimers.has(id)) { clearTimeout(this._aiTimers.get(id)); this._aiTimers.delete(id); }
      }
      if (!row.rootId) this._threads.delete(row._id);
      for (const [rootId, thread] of this._threads) {
        thread.items = thread.items.filter(item => !gone(item)); thread.fresh.delete(row._id);
        const cached = square.cachedChildren(this.data.postId, rootId);
        if (cached) thread.nextOffset = cached.nextOffset;
      }
      const cached = square.cachedReplies(this.data.postId);
      if (cached) this.setData({ nextOffset: cached.nextOffset, hasMore: cached.hasMore });
      const target = this.data.replyTarget;
      if (target && (target.id === row._id || target.rootId === row._id)) this.cancelReply();
      this.renderComments();
      this.triggerEvent('changed', { id: this.data.postId });
    },
    viewCommentAuthor(event) {
      if (this._dead || this._pageHidden || this.data.sending) return;
      const row = this.findComment(event.currentTarget.dataset.id);
      if (row && !row.pending && row.author && !row.author.isAI) this.triggerEvent('author', { author: row.author });
    },
    async manageComment(event) {
      if (this._commentMenuBusy || this.data.sending || this._dead || this._pageHidden) return;
      const user = users.getCachedUser();
      if (!user) { this.login(); return; }
      const id = event.currentTarget.dataset.id, row = this.findComment(id);
      if (!row || row.pending) return;
      const epoch = this._epoch, version = users.getSessionVersion();
      const valid = () => this.valid(epoch, version) && !this._pageHidden && Boolean(this.findComment(id));
      const own = row.isOwn === true || Boolean(user.accountId && row.author.accountId === user.accountId);
      this._commentMenuBusy = true;
      if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
      try {
        const choice = await popup('showActionSheet', { itemList: [own ? '删除' : '举报', '分享', '复制'], itemColor: '#171b20' });
        if (!valid()) return;
        const action = [own ? 'delete' : 'report', 'share', 'copy'][choice.tapIndex];
        if (!action || action === 'share') return;
        if (action === 'copy') {
          // 读取当前仍有效的正式记录，仅复制正文，不拼入图片、时间或界面提示。
          const latest = this.findComment(id);
          if (!latest || latest.hiddenByAncestor || !latest.content) return;
          const text = own ? latest.content : `@${latest.author.nickname} ${latest.content}`;
          await new Promise((resolve, reject) => wx.setClipboardData({ data: text, success: resolve,
            fail: () => reject(new Error('复制失败，请重试')) }));
          return;
        }
        if (action === 'delete' && own) {
          const confirm = await popup('showModal', { title: '删除评论', content: row.rootId ? '确定删除这条回复吗？' : '确定删除这条评论吗？该评论及其下的回复将不再展示。', confirmText: '删除', confirmColor: '#d84a4a' });
          if (!confirm.confirm || !valid()) return;
          const result = await square.deleteReply(this.data.postId, id);
          // 正常由缓存订阅同步；也兼容仅提供请求接口的宿主。
          if (this.valid(epoch, version) && !this._removedComments.has(id)) {
            if (result.root) this.applyCommentRow(result.root);
            this.removeCommentRow({ _id: id, postId: this.data.postId, rootId: result.rootId || '' });
          }
        } else if (action === 'report' && !own) {
          const selection = await popup('showActionSheet', { itemList: reportReasons.map(reason => reason.label) });
          const reason = reportReasons[selection.tapIndex];
          if (!reason || !valid()) return;
          const confirm = await popup('showModal', { title: '举报评论', content: `举报原因：${reason.label}。提交后将交由管理员处理。`, confirmText: '提交举报', confirmColor: '#4775fa' });
          if (!confirm.confirm || !valid()) return;
          const result = await square.reportReply(this.data.postId, id, reason.key);
          if (valid()) wx.showToast({ title: result.alreadyReported ? '你已举报过这条评论' : '举报已提交', icon: 'none' });
        }
      } catch (error) {
        if (valid() && !/cancel/.test(error.errMsg || '')) wx.showToast({ title: error.message || '操作失败，请重试', icon: 'none' });
      } finally { this._commentMenuBusy = false; }
    },
    showReplies(result) {
      this._roots = result.items.filter(row => !this._removedComments.has(row._id));
      if (this._focusRoot && !this._removedComments.has(this._focusRoot._id) && !this._roots.some(row => row._id === this._focusRoot._id)) this._roots.push(this._focusRoot);
      this.setData({ hasMore: result.hasMore, nextOffset: result.nextOffset, commentsClosed: result.commentsDisabled === true });
      this.renderComments();
      if (typeof square.warmReplyChildren === 'function') square.warmReplyChildren(this.data.postId, result.items);
      this.resumeAIReplies(result.items);
    },
    async locateReply() {
      const id = this.data.focusReplyId;
      if (!/^[rc]_[a-f0-9]{40}$/.test(id || '') || this._locatedReply === id || this._locatingReply === id || typeof square.replyContext !== 'function') return;
      const epoch = this._epoch, version = users.getSessionVersion(), draftRequest = this._requestId;
      this._locatingReply = id;
      try {
        const result = await square.replyContext(this.data.postId, id);
        if (!this.valid(epoch, version) || this._pageHidden || this.data.focusReplyId !== id || this._removedComments.has(id)) return;
        this._focusRoot = result.root;
        this._roots = [...this._roots.filter(row => row._id !== result.root._id), result.root];
        if (result.items.length) {
          const thread = this.thread(result.root._id);
          thread.items = result.items; thread.open = true; thread.focusStart = result.startOffset;
          thread.hasMore = result.hasMore; thread.nextOffset = result.nextOffset;
        }
        const focusInput = this.data.focusReplyInput && this._focusInputHandled !== id;
        this._focusInputHandled = id;
        this._locatedReply = id; this._highlightReply = result.targetId;
        this.renderComments();
        const reveal = () => {
          if (!this.valid(epoch, version) || this._pageHidden) return;
          this.setData({ scrollIntoView: `comment-${result.targetId}` });
          if (focusInput && !result.blocked && draftRequest === this._requestId && !this.data.text && !this.data.selectedImages.length && !this.data.sending)
            this.selectReply({ currentTarget: { dataset: { id } } });
        };
        if (typeof wx.nextTick === 'function') wx.nextTick(reveal); else reveal();
      } catch (error) {
        if (this.valid(epoch, version) && !this._pageHidden) this.setData({ locateError: error.message || '暂时无法定位这条回复' });
      } finally { if (this._locatingReply === id) this._locatingReply = ''; }
    },
    retryLocate() { this.setData({ locateError: '' }); return this.locateReply(); },
    async earlierChildren(event) {
      const id = event.currentTarget.dataset.id, thread = this.thread(id);
      if (thread.loading || !thread.focusStart || this._dead) return;
      const epoch = this._epoch, version = users.getSessionVersion(), offset = Math.max(0, thread.focusStart - 20);
      thread.loading = true; thread.error = ''; this.renderComments();
      try {
        const read = square.replyWindow || square.listChildren;
        const result = await read(this.data.postId, id, { offset, force: true });
        if (!this.valid(epoch, version) || this._removedComments.has(id)) return;
        thread.items = [...new Map([...result.items, ...thread.items].filter(row => !this._removedComments.has(row._id)).map(row => [row._id, row])).values()];
        thread.focusStart = offset;
      } catch (error) { if (this.valid(epoch, version)) thread.error = error.message || '回复读取失败，请重试'; }
      finally { thread.loading = false; if (this.valid(epoch, version)) this.renderComments(); }
    },
    thread(id) {
      if (!this._threads.has(id)) {
        const cached = square.cachedChildren(this.data.postId, id);
        this._threads.set(id, { items: cached ? cached.items : [], hasMore: cached ? cached.hasMore : true,
          nextOffset: cached ? cached.nextOffset : 0, fresh: new Set(), open: false, loading: false, error: '' });
      }
      return this._threads.get(id);
    },
    findComment(id) {
      return this._roots.find(row => row._id === id) || [...this._threads.values()].flatMap(thread => thread.items).find(row => row._id === id);
    },
    selectReply(event) {
      if (this.commentsAreClosed() || this.data.sending) return;
      if (!users.getCachedUser()) { this.login(); return; }
      const row = this.findComment(event.currentTarget.dataset.id);
      if (!row || row.folded || row.rootId && this.findComment(row.rootId)?.folded) return;
      const thread = row.rootId && this._threads.get(row.rootId);
      if (thread && thread.items.some(item => item.folded && (row.ancestorIds || []).includes(item._id))) return;
      this.closeEmoji();
      this._requestId = token();
      this.setData({ replyTarget: { id: row._id, rootId: row.rootId || row._id, nickname: row.author.nickname }, inputFocused: true, inputFocusRequested: true, sendError: '' });
    },
    cancelReply() {
      if (this.data.sending) return;
      this._requestId = token();
      this.setData({ replyTarget: null });
    },
    // 原生focus只更新观测值，不把这个事件反写成另一次focus请求。
    focusInput(event) {
      this.traceInput('focus'); this.closeEmoji();
      this._commentSelection = selectionOf(this.data.inputValue, event?.detail) || this._commentSelection;
      if (!this.data.inputFocused) this.setData({ inputFocused: true });
    },
    blurInput(event) {
      this.traceInput('blur');
      if (event?.detail?.value === this.data.inputValue) this._commentSelection = selectionOf(this.data.inputValue, event.detail) || this._commentSelection;
      // 键盘还在时，原生缩行的临时blur不能被放大成一条focus=false指令。
      // 不反向请求focus；真正收键盘后由keyboard事件解除聚焦请求。
      const values = {};
      if (this.data.inputFocused) values.inputFocused = false;
      if (!this.data.keyboardHeight && this.data.inputFocusRequested) values.inputFocusRequested = false;
      if (Object.keys(values).length) this.setData(values);
    },
    toggleThread(event) {
      const id = event.currentTarget.dataset.id, root = this.findComment(id);
      if (!root || root.folded) return;
      const thread = this.thread(id);
      thread.open = true;
      this.renderComments();
      if (thread.focusStart !== undefined) return;
      return this.loadChildren(id);
    },
    collapseThread(event) {
      const thread = this.thread(event.currentTarget.dataset.id);
      thread.open = false; thread.fresh.clear();
      this.renderComments();
    },
    moreChildren(event) { return this.loadChildren(event.currentTarget.dataset.id, true); },
    retryChildren(event) { return this.loadChildren(event.currentTarget.dataset.id, false, true); },
    async loadChildren(id, append = false, force = false) {
      const thread = this.thread(id);
      if (thread.loading || this._dead) return;
      const epoch = this._epoch, version = users.getSessionVersion();
      thread.loading = append || !thread.items.length; thread.error = ''; this.renderComments();
      try {
        const read = thread.focusStart !== undefined && square.replyWindow ? square.replyWindow : square.listChildren;
        const result = await read(this.data.postId, id, { offset: append ? thread.nextOffset : 0, force });
        if (!this.valid(epoch, version) || this._removedComments.has(id)) return;
        // 读取过程中刚发出的回复继续保留在独立显示区。
        thread.items = [...new Map([...result.items, ...thread.items.filter(row => thread.fresh.has(row._id) || thread.focusStart !== undefined)].filter(row => !this._removedComments.has(row._id)).map(row => [row._id, row])).values()];
        thread.hasMore = result.hasMore; thread.nextOffset = result.nextOffset;
        this.resumeAIReplies(result.items);
      } catch (error) {
        if (this.valid(epoch, version)) thread.error = error.message || '回复读取失败，请重试';
        else if (!this._dead && this._epoch === epoch) this.triggerEvent('close');
      } finally {
        thread.loading = false;
        if (this.valid(epoch, version)) this.renderComments();
      }
    },
    async reactComment(event) {
      if (this._dead || this._pageHidden) return;
      if (!users.getCachedUser()) { this.login(); return; }
      const { id, kind } = event.currentTarget.dataset;
      const row = this.findComment(id);
      if (!row || row.pending || row.hiddenByAncestor || !['like', 'fold'].includes(kind)) return;
      if ([row.rootId, ...(row.ancestorIds || [])].filter(Boolean).some(key => { const parent = this.findComment(key); return parent && parent.folded; })) return;
      const epoch = this._epoch, version = users.getSessionVersion();
      let operation = this._commentClicks.get(id);
      if (!operation) { operation = { confirmed: row, sequence: 0 }; this._commentClicks.set(id, operation); }
      const sequence = ++operation.sequence;
      const latestClick = () => this._commentClicks.get(id) === operation && operation.sequence === sequence;
      const active = kind === 'like' ? Boolean(row.folded || !row.liked) : !row.folded;
      this.startCommentMotion(id, kind, active);
      this.applyCommentRow(optimisticReaction(row, kind, active));
      try {
        const result = await square.commentState(this.data.postId, id, kind, active, row);
        if (!this.valid(epoch, version)) return;
        if (this._commentClicks.get(id) === operation) operation.confirmed = result;
        if (!latestClick()) return;
        const latest = typeof square.cachedComment === 'function' ? square.cachedComment(id) || result : result;
        this.applyCommentRow(latest);
        if (latest.folded && this.data.replyTarget) {
          const target = this.findComment(this.data.replyTarget.id);
          if (target && (target._id === id || (target.ancestorIds || []).includes(id))) {
            // 发送进行中保留请求目标，防止重试时意外变成一级评论。
            if (!this.data.sending) this.cancelReply();
          }
        }
        if (kind === 'fold' && !latest.folded && this._focusRoot) {
          this._locatedReply = '';
          await this.locateReply();
        }
      } catch (error) {
        if (!latestClick()) return;
        if (this.valid(epoch, version)) {
          const confirmed = typeof square.cachedComment === 'function' ? square.cachedComment(id) || operation.confirmed : operation.confirmed;
          this.clearCommentMotions(id, false);
          this.applyCommentRow(confirmed);
          wx.showToast({ title: error.message || '操作失败，请重试', icon: 'none' });
        }
        else if (!this._dead && this._epoch === epoch) this.triggerEvent(users.getCachedUser() ? 'close' : 'login');
      } finally { if (latestClick()) this._commentClicks.delete(id); }
    },
    async load(append = false, force = false) {
      if (this._loading || this._dead) return;
      this._loading = true;
      const epoch = this._epoch, version = users.getSessionVersion();
      this.setData({ loading: !this.data.items.length && !square.cachedReplies(this.data.postId), loadingMore: append, error: '' });
      try {
        const result = await square.listReplies(this.data.postId, { offset: append ? this.data.nextOffset : 0, force });
        if (this.valid(epoch, version)) this.showReplies(result);
      } catch (error) {
        if (this.valid(epoch, version)) {
          if (error.code === 'POST_NOT_FOUND') { this._roots = []; this._threads.clear(); }
          this.setData({ error: error.message || '评论读取失败，请重试', ...(error.code === 'POST_NOT_FOUND' ? { items: [], hasMore: false, replyTarget: null } : {}) });
        }
        else if (!this._dead && this._epoch === epoch) this.triggerEvent('close');
      } finally {
        this._loading = false;
        if (this.valid(epoch, version)) this.setData({ loading: false, loadingMore: false });
      }
    },
    retry() { return this.load(false, true); },
    loadMore() { if (this.data.hasMore && !this._loading) return this.load(true); },
    input(event) {
      if (this.data.sending) return;
      const value = event.detail.value;
      const { askAI, raw } = decodeInput(value, this.data.askAI, this.data.text);
      const maximum = askAI ? COMMENT_MAX - AI_MENTION_CHARS : COMMENT_MAX;
      const text = Array.from(raw).slice(0, maximum).join('');
      if (Array.from(replyText(raw, askAI)).length >= COMMENT_MAX) this.showLimitHint();
      else this.hideLimitHint();
      this._requestId = token();
      this._nativeInputSnapshot = value;
      this.setReplyInput(text, askAI, value);
      this._commentSelection = selectionOf(this.data.inputValue, event.detail);
      return this.data.inputValue;
    },
    setReplyInput(text, askAI, nativeValue, cursor = -1) {
      text = Array.from(text).slice(0, askAI ? COMMENT_MAX - AI_MENTION_CHARS : COMMENT_MAX).join('');
      const content = replyText(text, askAI), count = Array.from(content).length;
      const inputValue = (askAI ? AI_PREFIX : '') + text;
      const values = { text, askAI, inputValue, count, remainingCount: Math.max(0, COMMENT_MAX - count),
        countWarning: count >= COMMENT_MAX - COMMENT_WARNING, countProgress: Math.min(360, count * 360 / COMMENT_MAX),
        canSend: !this.data.choosingImages && Boolean(content.trim() || this.data.selectedImages.length) && count <= COMMENT_MAX, sendError: '' };
      // 正常键入（包括回车、拼音）交给原生控件，模型值与绑定值分离，禁止每字重设value/cursor。
      if (nativeValue !== inputValue) {
        this._commentSelection = selectionOf(inputValue, { cursor });
        const actual = this._nativeInputSnapshot === undefined ? this.data.inputValue : this._nativeInputSnapshot;
        // 原生值已在本地变化，但上次绑定值可能仍是空串；先回显实际值使清空/重复截断也能生效。
        if (this.data.nativeInputValue === inputValue && actual !== inputValue) this.setData({ nativeInputValue: actual });
        values.nativeInputValue = inputValue;
        values.inputCursor = cursor;
        this._nativeInputSnapshot = inputValue;
      }
      this.setData(values);
    },
    closeEmoji() {
      this._emojiSession = null;
      if (this.data.emojiOpen) this.setData({ emojiOpen: false });
    },
    toggleEmoji() {
      if (this.commentsAreClosed() || this._dead || this._pageHidden || this.data.sending || this.data.choosingImages) return;
      const viewer = users.getCachedUser();
      if (!viewer) { this.login(); return; }
      const version = users.getSessionVersion();
      if (viewer._id !== this.data.viewer?._id || version !== this._mediaVersion) return;
      if (this.data.emojiOpen) { this.closeEmoji(); return; }
      const ticket = this._emojiSession = { version };
      const value = this.data.inputValue, focused = this.data.inputFocused;
      captureSelection(wx, detail => {
        if (this._emojiSession === ticket && !ticket.picked && this.data.inputValue === value && users.getSessionVersion() === version) {
          this._commentSelection = selectionOf(value, detail) || this._commentSelection;
        }
      }, focused);
      this.setData({ emojiOpen: true, inputFocused: false, inputFocusRequested: false });
    },
    chooseEmoji(event) {
      if (!this.data.emojiOpen || this.commentsAreClosed() || this._dead || this._pageHidden || this.data.sending || this.data.choosingImages ||
          this._emojiSession?.version !== users.getSessionVersion()) return;
      const askAI = this.data.askAI, prefixLength = askAI ? AI_PREFIX.length : 0;
      const next = insertEmoji(this.data.inputValue, event.currentTarget.dataset.emoji, this._commentSelection,
        askAI ? COMMENT_MAX - AI_MENTION_CHARS : COMMENT_MAX, prefixLength);
      if (!next) return;
      if (next.limited) { this.showLimitHint(); return; }
      this._emojiSession.picked = true;
      this.hideLimitHint();
      this._requestId = token();
      this.setReplyInput(next.value.slice(prefixLength), askAI, undefined, next.cursor);
    },
    askXiaocui() {
      if (this.data.newsComments || this.data.sending || this._dead) return;
      if (!users.getCachedUser()) { this.login(); return; }
      this.closeEmoji();
      if (!this.data.askAI) this._requestId = token();
      this.setReplyInput(this.data.text, true);
      // hold-keyboard 保留原生焦点；已聚焦时只插入胶囊，不重放 focus。
      this.setData({ ...(!this.data.inputFocused ? { inputFocused: true, inputFocusRequested: true } : {}), inputCursor: this.data.inputValue.length });
    },
    showLimitHint() {
      clearTimeout(this._limitHintTimer);
      this.setData({ limitHintVisible: true });
      this._limitHintTimer = setTimeout(() => { if (!this._dead) this.setData({ limitHintVisible: false }); }, 2500);
    },
    hideLimitHint() { clearTimeout(this._limitHintTimer); if (this.data.limitHintVisible) this.setData({ limitHintVisible: false }); },
    keyboard(event) {
      const height = Math.max(0, event.detail.height || 0);
      this.traceInput('keyboard', { height });
      if (height === this.data.keyboardHeight) return;
      this.setData({ keyboardHeight: height, keyboardTop: this.keyboardTop(this.data.sheetTop, height),
        ...(!height && this.data.inputFocusRequested ? { inputFocusRequested: false } : {}) });
    },
    dismissKeyboardOnSend() {
      this.closeEmoji();
      this.setData({ inputFocused: false, inputFocusRequested: false, keyboardHeight: 0,
        keyboardTop: this.keyboardTop(this.data.sheetTop, 0) });
      // 仅点击发送时执行，云端回调不再操作键盘；API失败不能中断评论提交。
      if (!this._dead && !this._pageHidden && typeof wx.hideKeyboard === 'function') {
        try { wx.hideKeyboard({ fail() {} }); } catch (error) { /* 继续提交评论。 */ }
      }
    },
    async send() {
      if (this.commentsAreClosed()) return;
      const content = replyText(this.data.text, this.data.askAI);
      if (this._dead || this._pageHidden || this.data.sending || this.data.choosingImages || !content.trim() && !this.data.selectedImages.length || Array.from(content).length > COMMENT_MAX) return;
      if (!users.getCachedUser()) { this.login(); return; }
      this.dismissKeyboardOnSend();
      const epoch = this._epoch, version = users.getSessionVersion();
      this._requestId = this._requestId || token();
      const original = { text: this.data.text, askAI: this.data.askAI, count: this.data.count, target: this.data.replyTarget, images: this.data.selectedImages.map(image => ({ ...image })) };
      const viewer = users.getCachedUser(), targetRow = original.target && this.findComment(original.target.id);
      this._pendingReply = { _id: `pending_${this._requestId}`, content, images: original.images.map(image => image.path || image.fileID), pending: true, createdAt: new Date().toISOString(),
        author: { nickname: viewer.nickname || '', avatarFileID: viewer.avatarFileID || '', accountId: viewer.accountId || '',
          verified: viewer.role === 'student' && viewer.certificationStatus === 'approved' && Boolean(viewer.schoolId) },
        ...(original.target ? { rootId: original.target.rootId, replyToId: original.target.id, replyToName: original.target.nickname,
          ancestorIds: targetRow ? [...(targetRow.ancestorIds || []), targetRow._id] : [] } : {}) };
      this.hideLimitHint();
      this.setData({ selectedImages: [] }); this.setReplyInput('', false);
      this.setData({ sending: true, sendError: '', text: '', inputValue: '', inputCursor: -1, askAI: false, count: 0, canSend: false, scrollIntoView: `comment-${this._pendingReply._id}` });
      this.renderComments();
      try {
        const target = original.target;
        const images = original.images.length ? await this.uploadCommentImages(original.images, epoch, version) : [];
        if (!this.valid(epoch, version)) return;
        const result = await square.reply(this.data.postId, content, this._requestId, target && target.id, original.askAI, images);
        if (!this.valid(epoch, version)) return;
        this._pendingReply = null;
        if (target) {
          if (result.root) this._roots = this._roots.map(row => row._id === result.root._id ? result.root : row);
          const thread = this.thread(target.rootId);
          thread.items = [...thread.items.filter(row => row._id !== result.reply._id), result.reply];
          thread.fresh.add(result.reply._id);
        } else this._roots = [...this._roots.filter(row => row._id !== result.reply._id), result.reply];
        this.renderComments();
        this.setData({ text: '', inputValue: '', inputCursor: -1, askAI: false, count: 0, canSend: false, replyTarget: null, scrollIntoView: `comment-${result.reply._id}` });
        this._requestId = null;
        this.discardCommentUploads(); this._knownUploads.clear();
        this.triggerEvent('changed', { id: this.data.postId });
        this.startAIReply(result.reply);
      } catch (error) {
        if (this.valid(epoch, version)) {
          this._pendingReply = null;
          this.renderComments();
          this.setData({ selectedImages: original.images }); this.setReplyInput(original.text, original.askAI);
          this.setData({ replyTarget: original.target, sendError: error.message || '评论发布失败，请重试' });
        } else if (!this._dead && this._epoch === epoch) {
          if (!users.getCachedUser()) this.login();
          else this.triggerEvent('close');
        }
      } finally { if (!this._dead && this._epoch === epoch) this.setData({ sending: false }); }
    },
  },
});
