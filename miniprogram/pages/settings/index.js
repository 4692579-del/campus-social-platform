const { DEFAULT_LAYOUT, readTabLayout, patchState } = require('../../utils/tab-page-layout');
const {
  DEFAULT_TRANSPARENCY, MIN_TRANSPARENCY, MAX_TRANSPARENCY,
  clampTransparency, glassStyle, readTransparency, saveTransparency,
} = require('../../utils/dock-transparency');

const MARKS = [
  { position: 6, value: MAX_TRANSPARENCY },
  { position: 50, value: DEFAULT_TRANSPARENCY },
  { position: 94, value: MIN_TRANSPARENCY },
];
const TRACK_START = MARKS[0].position;
const TRACK_END = MARKS[2].position;
const TRACK_SPAN = TRACK_END - TRACK_START;
const TRANSPARENCY_SPAN = MAX_TRANSPARENCY - MIN_TRANSPARENCY;
const SNAP_ENTER_PX = 5;
const SNAP_EXIT_PX = 9;
const THUMB_TRANSPARENCY = DEFAULT_TRANSPARENCY * 0.7;

const PREVIEW_CITIES = [
  { id: 'hong-kong', name: '香港', description: '维多利亚港两岸，高楼灯火与山海相映。' },
  { id: 'tokyo', name: '东京', description: '从热闹的街区到安静的神社，日本首都处处可见新旧交融。' },
  { id: 'sydney', name: '悉尼', description: '歌剧院的白帆与海港大桥勾勒出悉尼的海岸线。' },
  { id: 'new-york', name: '纽约', description: '从自由女神像到曼哈顿天际线，纽约的故事沿着港湾展开。' },
];

function sliderPosition(value) {
  return TRACK_START + TRACK_SPAN * (MAX_TRANSPARENCY - value) / TRANSPARENCY_SPAN;
}

Page({
  data: {
    ...DEFAULT_LAYOUT,
    previewCities: PREVIEW_CITIES,
    defaultTransparency: DEFAULT_TRANSPARENCY,
    thumbGlassStyle: glassStyle(THUMB_TRANSPARENCY),
    minTransparency: MIN_TRANSPARENCY,
    maxTransparency: MAX_TRANSPARENCY,
    transparency: DEFAULT_TRANSPARENCY,
    sliderPosition: sliderPosition(DEFAULT_TRANSPARENCY),
    sliderMarks: MARKS,
    snappedMark: -1,
    draggingTransparency: false,
  },
  onLoad() {
    const pages = getCurrentPages();
    this._returnPage = pages[pages.length - 2];
    this._savedTransparency = readTransparency(wx);
    this.updateLayout();
    this.paintTransparency(this._savedTransparency);
  },
  onReady() { this.measureTrack(); },
  onHide() { this.cancelTransparencyDrag(); },
  onResize() {
    this.cancelTransparencyDrag();
    this._track = null;
    this.updateLayout();
    this.measureTrack();
  },
  onUnload() {
    this._drag = null;
    this._trackQuery = null;
    this.prepareReturn();
    this._returnPage = null;
  },
  updateLayout() {
    const { navTop, navButtonHeight, navHeight } = readTabLayout(wx);
    patchState(this, { navTop, navButtonHeight, navHeight });
  },
  paintTransparency(transparency, state = {}) {
    patchState(this, { transparency, sliderPosition: sliderPosition(transparency), ...state });
  },
  measureTrack(onMeasured) {
    const query = wx.createSelectorQuery();
    this._trackQuery = query;
    query.select('.dock-slider-track').boundingClientRect(rect => {
      if (this._trackQuery !== query) return;
      if (rect?.width > 0) this._track = rect;
      if (onMeasured) onMeasured(this._track);
    }).exec();
  },
  startTransparencyDrag(event) {
    if (this._drag || event.touches.length !== 1) return;
    const { identifier, clientX } = event.touches[0];
    if (!Number.isFinite(clientX)) return;
    const drag = this._drag = { identifier, startX: clientX, x: clientX, grabbedThumb: event.target?.dataset?.thumb };
    patchState(this, { draggingTransparency: true });
    const begin = track => {
      if (this._drag !== drag) return;
      if (!track) { this.cancelTransparencyDrag(); return; }
      const { left, width } = track;
      const center = left + width * this.data.sliderPosition / 100;
      drag.offset = drag.grabbedThumb ? drag.startX - center : 0;
      if (!drag.grabbedThumb || drag.x !== drag.startX) this.moveSliderTo(drag.x);
      if (drag.ended) this.finishTransparencyDrag();
    };
    if (this._track) begin(this._track);
    else this.measureTrack(begin);
  },
  moveTransparencyDrag(event) {
    const drag = this._drag;
    const touch = drag && event.touches.find(item => item.identifier === drag.identifier);
    if (touch) this.moveSliderTo(touch.clientX);
  },
  moveSliderTo(x) {
    if (!Number.isFinite(x)) return;
    const drag = this._drag;
    if (drag.offset !== undefined && drag.grabbedThumb && x === drag.x) return;
    drag.x = x;
    if (drag.offset === undefined) return;
    const { left, width } = this._track;
    const distance = x - drag.offset - left;
    const position = Math.min(TRACK_END, Math.max(TRACK_START, 100 * distance / width));
    // A slightly wider release radius keeps small finger movements from breaking the snap.
    const snappedMark = MARKS.findIndex((mark, index) =>
      Math.abs(position - mark.position) * width / 100 <= (index === this.data.snappedMark ? SNAP_EXIT_PX : SNAP_ENTER_PX));
    const value = snappedMark >= 0 ? MARKS[snappedMark].value
      : MAX_TRANSPARENCY - TRANSPARENCY_SPAN * (position - TRACK_START) / TRACK_SPAN;
    this.paintTransparency(clampTransparency(value), { snappedMark });
  },
  endTransparencyDrag(event) {
    const drag = this._drag;
    const touch = drag && event.changedTouches.find(item => item.identifier === drag.identifier);
    if (!touch) return;
    this.moveSliderTo(touch.clientX);
    if (drag.offset === undefined) drag.ended = true;
    else this.finishTransparencyDrag();
  },
  finishTransparencyDrag() {
    this._drag = null;
    this.commitTransparency(this.data.transparency);
  },
  cancelTransparencyDrag() {
    if (!this._drag) return;
    this._drag = null;
    this.paintTransparency(this._savedTransparency, { draggingTransparency: false, snappedMark: -1 });
  },
  selectTransparency(event) {
    if (!this._drag) this.commitTransparency(event.currentTarget.dataset.value);
  },
  resetTransparency() {
    this.commitTransparency(DEFAULT_TRANSPARENCY);
  },
  commitTransparency(value) {
    const transparency = clampTransparency(value);
    try {
      if (transparency !== this._savedTransparency) saveTransparency(wx, transparency);
      this._savedTransparency = transparency;
      this.paintTransparency(transparency, { draggingTransparency: false, snappedMark: -1 });
    } catch (error) {
      this.paintTransparency(this._savedTransparency, { draggingTransparency: false, snappedMark: -1 });
      wx.showToast({ title: '透明度保存失败，请重试', icon: 'none' });
    }
  },
  prepareReturn() {
    if (this._returnPrepared || typeof this._returnPage?.prepareMenuReturn !== 'function') return false;
    this._returnPage.prepareMenuReturn();
    this._returnPrepared = true;
    return true;
  },
  back() {
    if (this._returning) return;
    this._returning = true;
    const prepared = this.prepareReturn();
    const fallbackUrl = this._returnPage?.route === 'pages/search/index' ? '/pages/search/index' : '/pages/home/index';
    const navigate = () => wx.navigateBack({ fail: () => wx.switchTab({
      url: fallbackUrl,
      fail: () => { this._returning = false; },
    }) });
    if (prepared && typeof wx.nextTick === 'function') wx.nextTick(navigate);
    else navigate();
  },
});
