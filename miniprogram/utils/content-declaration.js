const declarations = [
  { key: 'none', label: '无需声明' },
  { key: 'ai', label: '内容由AI生成' },
  { key: 'opinion', label: '内容为个人观点和见解' },
  { key: 'repost', label: '内容为转载信息' },
  { key: 'fiction', label: '内容为虚构演绎' },
  { key: 'marketing', label: '内容含营销信息' },
];
function declarationKey(value) {
  return declarations.some(item => item.key === value) ? value : 'none';
}
function declarationText(value) {
  const item = declarations.find(item => item.key === value && item.key !== 'none');
  return item ? item.label : '';
}
module.exports = { declarations, declarationKey, declarationText };
