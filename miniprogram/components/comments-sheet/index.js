const users = require('../../services/user');
const square = require('../../services/square');
const { token } = require('../../utils/post-view');
const { commentGroups } = require('../../utils/comment-threads');
const { reactComment: optimisticReaction } = require('../../utils/comment-state');

Component({
  options: { multipleSlots: true },
  properties: { postId: String, viewer: Object, embedded: Boolean, topOffset: Number },
  observers: { topOffset() { if (this._sheetStops && this.data.embedded) this.measureSheet(); } },
  data: { items: [], loading: false, loadingMore: false, error: '', sendError: '', hasMore: false, nextOffset: 0,
    text: '', count: 0, canSend: false, sending: false, keyboardHeight: 0, keyboardTop: 0,
    viewportHeight: 812, sheetTop: 260, expanded: false, dragging: false,
    replyTarget: null, inputFocused: false, scrollIntoView: '' },
  lifetimes: {
    attached() {
      this._epoch = 0;
      this._roots = []; this._threads = new Map(); this._commentClicks = new Map();
      const version = users.getSessionVersion();
      if (typeof square.subscribeComment === 'function') this._stopComments = square.subscribeComment(row => {
        if (this.valid(0, version)) this.applyCommentRow(row);
      });
      this.measureSheet();
      const cached = square.cachedReplies(this.data.postId);
      if (cached) this.showReplies(cached);
      return this.load();
    },
    detached() { this._dead = true; this._drag = null; this._epoch = (this._epoch || 0) + 1; if (this._stopComments) this._stopComments(); },
  },
  pageLifetimes: { resize() { this.measureSheet(); } },
  methods: {
    stopEvent() {},
    measureSheet() {
      let height = 812, capsuleBottom = 84;
      try {
        const info = wx.getWindowInfo();
        height = info.windowHeight || height;
        capsuleBottom = (info.statusBarHeight || 0) + 48;
        const capsule = wx.getMenuButtonBoundingClientRect();
        if (capsule && capsule.height > 0 && capsule.top >= (info.statusBarHeight || 0)) capsuleBottom = capsule.top + capsule.height;
      } catch (error) { /* 不支持布局 API 的客户端使用默认安全位置。 */ }
      this._windowHeight = height;
      const compact = this.data.embedded ? this.data.topOffset : Math.round(height * .32);
      this._sheetStops = { compact, expanded: this.data.embedded ? compact : Math.min(compact, capsuleBottom + 12) };
      this._drag = null;
      const sheetTop = this.data.expanded ? this._sheetStops.expanded : compact;
      this.setData({ viewportHeight: height, sheetTop, dragging: false, keyboardTop: this.keyboardTop(sheetTop, this.data.keyboardHeight) });
    },
    keyboardTop(top, height) {
      if (this.data.embedded) return this.data.topOffset;
      return Math.min(top, Math.max(this._sheetStops.expanded, this._windowHeight - height - 220));
    },
    touchY(event) {
      const touch = event.touches && event.touches[0] || event.changedTouches && event.changedTouches[0];
      return touch && (typeof touch.clientY === 'number' ? touch.clientY : touch.pageY);
    },
    dragStart(event) {
      const y = this.touchY(event);
      if (this.data.embedded || this._dead || typeof y !== 'number' || !this._sheetStops) return;
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
      if (this.data.sending) return;
      if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
      this.triggerEvent('close');
    },
    login() { this.triggerEvent('login'); },
    focusComposer() {
      if (!users.getCachedUser()) { this.login(); return; }
      this.cancelReply();
      this.setData({ inputFocused: true });
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
      const items = commentGroups(roots, threads), values = {};
      if (items.length !== this.data.items.length || items.some((row, index) => row._id !== this.data.items[index]._id)) values.items = items;
      else for (let index = 0; index < items.length; index++) if (JSON.stringify(items[index]) !== JSON.stringify(this.data.items[index])) values[`items[${index}]`] = items[index];
      if (Object.keys(values).length) this.setData(values);
    },
    applyCommentRow(row) {
      let found = false;
      const replace = item => { if (item._id !== row._id) return item; found = true; return row; };
      this._roots = this._roots.map(replace);
      for (const thread of this._threads.values()) thread.items = thread.items.map(replace);
      if (found) this.renderComments();
    },
    showReplies(result) {
      this._roots = result.items;
      this.setData({ hasMore: result.hasMore, nextOffset: result.nextOffset });
      this.renderComments();
      if (typeof square.warmReplyChildren === 'function') square.warmReplyChildren(this.data.postId, result.items);
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
      if (this.data.sending) return;
      if (!users.getCachedUser()) { this.login(); return; }
      const row = this.findComment(event.currentTarget.dataset.id);
      if (!row || row.folded) return;
      const thread = row.rootId && this._threads.get(row.rootId);
      if (thread && thread.items.some(item => item.folded && (row.ancestorIds || []).includes(item._id))) return;
      this._requestId = token();
      this.setData({ replyTarget: { id: row._id, rootId: row.rootId || row._id, nickname: row.author.nickname }, inputFocused: true, sendError: '' });
    },
    cancelReply() {
      if (this.data.sending) return;
      this._requestId = token();
      this.setData({ replyTarget: null });
    },
    focusInput() { this.setData({ inputFocused: true }); },
    blurInput() { this.setData({ inputFocused: false }); },
    toggleThread(event) {
      const id = event.currentTarget.dataset.id, root = this.findComment(id);
      if (!root || root.folded) return;
      const thread = this.thread(id);
      thread.open = true;
      this.renderComments();
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
        const result = await square.listChildren(this.data.postId, id, { offset: append ? thread.nextOffset : 0, force });
        if (!this.valid(epoch, version)) return;
        // 读取过程中刚发出的回复继续保留在独立显示区。
        thread.items = [...new Map([...result.items, ...thread.items.filter(row => thread.fresh.has(row._id))].map(row => [row._id, row])).values()];
        thread.hasMore = result.hasMore; thread.nextOffset = result.nextOffset;
      } catch (error) {
        if (this.valid(epoch, version)) thread.error = error.message || '回复读取失败，请重试';
        else if (!this._dead && this._epoch === epoch) this.triggerEvent('close');
      } finally {
        thread.loading = false;
        if (this.valid(epoch, version)) this.renderComments();
      }
    },
    async reactComment(event) {
      if (!users.getCachedUser()) { this.login(); return; }
      const { id, kind } = event.currentTarget.dataset;
      const row = this.findComment(id);
      if (!row || !['like', 'fold'].includes(kind)) return;
      const epoch = this._epoch, version = users.getSessionVersion();
      let operation = this._commentClicks.get(id);
      if (!operation) { operation = { confirmed: row, sequence: 0 }; this._commentClicks.set(id, operation); }
      const sequence = ++operation.sequence;
      const latestClick = () => this._commentClicks.get(id) === operation && operation.sequence === sequence;
      const active = kind === 'like' ? Boolean(row.folded || !row.liked) : !row.folded;
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
      } catch (error) {
        if (!latestClick()) return;
        if (this.valid(epoch, version)) {
          const confirmed = typeof square.cachedComment === 'function' ? square.cachedComment(id) || operation.confirmed : operation.confirmed;
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
      const text = event.detail.value;
      this._requestId = token();
      const count = Array.from(text).length;
      this.setData({ text, count, canSend: Boolean(text.trim()) && count <= 300, sendError: '' });
    },
    keyboard(event) {
      const height = Math.max(0, event.detail.height || 0);
      this.setData({ keyboardHeight: height, keyboardTop: this.keyboardTop(this.data.sheetTop, height) });
    },
    async send() {
      if (this.data.sending || !this.data.text.trim() || this.data.count > 300) return;
      if (!users.getCachedUser()) { this.login(); return; }
      const epoch = this._epoch, version = users.getSessionVersion();
      this._requestId = this._requestId || token();
      const original = { text: this.data.text, count: this.data.count, target: this.data.replyTarget };
      const viewer = users.getCachedUser(), targetRow = original.target && this.findComment(original.target.id);
      this._pendingReply = { _id: `pending_${this._requestId}`, content: original.text, pending: true, createdAt: new Date().toISOString(),
        author: { nickname: viewer.nickname || '', avatarFileID: viewer.avatarFileID || '', accountId: viewer.accountId || '',
          verified: viewer.role === 'student' && viewer.certificationStatus === 'approved' && Boolean(viewer.schoolId) },
        ...(original.target ? { rootId: original.target.rootId, replyToId: original.target.id, replyToName: original.target.nickname,
          ancestorIds: targetRow ? [...(targetRow.ancestorIds || []), targetRow._id] : [] } : {}) };
      this.setData({ sending: true, sendError: '', text: '', count: 0, canSend: false, scrollIntoView: `comment-${this._pendingReply._id}` });
      this.renderComments();
      try {
        const target = original.target;
        const result = await square.reply(this.data.postId, original.text, this._requestId, target && target.id);
        if (!this.valid(epoch, version)) return;
        this._pendingReply = null;
        if (target) {
          if (result.root) this._roots = this._roots.map(row => row._id === result.root._id ? result.root : row);
          const thread = this.thread(target.rootId);
          thread.items = [...thread.items.filter(row => row._id !== result.reply._id), result.reply];
          thread.fresh.add(result.reply._id);
        } else this._roots = [...this._roots.filter(row => row._id !== result.reply._id), result.reply];
        this.renderComments();
        this.setData({ text: '', count: 0, canSend: false, replyTarget: null, scrollIntoView: `comment-${result.reply._id}` });
        this._requestId = null;
        this.triggerEvent('changed', { id: this.data.postId });
        wx.showToast({ title: '评论已发布' });
      } catch (error) {
        if (this.valid(epoch, version)) {
          this._pendingReply = null;
          this.renderComments();
          this.setData({ text: original.text, count: original.count, canSend: Boolean(original.text.trim()) && original.count <= 300, replyTarget: original.target,
            sendError: error.message || '评论发布失败，请重试' });
        } else if (!this._dead && this._epoch === epoch) {
          if (!users.getCachedUser()) this.login();
          else this.triggerEvent('close');
        }
      } finally { if (!this._dead && this._epoch === epoch) this.setData({ sending: false }); }
    },
  },
});
