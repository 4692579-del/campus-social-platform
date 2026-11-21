Component({
  properties: { target: Object, closing: Boolean, busy: Boolean },
  methods: {
    stopEvent() {},
    cancel() { if (!this.data.closing && !this.data.busy) this.triggerEvent('cancel'); },
    confirm() { if (!this.data.closing && !this.data.busy) this.triggerEvent('confirm'); },
  },
});
