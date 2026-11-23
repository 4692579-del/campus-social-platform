const { rememberSize, imageLayout } = require('../../utils/post-image-layout');
const { postMedia } = require('../../utils/post-media');

const FEED_VIDEO_VISIBILITY = .6;
const VIDEO_END_MARGIN = 2;
const visibleVideos = new Map();
let activeVideo, selectionPending;

function selectFeedVideo(card, file) {
  if (file) visibleVideos.set(card, file);
  else visibleVideos.delete(card);
  if (activeVideo && activeVideo.card === card && activeVideo.file !== file) {
    activeVideo = null;
    card.stopFeedVideo();
  }
  if (activeVideo || selectionPending || !visibleVideos.size) return;
  selectionPending = true;
  // 同一批面板/页面更新先暂停旧播放器，再决定是否有下一条可播放。
  Promise.resolve().then(() => {
    selectionPending = false;
    for (const [candidate, source] of visibleVideos) {
      if (candidate.feedVideoCandidate() !== source) { visibleVideos.delete(candidate); continue; }
      activeVideo = { card: candidate, file: source };
      candidate.startFeedVideo(source);
      break;
    }
  });
}

Component({
  options: { multipleSlots: true },
  properties: { post: Object, viewer: Object, detail: Boolean, likeMotion: Boolean, profilePosts: Boolean, pinned: Boolean, showPin: Boolean, homeFeed: Boolean, feedVideoEnabled: Boolean, followPreview: Object, sevenLinePreview: Boolean },
  data: { expanded: false, sevenLineOverflow: null, imageIndex: 0, imageFiles: [], mediaItems: [], galleryWidth: 100, galleryHeight: 471, likeMotionClass: '', feedVideo: null,
    likeParticleRays: [
      { angle: 0, color: '#b39ad4', accent: '#94c8d1' }, { angle: 51.4, color: '#ad83b3', accent: '#c1a4bf' },
      { angle: 102.9, color: '#a9d2a2', accent: '#86c6bd' }, { angle: 154.3, color: '#d4b275', accent: '#aec58e' },
      { angle: 205.7, color: '#9173ac', accent: '#c49ac7' }, { angle: 257.1, color: '#89bcca', accent: '#99d8be' },
      { angle: 308.6, color: '#95d3ab', accent: '#b4c9e5' },
    ],
  },
  lifetimes: {
    ready() { this._postReady = true; this.watchFeedVideo(); this.measureSevenLinePreview(); },
    detached() {
      this._unloaded = true;
      this.clearLikeMotion();
      this.disconnectFeedVideo();
    },
  },
  pageLifetimes: {
    resize() { this.measureSevenLinePreview(); },
    hide() { this._pageHidden = true; this.clearLikeMotion(); this.disconnectFeedVideo(); },
    show() {
      this._pageHidden = false;
      if (this._pendingImageLayout) { this._pendingImageLayout = false; this.updateImageLayout(); }
      this.watchFeedVideo();
      this.measureSevenLinePreview();
    },
  },
  observers: {
    'post._id': function (id) {
      if (this._postId === id) return;
      this.clearLikeMotion();
      this.resetFeedVideo();
      this._postId = id;
      this.setData({ expanded: false, imageIndex: 0, ...(this.data.sevenLineOverflow !== null ? { sevenLineOverflow: null } : {}) }, () => this.watchFeedVideo());
    },
    'sevenLinePreview, detail, post._id, post.content, post.fullContent': function () {
      if (this._unloaded) return;
      this.measureSevenLinePreview();
    },
    'viewer._id': function (id) {
      if (this._likeViewerId === id) return;
      this._likeViewerId = id;
      this.clearLikeMotion();
      this.resetFeedVideo();
      this.watchFeedVideo();
    },
    'post.liked': function (liked) {
      const target = Boolean(liked), intent = this._likeIntent;
      if (!intent) {
        // 保存失败的回退只恢复真实图标，不再播放一次用户点击动画。
        if (this.data.likeMotionClass && this._animatedLikeTarget !== target) this.clearLikeMotion();
        return;
      }
      if (this._unloaded || this._pageHidden || !this.data.likeMotion || intent.id !== this.data.post._id || Date.now() > intent.expires) {
        this.clearLikeMotion(); return;
      }
      if (target === intent.from) return;
      this._likeIntent = null;
      this.playLikeMotion(target);
    },
    'post.images': function (images) {
      this.syncMedia({ ...this.data.post, images });
    },
    'post.media': function (media) { this.syncMedia({ ...this.data.post, media }); },
    detail() {
      if (this._unloaded) return;
      this.updateImageLayout();
      this.disconnectFeedVideo();
      this.watchFeedVideo();
    },
    feedVideoEnabled() { this.watchFeedVideo(); },
  },
  methods: {
    measureSevenLinePreview() {
      const version = this._sevenLineMeasure = (this._sevenLineMeasure || 0) + 1;
      if (!this._postReady || this._unloaded || this._pageHidden || !this.data.sevenLinePreview || this.data.detail ||
          typeof this.createSelectorQuery !== 'function') return;
      const current = () => version === this._sevenLineMeasure && !this._unloaded && !this._pageHidden;
      const measure = () => {
        if (!current()) return;
        const query = this.createSelectorQuery();
        query.select('.post-text-seven-lines').fields({ size: true, computedStyle: ['lineHeight'] });
        query.exec(result => {
          const rect = result?.[0];
          if (!current() || !rect?.width) return;
          const lineHeight = parseFloat(rect.lineHeight);
          if (!(lineHeight > 0)) return;
          const overflow = rect.height > 7 * lineHeight + 1;
          if (overflow !== this.data.sevenLineOverflow) this.setData({ sevenLineOverflow: overflow });
        });
      };
      if (typeof wx.nextTick === 'function') wx.nextTick(measure);
      else measure();
    },
    syncMedia(post) {
      if (this._unloaded) return;
      const items = postMedia(post), files = items.map(item => item.fileID);
      // 点赞、时间等字段不重建媒体节点或改写轮播位置。
      if (JSON.stringify(items) === JSON.stringify(this.data.mediaItems)) return;
      this.setData({ imageFiles: files, mediaItems: items, ...imageLayout(files, this.data.detail), ...(this.data.imageIndex >= files.length && this.data.imageIndex !== 0 ? { imageIndex: 0 } : {}) }, () => this.watchFeedVideo());
      if (this._videoVisibility) this.updateFeedVideo();
    },
    watchFeedVideo() {
      if (!this._postReady || this._unloaded || this._pageHidden || !this.data.feedVideoEnabled ||
          !this.data.mediaItems.some(item => item.type === 'video')) {
        this.disconnectFeedVideo();
        return;
      }
      if (this._videoVisibility || typeof this.createIntersectionObserver !== 'function') return;
      try {
        const threshold = this.data.detail ? .25 : FEED_VIDEO_VISIBILITY;
        const observer = this._videoVisibility = this.createIntersectionObserver({ thresholds: [0, threshold] });
        observer.relativeToViewport().observe('.post-image-gallery', result => {
          if (this._videoVisibility !== observer) return;
          this._videoVisible = result.intersectionRatio >= threshold;
          if (!this._videoVisible) this._failedFeedVideo = '';
          this.updateFeedVideo();
        });
      } catch (_) { this.disconnectFeedVideo(); }
    },
    disconnectFeedVideo() {
      if (this._videoVisibility) {
        const observer = this._videoVisibility;
        this._videoVisibility = null;
        observer.disconnect();
      }
      this._videoVisible = false;
      selectFeedVideo(this, '');
    },
    resetFeedVideo() {
      this.disconnectFeedVideo();
      this._feedVideoHistory = null;
      this._failedFeedVideo = '';
    },
    feedVideoCandidate() {
      if (!this._videoVisible || this._unloaded || this._pageHidden || !this.data.feedVideoEnabled || this._previewing) return '';
      const item = this.data.mediaItems[this.data.imageIndex], file = item?.fileID;
      if (item?.type !== 'video' || this._failedFeedVideo === file) return '';
      return file;
    },
    updateFeedVideo() { selectFeedVideo(this, this.feedVideoCandidate()); },
    async startFeedVideo(file) {
      const token = this._feedVideoToken = (this._feedVideoToken || 0) + 1;
      const ticket = this._feedVideoTicket = { file, token };
      this.setData({ feedVideo: { file, token, start: this._feedVideoHistory?.get(file) || 0, src: '', ready: false } });
      try {
        const src = await require('../../services/post-images').resolveVideoPlayback(file);
        if (this._feedVideoTicket !== ticket || this.feedVideoCandidate() !== file) return;
        this.setData({ 'feedVideo.src': src });
      } catch (error) {
        if (this._feedVideoTicket !== ticket) return;
        if (error.code === 'SESSION_CHANGED') this.disconnectFeedVideo();
        else this.failFeedVideo(file);
      }
    },
    stopFeedVideo() {
      const player = this.data.feedVideo;
      this._feedVideoTicket = null;
      if (!player) return;
      if (player.src) {
        try { wx.createVideoContext(`feed-video-${player.token}`, this).pause(); } catch (_) { /* 卸载时原生播放器可能已释放。 */ }
      }
      if (!this._unloaded) this.setData({ feedVideo: null });
    },
    currentFeedVideo(event) {
      const ticket = this._feedVideoTicket;
      return ticket && ticket.token === Number(event.currentTarget.dataset.token) ? ticket : null;
    },
    feedVideoTime(event) {
      const ticket = this.currentFeedVideo(event);
      const { currentTime: time, duration } = event.detail;
      const player = this.data.feedVideo;
      if (!ticket || !player?.src || !Number.isFinite(time) || time < 0) return;
      if (Number.isFinite(duration) && duration > 0) ticket.duration = duration;
      if (ticket.restarting) {
        // 忽略 seek 到片头前迟到的片尾进度。
        if (time > (ticket.duration ? Math.min(VIDEO_END_MARGIN, ticket.duration / 2) : VIDEO_END_MARGIN)) return;
        ticket.restarting = false;
      }
      const history = this._feedVideoHistory || (this._feedVideoHistory = new Map());
      const nearEnd = ticket.duration && ticket.duration - time <= Math.min(VIDEO_END_MARGIN, ticket.duration / 2);
      history.set(ticket.file, nearEnd ? 0 : time);
      if (!player.ready) {
        // 原生播放器启动时仍可能是黑屏，等播放时间开始推进再露出画面。
        if (time <= 0 || time === player.start) return;
        this.setData({ 'feedVideo.ready': true });
      }
    },
    feedVideoEnded(event) {
      const ticket = this.currentFeedVideo(event);
      if (!ticket || ticket.restarting || this.feedVideoCandidate() !== ticket.file) return;
      this._feedVideoHistory?.delete(ticket.file);
      ticket.restarting = true;
      // initial-time 只用于续播，循环始终显式回到视频开头。
      try {
        const player = wx.createVideoContext(`feed-video-${ticket.token}`, this);
        player.seek(0);
        player.play();
      } catch (_) { this.failFeedVideo(ticket.file); }
    },
    feedVideoError(event) {
      const ticket = this.currentFeedVideo(event);
      if (ticket) this.failFeedVideo(ticket.file);
    },
    failFeedVideo(file) {
      this._failedFeedVideo = file;
      this.updateFeedVideo();
    },
    stopEvent() {},
    viewAuthor() { if (!this._unloaded && !this._pageHidden) this.triggerEvent('author', { author: this.data.post.author }); },
    isOwnAuthor() {
      const viewer = this.data.viewer, post = this.data.post;
      return Boolean(viewer && (viewer.accountId && post.author && post.author.accountId ? viewer.accountId === post.author.accountId : post.isOwn));
    },
    avatarMenu() {
      if (!this.data.homeFeed || this.data.detail || this._unloaded || this._pageHidden || this.isOwnAuthor()) return;
      this.triggerEvent('avatar', { id: this.data.post._id });
    },
    getAvatarRect(callback) {
      if (this._unloaded || this._pageHidden || !this.data.homeFeed || this.data.detail || this.isOwnAuthor()) return;
      const id = this.data.post._id;
      this.createSelectorQuery().select('.post-avatar-anchor').boundingClientRect(rect => {
        if (!this._unloaded && !this._pageHidden && this.data.post._id === id) callback(rect);
      }).exec();
    },
    clearLikeMotion() {
      this._likeIntent = null;
      this._likeMotionSequence = (this._likeMotionSequence || 0) + 1;
      if (this._likeMotionTimer) { clearTimeout(this._likeMotionTimer); this._likeMotionTimer = null; }
      if (!this._unloaded && this.data.likeMotionClass) this.setData({ likeMotionClass: '' });
    },
    playLikeMotion(liked) {
      if (this._unloaded || this._pageHidden || !this.data.likeMotion) return;
      if (this._likeMotionTimer) clearTimeout(this._likeMotionTimer);
      const sequence = this._likeMotionSequence = (this._likeMotionSequence || 0) + 1;
      this._likeMotionVariant = !this._likeMotionVariant;
      this._animatedLikeTarget = liked;
      // 交替动画名可在一次视图更新中重播，不重建图片或等待一帧清空样式。
      this.setData({ likeMotionClass: `is-${liked ? 'like' : 'unlike'}-${this._likeMotionVariant ? 'a' : 'b'}` });
      this._likeMotionTimer = setTimeout(() => {
        if (this._unloaded || this._pageHidden || sequence !== this._likeMotionSequence) return;
        this._likeMotionTimer = null;
        this.setData({ likeMotionClass: '' });
      }, liked ? 960 : 440);
    },
    updateImageLayout() {
      if (this._unloaded) return;
      const next = imageLayout(this.data.imageFiles, this.data.detail);
      const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => this.data[key] !== value));
      if (Object.keys(changed).length) this.setData(changed);
    },
    photoLoaded(event) {
      const file = event.currentTarget.dataset.file;
      if (this._unloaded || !this.data.imageFiles.includes(file)) return;
      rememberSize(file, event.detail.width, event.detail.height);
      // 同一图片可能在首页和详情同时解码；缓存已由另一实例写入时，本实例仍需应用尺寸。
      if (file !== this.data.imageFiles[0]) return;
      if (this._pageHidden) this._pendingImageLayout = true;
      else this.updateImageLayout();
    },
    open() { if (!this.data.detail) this.triggerEvent('open', { id: this.data.post._id }); },
    toggleExpanded() { this.setData({ expanded: !this.data.expanded }); },
    reply() {
      const post = this.data.post;
      if (post.author?.commentsDisabled && !post.replyCount) {
        wx.showToast({ title: '该账号已关闭评论', icon: 'none' });
        return;
      }
      this.triggerEvent('reply', { id: post._id });
    },
    quote() { this.triggerEvent('quote', { id: this.data.post._id }); },
    copyNewsSource() {
      const post = this.data.post;
      if (post.contentType === 'news' && /^https?:\/\//i.test(post.sourceUrl || '')) wx.setClipboardData({ data: post.sourceUrl });
    },
    like() {
      if (this._unloaded || this._pageHidden) return;
      this._likeIntent = this.data.likeMotion && this.data.viewer ? { id: this.data.post._id, from: Boolean(this.data.post.liked), expires: Date.now() + 750 } : null;
      this.triggerEvent('react', { id: this.data.post._id, kind: 'like' });
    },
    more() { this.triggerEvent('more', { id: this.data.post._id, profilePosts: this.data.profilePosts === true }); },
    imageChanged(event) {
      const index = event.detail.current, images = this.data.imageFiles;
      if (this._unloaded || this._pageHidden || !Number.isInteger(index) || index < 0 || index >= images.length || index === this.data.imageIndex) return;
      this.setData({ imageIndex: index });
      if (this._videoVisibility) this.updateFeedVideo();
    },
    async previewImage(event) {
      if (this._previewing || this._unloaded || this._pageHidden) return;
      const index = Number(event.currentTarget.dataset.index), files = this.data.imageFiles, current = files[index];
      if (!current) return;
      this._previewing = true;
      if (this._videoVisibility) this.updateFeedVideo();
      try {
        const service = require('../../services/post-images');
        if (this.data.mediaItems.some(item => item.type === 'video')) await service.previewMedia(this.data.mediaItems, index);
        else await service.previewImages(files, current);
      }
      catch (error) { if (!this._unloaded && error.code !== 'SESSION_CHANGED') wx.showToast({ title: error.message || '媒体预览失败，请重试', icon: 'none' }); }
      finally {
        this._previewing = false;
        if (this._videoVisibility) this.updateFeedVideo();
      }
    },
  },
});
