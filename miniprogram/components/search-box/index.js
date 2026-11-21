Component({
  properties: { value: String, accountId: String },
  methods: {
    input(event) { this.triggerEvent('input', { value: event.detail.value }); },
    submit() { this.triggerEvent('submit'); },
    removeAuthor() { this.triggerEvent('removeauthor'); },
  },
});
