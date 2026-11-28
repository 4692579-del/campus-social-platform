const users = require('../services/user');
const { cardPixels } = require('./post-removal-pixels');
const { SWEEP_MS, GRAIN_LIFE_MS, UPWARD_ROOM, createSandFrame, paintSand } = require('./post-removal-sand');

const REFLOW_DURATION = 480;
const MEASURE_TIMEOUT = 200;
const CAPTURE_TIMEOUT = 2000;
const PREPARE_TIMEOUT = 1050;
const ANIMATION_GRACE = 50;
const FADE_DURATION = 180;

function removalOwner(page) {
  return page.followSessionKey?.() ?? `${page.data.user?._id || ''}:${users.getSessionVersion()}`;
}

function clearRemoval(page) {
  const motion = page._postRemoval;
  if (!motion) return;
  page._postRemoval = null;
  clearTimeout(motion.timer);
  if (motion.frame !== undefined) motion.canvas?.cancelAnimationFrame?.(motion.frame);
  if (page._unloaded) return;
  motion.remove();
  page.setData({ postRemoval: null });
  if (motion.feedUpdated && page.currentView(motion.view) && motion.owner === removalOwner(page)) page.restorePostRemovalFeed(motion);
}

function removalArea(page, rect) {
  const viewportHeight = page._chromeViewportHeight || page._profileViewportHeight || 900;
  if (!rect?.width || !rect.height || rect.bottom <= 0 || rect.top >= viewportHeight) return null;
  const top = Math.max(0, -rect.top);
  const height = Math.min(rect.height - top, viewportHeight - rect.top - top);
  const canvasTop = Math.max(-rect.top, top - UPWARD_ROOM);
  return { width: rect.width, top, height, offset: top - canvasTop, canvasTop,
    canvasHeight: Math.ceil(height + top - canvasTop + 3) };
}

function runSweep(page, motion, area, canvas, pixels) {
  if (page._postRemoval !== motion || motion.phase !== 'prepare') return;
  clearTimeout(motion.timer);
  let frame;
  if (pixels?.surface && typeof canvas?.requestAnimationFrame === 'function') {
    try {
      const ratio = Math.min(wx.getWindowInfo?.().pixelRatio || 1, 2);
      canvas.width = Math.ceil(area.width * ratio);
      canvas.height = Math.ceil(area.canvasHeight * ratio);
      const ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      frame = createSandFrame(ctx, canvas, pixels, area);
      paintSand(frame, 0);
    } catch (_) { frame = null; }
  }
  const duration = frame ? SWEEP_MS + GRAIN_LIFE_MS : FADE_DURATION;
  motion.phase = 'scatter';
  motion.canvas = frame ? canvas : null;
  motion.startedAt = Date.now();
  const finish = () => {
    if (page._postRemoval !== motion) return;
    if (motion.phase !== 'scatter') { page.finishPostRemoval(); return; }
    page.advancePostRemoval(motion);
    if (motion.canvas) motion.timer = setTimeout(() => page.finishPostRemoval(), REFLOW_DURATION + ANIMATION_GRACE);
  };
  motion.timer = setTimeout(finish, duration + ANIMATION_GRACE * 2);
  page.setData({ 'postRemoval.phase': 'scatter', 'postRemoval.tiles': Boolean(frame) }, () => {
    if (page._postRemoval !== motion || motion.phase !== 'scatter') return;
    clearTimeout(motion.timer);
    motion.timer = setTimeout(finish, duration + ANIMATION_GRACE);
    if (!frame) return;
    motion.startedAt = Date.now();
    const tick = () => {
      motion.frame = undefined;
      if (page._postRemoval !== motion || !motion.canvas) return;
      const elapsed = Date.now() - motion.startedAt;
      if (elapsed >= duration && motion.phase === 'reflow') { page.finishPostRemoval(); return; }
      paintSand(frame, elapsed);
      if (frame.released === frame.tiles.length) page.advancePostRemoval(motion);
      motion.frame = canvas.requestAnimationFrame(tick);
    };
    motion.frame = canvas.requestAnimationFrame(tick);
  });
}

module.exports = {
  prepareDeletedPost(id) {
    const target = this.postRemovalTarget(id);
    if (!target || typeof this.createSelectorQuery !== 'function') return;
    const card = this.selectComponent?.('#' + target + '-post-' + id);
    if (!card) return;
    const view = this._viewVersion || 0, owner = removalOwner(this);
    let active = true;
    const current = () => active && this.currentView(view) && this.postRemovalTarget(id) === target && removalOwner(this) === owner;
    return new Promise(resolve => {
      const done = value => { active = false; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(done, CAPTURE_TIMEOUT);
      this.createSelectorQuery().select('#' + target + '-row-' + id).boundingClientRect(rect => {
        const area = current() && removalArea(this, rect);
        if (!area) { done(); return; }
        cardPixels(card, rect, area, current).then(pixels => done({ rect, area, pixels }), () => done());
      }).exec();
    }).catch(() => undefined);
  },
  animateDeletedPost(id, remove, prepared) {
    const target = this.postRemovalTarget(id);
    if (!target || this.data.pullRefreshing || this.data.profileRefreshing || this.data.menuOpen || this.data.commentPostId ||
        this.data.authorMenu || this.data.postPopover ||
        this.interactionBlocked() ||
        typeof this.createSelectorQuery !== 'function') return false;
    this.finishPostRemoval();
    const motion = this._postRemoval = { id, target, remove, view: this._viewVersion || 0, owner: removalOwner(this) };
    const ready = rect => {
      if (this._postRemoval !== motion) return;
      const area = removalArea(this, rect);
      if (!area) {
        this.finishPostRemoval();
        return;
      }
      clearTimeout(motion.timer);
      motion.phase = 'prepare';
      motion.timer = setTimeout(() => runSweep(this, motion, area), PREPARE_TIMEOUT);
      const card = this.selectComponent?.('#' + target + '-post-' + id);
      const current = () => this._postRemoval === motion && motion.phase === 'prepare';
      this.setData({ postRemoval: {
        id, target, phase: 'prepare', height: rect.height, canvasTop: area.canvasTop, canvasHeight: area.canvasHeight,
        fadeDuration: FADE_DURATION, reflowDuration: REFLOW_DURATION,
      } }, () => {
        if (!current()) return;
        if (!card) { runSweep(this, motion, area); return; }
        const surface = new Promise(resolve => {
          const query = this.createSelectorQuery();
          query.select('#post-removal-canvas').fields({ node: true });
          query.exec(result => resolve(result?.[0]?.node));
        });
        const readPixels = async () => {
          const capture = await prepared;
          if (!current()) return;
          if (capture?.pixels && Math.abs(capture.rect.width - rect.width) < 1 && Math.abs(capture.rect.height - rect.height) < 1 &&
              Math.abs(capture.area.top - area.top) < 1 && Math.abs(capture.area.height - area.height) < 1) return capture.pixels;
          return cardPixels(card, rect, area, current);
        };
        Promise.all([surface, readPixels()]).then(
          ([canvas, pixels]) => runSweep(this, motion, area, canvas, pixels),
          () => runSweep(this, motion, area),
        );
      });
    };
    motion.timer = setTimeout(() => this.finishPostRemoval(), MEASURE_TIMEOUT);
    this.createSelectorQuery().select('#' + target + '-row-' + id).boundingClientRect(ready).exec();
    return true;
  },
  advancePostRemoval(motion) {
    if (this._postRemoval !== motion || motion.phase !== 'scatter') return;
    motion.phase = 'reflow';
    this.setData({ 'postRemoval.phase': 'reflow' });
    if (!motion.canvas) {
      clearTimeout(motion.timer);
      motion.timer = setTimeout(() => this.finishPostRemoval(), REFLOW_DURATION + ANIMATION_GRACE);
    }
  },
  onPostRemovalAnimationEnd(event) {
    const motion = this._postRemoval;
    const { id, phase } = event.target.dataset || {};
    if (!motion || motion.id !== id || motion.phase !== phase) return;
    if (phase === 'scatter') {
      if (motion.canvas) {
        if (motion.frame !== undefined) motion.canvas.cancelAnimationFrame?.(motion.frame);
        motion.frame = undefined;
        motion.canvas = null;
      }
      this.advancePostRemoval(motion);
    }
    if (phase === 'reflow' && !motion.canvas) this.finishPostRemoval();
  },
  finishPostRemoval() { clearRemoval(this); },
};
