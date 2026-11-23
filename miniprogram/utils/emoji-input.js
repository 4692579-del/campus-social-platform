const emojiChoices = [
  ['😀', '笑脸'], ['😂', '笑哭'], ['🥰', '喜欢'], ['😍', '心动'], ['😎', '酷'], ['🤔', '思考'], ['😅', '尴尬'], ['😭', '大哭'],
  ['😤', '生气'], ['😴', '困'], ['🙃', '倒脸'], ['😳', '害羞'], ['🥺', '可怜'], ['🤣', '大笑'], ['🤩', '星星眼'], ['😮', '惊讶'],
  ['👍', '点赞'], ['👏', '鼓掌'], ['🙌', '举手'], ['🙏', '感谢'], ['💖', '爱心'], ['🎉', '庆祝'], ['✨', '闪亮'], ['🔥', '火热'],
].map(([emoji, label]) => ({ emoji, label }));

function selectionOf(value, detail = {}) {
  const { cursor, start, end } = detail;
  if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= value.length) return { value, start, end };
  if (Number.isInteger(cursor) && cursor >= 0 && cursor <= value.length) return { value, start: cursor, end: cursor };
  return null;
}

function captureSelection(api, apply, focused) {
  // 聚焦时优先读取选区，旧客户端继续使用 input / blur 报告的光标。
  try { if (focused) api.getSelectedTextRange?.({ success: apply, fail() {} }); } catch (_) { /* 保留已有光标。 */ }
  try { api.hideKeyboard?.({ fail() {} }); } catch (_) { /* 原生键盘生命周期继续处理布局。 */ }
}

function insertEmoji(value, emoji, selection, maximum, prefixLength = 0) {
  if (!emojiChoices.some(item => item.emoji === emoji)) return null;
  const cursor = position => {
    const index = Math.max(prefixLength, position);
    const unit = value.charCodeAt(index);
    return unit >= 0xdc00 && unit <= 0xdfff ? index + 1 : index;
  };
  const start = selection?.value === value ? cursor(selection.start) : value.length;
  const end = selection?.value === value ? cursor(selection.end) : value.length;
  const text = value.slice(0, start) + emoji + value.slice(end);
  return Array.from(text.slice(prefixLength)).length <= maximum ? { value: text, cursor: start + emoji.length } : { limited: true };
}

module.exports = { emojiChoices, selectionOf, captureSelection, insertEmoji };
