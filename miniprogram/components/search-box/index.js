Component({
  properties: { value: String, accountId: String, entry: Boolean, focusInput: Boolean },
  methods: {
    input(event) { this.triggerEvent('input', { value: event.detail.value }); },
    submit() { this.triggerEvent('submit'); },
    removeAuthor() { this.triggerEvent('removeauthor'); },
  },
});
