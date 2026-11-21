function normalize(value = {}) {
  const keyword = typeof value.keyword === 'string' ? value.keyword.trim() : '';
  const accountId = typeof value.accountId === 'string' ? value.accountId : '';
  if (Array.from(keyword).length > 100 || /[\u0000-\u001f\u007f]/.test(keyword) || accountId && !/^[1-9][0-9]{7}$/.test(accountId) || !keyword && !accountId) throw new Error('请输入有效的搜索内容');
  return { keyword, accountId };
}
function resultUrl(value) { return '/pages/search-results/index?query=' + encodeURIComponent(JSON.stringify(normalize(value))); }
function fromOptions(options = {}) {
  const raw = options.query;
  if (typeof raw !== 'string') throw new Error('搜索条件不正确');
  // 兼容原生已解码及未解码参数；不再次解码关键词中的百分号。
  const value = JSON.parse(raw.startsWith('{') ? raw : decodeURIComponent(raw));
  return normalize(value);
}
module.exports = { normalize, resultUrl, fromOptions };
