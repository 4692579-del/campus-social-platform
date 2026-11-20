const users = require('../../services/user');
const square = require('../../services/square');
const media = require('../../services/post-images');
const { postView } = require('../../utils/post-view');
const { rowView } = require('../../utils/comment-threads');
const popup = (name, args) => new Promise((resolve, reject) => wx[name]({ ...args, success: resolve, fail: reject }));

Component({
  properties: { active: Boolean, viewer: Object },
  data: { items: [], loading: false, error: '', hasMore: false },
  observers: { 'active, viewer': function () { if (this._ready) this.sync(); } },
  lifetimes: {
    attached() {
      this._ready = true;
      this._stop = square.subscribeHistory(event => {
        if (!this.current()) return;
        this.showCached();
        if (event.invalidated && this.data.active) this.load();
      });
      return this.sync();
    },
    detached() { this._dead = true; if (this._stop) this._stop(); },
  },
  pageLifetimes: {
    hide() { this._hidden = true; },
    show() { this._hidden = false; if (this._ready) return this.sync(); },
  },
  methods: {
    current(version = this._version) { return !this._dead && version === users.getSessionVersion(); },
    sync() {
      const version = users.getSessionVersion();
      if (version !== this._version) {
        this._version = version; this._request = null; this._cursor = '';
        this.setData({ items: [], loading: false, error: '', hasMore: false });
      }
      this.showCached();
      if (this.data.active && users.getCachedUser() && !this._hidden) return this.load();
    },
    showCached() {
      const cached = square.cachedOwnReplies();
      if (!cached) return;
      this._cursor = cached.nextCursor;
      const items = cached.items.map(item => ({ ...item, context: postView(item.context), reply: { ...rowView(item.reply), aiCanRetry: false } }));
      // 不重设未变化的图片源，标签切换和互动时保持预览节点。
      const patch = { hasMore: cached.hasMore };
      if (this.data.items.length !== items.length || this.data.items.some((item, i) => item._id !== items[i]._id)) patch.items = items;
      else items.forEach((item, i) => {
        for (const section of ['reply', 'context']) for (const [key, value] of Object.entries(item[section])) {
          if (JSON.stringify(value) !== JSON.stringify(this.data.items[i][section][key])) patch[`items[${i}].${section}.${key}`] = value;
        }
      });
      this.setData(patch);
    },
    load(force = false, more = false) {
      if (this._request || !this.current() || !users.getCachedUser() || this._hidden) return this._request || Promise.resolve();
      const version = this._version;
      this.setData({ loading: more || !this.data.items.length, error: '' });
      const cursor = more ? this._cursor : '';
      const request = square.listOwnReplies({ force, cursor }).then(() => {
        if (this.current(version)) this.showCached();
      }).catch(error => {
        if (this.current(version)) {
          this._failedMore = more;
          if (error.code === 'HISTORY_CHANGED') this._reload = true;
          else this.setData({ error: error.message || '回复读取失败，请重试' });
        }
      }).finally(() => {
        if (this._request !== request) return;
        this._request = null;
        if (!this.current(version)) return;
        this.setData({ loading: false });
        if (this._reload && this.data.active && !this._hidden) { this._reload = false; this.load(); }
      });
      this._request = request;
      return request;
    },
    loadMore() { if (this.data.hasMore) return this.load(false, true); },
    retry() { return this.load(true, Boolean(this._failedMore)); },
    entry(event) { return this.data.items.find(item => item._id === event.currentTarget.dataset.id); },
    openComment(event) {
      const item = this.entry(event);
      if (item && this.current() && !this._hidden) this.triggerEvent('open', { id: item.postId, replyId: item._id });
    },
    selectReply(event) {
      const item = this.entry(event);
      if (item && !item.reply.folded && this.current() && !this._hidden) this.triggerEvent('reply', { id: item.postId, replyId: item._id });
    },
    async previewCommentImages(event) {
      const item = this.entry(event), files = item && item.reply.images;
      if (!files || !files.length || item.reply.folded || !this.current()) return;
      try { await media.previewImages(files, files[Number(event.currentTarget.dataset.index) || 0]); }
      catch (error) { if (this.current()) wx.showToast({ title: error.message || '图片暂不可用', icon: 'none' }); }
    },
    async reactComment(event) {
      const item = this.entry(event), kind = event.currentTarget.dataset.kind;
      if (!item || item.reply.hiddenByAncestor || !this.current() || this._hidden) return;
      const row = item.reply, version = this._version;
      try { await square.commentState(item.postId, row._id, kind, kind === 'like' ? Boolean(row.folded || !row.liked) : !row.folded, row); }
      catch (error) { if (this.current(version)) wx.showToast({ title: error.message || '操作失败，请重试', icon: 'none' }); }
    },
    async manageComment(event) {
      const item = this.entry(event);
      if (!item || this._menuBusy || !this.current() || this._hidden) return;
      const version = this._version;
      this._menuBusy = true;
      try {
        const choice = await popup('showActionSheet', { itemList: ['删除评论'], itemColor: '#d84a4a' });
        if (!this.current(version) || this._hidden || choice.tapIndex !== 0) return;
        const result = await popup('showModal', { title: '删除评论', content: item.reply.rootId ? '确定删除这条回复吗？' : '确定删除这条评论吗？该评论及其下的回复将不再展示。', confirmText: '删除', confirmColor: '#d84a4a' });
        if (result.confirm && this.current(version) && !this._hidden) await square.deleteReply(item.postId, item._id);
      } catch (error) { if (this.current(version) && !/cancel/.test(error.errMsg || '')) wx.showToast({ title: error.message || '删除失败，请重试', icon: 'none' }); }
      finally { this._menuBusy = false; }
    },
    stopEvent() {},
  },
});
