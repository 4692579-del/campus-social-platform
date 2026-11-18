const { declarationText } = require('./content-declaration');
function dateOf(raw) {
  const value = raw && typeof raw === 'object' && '$date' in raw ? raw.$date : raw;
  return value ? new Date(value) : null;
}
function postView(post) {
  const date = dateOf(post.createdAt), valid = date && !Number.isNaN(date.getTime());
  const elapsed = valid ? Math.max(0, Date.now() - date.getTime()) : 0;
  const local = valid ? new Date(date.getTime() + 8 * 3600000) : null;
  const pad = n => String(n).padStart(2, '0');
  return { ...post, declarationText: declarationText(post.declaration), timeText: !valid ? '' : elapsed < 60000 ? '刚刚' : elapsed < 3600000 ? `${Math.floor(elapsed / 60000)}分钟` :
    elapsed < 86400000 ? `${Math.floor(elapsed / 3600000)}小时` : `${local.getUTCMonth() + 1}月${local.getUTCDate()}日`,
    exactTime: valid ? `${local.getUTCFullYear()}年${local.getUTCMonth() + 1}月${local.getUTCDate()}日 ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}` : '' };
}
function token() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`; }
function postPreview(post) {
  const content = post.fullContent || post.content || '';
  return postView({ ...post, content: Array.from(content).slice(0, 280).join(''), fullContent: content, truncated: Array.from(content).length > 280 });
}
function nav(page) {
  try {
    const info = wx.getWindowInfo(), capsule = wx.getMenuButtonBoundingClientRect();
    const top = capsule && capsule.height ? capsule.top : (info.statusBarHeight || 0) + 8;
    const height = capsule && capsule.height || 32;
    page.setData({ navTop: top, navButtonHeight: height, navHeight: top + height + 8 });
  } catch (error) { /* 旧客户端保留默认导航栏高度。 */ }
}
module.exports = { postView, postPreview, token, nav };
