const users = require('../../services/user');
const square = require('../../services/square');
const gate = require('../../utils/login-gate');
const { token } = require('../../utils/post-view');
const media = require('../../services/post-images');
const { declarations, declarationKey } = require('../../utils/content-declaration');

Component({
  data: { user: null, content: '', images: [], count: 0, countProgress: 0, canPublish: false, publishing: false, savingDraft: false, choosingImages: false, uploadDone: 0, uploadTotal: 0, error: '',
    viewportHeight: 812, sheetTop: 104, settingsHeight: 470, keyboardHeight: 0, editorFocused: false, closing: false,
    panel: '', exitConfirmVisible: false, replyAudience: 'anyone', viewAudience: 'anyone', declaration: 'none',
    audiences: [{ key: 'anyone', label: '任何人' }, { key: 'friends', label: '我的萃友' },
      { key: 'followers', label: '我的粉丝' }, { key: 'following', label: '我的关注' }],
    declarations,
    loginSheetOpen: false, loginLoading: false, loginError: '' },
  lifetimes: {
    attached() { this.measure(); return this.initialize(); },
    detached() {
      this._unloaded = true;
      this._authVersion = (this._authVersion || 0) + 1;
      clearTimeout(this._closeTimer);
    },
  },
  pageLifetimes: {
    resize() { this.measure(); },
    hide() {
      this.setData({ keyboardHeight: 0, editorFocused: false });
    },
    show() {
      if (this._unloaded) return;
      const current = users.getCachedUser();
      if ((current && current._id) !== (this.data.user && this.data.user._id)) {
        if (current) this.onLoggedIn(current);
        else { this._editorOwnerId = null; this._savedContent = ''; this._savedImages = []; this._savedDeclaration = 'none'; this.setData({ user: null, content: '', images: [], declaration: 'none', count: 0, countProgress: 0, canPublish: false, exitConfirmVisible: false }); this.requestLogin(); }
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
        this.setData({ viewportHeight: height, sheetTop: top, settingsHeight: Math.min(height - top - 16, 940 * width / 750) });
      } catch (error) { /* 旧设备保留默认安全位置。 */ }
    },
    async initialize() {
      const cached = users.getCachedUser();
      if (cached) { this.onLoggedIn(cached); return; }
      try {
        const user = await users.restore({ force: false });
        if (this._unloaded || this._closing) return;
        if (user) this.onLoggedIn(user);
        else this.requestLogin();
      } catch (error) { if (!this._unloaded && !this._closing) { this.setData({ error: error.message }); this.requestLogin(); } }
    },
    onLoggedIn(user) {
      const changed = this._editorOwnerId !== user._id;
      this._editorOwnerId = user._id;
      if (changed) {
        this._savedContent = '';
        this._savedDeclaration = 'none';
        this._savedImages = []; this._knownUploads = new Set();
        this.setData({ images: [] });
        this.setContent(''); this._requestId = null;
        this.setData({ replyAudience: 'anyone', viewAudience: 'anyone', declaration: 'none', panel: '', exitConfirmVisible: false, error: '' });
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
          this.setData({ images, declaration: this._savedDeclaration });
          this._savedContent = draft.content;
          this._requestId = draft.requestId || token();
          this.setContent(draft.content);
        }
      } catch (error) { /* 无草稿时直接开始输入。 */ }
    },
    setContent(content) {
      const count = Array.from(content).length;
      this.setData({ content, count, countProgress: Math.min(360, Math.round(count * 36) / 100), canPublish: Boolean(content.trim() || this.data.images.length) && count <= 1000 });
    },
    onInput(event) {
      if (this._unloaded || this._closing || this.data.publishing || this.data.savingDraft || this.data.exitConfirmVisible) return;
      this._requestId = token();
      this.setContent(event.detail.value);
      this.setData({ error: '' });
    },
    saveDraft() {
      const user = users.getCachedUser();
      if (!user || !this.data.user || user._id !== this.data.user._id) return false;
      try {
        const key = `square.draft.${user._id}`;
        if (this.data.content.trim() || this.data.images.length) wx.setStorageSync(key, { content: this.data.content, declaration: this.data.declaration, requestId: this._requestId || (this._requestId = token()),
          ...(this.data.images.length ? { images: this.data.images.map(image => ({ key: image.key, fileID: image.fileID, type: image.type })) } : {}) });
        else wx.removeStorageSync(key);
        this._savedContent = this.data.content;
        this._savedImages = this.data.images.map(image => image.fileID);
        this._savedDeclaration = this.data.declaration;
        return true;
      } catch (error) { return false; }
    },
    async saveAndClose() {
      if (this.busy()) return;
      if (!this.data.content.trim() && !this.data.images.length) { wx.showToast({ title: '请先写点内容或选择图片', icon: 'none' }); return; }
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
      const version = users.getSessionVersion();
      this.setData({ choosingImages: true, editorFocused: false, error: '' });
      if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
      try {
        const selected = await media.chooseImages(9 - this.data.images.length);
        if (this._unloaded || version !== users.getSessionVersion() || !selected.length) return;
        this.setData({ images: [...this.data.images, ...selected].slice(0, 9) });
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
      this._requestId = token(); this.setContent(this.data.content);
    },
    async previewSelectedImage(event) {
      const files = this.data.images.map(image => image.fileID || image.path), current = files[event.currentTarget.dataset.index];
      if (!current) return;
      try { await media.previewImages(files, current); }
      catch (error) { if (!this._unloaded && error.code !== 'SESSION_CHANGED') wx.showToast({ title: error.message || '图片预览失败', icon: 'none' }); }
      finally { if (!this._unloaded) this.triggerEvent('resumenavigation'); }
    },
    async uploadSelectedImages() {
      const version = users.getSessionVersion();
      this.setData({ uploadDone: 0, uploadTotal: this.data.images.length });
      return media.uploadImages(this.data.images, (index, fileID) => {
        if (this._unloaded || version !== users.getSessionVersion()) return;
        this._knownUploads = this._knownUploads || new Set(); this._knownUploads.add(fileID);
        this.setData({ [`images[${index}].fileID`]: fileID });
      }, (done, total) => {
        if (!this._unloaded && version === users.getSessionVersion()) this.setData({ uploadDone: done, uploadTotal: total });
      });
    },
    focusEditor() {
      if (!this.data.user || this.busy() || this.data.panel || this.data.exitConfirmVisible) return;
      this.setData({ editorFocused: true });
    },
    blurEditor() { this.setData({ editorFocused: false }); },
    keyboard(event) {
      if (this._unloaded || this._closing || this.data.panel || this.data.exitConfirmVisible) return;
      this.setData({ keyboardHeight: Math.max(0, Number(event.detail.height) || 0) });
    },
    openPanel(event) {
      if (this.busy() || this.data.loginSheetOpen || this.data.exitConfirmVisible) return;
      const panel = event.currentTarget.dataset.panel;
      if (!['options', 'declaration'].includes(panel)) return;
      if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
      this.setData({ panel, keyboardHeight: 0, editorFocused: false });
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
      this.setData({ declaration: value });
    },
    finishClose(published = false) {
      if (this._closing || this._unloaded) return;
      this._closing = true;
      this._authVersion = (this._authVersion || 0) + 1;
      this.setData({ closing: true, editorFocused: false, panel: '', exitConfirmVisible: false, loginSheetOpen: false });
      if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
      this._closeTimer = setTimeout(() => { if (!this._unloaded) this.triggerEvent('close', { published }); }, 260);
    },
    async publish() {
      if (this.busy() || !this.data.canPublish || this.data.loginSheetOpen || this.data.panel || this.data.exitConfirmVisible) return;
      const user = users.getCachedUser(), version = users.getSessionVersion();
      if (!user || !this.data.user || user._id !== this.data.user._id) { this.requestLogin(); return; }
      this._requestId = this._requestId || token();
      this.setData({ publishing: true, error: '' });
      try {
        const images = this.data.images.length ? await this.uploadSelectedImages() : [];
        if (this._unloaded || version !== users.getSessionVersion()) return;
        await square.publish(this.data.content, this._requestId, images, this.data.declaration);
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
      this.setData({ exitConfirmVisible: false, editorFocused: true });
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
      this.setData({ images: [], error: '' });
      this.setContent('');
      this.finishClose();
    },
    cancel() {
      if (this.busy() || this.data.exitConfirmVisible) return;
      const imageKeys = this.data.images.map(image => image.fileID || image.key);
      if ((this.data.content.length || this.data.images.length) && (this.data.content !== (this._savedContent || '') || this.data.declaration !== (this._savedDeclaration || 'none') || JSON.stringify(imageKeys) !== JSON.stringify(this._savedImages || []))) {
        this.setData({ exitConfirmVisible: true, panel: '', keyboardHeight: 0, editorFocused: false, error: '' });
        if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
        return;
      }
      if (!this.data.content.length && !this.data.images.length && !this.clearDraft()) return;
      this.finishClose();
    },
  },
});
