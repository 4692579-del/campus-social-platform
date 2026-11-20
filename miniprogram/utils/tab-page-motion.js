let pending = null;
let sequence = 0;

function phase(page, value) {
  if (page.data.tabMotionPhase !== value) page.setData({ tabMotionPhase: value });
}

// 单独绘制薄遮片，正文与图片始终保持不透明；路由不等动画或渲染回调。
module.exports = {
  data: { tabMotionPhase: '' },
  methods: {
    showTabMotion(route) {
      this.hideTabMotion();
      this._tabMotionVisible = true;
      const entering = pending && pending.route === route && Date.now() - pending.at < 1000;
      if (pending && (entering || Date.now() - pending.at >= 1000)) pending = null;
      phase(this, entering ? 'entering' : '');
      if (!entering) return;
      const epoch = this._tabMotionEpoch;
      this._tabMotionTimer = setTimeout(() => {
        if (epoch !== this._tabMotionEpoch || !this._tabMotionVisible || this._unloaded) return;
        this._tabMotionTimer = null;
        phase(this, '');
      }, 180);
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
      this.hideTabMotion();
      this._tabMotionVisible = true;
      const ticket = this._tabMotionTicket = ++sequence;
      pending = { route, at: Date.now(), ticket };
      phase(this, 'leaving');
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
