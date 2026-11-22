let pending = null;
let sequence = 0;
const LEAVE_MS = 80, ENTER_MS = 180, MAX_COVER = .24;
const easeOut = progress => 1 - Math.pow(1 - Math.max(0, Math.min(1, progress)), 2);

function phase(page, value, opacity = 0) {
  if (page.data.tabMotionPhase !== value || page.data.tabMotionOpacity !== opacity) {
    page.setData({ tabMotionPhase: value, tabMotionOpacity: opacity });
  }
}

// 单独绘制薄遮片，正文与图片始终保持不透明；路由不等动画或渲染回调。
module.exports = {
  data: { tabMotionPhase: '', tabMotionOpacity: 0 },
  methods: {
    showTabMotion(route) {
      this.hideTabMotion();
      this._tabMotionVisible = true;
      const now = Date.now(), age = pending && now - pending.at;
      const incoming = pending && pending.route === route && age < 1000 ? pending : null;
      if (incoming || age >= 1000) pending = null;
      const opacity = incoming ? incoming.opacity + (MAX_COVER - incoming.opacity) * easeOut(age / LEAVE_MS) : 0;
      this._tabMotionEnteredAt = now;
      phase(this, opacity > 0 ? 'entering' : '', opacity);
      if (!opacity) return;
      const epoch = this._tabMotionEpoch;
      this._tabMotionTimer = setTimeout(() => {
        if (epoch !== this._tabMotionEpoch || !this._tabMotionVisible || this._unloaded) return;
        this._tabMotionTimer = null;
        phase(this, '');
      }, ENTER_MS);
    },
    hideTabMotion() {
      this._tabMotionVisible = false;
      this._tabMotionEpoch = (this._tabMotionEpoch || 0) + 1;
      if (this._tabMotionTimer) clearTimeout(this._tabMotionTimer);
      this._tabMotionTimer = null;
      // 源页覆盖前不撤掉最后一帧，交由路由成功回调在隐藏后清理。
    },
    prepareTabLeave(route) {
      if (this._tabMotionVisible === false || this._unloaded) return null;
      const now = Date.now();
      const opacity = this.data.tabMotionPhase === 'entering' ?
        this.data.tabMotionOpacity * (1 - easeOut((now - this._tabMotionEnteredAt) / ENTER_MS)) : 0;
      this.hideTabMotion();
      this._tabMotionVisible = true;
      const ticket = this._tabMotionTicket = ++sequence;
      pending = { route, at: now, ticket, opacity };
      phase(this, 'leaving', opacity);
      return ticket;
    },
    finishTabLeave(ticket) {
      if (ticket !== this._tabMotionTicket || this._unloaded || this._tabMotionVisible) return;
      phase(this, '');
    },
    cancelTabLeave(ticket) {
      if (ticket !== this._tabMotionTicket) return;
      if (pending && pending.ticket === ticket) pending = null;
      this.hideTabMotion();
      if (this._unloaded) return;
      this._tabMotionVisible = true;
      phase(this, '');
    },
  },
};
