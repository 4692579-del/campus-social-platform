const users = require('../../services/user');
const square = require('../../services/square');
const gate = require('../../utils/login-gate');
const { token } = require('../../utils/post-view');
const media = require('../../services/post-images');
const { declarations, declarationKey } = require('../../utils/content-declaration');

Component({
  properties: { initialQuote: Object, quoteOwnerId: String },
  data: { user: null, content: '', images: [], count: 0, remainingCount: 150, countWarning: false, countProgress: 0, limitHintVisible: false, canPublish: false, publishing: false, savingDraft: false, choosingImages: false, uploadDone: 0, uploadTotal: 0, error: '',
    optimizing: false, canOptimize: false, canUndoOptimization: false, optimizeError: '', noticeOrder: [], optimizeHelpUsed: false, optimizeHelpVisible: false,
    viewportHeight: 812, sheetTop: 104, settingsMaxHeight: 692, settingsRowHeight: 92, keyboardHeight: 0, editorFocused: false, editorFocusRequested: false, closing: false,
    panel: '', exitConfirmVisible: false, replyAudience: 'anyone', viewAudience: 'anyone', declaration: 'none',
    audiences: [{ key: 'anyone', label: '任何人' }, { key: 'friends', label: '我的萃友' },
      { key: 'followers', label: '我的粉丝' }, { key: 'following', label: '我的关注' }],
    declarations,
    quotePostId: '', quote: null, quoteReady: false, quoteLoading: false, quoteError: '',
    loginSheetOpen: false, loginLoading: false, loginError: '' },
  lifetimes: {
    attached() { this.measure(); return this.initialize(); },
    detached() {
      this.cancelOptimization();
      this._unloaded = true;
      this._authVersion = (this._authVersion || 0) + 1;
      clearTimeout(this._closeTimer);
      clearTimeout(this._limitHintTimer);
    },
  },
  pageLifetimes: {
    resize() { this.measure(); },
    hide() {
      this.cancelOptimization();
      this.hideLimitHint();
      this.closeOptimizeHelp();
      this.setData({ keyboardHeight: 0, editorFocused: false, editorFocusRequested: false });
    },
    show() {
      if (this._unloaded) return;
      const current = users.getCachedUser();
      if ((current && current._id) !== (this.data.user && this.data.user._id)) {
        this._quoteSequence = (this._quoteSequence || 0) + 1;
        if (!current) { this._savedQuoteId = ''; this.setData({ quotePostId: '', quote: null, quoteReady: false, quoteLoading: false, quoteError: '' }); }
        this.hideLimitHint();
        if (current) this.onLoggedIn(current);
        else { this.cancelOptimization(); this._editorOwnerId = null; this._savedContent = ''; this._savedImages = []; this._savedDeclaration = 'none'; this._optimizedOriginal = null; this.setData({ user: null, content: '', images: [], declaration: 'none', count: 0, remainingCount: 150, countWarning: false, countProgress: 0, canPublish: false, canOptimize: false, canUndoOptimization: false, optimizeError: '', noticeOrder: [], exitConfirmVisible: false }); this.requestLogin(); }
      }
    },
  },
  methods: {
    ...gate,
    requestLogin() {
      const current = users.getCachedUser();
      if (current && (!this.data.user || current._id !== this.data.user._id)) { this.onLoggedIn(current); return; }
      gate.requestLogin.call(this);
    },
    measure() {
      try {
        const info = wx.getWindowInfo(), capsule = wx.getMenuButtonBoundingClientRect();
        const top = capsule && capsule.height > 0 ? capsule.top + capsule.height + 18 : (info.statusBarHeight || 0) + 66;
        const width = info.windowWidth || 375;
        // Android 可能先缩小窗口再通知键盘高度，保留完整高度，避免重复扣除键盘。
        const keyboardResize = this._layoutWidth === width && (this.data.editorFocused || this.data.keyboardHeight);
        const height = keyboardResize ? Math.max(info.windowHeight || 812, this.data.viewportHeight) : info.windowHeight || 812;
        this._layoutWidth = width;
        const settingsMaxHeight = Math.max(0, height - top - 16);
        // 按内容撑高；短屏缩紧选项行，为标题、两组小标题、完成按钮及安全区留足空间。
        const settingsRowHeight = Math.min(92, Math.max(52, Math.floor((settingsMaxHeight * 750 / width - 440) / 8)));
        this.setData({ viewportHeight: height, sheetTop: top, settingsMaxHeight, settingsRowHeight });
      } catch (error) { /* 旧设备保留默认安全位置。 */ }
    },
    async initialize() {
      const cached = users.getCachedUser();
      if (cached) return this.onLoggedIn(cached);
      try {
        const user = await users.restore({ force: false });
        if (this._unloaded || this._closing) return;
        if (user) return this.onLoggedIn(user);
        else this.requestLogin();
      } catch (error) { if (!this._unloaded && !this._closing) { this.setData({ error: error.message }); this.requestLogin(); } }
    },
    onLoggedIn(user) {
      const changed = this._editorOwnerId !== user._id;
      this._editorOwnerId = user._id;
      if (changed) {
        this._quoteSequence = (this._quoteSequence || 0) + 1;
        this._savedQuoteId = '';
        this.setData({ quotePostId: '', quote: null, quoteReady: false, quoteLoading: false, quoteError: '' });
        this.cancelOptimization(); this._optimizedOriginal = null;
        this.hideLimitHint();
        this._savedContent = '';
        this._savedDeclaration = 'none';
        this._savedImages = []; this._knownUploads = new Set();
        this.setData({ images: [], declaration: 'none', noticeOrder: [], optimizeHelpVisible: false });
        this.setContent(''); this._requestId = null;
        this.setData({ replyAudience: 'anyone', viewAudience: 'anyone', declaration: 'none', panel: '', exitConfirmVisible: false, error: '', optimizeError: '', canUndoOptimization: false });
      }
      this.setData({ user });
      if (!changed) return;
      try {
        const draft = wx.getStorageSync(`square.draft.${user._id}`);
        if (draft && typeof draft.content === 'string') {
          const images = Array.isArray(draft.images) ? draft.images.filter(image => image && typeof image.fileID === 'string' && image.fileID.includes(`/square-uploads/${user._id}/`)).slice(0, 9)
            .map(image => ({ key: image.key || token(), path: '', fileID: image.fileID, type: image.type || 'jpg' })) : [];
          this._savedImages = images.map(image => image.fileID);
          this._knownUploads = new Set(this._savedImages);
          this._savedDeclaration = declarationKey(draft.declaration);
          this._savedQuoteId = /^p_[a-f0-9]{40}$/.test(draft.quotePostId || '') ? draft.quotePostId : '';
          this.setData({ images, declaration: this._savedDeclaration, ...this.noticeState(false, this._savedDeclaration) });
          this._savedContent = draft.content;
          this._requestId = draft.requestId || token();
          this.setContent(draft.content);
        }
      } catch (error) { /* 无草稿时直接开始输入。 */ }
      let id = this._savedQuoteId, preview;
      if (!this._initialQuoteUsed && this.data.quoteOwnerId === user._id && /^p_[a-f0-9]{40}$/.test(this.data.initialQuote?._id || '')) {
        this._initialQuoteUsed = true; preview = this.data.initialQuote; id = preview._id;
        if (id !== this._savedQuoteId) this._requestId = token();
      }
      if (id) return this.attachQuote(id, preview);
    },
    refreshQuotePublish() {
      this.setData({ canPublish: Boolean(this.data.content.trim() || this.data.images.length || this.data.quotePostId) && this.data.count <= 150 && (!this.data.quotePostId || this.data.quoteReady) });
    },
    async attachQuote(id, preview) {
      const version = users.getSessionVersion(), owner = this._editorOwnerId, sequence = this._quoteSequence = (this._quoteSequence || 0) + 1;
      const cached = typeof square.cachedPost === 'function' && square.cachedPost(id) || preview;
      const current = () => !this._unloaded && !this._closing && sequence === this._quoteSequence && version === users.getSessionVersion() && owner === this._editorOwnerId;
      this.setData({ quotePostId: id, quote: cached ? { ...cached, content: cached.fullContent || cached.content } : { _id: id, loading: true }, quoteReady: Boolean(cached && !cached.unavailable), quoteLoading: true, quoteError: '' });
      this.refreshQuotePublish();
      try {
        const post = await square.detail(id);
        if (!current()) return;
        this.setData({ quote: { ...post, content: post.fullContent || post.content }, quoteReady: true });
      } catch (error) {
        if (current()) {
          const gone = ['POST_NOT_FOUND', 'QUOTE_UNAVAILABLE'].includes(error.code);
          this.setData({ ...(!gone && cached && !cached.unavailable ? {} : { quote: { _id: id, unavailable: gone, failed: !gone }, quoteReady: false }),
            quoteError: error.message || '原动态读取失败，请重试或移除引用' });
        }
      } finally { if (current()) { this.setData({ quoteLoading: false }); this.refreshQuotePublish(); } }
    },
    retryQuote() { if (this.data.quotePostId && !this.data.quoteLoading && !this.busy()) return this.attachQuote(this.data.quotePostId); },
    removeQuote() {
      if (this.busy()) return;
      this.cancelOptimization(); this._quoteSequence = (this._quoteSequence || 0) + 1; this._requestId = token();
      this.setData({ quotePostId: '', quote: null, quoteReady: false, quoteLoading: false, quoteError: '', error: '' });
      this.refreshQuotePublish();
    },
    noticeState(canOptimize = this.data.canOptimize, declaration = this.data.declaration) {
      const visible = { optimize: canOptimize, declaration: declaration !== 'none' };
      const noticeOrder = this.data.noticeOrder.filter(key => visible[key]);
      for (const key of ['optimize', 'declaration']) if (visible[key] && !noticeOrder.includes(key)) noticeOrder.push(key);
      return { noticeOrder };
    },
    setContent(content) {
      const changed = content !== this.data.content;
      if (changed) { this._editRevision = (this._editRevision || 0) + 1; this._optimizedOriginal = null; }
      const count = Array.from(content).length;
      const remainingCount = Math.max(0, 150 - count);
      const canOptimize = Boolean(content.trim() || this.data.images.length) && count <= 150;
      this.setData({ content, count, remainingCount, countWarning: remainingCount <= 20,
        ...(!canOptimize ? { optimizeHelpVisible: false } : {}),
        canOptimize, ...this.noticeState(canOptimize), ...(changed ? { canUndoOptimization: false, optimizeError: '' } : {}),
        countProgress: Math.min(360, Math.round(count * 360 / 150)), canPublish: Boolean(content.trim() || this.data.images.length || this.data.quotePostId) && count <= 150 && (!this.data.quotePostId || this.data.quoteReady) });
    },
    onInput(event) {
      if (this._unloaded || this._closing || this.data.publishing || this.data.savingDraft || this.data.exitConfirmVisible) return;
      const characters = Array.from(event.detail.value);
      const content = characters.slice(0, 150).join('');
      if (content !== this.data.content) this.cancelOptimization();
      if (content !== this.data.content) this._requestId = token();
      // textarea 不采用 input 回调返回值，必须下发两次不同的 value 修正重复超限输入。
      if (characters.length > 150) this.setData({ content: event.detail.value });
      this.setContent(content);
      if (characters.length >= 150) this.showLimitHint();
      else this.hideLimitHint();
      this.setData({ error: '' });
      // 即使截断结果与上一次绑定值相同，也让原生输入框丢弃超出的粘贴/输入。
      return content;
    },
    cancelOptimization() {
      this._optimizationSequence = (this._optimizationSequence || 0) + 1;
      clearTimeout(this._optimizationTimer);
      if (this._finishOptimizationWait) { this._finishOptimizationWait(); this._finishOptimizationWait = null; }
      if (this.data.optimizing) this.setData({ optimizing: false });
    },
    showOptimizeHelp() {
      if (this.busy() || this.data.optimizing || !this.data.canOptimize || this.data.optimizeHelpUsed || this.data.panel || this.data.exitConfirmVisible || this.data.loginSheetOpen) return;
      // 仅本次打开期间记忆，提示不请求模型、不保存草稿或改变原生焦点。
      this.setData({ optimizeHelpUsed: true, optimizeHelpVisible: true });
    },
    closeOptimizeHelp() {
      if (this.data.optimizeHelpVisible) this.setData({ optimizeHelpVisible: false });
    },
    async optimizeContent() {
      if (this.busy() || this.data.optimizing || !this.data.canOptimize || this.data.panel || this.data.exitConfirmVisible || this.data.loginSheetOpen) return;
      const user = users.getCachedUser(), version = users.getSessionVersion();
      if (!user || !this.data.user || user._id !== this.data.user._id) { this.requestLogin(); return; }
      this.setData({ optimizeHelpUsed: true, optimizeHelpVisible: false });
      const original = this.data.content, revision = this._editRevision;
      const sequence = this._optimizationSequence = (this._optimizationSequence || 0) + 1;
      const current = () => !this._unloaded && !this._closing && this._optimizationSequence === sequence && users.getSessionVersion() === version && this._editorOwnerId === user._id;
      this.hideLimitHint();
      this.setData({ optimizing: true, optimizeError: '' });
      const startedAt = Date.now();
      try {
        let result, failure;
        try {
          const images = this.data.images.length ? await this.uploadSelectedImages() : [];
          if (!current() || revision !== this._editRevision) return;
          result = await square.optimizeContent(original, images);
        } catch (error) { failure = error; }
        if (!current() || revision !== this._editRevision) return;
        const remaining = 5000 - (Date.now() - startedAt);
        if (remaining > 0) await new Promise(resolve => {
          this._finishOptimizationWait = resolve;
          this._optimizationTimer = setTimeout(() => { this._finishOptimizationWait = null; resolve(); }, remaining);
        });
        if (!current() || revision !== this._editRevision || this.data.publishing || this.data.savingDraft || this.data.exitConfirmVisible) return;
        if (failure) throw failure;
        if (typeof result !== 'string' || !result.trim()) throw new Error('暂未生成优化内容，请重试');
        // 不经过用户输入事件：即使结果恰好150字，也不弹超限气泡。
        const content = Array.from(result).slice(0, 150).join('');
        this.hideLimitHint();
        this.setContent(content);
        this._requestId = token();
        this._optimizedOriginal = original;
        this.setData({ canUndoOptimization: content !== original, error: '' });
      } catch (error) {
        if (current() && revision === this._editRevision) this.setData({ optimizeError: error.message || '优化失败，已保留原文' });
      } finally { if (current()) this.setData({ optimizing: false }); }
    },
    undoOptimization() {
      if (this.busy() || this.data.optimizing || !this.data.canUndoOptimization || typeof this._optimizedOriginal !== 'string') return;
      const original = this._optimizedOriginal;
      this.hideLimitHint(); this.setContent(original); this._requestId = token();
      this.setData({ canUndoOptimization: false, optimizeError: '' });
    },
    showLimitHint() {
      clearTimeout(this._limitHintTimer);
      this.setData({ limitHintVisible: true });
      this._limitHintTimer = setTimeout(() => {
        if (!this._unloaded && !this._closing) this.setData({ limitHintVisible: false });
      }, 2500);
    },
    hideLimitHint() {
      clearTimeout(this._limitHintTimer);
      if (this.data.limitHintVisible) this.setData({ limitHintVisible: false });
    },
    saveDraft() {
      const user = users.getCachedUser();
      if (!user || !this.data.user || user._id !== this.data.user._id) return false;
      try {
        const key = `square.draft.${user._id}`;
        if (this.data.content.trim() || this.data.images.length || this.data.quotePostId) wx.setStorageSync(key, { content: this.data.content, declaration: this.data.declaration, requestId: this._requestId || (this._requestId = token()), ...(this.data.quotePostId ? { quotePostId: this.data.quotePostId } : {}),
          ...(this.data.images.length ? { images: this.data.images.map(image => ({ key: image.key, fileID: image.fileID, type: image.type })) } : {}) });
        else wx.removeStorageSync(key);
        this._savedContent = this.data.content;
        this._savedImages = this.data.images.map(image => image.fileID);
        this._savedDeclaration = this.data.declaration;
        this._savedQuoteId = this.data.quotePostId;
        return true;
      } catch (error) { return false; }
    },
    async saveAndClose() {
      if (this.busy()) return;
      if (!this.data.content.trim() && !this.data.images.length && !this.data.quotePostId) { wx.showToast({ title: '请先写点内容或选择图片', icon: 'none' }); return; }
      this.cancelOptimization();
      this.setData({ savingDraft: true, error: '' });
      const version = users.getSessionVersion();
      try {
        if (this.data.images.length) await this.uploadSelectedImages();
        if (this._unloaded || version !== users.getSessionVersion()) return;
        if (!this.saveDraft()) throw new Error('草稿保存失败，请稍后重试');
        wx.showToast({ title: '已保存为草稿', icon: 'none' });
        this.finishClose();
      } catch (error) { if (!this._unloaded && version === users.getSessionVersion()) this.setData({ error: error.message || '图片草稿保存失败，请重试' }); }
      finally { if (!this._unloaded) this.setData({ savingDraft: false }); }
    },
    busy() { return this._unloaded || this._closing || this.data.publishing || this.data.savingDraft || this.data.choosingImages; },
    async choosePostImages() {
      if (this.busy()) return;
      if (!users.getCachedUser()) { this.requestLogin(); return; }
      if (this.data.images.length >= 9) { wx.showToast({ title: '一次最多发布 9 张图片', icon: 'none' }); return; }
      this.cancelOptimization();
      const version = users.getSessionVersion();
      this.setData({ choosingImages: true, editorFocused: false, editorFocusRequested: false, error: '' });
      if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
      try {
        const selected = await media.chooseImages(9 - this.data.images.length);
        if (this._unloaded || version !== users.getSessionVersion() || !selected.length) return;
        this.setData({ images: [...this.data.images, ...selected].slice(0, 9) });
        this.imagesDidChange();
        this._requestId = token(); this.setContent(this.data.content);
      } catch (error) { if (!this._unloaded && version === users.getSessionVersion() && !/cancel/.test(error.errMsg || '')) this.setData({ error: error.message || '选图失败，请检查相册或相机权限' }); }
      finally {
        if (!this._unloaded) {
          this.setData({ choosingImages: false });
          this.triggerEvent('resumenavigation');
        }
      }
    },
    removeImage(event) {
      if (this.busy()) return;
      const index = Number(event.currentTarget.dataset.index);
      if (!Number.isInteger(index) || index < 0 || index >= this.data.images.length) return;
      this.setData({ images: this.data.images.filter((image, at) => at !== index) });
      this.imagesDidChange();
      this._requestId = token(); this.setContent(this.data.content);
    },
    async previewSelectedImage(event) {
      const files = this.data.images.map(image => image.fileID || image.path), current = files[event.currentTarget.dataset.index];
      if (!current) return;
      try { await media.previewImages(files, current); }
      catch (error) { if (!this._unloaded && error.code !== 'SESSION_CHANGED') wx.showToast({ title: error.message || '图片预览失败', icon: 'none' }); }
      finally { if (!this._unloaded) this.triggerEvent('resumenavigation'); }
    },
    imagesDidChange() {
      this.cancelOptimization();
      this._editRevision = (this._editRevision || 0) + 1;
      this._optimizedOriginal = null;
      this.setData({ canUndoOptimization: false, optimizeError: '' });
    },
    async uploadSelectedImages() {
      const version = users.getSessionVersion();
      const images = this.data.images.map(image => ({ ...image }));
      this.setData({ uploadDone: 0, uploadTotal: images.length });
      return media.uploadImages(images, (index, fileID) => {
        if (this._unloaded || version !== users.getSessionVersion()) return;
        this._knownUploads = this._knownUploads || new Set(); this._knownUploads.add(fileID);
        // 上传期间允许继续编辑或删除图片，迟到结果不能写到已换位的下一张图。
        const at = this.data.images.findIndex(image => image.key === images[index].key);
        if (at >= 0 && this.data.images[at].fileID !== fileID) this.setData({ [`images[${at}].fileID`]: fileID });
      }, (done, total) => {
        if (!this._unloaded && version === users.getSessionVersion()) this.setData({ uploadDone: done, uploadTotal: total });
      });
    },
    focusEditor() {
      if (!this.data.user || this.busy() || this.data.panel || this.data.exitConfirmVisible) return;
      if (!this.data.editorFocused) this.setData({ editorFocused: true, editorFocusRequested: true });
    },
    // 原生focus只更新观测状态，绝不反写focus属性再次请求键盘。
    editorDidFocus() { if (!this.data.editorFocused) this.setData({ editorFocused: true }); },
    blurEditor() { this.setData({ editorFocused: false, editorFocusRequested: false }); },
    keyboard(event) {
      if (this._unloaded || this._closing || this.data.panel || this.data.exitConfirmVisible) return;
      const keyboardHeight = Math.max(0, Number(event.detail.height) || 0);
      if (keyboardHeight === this.data.keyboardHeight) return;
      this.setData({ keyboardHeight });
    },
    openPanel(event) {
      if (this.busy() || this.data.loginSheetOpen || this.data.exitConfirmVisible) return;
      const panel = event.currentTarget.dataset.panel;
      if (!['options', 'declaration'].includes(panel)) return;
      this.closeOptimizeHelp();
      if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
      this.setData({ panel, keyboardHeight: 0, editorFocused: false, editorFocusRequested: false });
    },
    closePanel() { this.setData({ panel: '' }); },
    selectAudience(event) {
      const value = event.currentTarget.dataset.key;
      if (this.data.audiences.some(item => item.key === value)) this.setData({ replyAudience: value });
    },
    selectViewAudience(event) {
      const value = event.currentTarget.dataset.key;
      if (this.data.audiences.some(item => item.key === value)) this.setData({ viewAudience: value });
    },
    selectDeclaration(event) {
      const value = event.currentTarget.dataset.key;
      if (this.busy() || this.data.declaration === value || !this.data.declarations.some(item => item.key === value)) return;
      this._requestId = token();
      this.setData({ declaration: value, ...this.noticeState(this.data.canOptimize, value) });
    },
    finishClose(published = false) {
      if (this._closing || this._unloaded) return;
      this.cancelOptimization();
      this.hideLimitHint();
      this._closing = true;
      this._authVersion = (this._authVersion || 0) + 1;
      this.setData({ closing: true, editorFocused: false, editorFocusRequested: false, panel: '', exitConfirmVisible: false, loginSheetOpen: false });
      if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
      this._closeTimer = setTimeout(() => { if (!this._unloaded) this.triggerEvent('close', { published }); }, 260);
    },
    async publish() {
      if (this.busy() || !this.data.canPublish || this.data.loginSheetOpen || this.data.panel || this.data.exitConfirmVisible) return;
      const user = users.getCachedUser(), version = users.getSessionVersion();
      if (!user || !this.data.user || user._id !== this.data.user._id) { this.requestLogin(); return; }
      this._requestId = this._requestId || token();
      this.cancelOptimization();
      this.setData({ publishing: true, error: '' });
      try {
        const images = this.data.images.length ? await this.uploadSelectedImages() : [];
        if (this._unloaded || version !== users.getSessionVersion()) return;
        await square.publish(this.data.content, this._requestId, images, this.data.declaration, this.data.quotePostId);
        if (this._unloaded || users.getSessionVersion() !== version) return;
        this._published = true;
        try { wx.removeStorageSync(`square.draft.${user._id}`); } catch (error) { /* 已发布的内容不会重复提交。 */ }
        Promise.resolve().then(() => media.discardUploads([...(this._knownUploads || [])])).catch(() => {});
        wx.showToast({ title: '发布成功' });
        this.finishClose(true);
      } catch (error) {
        if (!this._unloaded) {
          if (version === users.getSessionVersion()) this.setData({ error: error.message || '发布未确认，请重试' });
          if (!users.getCachedUser()) this.requestLogin();
        }
      } finally { if (!this._unloaded) this.setData({ publishing: false }); }
    },
    continueEditing() {
      if (this.busy() || !this.data.exitConfirmVisible) return;
      this.setData({ exitConfirmVisible: false, editorFocused: true, editorFocusRequested: true });
    },
    clearDraft() {
      const user = users.getCachedUser();
      if (!user || !this.data.user || user._id !== this.data.user._id || user._id !== this._editorOwnerId) return true;
      try {
        wx.removeStorageSync(`square.draft.${user._id}`);
        this._savedContent = '';
        this._requestId = null;
        this._savedImages = [];
        this._savedDeclaration = 'none';
        this._savedQuoteId = '';
        const uploads = [...(this._knownUploads || [])];
        Promise.resolve().then(() => media.discardUploads(uploads)).catch(() => {});
        return true;
      } catch (error) {
        this.setData({ error: '草稿清除失败，请稍后重试' });
        return false;
      }
    },
    discardAndClose() {
      if (this.busy() || !this.data.exitConfirmVisible || !this.clearDraft()) return;
      this._quoteSequence = (this._quoteSequence || 0) + 1;
      this.setData({ quotePostId: '', quote: null, quoteReady: false, quoteLoading: false, quoteError: '' });
      this.setData({ images: [], error: '' });
      this.setContent('');
      this.finishClose();
    },
    cancel() {
      if (this.busy() || this.data.exitConfirmVisible) return;
      this.cancelOptimization();
      const imageKeys = this.data.images.map(image => image.fileID || image.key);
      if ((this.data.content.length || this.data.images.length || this.data.quotePostId) && (this.data.content !== (this._savedContent || '') || this.data.declaration !== (this._savedDeclaration || 'none') || JSON.stringify(imageKeys) !== JSON.stringify(this._savedImages || []) || this.data.quotePostId !== (this._savedQuoteId || ''))) {
        this.setData({ exitConfirmVisible: true, panel: '', keyboardHeight: 0, editorFocused: false, editorFocusRequested: false, error: '' });
        if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
        return;
      }
      if (!this.data.content.length && !this.data.images.length && !this.data.quotePostId && !this.clearDraft()) return;
      this.finishClose();
    },
  },
});
