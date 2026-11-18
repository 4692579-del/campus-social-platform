Component({
  properties: { post: Object, viewer: Object },
  data: { expanded: false },
  observers: { 'post._id': function () { this.setData({ expanded: false }); } },
  methods: {
    toggleExpanded() { this.setData({ expanded: !this.data.expanded }); },
    reply() { this.triggerEvent('reply', { id: this.data.post._id }); },
    like() { this.triggerEvent('react', { id: this.data.post._id, kind: 'like' }); },
    repost() { this.triggerEvent('react', { id: this.data.post._id, kind: 'repost' }); },
    more() { this.triggerEvent('more', { id: this.data.post._id }); },
    share() { this.triggerEvent('share', { id: this.data.post._id }); },
  },
});
