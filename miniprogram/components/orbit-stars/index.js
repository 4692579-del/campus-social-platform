const TURN = Math.PI * 2;
const AXIS_TILT = Math.PI / 14;
const SIN_TILT = Math.sin(AXIS_TILT);
const COS_TILT = Math.cos(AXIS_TILT);

function makeStars() {
  let seed = 2461;
  const sample = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  return Array.from({ length: 160 }, () => {
    const distance = sample();
    return { angle: sample() * TURN, radius: 0.95 + distance * 0.55,
      rise: (sample() - 0.5) * 0.86, speed: 0.065 - distance * 0.027,
      size: 0.36 + sample() * 0.6, color: sample() < 0.72 ? 'rgba(207,229,255,.54)' : 'rgba(240,248,255,.82)' };
  });
}

Component({
  properties: { active: Boolean },
  observers: { active() { this.syncMotion(); } },
  lifetimes: {
    ready() { this.measureSky(); },
    detached() { this._dead = true; this.stopMotion(); },
  },
  pageLifetimes: {
    show() { this._hidden = false; this.syncMotion(); },
    hide() { this._hidden = true; this.stopMotion(); },
    resize() { this.measureSky(); },
  },
  methods: {
    measureSky() {
      const measurement = this._measurement = {};
      this.createSelectorQuery().select('#orbit-sky').fields({ node: true, size: true }).exec(([sky]) => {
        if (this._dead || this._measurement !== measurement || !sky?.node || !sky.width || !sky.height) return;
        this.stopMotion();
        const { node, width, height } = sky;
        let ratio = 1;
        try { ratio = Math.min(2, wx.getWindowInfo().pixelRatio || 1); } catch (_) { /* 使用默认像素比。 */ }
        node.width = Math.round(width * ratio);
        node.height = Math.round(height * ratio);
        const context = node.getContext('2d');
        if (!context) return;
        context.scale(ratio, ratio);
        this._sky = { node, context, width, height };
        if (!this._stars) this._stars = makeStars();
        this.paintSky();
        this.syncMotion();
      });
    },
    stopMotion() {
      this._motion = null;
      if (this._frame !== undefined) this._sky?.node.cancelAnimationFrame(this._frame);
      this._frame = undefined;
    },
    syncMotion() {
      this.stopMotion();
      if (this._dead || this._hidden || !this.data.active || !this._sky) return;
      const { node } = this._sky;
      const motion = this._motion = {};
      let last = 0;
      const tick = () => {
        if (this._motion !== motion) return;
        const time = Date.now();
        if (last && time - last < 29) { this._frame = node.requestAnimationFrame(tick); return; }
        const seconds = last ? Math.min(time - last, 64) / 1000 : 0;
        last = time;
        for (const star of this._stars) star.angle = (star.angle + star.speed * seconds) % TURN;
        this.paintSky();
        this._frame = node.requestAnimationFrame(tick);
      };
      this._frame = node.requestAnimationFrame(tick);
    },
    paintSky() {
      const { context, width, height } = this._sky;
      context.clearRect(0, 0, width, height);
      // 与 aspectFill 使用同一缩放和居中裁剪，将轨道对齐背景图里的地球。
      const scale = Math.max(width / 817, height / 386);
      const artWidth = 817 * scale, artHeight = 386 * scale;
      const left = (width - artWidth) / 2, top = (height - artHeight) / 2;
      for (const star of this._stars) {
        const horizontal = star.radius * Math.sin(star.angle);
        const depth = star.radius * Math.cos(star.angle);
        // 倾斜的圆形轨道经透视投影后形成弧线，靠近屏幕时自然放大。
        const perspective = 1 / (2.1 - depth);
        const artX = 0.422 + (horizontal * COS_TILT * 0.66 + star.rise * 0.09) * perspective;
        const artY = 0.57 + (star.rise * COS_TILT * 0.65 - horizontal * SIN_TILT + 0.24 * depth) * perspective;
        const x = left + artWidth * artX, y = top + artHeight * artY;
        if (x < -2 || x > width + 2 || y < -2 || y > height + 2) continue;
        // 地球挡住后方星星，前方轨道可掠过外缘。
        const limb = ((artX - 0.422) / 0.43) ** 2 + ((artY - 1.31) / 0.76) ** 2;
        if (limb < (depth > 0 ? 0.84 : 1)) continue;
        context.fillStyle = star.color;
        context.beginPath();
        context.arc(x, y, star.size * (0.75 + 0.4 * perspective), 0, TURN);
        context.fill();
      }
    },
  },
});
