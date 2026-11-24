const plans = [
  { name: 'Free', free: true },
  { name: 'Go', monthly: 19, yearly: 182, original: 228, score: 'go' },
  { name: 'Up', monthly: 39, yearly: 374, original: 468, score: 'up' },
  { name: 'Get', monthly: 79, yearly: 758, original: 948, score: 'get' },
];

const benefits = [
  { icon: 'message-circle', label: '动态发布、点赞、评论、私信', values: [true, true, true, true] },
  { icon: 'shopping-bag', label: '二手集市、跑腿互助', values: [true, true, true, true] },
  {
    icon: 'xiaocui-spark',
    label: 'AI 使用额度 / 月',
    values: ['10 点', '50 点', '150 点', '400 点'],
    details: [
      ['问问小萃'],
      ['问问小萃', '小萃优化'],
      ['问问小萃', '小萃优化', '小萃翻译', '小萃总结'],
      ['问问小萃', '小萃优化', '小萃翻译', '小萃总结', '专属小萃'],
    ],
  },
  { icon: 'new-post', label: '动态发布内容字数', values: ['150字', '300字', '1500字', '10000字'] },
  { icon: 'album', label: '个性化主页封面', values: ['基础', '更多预设', '自定义主题', '全部主题'] },
  { icon: 'file-lines', label: '动态草稿云保存', values: ['3 篇', '10 篇', '30 篇', '100 篇'] },
  { icon: 'bookmark', label: '收藏夹分类', values: ['3 个', '10 个', '30 个', '100 个'] },
  { icon: 'sliders', label: '高级动态搜索筛选', values: ['', '基础', '完整', '完整'] },
  { icon: 'feather', label: 'AI 文案润色', values: ['', true, true, true] },
  { icon: 'globe', label: 'AI 新闻摘要、翻译', values: ['', '', true, true] },
  { icon: 'chart-bars-muted', label: '个人动态数据分析', values: ['', '', '基础版', '详细版'] },
  { icon: 'user', label: '专属主页装扮', values: ['', '', '部分', '全部'] },
  { icon: 'xiaocui-black', label: '专属 AI 智能助手', values: ['', '', '', true] },
  { icon: 'bell', label: '智能订阅提醒', values: ['', '', '', true] },
  { icon: 'history', label: '高级浏览足迹', values: ['', '', '', true] },
];

Component({
  properties: { top: { type: Number, value: 72 }, capsuleHeight: { type: Number, value: 32 } },
  data: {
    plans, benefits, selected: 1, paymentPlanIndex: 1, billing: 'yearly', closing: false,
    aiDetailsExpanded: plans.map(() => false), layout: null,
  },
  lifetimes: {
    ready() { this.measureLayout(); },
    detached() {
      clearTimeout(this._closeTimer);
      this._layoutQuery = null;
    },
  },
  pageLifetimes: { resize() { this.measureLayout(); } },
  methods: {
    measureLayout() {
      const query = this.createSelectorQuery();
      this._layoutQuery = query;
      query.select('.membership-benefits-viewport').boundingClientRect();
      query.select('.membership-footer').boundingClientRect();
      query.select('.membership-benefits-page.is-free .membership-page-content').boundingClientRect();
      query.select('.membership-benefits-page.is-free .membership-benefit-details').boundingClientRect();
      query.select('.membership-benefits-page.is-free .membership-benefit-detail-list').boundingClientRect();
      query.exec(([viewport, footer, freeContent, visibleDetails, fullDetails]) => {
        if (this._layoutQuery !== query || this.data.closing || !viewport || !footer?.height || !freeContent?.height || !visibleDetails || !fullDetails) return;
        this.setData({
          layout: {
            paidHeight: Math.max(0, viewport.height - (this.data.layout ? footer.height : 0)),
            freeHeight: freeContent.height - visibleDetails.height,
            freeDetailsHeight: fullDetails.height,
          },
        });
      });
    },
    selectPlan(event) {
      const index = Number(event.currentTarget.dataset.index);
      if (this.data.closing || !Number.isInteger(index) || !plans[index] || index === this.data.selected) return;
      this.setData(plans[index].free ? { selected: index } : { selected: index, paymentPlanIndex: index });
    },
    toggleAiDetails(event) {
      const index = Number(event.currentTarget.dataset.index);
      if (this.data.closing || index !== this.data.selected) return;
      this.setData({ [`aiDetailsExpanded[${index}]`]: !this.data.aiDetailsExpanded[index] });
    },
    selectBilling(event) {
      if (plans[this.data.selected].free) return;
      const billing = event.currentTarget.dataset.billing;
      if (!this.data.closing && (billing === 'monthly' || billing === 'yearly') && billing !== this.data.billing) this.setData({ billing });
    },
    close() {
      if (this.data.closing) return;
      this.setData({ closing: true });
      this._closeTimer = setTimeout(() => this.triggerEvent('close'), 240);
    },
    stopMove() {},
  },
});
